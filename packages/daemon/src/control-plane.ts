import { stat } from "node:fs/promises";

import { isAlreadyDiagnosedError } from "@reins/adapter-kit";
import {
  SendCommitFailure,
  SendDeliveryFailure,
  SpawnCommitFailure,
  SpawnStartFailure,
  InterruptCommitFailure,
  InterruptRequestFailure,
  type SessionMachine,
} from "@reins/core";
import type {
  ControlOperation,
  ControlStore,
  SessionEventsPage,
  StoredCommittedEvent,
  StoredSession,
} from "@reins/event-journal";
import type {
  AttachParams,
  AttachInitial,
  ConsumerContext,
  AutonomousTurnCause,
  DaemonDiagnosticFact,
  DiagnosticsParams,
  DomainEvent,
  EventId,
  HarnessId,
  HarnessModelCatalog,
  ModelCatalogResult,
  MachineError,
  KillParams,
  KillResult,
  InterruptAck,
  InterruptParams,
  OperationKey,
  OperationEffect,
  OperationRecord,
  ProtocolMethod,
  RuntimeScopeId,
  SessionId,
  SessionInfo,
  SessionCloseEffect,
  StopReason,
  SendAck,
  SendParams,
  SpawnAck,
  SpawnParams,
  SubscriptionTarget,
  TurnTarget,
  TurnId,
  WaitParams,
  WaitResult,
} from "@reins/protocol";
import {
  decodeResumeCursor,
  encodeResumeCursor,
  harnessModelCatalogSchema,
  isSideEffectMethod,
  killParamsSchema,
  makeErrorCause,
  makeTextEvidence,
  machineErrorSchema,
  operationRecordSchemaFor,
  interruptParamsSchema,
  parseOperationKey,
  sendParamsSchema,
  spawnParamsSchema,
} from "@reins/protocol";
import * as v from "valibot";

import type { ConsumerScope } from "./consumer-scope.ts";
import type { OrderedDiagnosticsRuntime } from "./diagnostics-acceptance.ts";
import type { AdapterRegistry } from "./registry.ts";

const ATTACH_HISTORY_PAGE_SIZE = 128;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? "Unknown error";
  } catch {
    return "Unknown error";
  }
}

class SpawnCommitVerificationError extends Error {
  readonly durableState: "not_committed" | "unconfirmed";
  readonly commitError: unknown;
  readonly verificationError: unknown;

  constructor(
    durableState: "not_committed" | "unconfirmed",
    commitError: unknown,
    verificationError?: unknown,
  ) {
    super("Spawn commit could not be confirmed after an error");
    this.name = "SpawnCommitVerificationError";
    this.durableState = durableState;
    this.commitError = commitError;
    this.verificationError = verificationError;
  }
}

class SendCommitVerificationError extends Error {
  readonly durableState: "not_committed" | "unconfirmed";
  readonly commitError: unknown;
  readonly verificationError: unknown;

  constructor(
    durableState: "not_committed" | "unconfirmed",
    commitError: unknown,
    verificationError?: unknown,
  ) {
    super("Send commit could not be confirmed after an error");
    this.name = "SendCommitVerificationError";
    this.durableState = durableState;
    this.commitError = commitError;
    this.verificationError = verificationError;
  }
}

class KillCommitVerificationError extends Error {
  readonly durableState: "not_committed" | "unconfirmed";
  readonly result: KillResult;
  readonly commitError: unknown;
  readonly verificationError: unknown;

  constructor(
    durableState: "not_committed" | "unconfirmed",
    result: KillResult,
    commitError: unknown,
    verificationError?: unknown,
  ) {
    super("Kill commit could not be confirmed after an error");
    this.name = "KillCommitVerificationError";
    this.durableState = durableState;
    this.result = result;
    this.commitError = commitError;
    this.verificationError = verificationError;
  }
}

class InterruptCommitVerificationError extends Error {
  readonly durableState: "not_committed" | "unconfirmed";
  readonly commitError: unknown;
  readonly verificationError: unknown;

  constructor(
    durableState: "not_committed" | "unconfirmed",
    commitError: unknown,
    verificationError?: unknown,
  ) {
    super(
      "Interrupt commit failed before its durable state could be confirmed",
    );
    this.name = "InterruptCommitVerificationError";
    this.durableState = durableState;
    this.commitError = commitError;
    this.verificationError = verificationError;
  }
}

export type CommittedEvent = {
  readonly event: DomainEvent;
  readonly eventId: EventId;
};

type SessionProjectionBase = Pick<
  SessionInfo,
  | "sessionId"
  | "harness"
  | "model"
  | "reasoning"
  | "cwd"
  | "spawnedAt"
  | "turns"
> & {
  readonly sessionLabel?: SessionInfo["sessionLabel"];
  readonly lastCompletedTurn?: NonNullable<
    Extract<SessionInfo, { state: "idle" }>["lastCompletedTurn"]
  >;
};

type KillEffectError = Extract<MachineError, { code: "internal_error" }> & {
  readonly effect: SessionCloseEffect;
};

export type AttachSubscriptionStart = {
  readonly target: SubscriptionTarget;
  readonly firstPage: SessionEventsPage;
  readonly initial: AttachInitial;
  readonly startEventId: number;
  readonly follow: boolean;
  readonly endReason?: StopReason | "session_killed" | "control_unavailable";
};

export type ControlPlane = {
  execute(
    request: {
      readonly method: ProtocolMethod;
      readonly params: unknown;
      readonly operationKey?: OperationKey;
    },
    consumer: ConsumerContext | undefined,
    perform: () => Promise<{ result: unknown } | { error: MachineError }>,
  ): Promise<{ result: unknown } | { error: MachineError }>;
  dispatch(
    method: ProtocolMethod,
    params: unknown,
    consumer: ConsumerContext | undefined,
    operationKey?: OperationKey,
  ): Promise<unknown>;
  acceptEvent(event: DomainEvent): Promise<void>;
  beginAutonomousTurn(input: {
    readonly sessionId: SessionId;
    readonly harness: HarnessId;
    readonly cause?: AutonomousTurnCause;
  }): TurnId;
  settleEvents(): Promise<void>;
  subscribeEvents(listener: (entry: CommittedEvent) => void): () => void;
  subscribeControlUnavailable(listener: () => void): () => void;
  assertSessionScope(sessionId: SessionId, consumer?: ConsumerContext): void;
  list(
    filter: Parameters<SessionMachine["list"]>[0],
    consumer?: ConsumerContext,
  ): SessionInfo[];
  attachInitial(
    params: AttachParams,
    consumer?: ConsumerContext,
  ): AttachSubscriptionStart;
  readAttachPage(
    target: SubscriptionTarget,
    afterEventId: number,
    throughEventId?: EventId | null,
  ): SessionEventsPage;
  waitForAttachTurn(target: TurnTarget): Promise<WaitResult>;
  isSessionKilled(sessionId: SessionId): boolean;
  liveSessionIds(): SessionId[];
  terminateLiveSessions(): Promise<void>;
  close(): void;
};

type ControlPlaneOptions = {
  machine: SessionMachine;
  adapters: AdapterRegistry;
  diagnostics: OrderedDiagnosticsRuntime;
  consumerScope: ConsumerScope;
  controlStore: ControlStore;
  runtimeScopeId: RuntimeScopeId;
  assertWriterLease?: () => Promise<void>;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}

export function createControlPlane(options: ControlPlaneOptions): ControlPlane {
  const eventListeners = new Set<(entry: CommittedEvent) => void>();
  const controlUnavailableListeners = new Set<() => void>();
  const waitListeners = new Set<(entry?: CommittedEvent) => void>();
  const committedEvents = new Map<SessionId, StoredCommittedEvent[]>();
  function queueCommittedEvents(
    sessionId: SessionId,
    entries: readonly StoredCommittedEvent[],
  ): void {
    const queued = committedEvents.get(sessionId) ?? [];
    queued.push(...entries);
    committedEvents.set(sessionId, queued);
  }
  const transientOperations = new Map<
    string,
    {
      method: ProtocolMethod;
      consumer: ConsumerContext | undefined;
      fingerprint: string;
      outcome: Promise<{ result: unknown } | { error: MachineError }>;
    }
  >();
  const spawnResults = new Map<
    string,
    | {
        readonly status: "accepted_uncommitted" | "accepted_unconfirmed";
        readonly result: SpawnAck;
        readonly error: unknown;
        readonly verificationError?: unknown;
        readonly cleanupError: unknown;
      }
    | { readonly status: "outcome_unknown"; readonly error: MachineError }
  >();
  const sendResults = new Map<
    string,
    | { readonly status: "failed"; readonly error: MachineError }
    | {
        readonly status:
          | "not_accepted_uncommitted"
          | "not_accepted_unconfirmed";
        readonly error: MachineError;
        readonly failureWriteError: unknown;
        readonly verificationError?: unknown;
      }
    | {
        readonly status:
          | "partial_effect_uncommitted"
          | "partial_effect_unconfirmed";
        readonly error: MachineError;
        readonly failureWriteError: unknown;
        readonly verificationError?: unknown;
      }
    | {
        readonly status: "accepted_uncommitted" | "accepted_unconfirmed";
        readonly result: SendAck;
        readonly error: unknown;
        readonly verificationError?: unknown;
        readonly cleanupError: unknown;
      }
    | { readonly status: "outcome_unknown"; readonly error: MachineError }
  >();
  const interruptResults = new Map<
    string,
    | { readonly status: "failed"; readonly error: MachineError }
    | {
        readonly status:
          | "not_accepted_uncommitted"
          | "not_accepted_unconfirmed";
        readonly error: MachineError;
        readonly failureWriteError: unknown;
        readonly verificationError?: unknown;
      }
    | {
        readonly status: "accepted_uncommitted" | "accepted_unconfirmed";
        readonly result: InterruptAck;
        readonly error: unknown;
        readonly verificationError?: unknown;
        readonly cleanupError?: unknown;
      }
    | { readonly status: "outcome_unknown"; readonly error: MachineError }
  >();
  const interruptRequestFingerprints = new Map<string, string>();
  type KillOperationResult =
    | { readonly status: "failed"; readonly error: MachineError }
    | {
        readonly status:
          | "not_accepted_uncommitted"
          | "not_accepted_unconfirmed";
        readonly error: MachineError;
        readonly failureWriteError: unknown;
        readonly verificationError?: unknown;
      }
    | {
        readonly status: "accepted_uncommitted" | "accepted_unconfirmed";
        readonly result: KillResult;
        readonly error: unknown;
        readonly verificationError?: unknown;
      }
    | {
        readonly status:
          | "partial_effect_uncommitted"
          | "partial_effect_unconfirmed";
        readonly error: KillEffectError;
        readonly cause: ReturnType<typeof makeErrorCause>;
      }
    | { readonly status: "outcome_unknown"; readonly error: MachineError };
  const killResults = new Map<
    string,
    KillOperationResult & { readonly fingerprint: string }
  >();
  function rememberKillResult(
    operationKey: OperationKey,
    result: KillOperationResult,
  ): void {
    const active = transientOperations.get(operationKey);
    if (active?.method === "kill") {
      killResults.set(operationKey, {
        ...result,
        fingerprint: active.fingerprint,
      });
      return;
    }
    const operation = options.controlStore.getOperation(operationKey);
    if (operation?.kind !== "kill")
      throw new Error("Kill request fingerprint is unavailable");
    killResults.set(operationKey, {
      ...result,
      fingerprint: canonical({ method: "kill", params: operation.request }),
    });
  }
  let eventWriteFailure: unknown;
  const eventWriteFailures = new Map<SessionId, DomainEvent>();
  const eventOperationFailures = new Map<
    SessionId,
    {
      readonly operationKey: OperationKey<"kill">;
      readonly event: DomainEvent;
    }
  >();
  const activeKillOperationKeys = new Map<
    SessionId,
    Set<OperationKey<"kill">>
  >();
  const eventFailureCleanupFailures = new Map<SessionId, unknown>();
  const eventFailureStops = new Map<SessionId, Promise<void>>();

  function stopSessionAfterEventWriteFailure(sessionId: SessionId): void {
    if (eventFailureStops.has(sessionId)) return;
    const stopping = Promise.resolve().then(async () => {
      try {
        await options.machine.kill({ sessionId });
      } catch (error) {
        if (!eventFailureCleanupFailures.has(sessionId))
          eventFailureCleanupFailures.set(
            sessionId,
            error === undefined ? new Error("Worker shutdown failed") : error,
          );
      }
    });
    eventFailureStops.set(sessionId, stopping);
  }
  const unsubscribeMachine = options.machine.subscribe((event) => {
    try {
      void acceptEvent(event).catch(() => undefined);
    } catch {
      // EventBus routes synchronous persistence failures to its listener error sink.
    }
  });

  function recordDiagnostic(input: DaemonDiagnosticFact) {
    if (options.diagnostics.health().status === "degraded")
      return Promise.resolve(undefined);
    const unsafe = input as unknown as Record<string, unknown>;
    if ("source" in unsafe) return Promise.resolve(undefined);
    return options.diagnostics
      .record({ ...input, source: "daemon" })
      .catch(() => undefined);
  }

  async function assertWriterLease(): Promise<void> {
    try {
      await options.assertWriterLease?.();
    } catch {
      throw {
        code: "internal_error",
        cause: makeErrorCause("closed", "Control writer lease is unavailable"),
      } satisfies MachineError;
    }
  }

  async function verifiedModelCatalogDiagnostic(
    error: unknown,
    harness: HarnessId,
  ) {
    if (!isAlreadyDiagnosedError(error) || error.diagnosticId === undefined)
      return undefined;
    try {
      const result = await options.diagnostics.query({
        diagnosticId: error.diagnosticId,
      });
      if (!("record" in result)) return undefined;
      const record = result.record;
      return record.diagnosticId === error.diagnosticId &&
        record.source === "adapter" &&
        record.harness === harness &&
        record.kind === "request_failure" &&
        record.operation === "model_catalog" &&
        record.stage === "query"
        ? error.diagnosticId
        : undefined;
    } catch {
      return undefined;
    }
  }

  async function aggregateModelCatalog(): Promise<ModelCatalogResult> {
    const entries = Array.from(options.adapters.entries());
    const results = await Promise.allSettled(
      entries.map(async ([harness, adapter]) =>
        adapter.modelCatalog(async (input) => {
          const unsafe = input as unknown as Record<string, unknown>;
          if ("source" in unsafe || "harness" in unsafe) return undefined;
          return await options.diagnostics.record({
            ...input,
            source: "adapter",
            harness,
          });
        }),
      ),
    );
    const catalogs: HarnessModelCatalog[] = [];
    const failures: ModelCatalogResult["failures"] = [];
    for (const [index, result] of results.entries()) {
      const harness = entries[index]?.[0];
      if (harness === undefined) continue;
      if (result.status === "fulfilled") {
        const parsed = v.safeParse(harnessModelCatalogSchema, result.value);
        if (parsed.success && parsed.output.harness === harness) {
          catalogs.push(parsed.output);
          continue;
        }
        const reason = new Error("Model catalog did not match its harness");
        const diagnosticId = await recordDiagnostic({
          harness,
          kind: "request_failure",
          operation: "model_catalog",
          stage: "query",
          reason: "upstream_error",
          message: makeTextEvidence(String(reason)),
        });
        failures.push({
          harness,
          code: "model_catalog_query_failed",
          failure: {
            failureCategory: "unclassified",
            retryDisposition: "unknown",
          },
          ...(diagnosticId === undefined ? {} : { diagnosticId }),
        });
      } else {
        const suppliedDiagnosticId = await verifiedModelCatalogDiagnostic(
          result.reason,
          harness,
        );
        const diagnosticId =
          suppliedDiagnosticId ??
          (await recordDiagnostic({
            kind: "request_failure",
            operation: "model_catalog",
            stage: "query",
            reason: "upstream_error",
            harness,
            message: makeTextEvidence(String(result.reason)),
          }));
        failures.push({
          harness,
          code: "model_catalog_query_failed",
          failure: {
            failureCategory: "unclassified",
            retryDisposition: "unknown",
          },
          ...(diagnosticId === undefined ? {} : { diagnosticId }),
        });
      }
    }
    return { catalogs, failures };
  }

  function operationClaims(
    operationKey: OperationKey | undefined,
    kind: Parameters<typeof parseOperationKey>[1],
    consumer: ConsumerContext | undefined,
  ) {
    if (operationKey === undefined || consumer === undefined)
      throw { code: "protocol_error" } satisfies MachineError;
    let claims;
    try {
      claims = parseOperationKey(operationKey, kind);
    } catch {
      throw { code: "operation_key_conflict" } satisfies MachineError;
    }
    if (
      claims.runtimeScopeId !== options.runtimeScopeId ||
      claims.consumer !== consumer
    )
      throw { code: "operation_key_scope_mismatch" } satisfies MachineError;
    if (claims.generation !== options.diagnostics.generation)
      throw { code: "stale_operation_key" } satisfies MachineError;
    return claims;
  }

  function spawnSessionInfo(
    params: SpawnParams,
    result: SpawnAck,
    events: readonly DomainEvent[],
  ): SessionInfo {
    const created = events[0];
    if (created?.type !== "session.created")
      throw new Error("Initial spawn event is missing session.created");
    const started = events.find(
      (event) =>
        event.type === "turn.started" && event.turnId === result.turnId,
    );
    if (started?.type !== "turn.started")
      throw new Error("Initial spawn event is missing turn.started");
    let info: SessionInfo = {
      sessionId: result.sessionId,
      ...(created.sessionLabel === undefined
        ? {}
        : { sessionLabel: created.sessionLabel }),
      harness: params.harness,
      model: params.model ?? null,
      reasoning: params.reasoning ?? null,
      cwd: result.cwd,
      spawnedAt: created.spawnedAt,
      turns: 0,
      state: "busy",
      activeTurnId: result.turnId,
      ...(started.origin === undefined
        ? {}
        : { activeTurnOrigin: started.origin }),
    };
    for (const event of events.slice(2)) {
      if (event.type === "turn.completed") {
        const common: SessionProjectionBase = {
          sessionId: info.sessionId,
          ...(info.sessionLabel === undefined
            ? {}
            : { sessionLabel: info.sessionLabel }),
          harness: info.harness,
          model: info.model,
          reasoning: info.reasoning,
          cwd: info.cwd,
          spawnedAt: info.spawnedAt,
          turns: info.turns + 1,
        };
        info = {
          ...common,
          state: "idle",
          lastCompletedTurn: {
            turnId: event.turnId,
            ...((event.origin ?? started.origin) === undefined
              ? {}
              : { origin: event.origin ?? started.origin }),
            stopReason: event.stopReason,
          },
        };
      } else if (event.type === "session.killed") {
        const common: SessionProjectionBase = {
          sessionId: info.sessionId,
          ...(info.sessionLabel === undefined
            ? {}
            : { sessionLabel: info.sessionLabel }),
          harness: info.harness,
          model: info.model,
          reasoning: info.reasoning,
          cwd: info.cwd,
          spawnedAt: info.spawnedAt,
          turns: info.turns,
          ...(info.state === "idle"
            ? { lastCompletedTurn: info.lastCompletedTurn }
            : {}),
        };
        info = { ...common, state: "killed" };
      }
    }
    return info;
  }

  function sendSessionInfo(
    previous: SessionInfo,
    result: SendAck,
    events: readonly DomainEvent[],
  ): SessionInfo {
    if (result.deliveryPoint === "active_turn") {
      const caller = events[0];
      if (
        previous.state !== "busy" ||
        previous.activeTurnId !== result.turnId ||
        events.length !== 1 ||
        caller?.type !== "message" ||
        caller.role !== "caller" ||
        caller.messageId !== result.messageId ||
        caller.turnId !== result.turnId ||
        caller.sessionId !== result.sessionId
      )
        throw new Error("Active send target was not the recorded active turn");
      return previous;
    }
    if (previous.state !== "idle")
      throw new Error("New turn target was not idle before commit");
    const started = events.find(
      (event) =>
        event.type === "turn.started" && event.turnId === result.turnId,
    );
    if (started?.type !== "turn.started")
      throw new Error("New turn event is missing turn.started");
    const common: SessionProjectionBase = {
      sessionId: previous.sessionId,
      ...(previous.sessionLabel === undefined
        ? {}
        : { sessionLabel: previous.sessionLabel }),
      harness: previous.harness,
      model: previous.model,
      reasoning: previous.reasoning,
      cwd: previous.cwd,
      spawnedAt: previous.spawnedAt,
      turns: previous.turns,
      ...(previous.lastCompletedTurn === undefined
        ? {}
        : { lastCompletedTurn: previous.lastCompletedTurn }),
    };
    const terminal = events.find((event) => event.type === "turn.completed");
    if (terminal?.type === "turn.completed") {
      if (terminal.turnId !== result.turnId)
        throw new Error("New turn completion does not match its result");
      return {
        ...common,
        turns: previous.turns + 1,
        state: "idle",
        lastCompletedTurn: {
          turnId: terminal.turnId,
          ...((terminal.origin ?? started.origin) === undefined
            ? {}
            : { origin: terminal.origin ?? started.origin }),
          stopReason: terminal.stopReason,
        },
      };
    }
    return {
      ...common,
      state: "busy",
      activeTurnId: result.turnId,
      ...(started.origin === undefined
        ? {}
        : { activeTurnOrigin: started.origin }),
    };
  }

  function killSessionInfo(
    previous: SessionInfo,
    events: readonly DomainEvent[],
  ): SessionInfo {
    if (previous.state === "killed") {
      if (events.length !== 0)
        throw new Error("Already-killed session cannot add terminal events");
      return previous;
    }
    const common: SessionProjectionBase = {
      sessionId: previous.sessionId,
      ...(previous.sessionLabel === undefined
        ? {}
        : { sessionLabel: previous.sessionLabel }),
      harness: previous.harness,
      model: previous.model,
      reasoning: previous.reasoning,
      cwd: previous.cwd,
      spawnedAt: previous.spawnedAt,
      turns: previous.turns,
      ...(previous.state === "idle" && previous.lastCompletedTurn !== undefined
        ? { lastCompletedTurn: previous.lastCompletedTurn }
        : {}),
    };
    let turns = previous.turns;
    let lastCompletedTurn =
      previous.state === "idle" ? previous.lastCompletedTurn : undefined;
    for (const event of events) {
      if (event.type !== "turn.completed") continue;
      turns += 1;
      lastCompletedTurn = {
        turnId: event.turnId,
        stopReason: event.stopReason,
      };
    }
    if (events.at(-1)?.type !== "session.killed")
      throw new Error("Kill event batch has no session terminal");
    return {
      ...common,
      turns,
      state: "killed",
      ...(lastCompletedTurn === undefined ? {} : { lastCompletedTurn }),
    };
  }

  function missingKillEvents(
    sessionId: SessionId,
    events: readonly DomainEvent[],
  ): readonly DomainEvent[] {
    if (events.length === 0) return events;
    const stored = options.controlStore.sessionEvents(sessionId);
    for (
      let prefixLength = Math.min(events.length, stored.length);
      prefixLength > 0;
      prefixLength -= 1
    ) {
      const tail = stored.slice(-prefixLength);
      if (
        tail.every(
          (entry, index) => canonical(entry.event) === canonical(events[index]),
        )
      )
        return events.slice(prefixLength);
    }
    return events;
  }

  function verifyCommittedSpawn(input: {
    operationKey: OperationKey;
    request: SpawnParams;
    result: SpawnAck;
    session: StoredSession;
    events: readonly DomainEvent[];
  }):
    | {
        readonly status: "committed";
        readonly events: readonly StoredCommittedEvent[];
      }
    | { readonly status: "not_committed" }
    | { readonly status: "unconfirmed"; readonly error: unknown } {
    try {
      const operation = options.controlStore.getOperation(input.operationKey);
      if (operation === undefined)
        return {
          status: "unconfirmed",
          error: new Error(
            "Spawn operation record is missing after commit error",
          ),
        };
      if (
        operation.runtimeScopeId !== input.session.runtimeScopeId ||
        operation.consumer !== input.session.consumer ||
        operation.generation !== input.session.generation ||
        canonical(operation.request) !== canonical(input.request)
      )
        return {
          status: "unconfirmed",
          error: new Error(
            "Stored operation does not match the submitted spawn",
          ),
        };
      if (operation.status === "dispatched") return { status: "not_committed" };
      if (
        operation.status !== "succeeded" ||
        canonical(operation.result) !== canonical(input.result)
      )
        return {
          status: "unconfirmed",
          error: new Error(
            "Stored spawn result does not match the accepted result",
          ),
        };
      const session = options.controlStore.getSession(input.result.sessionId);
      const committedEvents = options.controlStore.sessionEvents(
        input.result.sessionId,
      );
      if (
        session === undefined ||
        canonical(session) !== canonical(input.session) ||
        committedEvents.length !== input.events.length ||
        committedEvents.some(
          (entry, index) =>
            entry.eventId !== index + 1 ||
            canonical(entry.event) !== canonical(input.events[index]),
        )
      )
        return {
          status: "unconfirmed",
          error: new Error("Stored spawn session or event batch is incomplete"),
        };
      return { status: "committed", events: committedEvents };
    } catch (error) {
      return { status: "unconfirmed", error };
    }
  }

  function verifyCommittedSend(input: {
    operationKey: OperationKey;
    request: SendParams;
    result: SendAck;
    session: StoredSession;
    events: readonly DomainEvent[];
  }):
    | {
        readonly status: "committed";
        readonly events: readonly StoredCommittedEvent[];
      }
    | { readonly status: "not_committed" }
    | { readonly status: "unconfirmed"; readonly error: unknown } {
    try {
      const operation = options.controlStore.getOperation(input.operationKey);
      if (operation === undefined || operation.kind !== "send")
        return {
          status: "unconfirmed",
          error: new Error(
            "Send operation record is missing after commit error",
          ),
        };
      if (
        operation.runtimeScopeId !== input.session.runtimeScopeId ||
        operation.consumer !== input.session.consumer ||
        operation.generation !== input.session.generation ||
        canonical(operation.request) !== canonical(input.request)
      )
        return {
          status: "unconfirmed",
          error: new Error(
            "Stored operation does not match the submitted send",
          ),
        };
      if (operation.status === "dispatched") return { status: "not_committed" };
      if (
        operation.status !== "succeeded" ||
        canonical(operation.result) !== canonical(input.result)
      )
        return {
          status: "unconfirmed",
          error: new Error(
            "Stored send result does not match the accepted result",
          ),
        };
      const session = options.controlStore.getSession(input.result.sessionId);
      const committedEvents = options.controlStore.sessionEvents(
        input.result.sessionId,
      );
      const tail = committedEvents.slice(-input.events.length);
      if (
        session === undefined ||
        canonical(session) !== canonical(input.session) ||
        tail.length !== input.events.length ||
        tail.some(
          (entry, index) =>
            canonical(entry.event) !== canonical(input.events[index]) ||
            (index > 0 && entry.eventId !== tail[index - 1]!.eventId + 1),
        )
      )
        return {
          status: "unconfirmed",
          error: new Error("Stored send session or event batch is incomplete"),
        };
      return { status: "committed", events: tail };
    } catch (error) {
      return { status: "unconfirmed", error };
    }
  }

  function verifyCommittedKill(input: {
    operationKey: OperationKey;
    request: KillParams;
    result: KillResult;
    session?: StoredSession;
    events: readonly DomainEvent[];
  }):
    | {
        readonly status: "committed";
        readonly events: readonly StoredCommittedEvent[];
      }
    | { readonly status: "not_committed" }
    | { readonly status: "unconfirmed"; readonly error: unknown } {
    try {
      const operation = options.controlStore.getOperation(input.operationKey);
      if (operation === undefined) return { status: "not_committed" };
      if (operation.kind !== "kill")
        return {
          status: "unconfirmed",
          error: new Error("Stored operation does not have kill kind"),
        };
      if (
        operation.runtimeScopeId !== options.runtimeScopeId ||
        operation.request.sessionId !== input.request.sessionId ||
        operation.consumer !==
          parseOperationKey(input.operationKey, "kill").consumer ||
        operation.generation !==
          parseOperationKey(input.operationKey, "kill").generation
      )
        return {
          status: "unconfirmed",
          error: new Error(
            "Stored operation does not match the submitted kill",
          ),
        };
      if (operation.status === "pending" || operation.status === "dispatched")
        return { status: "not_committed" };
      if (
        operation.status !== "succeeded" ||
        canonical(operation.result) !== canonical(input.result)
      )
        return {
          status: "unconfirmed",
          error: new Error("Stored kill result does not match the close"),
        };
      if (input.session !== undefined) {
        const session = options.controlStore.getSession(input.result.sessionId);
        if (
          session === undefined ||
          canonical(session) !== canonical(input.session)
        )
          return {
            status: "unconfirmed",
            error: new Error("Stored kill session projection is incomplete"),
          };
      }
      const committedEvents =
        input.events.length === 0
          ? []
          : options.controlStore
              .sessionEvents(input.result.sessionId)
              .slice(-input.events.length);
      if (
        committedEvents.length !== input.events.length ||
        committedEvents.some(
          (entry, index) =>
            canonical(entry.event) !== canonical(input.events[index]) ||
            (index > 0 &&
              entry.eventId !== committedEvents[index - 1]!.eventId + 1),
        )
      )
        return {
          status: "unconfirmed",
          error: new Error("Stored kill event batch is incomplete"),
        };
      return { status: "committed", events: committedEvents };
    } catch (error) {
      return { status: "unconfirmed", error };
    }
  }

  function commitKillResult(
    result: KillResult,
    events: readonly DomainEvent[],
    operationKey?: OperationKey,
  ): KillResult {
    if (operationKey === undefined) return result;
    const key = operationKey as OperationKey<"kill">;
    let session: StoredSession | undefined;
    let eventsToCommit = events;
    if (result.status === "killed") {
      const existing = options.controlStore.getSession(result.sessionId);
      if (existing === undefined)
        throw new Error("Kill target is missing from the control store");
      eventsToCommit = missingKillEvents(result.sessionId, events);
      session = {
        ...existing,
        info: killSessionInfo(existing.info, eventsToCommit),
      };
    }
    let committed: readonly StoredCommittedEvent[];
    try {
      committed = options.controlStore.commitKill({
        operationKey: key,
        result,
        ...(session === undefined ? {} : { session }),
        events: eventsToCommit,
      });
    } catch (commitError) {
      wakeWaitersIfStoreUnavailable();
      const verification = verifyCommittedKill({
        operationKey: key,
        request: { sessionId: result.sessionId },
        result,
        ...(session === undefined ? {} : { session }),
        events: eventsToCommit,
      });
      if (verification.status === "committed") {
        committed = verification.events;
      } else {
        throw new KillCommitVerificationError(
          verification.status,
          result,
          commitError,
          verification.status === "unconfirmed"
            ? verification.error
            : undefined,
        );
      }
    }
    if (committed.length > 0)
      committedEvents.set(result.sessionId, [...committed]);
    return result;
  }

  function verifyCommittedInterrupt(input: {
    operationKey: OperationKey;
    request: InterruptParams;
    result: InterruptAck;
  }):
    | { readonly status: "committed" }
    | { readonly status: "not_committed" }
    | { readonly status: "unconfirmed"; readonly error: unknown } {
    try {
      const operation = options.controlStore.getOperation(input.operationKey);
      if (
        operation?.kind !== "interrupt" ||
        canonical(operation.request) !== canonical(input.request)
      )
        return {
          status: "unconfirmed",
          error: new Error("Stored operation does not match the interrupt"),
        };
      if (operation.status === "pending" || operation.status === "dispatched")
        return { status: "not_committed" };
      if (
        operation.status === "succeeded" &&
        canonical(operation.result) === canonical(input.result)
      )
        return { status: "committed" };
      return {
        status: "unconfirmed",
        error: new Error(
          "Stored interrupt result does not match the native acceptance result",
        ),
      };
    } catch {
      return {
        status: "unconfirmed",
        error: new Error("Could not read the stored interrupt result"),
      };
    }
  }

  function rememberUncommittedInterruptFailure(
    operationKey: OperationKey,
    failure: MachineError,
    failureWriteError: unknown,
  ): boolean {
    let operation: ControlOperation | undefined;
    let verificationError: unknown;
    try {
      operation = options.controlStore.getOperation(operationKey);
    } catch (error) {
      verificationError = error;
    }
    const recorded =
      operation?.status === "failed" &&
      canonical(operation.error) === canonical(failure);
    if (recorded) return true;
    const stateIsUncommitted =
      verificationError === undefined &&
      (operation === undefined ||
        operation.status === "pending" ||
        operation.status === "dispatched");
    interruptResults.set(operationKey, {
      status: stateIsUncommitted
        ? "not_accepted_uncommitted"
        : "not_accepted_unconfirmed",
      error: failure,
      failureWriteError,
      ...(verificationError === undefined
        ? stateIsUncommitted
          ? {}
          : {
              verificationError: new Error(
                "Stored operation does not match the known rejection",
              ),
            }
        : { verificationError }),
    });
    return false;
  }

  function rememberUncommittedSendFailure(
    operationKey: OperationKey,
    failure: MachineError,
    failureWriteError: unknown,
  ): boolean {
    let operation: ControlOperation | undefined;
    let verificationError: unknown;
    try {
      operation = options.controlStore.getOperation(operationKey);
    } catch (error) {
      verificationError = error;
    }
    const recorded =
      operation?.status === "failed" &&
      canonical(operation.error) === canonical(failure);
    if (recorded) return true;

    const stateIsUncommitted =
      verificationError === undefined &&
      (operation === undefined ||
        operation.status === "pending" ||
        operation.status === "dispatched");
    const partialEffect =
      failure.code === "internal_error" &&
      failure.effect?.kind === "execution_phase_cancelled";
    sendResults.set(operationKey, {
      status: partialEffect
        ? stateIsUncommitted
          ? "partial_effect_uncommitted"
          : "partial_effect_unconfirmed"
        : stateIsUncommitted
          ? "not_accepted_uncommitted"
          : "not_accepted_unconfirmed",
      error: failure,
      failureWriteError,
      ...(verificationError === undefined
        ? stateIsUncommitted
          ? {}
          : {
              verificationError: new Error(
                "Stored operation does not match the known rejection",
              ),
            }
        : { verificationError }),
    });
    return false;
  }

  function getKillOperation(
    operationKey: OperationKey<"kill">,
    claims: ReturnType<typeof parseOperationKey>,
  ): OperationRecord {
    const known = killResults.get(operationKey);
    const record = (value: unknown): OperationRecord =>
      v.parse(operationRecordSchemaFor("kill"), value) as OperationRecord;
    const partialRecord = (
      status: "partial_effect_uncommitted" | "partial_effect_unconfirmed",
      verificationError?: unknown,
    ): OperationRecord => {
      if (
        known === undefined ||
        (known.status !== "partial_effect_uncommitted" &&
          known.status !== "partial_effect_unconfirmed")
      )
        throw new Error("No partial kill effect is recorded");
      return record({
        status,
        operationKey,
        error: known.error,
        cause: makeErrorCause(
          "io",
          verificationError === undefined
            ? known.cause.message
            : `${known.cause.message}; durable state verification failed: ${errorMessage(verificationError)}`,
        ),
      });
    };
    const acceptedRecord = (
      status: "accepted_uncommitted" | "accepted_unconfirmed",
      verificationError?: unknown,
    ): OperationRecord => {
      if (
        known === undefined ||
        (known.status !== "accepted_uncommitted" &&
          known.status !== "accepted_unconfirmed")
      )
        throw new Error("No accepted kill result is recorded");
      return record({
        status,
        operationKey,
        result: known.result,
        cause: makeErrorCause(
          "io",
          verificationError === undefined
            ? errorMessage(known.error)
            : `${errorMessage(known.error)}; durable state verification failed: ${errorMessage(verificationError)}`,
        ),
      });
    };
    const notAcceptedRecord = (
      status: "not_accepted_uncommitted" | "not_accepted_unconfirmed",
      verificationError?: unknown,
    ): OperationRecord => {
      if (
        known === undefined ||
        (known.status !== "not_accepted_uncommitted" &&
          known.status !== "not_accepted_unconfirmed")
      )
        throw new Error("No uncommitted kill failure is recorded");
      return record({
        status,
        operationKey,
        error: known.error,
        cause: makeErrorCause(
          "io",
          verificationError === undefined
            ? errorMessage(known.failureWriteError)
            : `${errorMessage(known.failureWriteError)}; durable state verification failed: ${errorMessage(verificationError)}`,
        ),
      });
    };

    if (transientOperations.get(operationKey)?.method === "kill")
      return record({ status: "pending", operationKey });
    try {
      const operation = options.controlStore.getOperation(operationKey);
      if (operation === undefined) {
        if (
          known?.status === "partial_effect_uncommitted" ||
          known?.status === "partial_effect_unconfirmed"
        )
          return partialRecord("partial_effect_uncommitted");
        if (
          known?.status === "not_accepted_uncommitted" ||
          known?.status === "not_accepted_unconfirmed"
        )
          return notAcceptedRecord("not_accepted_uncommitted");
        if (
          known?.status === "accepted_uncommitted" ||
          known?.status === "accepted_unconfirmed"
        )
          return acceptedRecord("accepted_uncommitted");
        if (known?.status === "failed")
          return record({ status: "failed", operationKey, error: known.error });
        if (known?.status === "outcome_unknown")
          return record({
            status: "outcome_unknown",
            operationKey,
            ...(known.error.code === "operation_outcome_unknown" &&
            known.error.cause !== undefined
              ? { cause: known.error.cause }
              : {}),
            ...(known.error.code === "operation_outcome_unknown" &&
            known.error.cleanupCause !== undefined
              ? { cleanupCause: known.error.cleanupCause }
              : {}),
          });
        return record({
          status:
            options.controlStore.health().status === "available"
              ? "unknown"
              : "unavailable",
          operationKey,
        });
      }
      if (operation.kind !== "kill")
        throw { code: "operation_key_conflict" } satisfies MachineError;
      if (
        operation.runtimeScopeId !== claims.runtimeScopeId ||
        operation.consumer !== claims.consumer ||
        operation.generation !== claims.generation
      )
        throw { code: "operation_key_scope_mismatch" } satisfies MachineError;
      switch (operation.status) {
        case "pending":
        case "dispatched":
          if (
            known?.status === "partial_effect_uncommitted" ||
            known?.status === "partial_effect_unconfirmed"
          )
            return partialRecord("partial_effect_uncommitted");
          if (
            known?.status === "not_accepted_uncommitted" ||
            known?.status === "not_accepted_unconfirmed"
          )
            return notAcceptedRecord("not_accepted_uncommitted");
          if (
            known?.status === "accepted_uncommitted" ||
            known?.status === "accepted_unconfirmed"
          )
            return acceptedRecord("accepted_uncommitted");
          if (known?.status === "failed")
            return record({
              status: "failed",
              operationKey,
              error: known.error,
            });
          if (known?.status === "outcome_unknown")
            return record({
              status: "outcome_unknown",
              operationKey,
              ...(known.error.code === "operation_outcome_unknown" &&
              known.error.cause !== undefined
                ? { cause: known.error.cause }
                : {}),
              ...(known.error.code === "operation_outcome_unknown" &&
              known.error.cleanupCause !== undefined
                ? { cleanupCause: known.error.cleanupCause }
                : {}),
            });
          return operation.status === "pending"
            ? record({ status: "pending", operationKey })
            : record({ status: "outcome_unknown", operationKey });
        case "outcome_unknown":
          return record({
            status: "outcome_unknown",
            operationKey,
            ...(operation.error.cause === undefined
              ? {}
              : { cause: operation.error.cause }),
            ...(operation.error.cleanupCause === undefined
              ? {}
              : { cleanupCause: operation.error.cleanupCause }),
            ...(operation.error.diagnosticId === undefined
              ? {}
              : { diagnosticId: operation.error.diagnosticId }),
            ...(operation.error.effect === undefined
              ? {}
              : { effect: operation.error.effect }),
          });
        case "succeeded":
          return record({
            status: "succeeded",
            operationKey,
            result: operation.result,
          });
        case "failed":
          return record({
            status: "failed",
            operationKey,
            error: operation.error,
          });
      }
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error.code === "operation_key_scope_mismatch" ||
          error.code === "operation_key_conflict")
      )
        throw error;
      if (
        known?.status === "partial_effect_uncommitted" ||
        known?.status === "partial_effect_unconfirmed"
      )
        return partialRecord("partial_effect_unconfirmed", error);
      if (
        known?.status === "not_accepted_uncommitted" ||
        known?.status === "not_accepted_unconfirmed"
      )
        return notAcceptedRecord("not_accepted_unconfirmed", error);
      if (known?.status === "accepted_uncommitted")
        return acceptedRecord("accepted_unconfirmed", error);
      if (known?.status === "accepted_unconfirmed")
        return acceptedRecord("accepted_unconfirmed", error);
      if (known?.status === "failed")
        return record({ status: "failed", operationKey, error: known.error });
      if (known?.status === "outcome_unknown")
        return record({ status: "outcome_unknown", operationKey });
      return record({ status: "unavailable", operationKey });
    }
  }

  function getOperation(
    operationKey: OperationKey,
    consumer: ConsumerContext | undefined,
  ): OperationRecord {
    let claims;
    try {
      claims = parseOperationKey(operationKey);
    } catch {
      throw { code: "operation_key_conflict" } satisfies MachineError;
    }
    if (
      claims.kind !== "spawn" &&
      claims.kind !== "send" &&
      claims.kind !== "interrupt" &&
      claims.kind !== "kill"
    )
      throw { code: "operation_key_conflict" } satisfies MachineError;
    if (
      consumer === undefined ||
      claims.runtimeScopeId !== options.runtimeScopeId ||
      claims.consumer !== consumer
    )
      throw { code: "operation_key_scope_mismatch" } satisfies MachineError;
    if (claims.kind === "kill")
      return getKillOperation(operationKey as OperationKey<"kill">, claims);
    const kind = claims.kind;
    const known =
      kind === "send"
        ? sendResults.get(operationKey)
        : kind === "interrupt"
          ? interruptResults.get(operationKey)
          : spawnResults.get(operationKey);
    const record = (value: unknown): OperationRecord =>
      v.parse(operationRecordSchemaFor(kind), value) as OperationRecord;
    const knownUnknownRecord = (): OperationRecord => {
      const error =
        known?.status === "outcome_unknown" &&
        known.error.code === "operation_outcome_unknown"
          ? known.error
          : undefined;
      return record({
        status: "outcome_unknown",
        operationKey,
        ...(error?.cause === undefined ? {} : { cause: error.cause }),
        ...(error?.cleanupCause === undefined
          ? {}
          : { cleanupCause: error.cleanupCause }),
        ...(error?.diagnosticId === undefined
          ? {}
          : { diagnosticId: error.diagnosticId }),
        ...(error?.effect === undefined ? {} : { effect: error.effect }),
      });
    };
    const knownNotAcceptedRecord = (
      status: "not_accepted_uncommitted" | "not_accepted_unconfirmed",
    ): OperationRecord => {
      if (
        known === undefined ||
        (known.status !== "not_accepted_uncommitted" &&
          known.status !== "not_accepted_unconfirmed")
      )
        throw new Error("No uncommitted operation failure is recorded");
      return record({
        status,
        operationKey,
        error: known.error,
        cause: makeErrorCause(
          "io",
          status === "not_accepted_uncommitted" ||
            known.verificationError === undefined
            ? errorMessage(known.failureWriteError)
            : `${errorMessage(known.failureWriteError)}; durable state verification failed: ${errorMessage(known.verificationError)}`,
        ),
      });
    };
    const knownPartialEffectRecord = (
      status: "partial_effect_uncommitted" | "partial_effect_unconfirmed",
    ): OperationRecord => {
      if (
        known === undefined ||
        (known.status !== "partial_effect_uncommitted" &&
          known.status !== "partial_effect_unconfirmed")
      )
        throw new Error("No uncommitted send effect is recorded");
      return record({
        status,
        operationKey,
        error: known.error,
        cause: makeErrorCause(
          "io",
          status === "partial_effect_uncommitted" ||
            known.verificationError === undefined
            ? errorMessage(known.failureWriteError)
            : `${errorMessage(known.failureWriteError)}; durable state verification failed: ${errorMessage(known.verificationError)}`,
        ),
      });
    };
    if (transientOperations.get(operationKey)?.method === kind)
      return record({
        status: "pending",
        operationKey,
      });
    const knownAcceptedRecord = (
      status: "accepted_uncommitted" | "accepted_unconfirmed",
    ) => {
      if (
        known === undefined ||
        (known.status !== "accepted_uncommitted" &&
          known.status !== "accepted_unconfirmed")
      )
        throw new Error("No accepted operation result is recorded");
      return record({
        status,
        operationKey,
        result: known.result,
        cause: makeErrorCause(
          "io",
          known.verificationError === undefined
            ? errorMessage(known.error)
            : `${errorMessage(known.error)}; durable state verification failed: ${errorMessage(known.verificationError)}`,
        ),
        ...(known.cleanupError === undefined
          ? {}
          : {
              cleanupCause: makeErrorCause(
                "closed",
                errorMessage(known.cleanupError),
              ),
            }),
      });
    };
    try {
      const operation = options.controlStore.getOperation(operationKey);
      if (operation === undefined) {
        if (
          known?.status === "accepted_uncommitted" ||
          known?.status === "accepted_unconfirmed"
        )
          return knownAcceptedRecord("accepted_unconfirmed");
        if (
          known?.status === "not_accepted_uncommitted" ||
          known?.status === "not_accepted_unconfirmed"
        )
          return knownNotAcceptedRecord("not_accepted_uncommitted");
        if (
          known?.status === "partial_effect_uncommitted" ||
          known?.status === "partial_effect_unconfirmed"
        )
          return knownPartialEffectRecord("partial_effect_uncommitted");
        if (known?.status === "failed")
          return record({ status: "failed", operationKey, error: known.error });
        if (known?.status === "outcome_unknown") return knownUnknownRecord();
        return record({
          status:
            options.controlStore.health().status === "available"
              ? "unknown"
              : "unavailable",
          operationKey,
        });
      }
      if (
        operation.runtimeScopeId !== claims.runtimeScopeId ||
        operation.consumer !== claims.consumer ||
        operation.generation !== claims.generation ||
        operation.kind !== kind
      )
        throw { code: "operation_key_scope_mismatch" } satisfies MachineError;
      switch (operation.status) {
        case "pending":
          if (
            known?.status === "accepted_uncommitted" ||
            known?.status === "accepted_unconfirmed"
          )
            return knownAcceptedRecord(
              known.status === "accepted_uncommitted"
                ? "accepted_uncommitted"
                : "accepted_unconfirmed",
            );
          if (
            known?.status === "not_accepted_uncommitted" ||
            known?.status === "not_accepted_unconfirmed"
          )
            return knownNotAcceptedRecord("not_accepted_uncommitted");
          if (
            known?.status === "partial_effect_uncommitted" ||
            known?.status === "partial_effect_unconfirmed"
          )
            return knownPartialEffectRecord("partial_effect_uncommitted");
          if (known?.status === "failed")
            return record({
              status: "failed",
              operationKey,
              error: known.error,
            });
          return record({
            status: "pending",
            operationKey,
          });
        case "dispatched":
          if (
            known?.status === "not_accepted_uncommitted" ||
            known?.status === "not_accepted_unconfirmed"
          )
            return knownNotAcceptedRecord("not_accepted_uncommitted");
          if (
            known?.status === "partial_effect_uncommitted" ||
            known?.status === "partial_effect_unconfirmed"
          )
            return knownPartialEffectRecord("partial_effect_uncommitted");
          if (known?.status === "failed")
            return record({
              status: "failed",
              operationKey,
              error: known.error,
            });
          if (transientOperations.get(operationKey)?.method === kind)
            return record({
              status: "pending",
              operationKey,
            });
          if (known?.status === "accepted_uncommitted")
            return knownAcceptedRecord("accepted_uncommitted");
          if (known?.status === "accepted_unconfirmed")
            return knownAcceptedRecord("accepted_unconfirmed");
          if (known?.status === "outcome_unknown") return knownUnknownRecord();
          return knownUnknownRecord();
        case "outcome_unknown":
          return record({
            status: "outcome_unknown",
            operationKey,
            ...(operation.error.cause === undefined
              ? {}
              : { cause: operation.error.cause }),
            ...(operation.error.cleanupCause === undefined
              ? {}
              : { cleanupCause: operation.error.cleanupCause }),
            ...(operation.error.diagnosticId === undefined
              ? {}
              : { diagnosticId: operation.error.diagnosticId }),
            ...(operation.error.effect === undefined
              ? {}
              : { effect: operation.error.effect }),
          });
        case "succeeded":
          return record({
            status: "succeeded",
            operationKey,
            result: operation.result,
          });
        case "failed":
          return record({
            status: "failed",
            operationKey,
            error: operation.error,
          });
      }
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "operation_key_scope_mismatch"
      )
        throw error;
      if (known?.status === "accepted_uncommitted")
        return knownAcceptedRecord("accepted_uncommitted");
      if (known?.status === "accepted_unconfirmed")
        return knownAcceptedRecord("accepted_unconfirmed");
      if (
        known?.status === "not_accepted_uncommitted" ||
        known?.status === "not_accepted_unconfirmed"
      )
        return knownNotAcceptedRecord("not_accepted_unconfirmed");
      if (
        known?.status === "partial_effect_uncommitted" ||
        known?.status === "partial_effect_unconfirmed"
      )
        return knownPartialEffectRecord("partial_effect_unconfirmed");
      if (known?.status === "outcome_unknown") return knownUnknownRecord();
      if (known?.status === "failed")
        return record({ status: "failed", operationKey, error: known.error });
      return record({
        status: "unavailable",
        operationKey,
      });
    }
  }

  function assertSessionScope(
    sessionId: SessionId,
    consumer?: ConsumerContext,
  ): void {
    if (
      consumer !== undefined &&
      !options.consumerScope.inScope(consumer, sessionId)
    )
      throw { code: "session_not_found", sessionId } satisfies MachineError;
  }

  async function dispatch(
    method: ProtocolMethod,
    rawParams: unknown,
    consumer: ConsumerContext | undefined,
    operationKey?: OperationKey,
  ): Promise<unknown> {
    switch (method) {
      case "getOperation":
        return getOperation(
          (rawParams as { operationKey: OperationKey }).operationKey,
          consumer,
        );
      case "modelCatalog":
        return await aggregateModelCatalog();
      case "spawn": {
        const spawnParams = rawParams as SpawnParams;
        try {
          const directory = await stat(spawnParams.cwd, { bigint: true });
          if (
            !directory.isDirectory() ||
            (spawnParams.cwdIdentity !== undefined &&
              (spawnParams.cwdIdentity.device !== String(directory.dev) ||
                spawnParams.cwdIdentity.inode !== String(directory.ino)))
          )
            throw new Error("Not a directory");
        } catch {
          throw {
            code: "invalid_params",
            issues: [{ issue: "invalid_value", path: "cwd" }],
          } satisfies MachineError;
        }
        if (
          spawnParams.captureHarnessStderr === true &&
          options.adapters.has(spawnParams.harness) &&
          options.adapters.get(spawnParams.harness)?.canCaptureHarnessStderr !==
            true
        )
          throw {
            code: "unsupported_feature",
            feature: "capture_harness_stderr",
          } satisfies MachineError;
        const knownHarnesses = new Set(options.adapters.keys());
        if (!knownHarnesses.has(spawnParams.harness))
          throw {
            code: "unknown_harness",
            harness: spawnParams.harness,
            availableHarnesses: [...knownHarnesses],
          } satisfies MachineError;
        if (spawnParams.model !== undefined) {
          const currentModelCatalog = await aggregateModelCatalog();
          const catalog = currentModelCatalog.catalogs.find(
            ({ harness }) => harness === spawnParams.harness,
          );
          const model = catalog?.models.find(
            ({ id }) => id === spawnParams.model,
          );
          if (catalog !== undefined && model === undefined)
            throw {
              code: "invalid_params",
              issues: [{ issue: "invalid_value", path: "model" }],
            } satisfies MachineError;
          if (
            model !== undefined &&
            spawnParams.reasoning !== undefined &&
            !model.reasoningEfforts.includes(spawnParams.reasoning)
          )
            throw {
              code: "invalid_params",
              issues: [{ issue: "invalid_value", path: "reasoning" }],
            } satisfies MachineError;
        }
        await assertWriterLease();
        const claims = operationClaims(operationKey, "spawn", consumer);
        const key = operationKey!;
        try {
          options.controlStore.markSpawnDispatched(key);
        } catch (error) {
          wakeWaitersIfStoreUnavailable();
          throw {
            code: "control_store_unavailable",
            operationKey: key,
            stage: "dispatch",
            acceptance: "not_dispatched",
            cause: makeErrorCause("io", errorMessage(error)),
          } satisfies MachineError;
        }
        try {
          return await options.machine.spawn(spawnParams, (result, events) => {
            const session: StoredSession = {
              info: spawnSessionInfo(spawnParams, result, events),
              runtimeScopeId: claims.runtimeScopeId,
              consumer: claims.consumer,
              generation: claims.generation,
            };
            let committed: readonly StoredCommittedEvent[];
            try {
              committed = options.controlStore.commitSpawn({
                operationKey: key,
                result,
                session,
                events,
              });
            } catch (commitError) {
              wakeWaitersIfStoreUnavailable();
              const verification = verifyCommittedSpawn({
                operationKey: key,
                request: spawnParams,
                result,
                session,
                events,
              });
              if (verification.status === "committed") {
                committed = verification.events;
              } else {
                throw new SpawnCommitVerificationError(
                  verification.status,
                  commitError,
                  verification.status === "unconfirmed"
                    ? verification.error
                    : undefined,
                );
              }
            }
            committedEvents.set(result.sessionId, [...committed]);
          });
        } catch (error) {
          if (error instanceof SpawnCommitFailure) {
            const commitVerification =
              error.commitError instanceof SpawnCommitVerificationError
                ? error.commitError
                : undefined;
            const durableState =
              commitVerification?.durableState ?? "unconfirmed";
            spawnResults.set(key, {
              status:
                durableState === "not_committed"
                  ? "accepted_uncommitted"
                  : "accepted_unconfirmed",
              result: error.result,
              error: commitVerification?.commitError ?? error.commitError,
              ...(commitVerification?.verificationError === undefined
                ? {}
                : { verificationError: commitVerification.verificationError }),
              cleanupError: error.terminationError,
            });
            const failure: MachineError = {
              code: "control_store_unavailable",
              operationKey: key,
              stage: "commit",
              acceptance: "accepted",
              cause: makeErrorCause(
                "io",
                errorMessage(
                  commitVerification?.commitError ?? error.commitError,
                ),
              ),
              acceptedResult: error.result,
              ...(error.terminationError === undefined
                ? {}
                : {
                    cleanupCause: makeErrorCause(
                      "closed",
                      errorMessage(error.terminationError),
                    ),
                  }),
            };
            throw failure;
          }
          if (error instanceof SpawnStartFailure) {
            if (error.acceptance === "unknown") {
              const unknown: MachineError = {
                code: "operation_outcome_unknown",
                operationKey: key,
                cause: failureCause(error.failure),
                ...(error.failure.code !== "internal_error" ||
                error.failure.diagnosticId === undefined
                  ? {}
                  : { diagnosticId: error.failure.diagnosticId }),
                ...(error.terminationError === undefined
                  ? {}
                  : {
                      cleanupCause: makeErrorCause(
                        "closed",
                        errorMessage(error.terminationError),
                      ),
                    }),
              };
              spawnResults.set(key, {
                status: "outcome_unknown",
                error: unknown,
              });
              try {
                options.controlStore.recordSpawnOutcomeUnknown(
                  key,
                  unknown as Extract<
                    MachineError,
                    { code: "operation_outcome_unknown" }
                  >,
                );
              } catch (storeError) {
                wakeWaitersIfStoreUnavailable();
                let recorded = false;
                try {
                  const operation = options.controlStore.getOperation(key);
                  recorded =
                    operation?.status === "outcome_unknown" &&
                    canonical(operation.error) === canonical(unknown);
                } catch {
                  // 无法核实是否已提交时保留原生结果未知事实。
                }
                if (!recorded)
                  throw storeUnavailable(
                    key,
                    "failure",
                    "unknown",
                    new Error(
                      `${failureCause(error.failure).message}; outcome record failed: ${errorMessage(storeError)}`,
                    ),
                    undefined,
                    error.terminationError,
                  );
              }
              throw unknown;
            }
            const failure = withCleanupCause(
              error.failure,
              error.terminationError,
            );
            try {
              options.controlStore.failSpawn(key, failure);
            } catch (storeError) {
              wakeWaitersIfStoreUnavailable();
              let recorded = false;
              try {
                const operation = options.controlStore.getOperation(key);
                recorded =
                  operation?.status === "failed" &&
                  canonical(operation.error) === canonical(failure);
              } catch {
                // 无法核实是否已提交时保留原生未接受事实。
              }
              if (recorded) throw failure;
              throw {
                ...storeUnavailable(
                  key,
                  "failure",
                  "not_dispatched",
                  new Error(
                    `${failureCause(failure).message}; failure record failed: ${errorMessage(storeError)}`,
                  ),
                  undefined,
                  error.terminationError,
                ),
              } satisfies MachineError;
            }
            throw failure;
          }
          throw error;
        }
      }
      case "send": {
        const params = rawParams as SendParams;
        assertSessionScope(params.sessionId, consumer);
        await assertWriterLease();
        const claims = operationClaims(operationKey, "send", consumer);
        const key = operationKey!;
        try {
          return await options.machine.send(params, {
            beforeDispatch() {
              try {
                options.controlStore.markSendDispatched(key);
              } catch (error) {
                wakeWaitersIfStoreUnavailable();
                const failure = storeUnavailable(
                  key,
                  "dispatch",
                  "not_dispatched",
                  error,
                );
                sendResults.set(key, { status: "failed", error: failure });
                try {
                  options.controlStore.failSend(key, failure);
                } catch (failureWriteError) {
                  wakeWaitersIfStoreUnavailable();
                  rememberUncommittedSendFailure(
                    key,
                    failure,
                    failureWriteError,
                  );
                }
                throw failure;
              }
            },
            async commit(result, events) {
              const existingSession = options.controlStore.getSession(
                result.sessionId,
              );
              if (existingSession === undefined)
                throw new Error("Send target disappeared before commit");
              const session: StoredSession = {
                info: sendSessionInfo(existingSession.info, result, events),
                runtimeScopeId: claims.runtimeScopeId,
                consumer: claims.consumer,
                generation: claims.generation,
              };
              let committed: readonly StoredCommittedEvent[];
              try {
                committed = options.controlStore.commitSend({
                  operationKey: key,
                  result,
                  session,
                  events,
                });
              } catch (commitError) {
                wakeWaitersIfStoreUnavailable();
                const verification = verifyCommittedSend({
                  operationKey: key,
                  request: params,
                  result,
                  session,
                  events,
                });
                if (verification.status === "committed") {
                  committed = verification.events;
                } else {
                  throw new SendCommitVerificationError(
                    verification.status,
                    commitError,
                    verification.status === "unconfirmed"
                      ? verification.error
                      : undefined,
                  );
                }
              }
              queueCommittedEvents(result.sessionId, committed);
            },
          });
        } catch (error) {
          if (error instanceof SendCommitFailure) {
            const verification =
              error.commitError instanceof SendCommitVerificationError
                ? error.commitError
                : undefined;
            const durableState = verification?.durableState ?? "unconfirmed";
            sendResults.set(key, {
              status:
                durableState === "not_committed"
                  ? "accepted_uncommitted"
                  : "accepted_unconfirmed",
              result: error.result,
              error: verification?.commitError ?? error.commitError,
              ...(verification?.verificationError === undefined
                ? {}
                : { verificationError: verification.verificationError }),
              cleanupError: error.terminationError,
            });
            throw storeUnavailable(
              key,
              "commit",
              "accepted",
              verification?.commitError ?? error.commitError,
              error.result,
              error.terminationError,
            );
          }
          if (error instanceof SendDeliveryFailure) {
            if (error.acceptance === "unknown") {
              const unknown: MachineError = {
                code: "operation_outcome_unknown",
                operationKey: key,
                cause: failureCause(error.failure),
                ...(error.failure.code !== "internal_error" ||
                error.failure.diagnosticId === undefined
                  ? {}
                  : { diagnosticId: error.failure.diagnosticId }),
                ...(error.failure.code !== "internal_error" ||
                error.failure.effect === undefined
                  ? {}
                  : { effect: error.failure.effect }),
                ...(error.terminationError === undefined
                  ? {}
                  : {
                      cleanupCause: makeErrorCause(
                        "closed",
                        errorMessage(error.terminationError),
                      ),
                    }),
              };
              sendResults.set(key, {
                status: "outcome_unknown",
                error: unknown,
              });
              try {
                options.controlStore.recordSendOutcomeUnknown(
                  key,
                  unknown as Extract<
                    MachineError,
                    { code: "operation_outcome_unknown" }
                  >,
                );
              } catch (storeError) {
                wakeWaitersIfStoreUnavailable();
                let recorded = false;
                try {
                  const operation = options.controlStore.getOperation(key);
                  recorded =
                    operation?.status === "outcome_unknown" &&
                    canonical(operation.error) === canonical(unknown);
                } catch {
                  // 无法核实时保留原生接受未知事实。
                }
                if (!recorded)
                  throw storeUnavailable(
                    key,
                    "failure",
                    "unknown",
                    new Error(
                      `${failureCause(error.failure).message}; outcome record failed: ${errorMessage(storeError)}`,
                    ),
                    undefined,
                    error.terminationError,
                    error.failure.code === "internal_error"
                      ? error.failure.effect
                      : undefined,
                  );
              }
              throw unknown;
            }

            const failure = withCleanupCause(
              error.failure,
              error.terminationError,
            );
            sendResults.set(key, { status: "failed", error: failure });
            try {
              options.controlStore.failSend(key, failure);
            } catch (storeError) {
              wakeWaitersIfStoreUnavailable();
              const recorded = rememberUncommittedSendFailure(
                key,
                failure,
                storeError,
              );
              if (!recorded)
                throw storeUnavailable(
                  key,
                  "failure",
                  "not_dispatched",
                  new Error(
                    `${failureCause(failure).message}; failure record failed: ${errorMessage(storeError)}`,
                  ),
                  undefined,
                  error.terminationError,
                  failure.code === "internal_error"
                    ? failure.effect
                    : undefined,
                );
            }
            throw failure;
          }
          throw error;
        }
      }
      case "wait": {
        const params = rawParams as WaitParams;
        for (const target of params.targets)
          assertSessionScope(target.sessionId, consumer);
        return await waitForCommittedTargets(params);
      }
      case "interrupt": {
        const params = rawParams as InterruptParams;
        assertSessionScope(params.sessionId, consumer);
        operationClaims(operationKey, "interrupt", consumer);
        const key = operationKey!;
        const input = {
          operationKey: key,
          runtimeScopeId: options.runtimeScopeId,
          consumer: consumer!,
          generation: options.diagnostics.generation,
          request: params,
        };
        const prepareInterruptRecord = () => {
          let operation = options.controlStore.getOperation(key);
          if (operation === undefined)
            operation = options.controlStore.registerInterrupt(input).operation;
          if (
            operation.kind !== "interrupt" ||
            operation.runtimeScopeId !== options.runtimeScopeId ||
            operation.consumer !== consumer ||
            operation.generation !== options.diagnostics.generation ||
            canonical(operation.request) !== canonical(params)
          )
            throw { code: "operation_key_conflict" } satisfies MachineError;
          if (operation.status === "pending") {
            options.controlStore.markInterruptDispatched(key);
            return;
          }
          if (operation.status === "dispatched") return;
          throw operation.status === "failed" ||
            operation.status === "outcome_unknown"
            ? operation.error
            : ({
                code: "operation_outcome_unknown",
                operationKey: key,
              } satisfies MachineError);
        };
        try {
          return await options.machine.interrupt(params, {
            beforeDispatch() {
              try {
                prepareInterruptRecord();
              } catch (error) {
                const known = asMachineError(error);
                if (
                  known.code === "operation_key_conflict" ||
                  known.code === "operation_pending" ||
                  known.code === "operation_outcome_unknown" ||
                  known.code === "operation_key_scope_mismatch"
                )
                  throw known;
                let operation: ControlOperation | undefined;
                try {
                  operation = options.controlStore.getOperation(key);
                } catch {
                  // 当前提交状态无法读取时，仍尝试必要的原生停止。
                }
                if (operation?.status === "failed") throw operation.error;
                if (operation?.status === "outcome_unknown")
                  throw operation.error;
                if (operation?.status === "succeeded")
                  throw {
                    code: "operation_outcome_unknown",
                    operationKey: key,
                  } satisfies MachineError;
                wakeWaitersIfStoreUnavailable();
              }
            },
            commit(result) {
              try {
                prepareInterruptRecord();
                options.controlStore.commitInterrupt({
                  operationKey: key,
                  result,
                });
              } catch (commitError) {
                wakeWaitersIfStoreUnavailable();
                const verification = verifyCommittedInterrupt({
                  operationKey: key,
                  request: params,
                  result,
                });
                if (verification.status === "committed") return;
                throw new InterruptCommitVerificationError(
                  verification.status,
                  commitError,
                  verification.status === "unconfirmed"
                    ? verification.error
                    : undefined,
                );
              }
            },
          });
        } catch (error) {
          if (error instanceof InterruptCommitFailure) {
            const verification =
              error.commitError instanceof InterruptCommitVerificationError
                ? error.commitError
                : undefined;
            const durableState = verification?.durableState ?? "unconfirmed";
            interruptResults.set(key, {
              status:
                durableState === "not_committed"
                  ? "accepted_uncommitted"
                  : "accepted_unconfirmed",
              result: error.result,
              error: verification?.commitError ?? error.commitError,
              ...(verification?.verificationError === undefined
                ? {}
                : { verificationError: verification.verificationError }),
            });
            throw storeUnavailable(
              key,
              "commit",
              "accepted",
              verification?.commitError ?? error.commitError,
              error.result,
            );
          }
          if (error instanceof InterruptRequestFailure) {
            if (error.acceptance === "unknown") {
              const unknown: MachineError = {
                code: "operation_outcome_unknown",
                operationKey: key,
                cause: failureCause(error.failure),
                ...(error.failure.code !== "internal_error" ||
                error.failure.diagnosticId === undefined
                  ? {}
                  : { diagnosticId: error.failure.diagnosticId }),
                ...(error.failure.code !== "internal_error" ||
                error.failure.effect === undefined
                  ? {}
                  : { effect: error.failure.effect }),
              };
              interruptResults.set(key, {
                status: "outcome_unknown",
                error: unknown,
              });
              try {
                prepareInterruptRecord();
                options.controlStore.recordInterruptOutcomeUnknown(
                  key,
                  unknown as Extract<
                    MachineError,
                    { code: "operation_outcome_unknown" }
                  >,
                );
              } catch (storeError) {
                wakeWaitersIfStoreUnavailable();
                const operation = (() => {
                  try {
                    return options.controlStore.getOperation(key);
                  } catch {
                    return undefined;
                  }
                })();
                if (
                  operation?.status !== "outcome_unknown" ||
                  canonical(operation.error) !== canonical(unknown)
                )
                  throw storeUnavailable(
                    key,
                    "failure",
                    "unknown",
                    new Error(
                      `${failureCause(error.failure).message}; outcome record failed: ${errorMessage(storeError)}`,
                    ),
                  );
              }
              throw unknown;
            }
            const failure = error.failure;
            interruptResults.set(key, { status: "failed", error: failure });
            try {
              prepareInterruptRecord();
              options.controlStore.failInterrupt(key, failure);
            } catch (storeError) {
              wakeWaitersIfStoreUnavailable();
              const recorded = rememberUncommittedInterruptFailure(
                key,
                failure,
                storeError,
              );
              if (!recorded)
                throw storeUnavailable(
                  key,
                  "failure",
                  "not_dispatched",
                  new Error(
                    `${failureCause(failure).message}; failure record failed: ${errorMessage(storeError)}`,
                  ),
                );
            }
            throw failure;
          }
          throw error;
        }
      }
      case "kill": {
        const params = rawParams as Parameters<SessionMachine["kill"]>[0];
        if (
          consumer !== undefined &&
          !options.consumerScope.inScope(consumer, params.sessionId)
        )
          return commitKillResult(
            { sessionId: params.sessionId, status: "not_found" },
            [],
            operationKey,
          );
        if (operationKey === undefined)
          return await options.machine.kill(params);
        try {
          return await options.machine.kill(params, (result, events) => {
            commitKillResult(result, events, operationKey);
            return undefined;
          });
        } catch (error) {
          if (!(error instanceof KillCommitVerificationError)) throw error;
          rememberKillResult(operationKey, {
            status:
              error.durableState === "not_committed"
                ? "accepted_uncommitted"
                : "accepted_unconfirmed",
            result: error.result,
            error: error.commitError,
            ...(error.verificationError === undefined
              ? {}
              : { verificationError: error.verificationError }),
          });
          wakeWaitersIfStoreUnavailable();
          throw storeUnavailable(
            operationKey,
            "commit",
            "accepted",
            error.commitError,
            error.result,
          );
        }
      }
      case "list":
        return list(
          rawParams as Parameters<SessionMachine["list"]>[0],
          consumer,
        );
      case "resolvePermission": {
        const params = rawParams as Parameters<
          SessionMachine["resolvePermission"]
        >[0];
        assertSessionScope(params.sessionId, consumer);
        await assertWriterLease();
        await options.machine.resolvePermission(params);
        return {
          sessionId: params.sessionId,
          permissionId: params.permissionId,
          turnId: params.turnId,
        };
      }
      case "diagnostics": {
        if (options.diagnostics.health().status === "degraded")
          throw { code: "diagnostics_unavailable" } satisfies MachineError;
        const diagnosticsParams = rawParams as DiagnosticsParams;
        try {
          return await options.diagnostics.query(diagnosticsParams);
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "diagnostic_not_found" &&
            "diagnosticId" in diagnosticsParams
          )
            throw {
              code: "diagnostic_not_found",
              diagnosticId: diagnosticsParams.diagnosticId,
            } satisfies MachineError;
          throw { code: "diagnostics_unavailable" } satisfies MachineError;
        }
      }
      default:
        throw new Error(`unexpected control method: ${method}`);
    }
  }

  function list(
    filter: Parameters<SessionMachine["list"]>[0],
    consumer?: ConsumerContext,
  ): SessionInfo[] {
    const criteria = filter ?? {};
    const liveSessionIds = new Set(
      options.machine.list().map((session) => session.sessionId),
    );
    const storeUnavailable =
      eventWriteFailure !== undefined ||
      options.controlStore.health().status !== "available";
    return options.controlStore.listSessions().flatMap((stored) => {
      const { info } = stored;
      if (
        criteria.sessionId === undefined &&
        stored.generation !== options.diagnostics.generation
      )
        return [];
      if (
        criteria.sessionId !== undefined &&
        info.sessionId !== criteria.sessionId
      )
        return [];
      if (
        consumer !== undefined &&
        !options.consumerScope.inScope(consumer, info.sessionId)
      )
        return [];

      let session = info;
      if (info.state !== "killed" && info.state !== "unreachable") {
        const unreachableReason = storeUnavailable
          ? "commit_unavailable"
          : stored.generation !== options.diagnostics.generation
            ? "previous_generation"
            : liveSessionIds.has(info.sessionId)
              ? undefined
              : "control_lost";
        if (unreachableReason !== undefined)
          session = unreachableSessionInfo(info, unreachableReason);
      }
      if (
        criteria.harness !== undefined &&
        session.harness !== criteria.harness
      )
        return [];
      if (criteria.state !== undefined) {
        const stateMatches =
          session.state === criteria.state ||
          (session.state === "unreachable" &&
            session.lastKnownState === criteria.state);
        if (!stateMatches) return [];
      }
      if (
        criteria.sessionLabel !== undefined &&
        session.sessionLabel !== criteria.sessionLabel
      )
        return [];
      if (criteria.model !== undefined && session.model !== criteria.model)
        return [];
      return [session];
    });
  }

  function recordEventWriteFailure(event: DomainEvent, error: unknown): void {
    const firstUnavailableEvent = eventWriteFailure === undefined;
    eventWriteFailure ??= error;
    if (firstUnavailableEvent) notifyControlUnavailable();
    wakeWaiters();
    if (!eventWriteFailures.has(event.sessionId)) {
      eventWriteFailures.set(event.sessionId, event);
      if (
        event.type === "session.killed" ||
        (event.type === "turn.completed" && event.stopReason === "killed")
      ) {
        const operationKeys = activeKillOperationKeys.get(event.sessionId);
        if (operationKeys?.size === 1)
          eventOperationFailures.set(event.sessionId, {
            operationKey: operationKeys.values().next().value!,
            event,
          });
      }
    }
    stopSessionAfterEventWriteFailure(event.sessionId);
  }

  function beginAutonomousTurn(input: {
    readonly sessionId: SessionId;
    readonly harness: HarnessId;
    readonly cause?: AutonomousTurnCause;
  }): TurnId {
    return options.machine.beginAutonomousTurn(input, (event, session) => {
      try {
        if (eventWriteFailure !== undefined) throw eventWriteFailure;
        const entry = options.controlStore.recordEvent(event, session);
        queueCommittedEvents(event.sessionId, [entry]);
      } catch (error) {
        recordEventWriteFailure(event, error);
        throw error;
      }
    });
  }

  function acceptEvent(event: DomainEvent): Promise<void> {
    try {
      if (eventWriteFailure !== undefined) throw eventWriteFailure;
      const queue = committedEvents.get(event.sessionId);
      const committed = queue?.[0];
      let entry: StoredCommittedEvent;
      if (committed !== undefined) {
        if (canonical(committed.event) !== canonical(event))
          throw new Error("Committed spawn event order changed before publish");
        queue!.shift();
        if (queue!.length === 0) committedEvents.delete(event.sessionId);
        entry = committed;
      } else {
        const session = options.machine.list({ sessionId: event.sessionId })[0];
        if (session === undefined)
          throw new Error("A published event has no applied session state");
        entry = options.controlStore.recordEvent(event, session);
      }
      for (const listener of Array.from(eventListeners)) listener(entry);
      wakeWaiters(entry);
      return Promise.resolve();
    } catch (error) {
      recordEventWriteFailure(event, error);
      return Promise.reject(error);
    }
  }

  function wakeWaiters(entry?: CommittedEvent): void {
    for (const listener of Array.from(waitListeners)) {
      try {
        listener(entry);
      } catch {
        // 每个等待者负责把读取失败转为自己的拒绝，不阻断事件提交链。
      }
    }
  }

  function wakeWaitersIfStoreUnavailable(): void {
    try {
      if (
        eventWriteFailure !== undefined ||
        options.controlStore.health().status !== "available"
      ) {
        wakeWaiters();
        notifyControlUnavailable();
      }
    } catch {
      wakeWaiters();
      notifyControlUnavailable();
    }
  }

  function notifyControlUnavailable(): void {
    for (const listener of Array.from(controlUnavailableListeners)) {
      try {
        listener();
      } catch {
        // 可用性变化不能中断事件失败的正式收束路径。
      }
    }
  }

  async function settleEvents(operation?: {
    readonly operationKey: OperationKey<"kill">;
    readonly sessionId: SessionId;
  }): Promise<void> {
    await Promise.all(eventFailureStops.values());
    if (eventWriteFailure !== undefined) {
      const operationFailure =
        operation === undefined
          ? undefined
          : eventOperationFailures.get(operation.sessionId);
      if (
        operationFailure !== undefined &&
        operationFailure.operationKey === operation?.operationKey
      ) {
        eventOperationFailures.delete(operation.sessionId);
        const cleanupFailure = Array.from(
          eventFailureCleanupFailures.entries(),
        )[0];
        throw eventStoreUnavailable(
          operationFailure.event,
          eventWriteFailure,
          cleanupFailure === undefined
            ? undefined
            : {
                sessionId: cleanupFailure[0],
                error: cleanupFailure[1],
              },
          operation.operationKey,
        );
      }
      const affectedSessionId =
        Array.from(eventFailureCleanupFailures.keys())[0] ??
        eventWriteFailures.keys().next().value;
      const event =
        affectedSessionId === undefined
          ? undefined
          : eventWriteFailures.get(affectedSessionId);
      if (event !== undefined)
        throw eventStoreUnavailable(
          event,
          eventWriteFailure,
          affectedSessionId === undefined ||
            !eventFailureCleanupFailures.has(affectedSessionId)
            ? undefined
            : {
                sessionId: affectedSessionId,
                error: eventFailureCleanupFailures.get(affectedSessionId),
              },
        );
      throw eventWriteFailure;
    }
  }

  function unreachableSessionInfo(
    info: Exclude<SessionInfo, { state: "killed" | "unreachable" }>,
    unreachableReason:
      | "previous_generation"
      | "control_lost"
      | "commit_unavailable",
  ): SessionInfo {
    if (info.state === "busy") {
      const { activeTurnId, ...fields } = info;
      return {
        ...fields,
        state: "unreachable",
        lastKnownState: "busy",
        lastKnownActiveTurn: activeTurnId,
        unreachableReason,
      };
    }
    return {
      ...info,
      state: "unreachable",
      lastKnownState: "idle",
      unreachableReason,
    };
  }

  function readWaitFacts(params: WaitParams): Omit<WaitResult, "status"> {
    const completed: WaitResult["completed"] = [];
    const pending: WaitResult["pending"] = [];
    const unreachable: NonNullable<WaitResult["unreachable"]> = [];
    const sessions = new Map<SessionId, StoredSession>();
    const events = new Map<string, readonly StoredCommittedEvent[]>();
    const machineSessions = new Set(
      options.machine.list().map((session) => session.sessionId),
    );
    const commitUnavailable =
      eventWriteFailure !== undefined ||
      options.controlStore.health().status !== "available";

    for (const target of params.targets) {
      let stored = sessions.get(target.sessionId);
      if (stored === undefined) {
        stored = options.controlStore.getSession(target.sessionId);
        if (stored === undefined)
          throw {
            code: "session_not_found",
            sessionId: target.sessionId,
          } satisfies MachineError;
        sessions.set(target.sessionId, stored);
      }
      const historyKey = `${target.sessionId}:${target.turnId}`;
      let history = events.get(historyKey);
      if (history === undefined) {
        const pageInput = {
          sessionId: target.sessionId,
          afterEventId: 0,
          limit: ATTACH_HISTORY_PAGE_SIZE,
          turnId: target.turnId,
        } as const;
        const firstPage = options.controlStore.sessionEventsPage(pageInput);
        const entries = [...firstPage.entries];
        let page = firstPage;
        while (page.hasMore) {
          page = options.controlStore.sessionEventsPage({
            ...pageInput,
            afterEventId: page.nextAfter,
            throughEventId: firstPage.throughEventId,
          });
          entries.push(...page.entries);
        }
        history = entries;
        events.set(historyKey, history);
      }
      const targetEvents = history;
      const terminal = targetEvents.find(
        ({ event }) => event.type === "turn.completed",
      )?.event;
      const knownActiveTurn =
        stored.info.state === "busy" &&
        stored.info.activeTurnId === target.turnId;
      const knownStarted = targetEvents.some(
        ({ event }) => event.type === "turn.started",
      );
      if (terminal?.type === "turn.completed") {
        const { type: _type, ...turn } = terminal;
        completed.push(turn);
        continue;
      }
      if (!knownStarted && !knownActiveTurn)
        throw {
          code: "invalid_params",
          issues: [{ issue: "invalid_value", path: "targets.turnId" }],
        } satisfies MachineError;

      let reason:
        | "previous_generation"
        | "control_lost"
        | "commit_unavailable"
        | undefined;
      if (commitUnavailable) reason = "commit_unavailable";
      else if (stored.generation !== options.diagnostics.generation)
        reason = "previous_generation";
      else if (
        stored.info.state === "killed" ||
        stored.info.state === "unreachable" ||
        !machineSessions.has(target.sessionId)
      )
        reason = "control_lost";

      if (reason === undefined) pending.push(target);
      else unreachable.push({ ...target, reason });
    }
    return {
      completed,
      pending,
      ...(unreachable.length === 0 ? {} : { unreachable }),
    };
  }

  function settledWaitResult(
    params: WaitParams,
    facts: Omit<WaitResult, "status">,
  ): WaitResult | undefined {
    if (params.completion === "any") {
      if (facts.completed.length > 0) return { status: "satisfied", ...facts };
      if (
        facts.pending.length === 0 &&
        facts.unreachable !== undefined &&
        facts.unreachable.length > 0
      )
        return {
          status: "unreachable",
          ...facts,
          unreachable: facts.unreachable,
        };
      return undefined;
    }
    if (facts.unreachable !== undefined && facts.unreachable.length > 0)
      return {
        status: "unreachable",
        ...facts,
        unreachable: facts.unreachable,
      };
    if (facts.pending.length === 0) return { status: "satisfied", ...facts };
    return undefined;
  }

  function waitForCommittedTargets(params: WaitParams): Promise<WaitResult> {
    const initialFacts = readWaitFacts(params);
    const initialResult = settledWaitResult(params, initialFacts);
    if (initialResult !== undefined) return Promise.resolve(initialResult);
    if (params.timeoutMs === 0)
      return Promise.resolve({ status: "timeout", ...initialFacts });

    return new Promise<WaitResult>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        waitListeners.delete(observe);
        if (timer !== undefined) clearTimeout(timer);
        action();
      };
      const observe = (entry?: CommittedEvent): void => {
        if (entry !== undefined) {
          const event = entry.event;
          if (
            event.type !== "turn.completed" ||
            !params.targets.some(
              (target) =>
                target.sessionId === event.sessionId &&
                target.turnId === event.turnId,
            )
          )
            return;
        }
        try {
          const facts = readWaitFacts(params);
          const result = settledWaitResult(params, facts);
          if (result !== undefined) finish(() => resolve(result));
        } catch (error) {
          finish(() => reject(error));
        }
      };
      waitListeners.add(observe);
      if (params.timeoutMs !== undefined) {
        const deadline = performance.now() + params.timeoutMs;
        const observeDeadline = (): void => {
          const remaining = deadline - performance.now();
          if (remaining > 0) {
            timer = setTimeout(
              observeDeadline,
              Math.min(remaining, 2_147_483_647),
            );
            return;
          }
          try {
            const facts = readWaitFacts(params);
            const result = settledWaitResult(params, facts);
            finish(() => resolve(result ?? { status: "timeout", ...facts }));
          } catch (error) {
            finish(() => reject(error));
          }
        };
        observeDeadline();
      }
      observe();
    });
  }

  function attachHistoryReadFailure(
    sessionId: SessionId,
    error: unknown,
  ): MachineError {
    const parsed = v.safeParse(machineErrorSchema, error);
    return parsed.success
      ? parsed.output
      : { code: "event_history_unavailable", sessionId };
  }

  function attachInitial(
    params: AttachParams,
    consumer?: ConsumerContext,
  ): AttachSubscriptionStart {
    assertSessionScope(params.sessionId, consumer);
    let storedSession: StoredSession | undefined;
    let sessionInfo: SessionInfo | undefined;
    let head: EventId | null;
    let oldest: EventId | null;
    try {
      storedSession = options.controlStore.getSession(params.sessionId);
      if (storedSession !== undefined)
        sessionInfo = list({ sessionId: params.sessionId }, consumer)[0];
      ({ head, oldest } = options.controlStore.eventWindow(params.sessionId));
    } catch (error) {
      throw attachHistoryReadFailure(params.sessionId, error);
    }
    if (storedSession === undefined)
      throw {
        code: "session_not_found",
        sessionId: params.sessionId,
      } satisfies MachineError;
    if (sessionInfo === undefined)
      throw {
        code: "session_not_found",
        sessionId: params.sessionId,
      } satisfies MachineError;
    const target: SubscriptionTarget =
      params.scope === "turn"
        ? {
            scope: "turn",
            sessionId: params.sessionId,
            turnId: params.turnId,
          }
        : { scope: "session", sessionId: params.sessionId };
    const window = {
      truncated: head !== null && (oldest === null || oldest > 1),
      oldest,
      head,
    };
    let after = 0;
    if (params.start.mode === "after") {
      const cursor = decodeResumeCursor(params.start.cursor);
      if (
        cursor.runtimeScopeId !== options.runtimeScopeId ||
        cursor.daemonGeneration !== storedSession.generation ||
        cursor.target.scope !== target.scope ||
        cursor.target.sessionId !== target.sessionId ||
        (target.scope === "turn" &&
          (cursor.target.scope !== "turn" ||
            cursor.target.turnId !== target.turnId)) ||
        cursor.eventId > (head ?? 0)
      )
        throw {
          code: "invalid_params",
          issues: [{ issue: "invalid_value", path: "start.cursor" }],
        } satisfies MachineError;
      if (cursor.eventId < (oldest === null ? (head ?? 0) : oldest - 1))
        throw {
          code: "event_cursor_expired",
          oldest,
          head,
        } satisfies MachineError;
      after = cursor.eventId;
    } else if (params.start.mode === "snapshot") {
      after = head ?? 0;
    } else if (oldest !== null && oldest > 1) {
      throw {
        code: "event_cursor_expired",
        oldest,
        head,
      } satisfies MachineError;
    }
    let firstPage: SessionEventsPage;
    try {
      firstPage = options.controlStore.sessionEventsPage({
        sessionId: params.sessionId,
        afterEventId: after,
        throughEventId: head,
        limit: ATTACH_HISTORY_PAGE_SIZE,
        ...(target.scope === "turn" ? { turnId: target.turnId } : {}),
      });
    } catch (error) {
      throw attachHistoryReadFailure(params.sessionId, error);
    }
    let turnTerminal: StopReason | undefined;
    if (target.scope === "turn") {
      try {
        const facts = readWaitFacts({
          targets: [target],
          completion: "all",
        });
        if (facts.completed[0] !== undefined)
          turnTerminal = facts.completed[0].stopReason;
      } catch (error) {
        throw attachHistoryReadFailure(params.sessionId, error);
      }
    }
    const cursor = encodeResumeCursor({
      target,
      runtimeScopeId: storedSession.runtimeScopeId,
      daemonGeneration: storedSession.generation,
      eventId: after,
    });
    let initial: AttachInitial;
    if (params.start.mode === "snapshot") {
      let baseline: Extract<AttachInitial, { mode: "snapshot" }>["baseline"];
      try {
        baseline = readAttachBaseline(storedSession, sessionInfo, target, head);
      } catch (error) {
        throw attachHistoryReadFailure(params.sessionId, error);
      }
      initial = {
        mode: "snapshot",
        target,
        cursor,
        window,
        baseline,
      };
    } else {
      initial = {
        mode: params.start.mode,
        target,
        cursor,
        window,
        replayed: firstPage.total,
      };
    }
    const liveSession = options.machine.list({
      sessionId: params.sessionId,
    })[0];
    const canFollow =
      storedSession.generation === options.diagnostics.generation &&
      liveSession !== undefined &&
      sessionInfo.state !== "unreachable" &&
      sessionInfo.state !== "killed";
    const endReason: AttachSubscriptionStart["endReason"] =
      sessionInfo.state === "killed"
        ? "session_killed"
        : (turnTerminal ?? (canFollow ? undefined : "control_unavailable"));
    return {
      target,
      firstPage,
      initial,
      startEventId: after,
      follow: endReason === undefined,
      ...(endReason === undefined ? {} : { endReason }),
    };
  }

  function readAttachBaseline(
    storedSession: StoredSession,
    sessionInfo: SessionInfo,
    target: SubscriptionTarget,
    head: EventId | null,
  ): {
    session: SessionInfo;
    activeTurnCause?: AutonomousTurnCause;
    confirmedTerminals: {
      eventId: EventId;
      event: Extract<
        DomainEvent,
        { type: "turn.completed" | "session.killed" }
      >;
    }[];
    pendingPermissions: {
      eventId: EventId;
      event: Extract<DomainEvent, { type: "permission.requested" }>;
    }[];
    backgroundActivities: {
      eventId: EventId;
      event: Extract<DomainEvent, { type: "background.activity" }>;
    }[];
  } {
    const confirmedTerminals: {
      eventId: EventId;
      event: Extract<
        DomainEvent,
        { type: "turn.completed" | "session.killed" }
      >;
    }[] = [];
    const pendingPermissions = new Map<
      string,
      {
        eventId: EventId;
        event: Extract<DomainEvent, { type: "permission.requested" }>;
      }
    >();
    const backgroundActivities = new Map<
      string,
      {
        eventId: EventId;
        event: Extract<DomainEvent, { type: "background.activity" }>;
      }
    >();
    const turnStarts = new Map<
      TurnId,
      {
        eventId: EventId;
        event: Extract<DomainEvent, { type: "turn.started" }>;
      }
    >();
    const input = {
      sessionId: target.sessionId,
      afterEventId: 0,
      throughEventId: head,
      limit: ATTACH_HISTORY_PAGE_SIZE,
    } as const;
    let page = options.controlStore.sessionEventsPage(input);
    let expectedEventId = 1;
    for (;;) {
      for (const entry of page.entries) {
        if (entry.eventId !== expectedEventId)
          throw new Error("Session event history contains a gap");
        expectedEventId += 1;
        const event = entry.event;
        if (event.type === "turn.started")
          turnStarts.set(event.turnId, {
            eventId: entry.eventId,
            event,
          });
        if (
          event.type === "turn.completed" &&
          (target.scope === "session" || event.turnId === target.turnId)
        )
          confirmedTerminals.push({
            eventId: entry.eventId,
            event: event as Extract<
              DomainEvent,
              { type: "turn.completed" | "session.killed" }
            >,
          });
        else if (event.type === "session.killed")
          confirmedTerminals.push({
            eventId: entry.eventId,
            event: event as Extract<
              DomainEvent,
              { type: "turn.completed" | "session.killed" }
            >,
          });

        if (event.type === "permission.requested")
          pendingPermissions.set(event.permissionId, {
            eventId: entry.eventId,
            event: event as Extract<
              DomainEvent,
              { type: "permission.requested" }
            >,
          });
        else if (event.type === "permission.resolved")
          pendingPermissions.delete(event.permissionId);
        else if (
          event.type === "turn.completed" ||
          event.type === "session.killed"
        )
          pendingPermissions.clear();

        if (event.type === "background.activity") {
          const key = JSON.stringify([event.source.kind, event.source.id]);
          if (event.status === "active")
            backgroundActivities.set(key, {
              eventId: entry.eventId,
              event,
            });
          else backgroundActivities.delete(key);
        }
      }
      if (!page.hasMore) break;
      page = options.controlStore.sessionEventsPage({
        ...input,
        afterEventId: page.nextAfter,
      });
    }
    if (expectedEventId !== (head ?? 0) + 1)
      throw new Error("Session event history ended before its committed head");

    const currentGeneration =
      storedSession.generation === options.diagnostics.generation;
    const activeTurnId =
      sessionInfo.state === "busy" ? sessionInfo.activeTurnId : undefined;
    const knownTurnId =
      activeTurnId ??
      (sessionInfo.state === "unreachable" &&
      sessionInfo.lastKnownState === "busy"
        ? sessionInfo.lastKnownActiveTurn
        : undefined);
    const activeTurnCause =
      knownTurnId === undefined
        ? undefined
        : turnStarts.get(knownTurnId)?.event.cause;
    const effectivePermissions =
      currentGeneration && activeTurnId !== undefined
        ? Array.from(pendingPermissions.values()).filter(
            ({ event }) =>
              event.type === "permission.requested" &&
              event.turnId === activeTurnId &&
              (target.scope === "session" || event.turnId === target.turnId),
          )
        : [];
    return {
      session: sessionInfo,
      ...(activeTurnCause === undefined ? {} : { activeTurnCause }),
      confirmedTerminals,
      pendingPermissions: effectivePermissions,
      backgroundActivities: Array.from(backgroundActivities.values()).toSorted(
        (left, right) => left.eventId - right.eventId,
      ),
    };
  }

  function readAttachPage(
    target: SubscriptionTarget,
    afterEventId: number,
    throughEventId?: EventId | null,
  ): SessionEventsPage {
    return options.controlStore.sessionEventsPage({
      sessionId: target.sessionId,
      afterEventId,
      ...(throughEventId === undefined ? {} : { throughEventId }),
      limit: ATTACH_HISTORY_PAGE_SIZE,
      ...(target.scope === "turn" ? { turnId: target.turnId } : {}),
    });
  }

  function asMachineError(error: unknown): MachineError {
    const parsed = v.safeParse(machineErrorSchema, error);
    return parsed.success
      ? parsed.output
      : {
          code: "internal_error",
          cause: makeErrorCause("exception", errorMessage(error)),
        };
  }

  function storeUnavailable(
    operationKey: OperationKey,
    stage: "register" | "dispatch" | "commit" | "failure",
    acceptance: "not_dispatched" | "unknown" | "accepted",
    error: unknown,
    result?: SpawnAck | SendAck | InterruptAck | KillResult,
    cleanupError?: unknown,
    effect?: OperationEffect,
  ): MachineError {
    return {
      code: "control_store_unavailable",
      operationKey,
      stage,
      acceptance,
      cause: makeErrorCause("io", errorMessage(error)),
      ...(result === undefined ? {} : { acceptedResult: result }),
      ...(cleanupError === undefined
        ? {}
        : {
            cleanupCause: makeErrorCause("closed", errorMessage(cleanupError)),
          }),
      ...(effect === undefined ? {} : { effect }),
    };
  }

  function eventStoreUnavailable(
    event: DomainEvent,
    error: unknown,
    cleanupFailure?: { readonly sessionId: SessionId; readonly error: unknown },
    operationKey?: OperationKey<"kill">,
  ): MachineError {
    const eventFields = {
      sessionId: event.sessionId,
      eventType: event.type,
      ...("turnId" in event ? { turnId: event.turnId } : {}),
      cause: makeErrorCause("io", errorMessage(error)),
      ...(cleanupFailure === undefined
        ? {}
        : {
            cleanupCause: makeErrorCause(
              "closed",
              errorMessage(cleanupFailure.error),
            ),
            ...(cleanupFailure.sessionId === event.sessionId
              ? {}
              : { cleanupSessionId: cleanupFailure.sessionId }),
          }),
    };
    if (operationKey !== undefined)
      return {
        code: "control_store_unavailable",
        stage: "event_commit",
        operationKey,
        acceptance: "accepted",
        ...eventFields,
      };
    return {
      code: "control_store_unavailable",
      stage: "event",
      ...eventFields,
    };
  }

  function failureCause(failure: MachineError) {
    if ("cause" in failure && failure.cause !== undefined) return failure.cause;
    return makeErrorCause("exception", JSON.stringify(failure));
  }

  function withCleanupCause(
    failure: MachineError,
    cleanupError: unknown,
    kind: "closed" | "io" = "closed",
  ): MachineError {
    if (cleanupError === undefined) return failure;
    const cleanupCause = makeErrorCause(kind, errorMessage(cleanupError));
    if (failure.code === "internal_error") return { ...failure, cleanupCause };
    return {
      code: "internal_error",
      cause: makeErrorCause("exception", JSON.stringify(failure)),
      cleanupCause,
    };
  }

  async function performSafely(
    perform: () => Promise<{ result: unknown } | { error: MachineError }>,
  ): Promise<{ result: unknown } | { error: MachineError }> {
    try {
      return await perform();
    } catch (error) {
      return { error: asMachineError(error) };
    }
  }

  function sessionIdFromParams(params: unknown): SessionId | undefined {
    if (typeof params !== "object" || params === null) return undefined;
    const sessionId = (params as { readonly sessionId?: unknown }).sessionId;
    return typeof sessionId === "string" ? (sessionId as SessionId) : undefined;
  }

  async function performWithKillOperationContext(
    method: ProtocolMethod,
    params: unknown,
    operationKey: OperationKey,
    perform: () => Promise<{ result: unknown } | { error: MachineError }>,
  ): Promise<{ result: unknown } | { error: MachineError }> {
    if (method !== "kill") return performSafely(perform);
    const sessionId = sessionIdFromParams(params);
    if (sessionId === undefined) return performSafely(perform);
    const operationKeys = activeKillOperationKeys.get(sessionId) ?? new Set();
    operationKeys.add(operationKey as OperationKey<"kill">);
    activeKillOperationKeys.set(sessionId, operationKeys);
    try {
      return await performSafely(perform);
    } finally {
      operationKeys.delete(operationKey as OperationKey<"kill">);
      if (operationKeys.size === 0) activeKillOperationKeys.delete(sessionId);
    }
  }

  async function execute(
    request: {
      readonly method: ProtocolMethod;
      readonly params: unknown;
      readonly operationKey?: OperationKey;
    },
    consumer: ConsumerContext | undefined,
    perform: () => Promise<{ result: unknown } | { error: MachineError }>,
  ): Promise<{ result: unknown } | { error: MachineError }> {
    if (
      request.method === "getOperation" ||
      request.method === "list" ||
      request.method === "wait" ||
      request.method === "attach" ||
      request.method === "modelCatalog" ||
      request.method === "diagnostics"
    )
      return performSafely(perform);

    if (!isSideEffectMethod(request.method)) {
      try {
        await settleEvents();
        const outcome = await performSafely(perform);
        await settleEvents();
        return outcome;
      } catch (error) {
        return { error: asMachineError(error) };
      }
    }

    const operationKey = request.operationKey;
    if (operationKey === undefined)
      return { error: { code: "protocol_error" } };
    try {
      operationClaims(operationKey, request.method, consumer);
    } catch (error) {
      return { error: asMachineError(error) };
    }
    const killSessionId =
      request.method === "kill"
        ? sessionIdFromParams(request.params)
        : undefined;
    const operationEventContext =
      killSessionId === undefined
        ? undefined
        : {
            operationKey: operationKey as OperationKey<"kill">,
            sessionId: killSessionId,
          };

    const fingerprint = canonical({
      method: request.method,
      params: request.params,
    });
    const existing = transientOperations.get(operationKey);
    if (existing !== undefined)
      return existing.consumer === consumer &&
        existing.fingerprint === fingerprint
        ? existing.outcome
        : { error: { code: "operation_key_conflict" } };

    if (request.method === "spawn") {
      const parsed = v.safeParse(spawnParamsSchema, request.params);
      if (!parsed.success) return performSafely(perform);
      let registration: ReturnType<ControlStore["registerSpawn"]>;
      try {
        registration = options.controlStore.registerSpawn({
          operationKey,
          runtimeScopeId: options.runtimeScopeId,
          consumer: consumer!,
          generation: options.diagnostics.generation,
          request: parsed.output,
        });
      } catch (error) {
        wakeWaitersIfStoreUnavailable();
        const known = asMachineError(error);
        return known.code === "operation_key_conflict"
          ? { error: known }
          : {
              error: storeUnavailable(
                operationKey,
                "register",
                "not_dispatched",
                error,
              ),
            };
      }

      if (!registration.created) {
        switch (registration.operation.status) {
          case "succeeded":
            return { result: registration.operation.result };
          case "failed":
            return { error: registration.operation.error };
          case "pending":
            return { error: { code: "operation_pending", operationKey } };
          case "dispatched": {
            const known = spawnResults.get(operationKey);
            if (
              known?.status === "accepted_uncommitted" ||
              known?.status === "accepted_unconfirmed"
            )
              return {
                error: storeUnavailable(
                  operationKey,
                  "commit",
                  "accepted",
                  known.error,
                  known.result,
                  known.cleanupError,
                ),
              };
            return {
              error: {
                code: "operation_outcome_unknown",
                operationKey,
              },
            };
          }
          case "outcome_unknown":
            return { error: registration.operation.error };
        }
      }

      const outcome: Promise<{ result: unknown } | { error: MachineError }> =
        (async () => {
          if (eventWriteFailure !== undefined) {
            const failure = storeUnavailable(
              operationKey,
              "dispatch",
              "not_dispatched",
              eventWriteFailure,
            );
            try {
              options.controlStore.failSpawn(operationKey, failure);
            } catch {
              wakeWaitersIfStoreUnavailable();
              // 保留原始存储故障，不能因补记失败改称动作已派发。
            }
            return { error: failure };
          }

          const result = await performSafely(perform);
          if ("result" in result) return result;

          const known = spawnResults.get(operationKey);
          if (known?.status === "accepted_uncommitted") return result;
          if (known?.status === "outcome_unknown") return result;

          if (result.error.code === "control_store_unavailable") return result;
          let storedOperation: ControlOperation | undefined;
          try {
            storedOperation = options.controlStore.getOperation(operationKey);
          } catch (error) {
            return {
              error: storeUnavailable(
                operationKey,
                "failure",
                "unknown",
                error,
              ),
            };
          }
          if (storedOperation?.status === "failed") return result;
          if (storedOperation?.status === "dispatched")
            return {
              error: {
                code: "operation_outcome_unknown",
                operationKey,
              } satisfies MachineError,
            };
          try {
            options.controlStore.failSpawn(operationKey, result.error);
          } catch (error) {
            wakeWaitersIfStoreUnavailable();
            return {
              error: storeUnavailable(
                operationKey,
                "failure",
                "not_dispatched",
                error,
              ),
            };
          }
          return result;
        })();
      const pending = {
        method: request.method,
        consumer,
        fingerprint,
        outcome,
      };
      transientOperations.set(operationKey, pending);
      try {
        return await outcome;
      } finally {
        // 创建事实已由 ControlStore 持久化；其他动作仍沿用既有的
        // 进程内幂等结果缓存，避免同一 OperationKey 再次执行副作用。
        if (
          request.method === "spawn" &&
          transientOperations.get(operationKey) === pending
        )
          transientOperations.delete(operationKey);
      }
    }

    if (
      request.method === "send" &&
      v.safeParse(sendParamsSchema, request.params).success
    ) {
      const parsed = v.parse(sendParamsSchema, request.params);
      let registration: ReturnType<ControlStore["registerSend"]>;
      try {
        registration = options.controlStore.registerSend({
          operationKey,
          runtimeScopeId: options.runtimeScopeId,
          consumer: consumer!,
          generation: options.diagnostics.generation,
          request: parsed,
        });
      } catch (error) {
        wakeWaitersIfStoreUnavailable();
        const known = asMachineError(error);
        return known.code === "operation_key_conflict"
          ? { error: known }
          : {
              error: storeUnavailable(
                operationKey,
                "register",
                "not_dispatched",
                error,
              ),
            };
      }

      if (!registration.created) {
        const known = sendResults.get(operationKey);
        if (
          known?.status === "failed" ||
          known?.status === "not_accepted_uncommitted" ||
          known?.status === "not_accepted_unconfirmed"
        )
          return { error: known.error };
        switch (registration.operation.status) {
          case "succeeded":
            return { result: registration.operation.result };
          case "failed":
            return { error: registration.operation.error };
          case "pending":
            return { error: { code: "operation_pending", operationKey } };
          case "dispatched": {
            const known = sendResults.get(operationKey);
            if (
              known?.status === "accepted_uncommitted" ||
              known?.status === "accepted_unconfirmed"
            )
              return {
                error: storeUnavailable(
                  operationKey,
                  "commit",
                  "accepted",
                  known.error,
                  known.result,
                  known.cleanupError,
                ),
              };
            if (known?.status === "outcome_unknown")
              return { error: known.error };
            if (
              known?.status === "partial_effect_uncommitted" ||
              known?.status === "partial_effect_unconfirmed"
            )
              return {
                error: storeUnavailable(
                  operationKey,
                  "failure",
                  "not_dispatched",
                  known.failureWriteError,
                  undefined,
                  undefined,
                  known.error.code === "internal_error"
                    ? known.error.effect
                    : undefined,
                ),
              };
            return {
              error: {
                code: "operation_outcome_unknown",
                operationKey,
              },
            };
          }
          case "outcome_unknown":
            return { error: registration.operation.error };
        }
      }

      const outcome: Promise<{ result: unknown } | { error: MachineError }> =
        (async () => {
          if (eventWriteFailure !== undefined) {
            const failure = storeUnavailable(
              operationKey,
              "dispatch",
              "not_dispatched",
              eventWriteFailure,
            );
            sendResults.set(operationKey, {
              status: "failed",
              error: failure,
            });
            try {
              options.controlStore.failSend(operationKey, failure);
            } catch (failureWriteError) {
              wakeWaitersIfStoreUnavailable();
              rememberUncommittedSendFailure(
                operationKey,
                failure,
                failureWriteError,
              );
            }
            return { error: failure };
          }

          const result = await performSafely(perform);
          if ("result" in result) return result;
          const known = sendResults.get(operationKey);
          if (
            known?.status === "failed" ||
            known?.status === "not_accepted_uncommitted" ||
            known?.status === "not_accepted_unconfirmed" ||
            known?.status === "partial_effect_uncommitted" ||
            known?.status === "partial_effect_unconfirmed" ||
            known?.status === "accepted_uncommitted" ||
            known?.status === "accepted_unconfirmed" ||
            known?.status === "outcome_unknown"
          )
            return result;
          if (result.error.code === "control_store_unavailable") return result;

          let storedOperation: ControlOperation | undefined;
          try {
            storedOperation = options.controlStore.getOperation(operationKey);
          } catch (error) {
            return {
              error: storeUnavailable(
                operationKey,
                "failure",
                "unknown",
                error,
              ),
            };
          }
          if (storedOperation?.status === "failed") return result;
          if (storedOperation?.status === "outcome_unknown")
            return { error: storedOperation.error };
          if (storedOperation?.status === "dispatched")
            return {
              error: {
                code: "operation_outcome_unknown",
                operationKey,
              } satisfies MachineError,
            };
          try {
            options.controlStore.failSend(operationKey, result.error);
          } catch (error) {
            wakeWaitersIfStoreUnavailable();
            rememberUncommittedSendFailure(operationKey, result.error, error);
            return {
              error: storeUnavailable(
                operationKey,
                "failure",
                "not_dispatched",
                error,
              ),
            };
          }
          return result;
        })();
      const pending = {
        method: request.method,
        consumer,
        fingerprint,
        outcome,
      };
      transientOperations.set(operationKey, pending);
      try {
        return await outcome;
      } finally {
        if (transientOperations.get(operationKey) === pending)
          transientOperations.delete(operationKey);
      }
    }

    if (request.method === "kill") {
      const parsed = v.safeParse(killParamsSchema, request.params);
      if (!parsed.success) return performSafely(perform);
      const key = operationKey as OperationKey<"kill">;
      const cached = killResults.get(key);
      if (cached !== undefined && cached.fingerprint !== fingerprint)
        return { error: { code: "operation_key_conflict" } };

      const cachedOutcome = (
        known: NonNullable<typeof cached>,
      ): { error: MachineError } => {
        switch (known.status) {
          case "failed":
          case "outcome_unknown":
            return { error: known.error };
          case "not_accepted_uncommitted":
          case "not_accepted_unconfirmed":
            return {
              error: storeUnavailable(
                key,
                "failure",
                "not_dispatched",
                new Error(
                  `${failureCause(known.error).message}; failure record failed: ${errorMessage(known.failureWriteError)}`,
                ),
              ),
            };
          case "accepted_uncommitted":
          case "accepted_unconfirmed":
            return {
              error: storeUnavailable(
                key,
                "commit",
                "accepted",
                known.error,
                known.result,
              ),
            };
          case "partial_effect_uncommitted":
          case "partial_effect_unconfirmed":
            return {
              error: {
                ...known.error,
                ...(known.error.cleanupCause === undefined
                  ? {
                      cleanupCause: makeErrorCause("io", known.cause.message),
                    }
                  : {}),
              },
            };
        }
      };
      if (
        cached?.status === "failed" ||
        cached?.status === "outcome_unknown" ||
        cached?.status === "not_accepted_uncommitted" ||
        cached?.status === "not_accepted_unconfirmed" ||
        cached?.status === "partial_effect_uncommitted" ||
        cached?.status === "partial_effect_unconfirmed"
      )
        return cachedOutcome(cached);

      let registration: ReturnType<ControlStore["registerKill"]> | undefined;
      try {
        registration = options.controlStore.registerKill({
          operationKey: key,
          runtimeScopeId: options.runtimeScopeId,
          consumer: consumer!,
          generation: options.diagnostics.generation,
          request: parsed.output,
        });
      } catch (error) {
        wakeWaitersIfStoreUnavailable();
        const known = asMachineError(error);
        if (
          known.code === "operation_key_conflict" ||
          known.code === "operation_key_scope_mismatch" ||
          known.code === "stale_operation_key"
        )
          return { error: known };

        let stored: ControlOperation | undefined;
        try {
          stored = options.controlStore.getOperation(key);
        } catch (verificationError) {
          const cachedAfterFailure = killResults.get(key);
          if (cachedAfterFailure !== undefined)
            return cachedOutcome(cachedAfterFailure);
          return {
            error: storeUnavailable(
              key,
              "register",
              "unknown",
              new Error(
                `${errorMessage(error)}; operation lookup failed: ${errorMessage(verificationError)}`,
              ),
            ),
          };
        }
        if (stored === undefined) {
          const cachedAfterFailure = killResults.get(key);
          if (cachedAfterFailure !== undefined)
            return cachedOutcome(cachedAfterFailure);
        } else {
          if (stored.kind !== "kill")
            return { error: { code: "operation_key_conflict" } };
          if (
            stored.runtimeScopeId !== options.runtimeScopeId ||
            stored.consumer !== consumer ||
            stored.generation !== options.diagnostics.generation
          )
            return { error: { code: "operation_key_scope_mismatch" } };
          if (canonical(stored.request) !== canonical(parsed.output))
            return { error: { code: "operation_key_conflict" } };
          registration = { created: false, operation: stored };
        }
      }

      if (registration !== undefined && !registration.created) {
        switch (registration.operation.status) {
          case "succeeded":
            return { result: registration.operation.result };
          case "failed":
            return { error: registration.operation.error };
          case "outcome_unknown":
            return { error: registration.operation.error };
          case "pending":
            break;
          case "dispatched": {
            const known = killResults.get(key);
            if (
              known?.status === "accepted_uncommitted" ||
              known?.status === "accepted_unconfirmed"
            )
              break;
            if (
              known?.status === "failed" ||
              known?.status === "not_accepted_uncommitted" ||
              known?.status === "not_accepted_unconfirmed" ||
              known?.status === "outcome_unknown"
            )
              return { error: known.error };
            return {
              error: { code: "operation_outcome_unknown", operationKey: key },
            };
          }
        }
      }

      if (
        registration === undefined ||
        registration.created ||
        registration.operation.status === "pending"
      ) {
        try {
          options.controlStore.markKillDispatched(key);
        } catch {
          wakeWaitersIfStoreUnavailable();
        }
      }

      const outcome: Promise<{ result: unknown } | { error: MachineError }> =
        (async () => {
          const result = await performWithKillOperationContext(
            "kill",
            parsed.output,
            key,
            perform,
          );
          if ("result" in result) {
            killResults.delete(key);
            try {
              await settleEvents(operationEventContext);
            } catch (error) {
              const eventFailure = asMachineError(error);
              if (
                eventFailure.code === "control_store_unavailable" &&
                (eventFailure.stage === "event" ||
                  eventFailure.stage === "event_commit")
              )
                return { error: eventFailure };
              return {
                error: storeUnavailable(
                  key,
                  "commit",
                  "accepted",
                  eventWriteFailure ?? error,
                  result.result as KillResult,
                  killSessionId === undefined
                    ? undefined
                    : eventFailureCleanupFailures.get(killSessionId),
                ),
              };
            }
            return result;
          }

          let eventFailureResponse:
            | { readonly error: MachineError }
            | undefined;
          try {
            await settleEvents(operationEventContext);
          } catch (error) {
            const eventFailure = asMachineError(error);
            if (
              eventFailure.code === "control_store_unavailable" &&
              (eventFailure.stage === "event" ||
                eventFailure.stage === "event_commit")
            ) {
              if (
                eventFailure.stage === "event" &&
                killSessionId !== undefined &&
                eventFailure.sessionId !== killSessionId
              ) {
                const failedEvent = eventWriteFailures.get(
                  eventFailure.sessionId,
                );
                if (failedEvent !== undefined)
                  eventFailureResponse = {
                    error: eventStoreUnavailable(
                      failedEvent,
                      eventWriteFailure ?? eventFailure.cause,
                      { sessionId: killSessionId, error: result.error },
                    ),
                  };
              }
              eventFailureResponse ??= { error: eventFailure };
            } else {
              eventFailureResponse = {
                error: storeUnavailable(
                  key,
                  "commit",
                  "accepted",
                  eventWriteFailure ?? error,
                  undefined,
                  killSessionId === undefined
                    ? undefined
                    : eventFailureCleanupFailures.get(killSessionId),
                ),
              };
            }
          }

          const known = killResults.get(key);
          if (
            known?.status === "accepted_uncommitted" ||
            known?.status === "accepted_unconfirmed" ||
            known?.status === "failed" ||
            known?.status === "not_accepted_uncommitted" ||
            known?.status === "not_accepted_unconfirmed" ||
            known?.status === "partial_effect_uncommitted" ||
            known?.status === "partial_effect_unconfirmed" ||
            known?.status === "outcome_unknown"
          )
            return eventFailureResponse ?? result;
          if (result.error.code === "control_store_unavailable")
            return eventFailureResponse ?? result;

          const failure = result.error;
          if (
            failure.code === "internal_error" &&
            failure.effect?.kind === "session_closed"
          ) {
            const effectFailure = failure as KillEffectError;
            try {
              options.controlStore.failKill(key, effectFailure);
              rememberKillResult(key, {
                status: "failed",
                error: effectFailure,
              });
              return eventFailureResponse ?? { error: effectFailure };
            } catch (storeError) {
              wakeWaitersIfStoreUnavailable();
              let stored: ControlOperation | undefined;
              let verificationError: unknown;
              try {
                stored = options.controlStore.getOperation(key);
              } catch (error) {
                verificationError = error;
              }
              if (
                stored?.status === "failed" &&
                canonical(stored.error) === canonical(effectFailure)
              ) {
                rememberKillResult(key, {
                  status: "failed",
                  error: stored.error,
                });
                return eventFailureResponse ?? { error: stored.error };
              }
              if (stored?.status === "outcome_unknown")
                return eventFailureResponse ?? { error: stored.error };
              const stateIsUncommitted =
                verificationError === undefined &&
                (stored === undefined ||
                  stored.status === "pending" ||
                  stored.status === "dispatched");
              const status = stateIsUncommitted
                ? "partial_effect_uncommitted"
                : "partial_effect_unconfirmed";
              rememberKillResult(key, {
                status,
                error: effectFailure,
                cause: makeErrorCause("io", errorMessage(storeError)),
              });
              return (
                eventFailureResponse ?? {
                  error: {
                    ...effectFailure,
                    ...(effectFailure.cleanupCause === undefined
                      ? {
                          cleanupCause: makeErrorCause(
                            "io",
                            errorMessage(storeError),
                          ),
                        }
                      : {}),
                  },
                }
              );
            }
          }

          const outcomeUnknown =
            failure.code === "internal_error" &&
            (failure.cause?.kind === "timeout" ||
              failure.cause?.kind === "closed");
          if (outcomeUnknown) {
            const unknown: MachineError = {
              code: "operation_outcome_unknown",
              operationKey: key,
              cause: failureCause(failure),
              ...(failure.code === "internal_error" &&
              failure.cleanupCause !== undefined
                ? { cleanupCause: failure.cleanupCause }
                : {}),
              ...(failure.code === "internal_error" &&
              failure.diagnosticId !== undefined
                ? { diagnosticId: failure.diagnosticId }
                : {}),
            };
            rememberKillResult(key, {
              status: "outcome_unknown",
              error: unknown,
            });
            try {
              options.controlStore.recordKillOutcomeUnknown(
                key,
                unknown as Extract<
                  MachineError,
                  { code: "operation_outcome_unknown" }
                >,
              );
            } catch (storeError) {
              wakeWaitersIfStoreUnavailable();
              try {
                const stored = options.controlStore.getOperation(key);
                if (
                  stored?.status === "outcome_unknown" &&
                  canonical(stored.error) === canonical(unknown)
                )
                  return eventFailureResponse ?? { error: stored.error };
              } catch {
                // 未能核实持久状态时，仍保留关闭结果未知这一事实。
              }
              if (registration === undefined)
                rememberKillResult(key, {
                  status: "outcome_unknown",
                  error: unknown,
                });
              void storeError;
            }
            return eventFailureResponse ?? { error: unknown };
          }

          try {
            options.controlStore.failKill(key, failure);
            rememberKillResult(key, { status: "failed", error: failure });
            return eventFailureResponse ?? { error: failure };
          } catch (storeError) {
            wakeWaitersIfStoreUnavailable();
            let stored: ControlOperation | undefined;
            let verificationError: unknown;
            try {
              stored = options.controlStore.getOperation(key);
            } catch (error) {
              verificationError = error;
            }
            if (
              stored?.status === "failed" &&
              canonical(stored.error) === canonical(failure)
            ) {
              rememberKillResult(key, {
                status: "failed",
                error: stored.error,
              });
              return eventFailureResponse ?? { error: stored.error };
            }
            if (stored?.status === "outcome_unknown")
              return eventFailureResponse ?? { error: stored.error };
            const stateIsUncommitted =
              verificationError === undefined &&
              (stored === undefined ||
                stored.status === "pending" ||
                stored.status === "dispatched");
            const status = stateIsUncommitted
              ? "not_accepted_uncommitted"
              : "not_accepted_unconfirmed";
            rememberKillResult(key, {
              status,
              error: failure,
              failureWriteError: storeError,
              ...(verificationError === undefined ? {} : { verificationError }),
            });
            return (
              eventFailureResponse ?? {
                error: storeUnavailable(
                  key,
                  "failure",
                  "not_dispatched",
                  new Error(
                    `${failureCause(failure).message}; failure record failed: ${errorMessage(storeError)}`,
                  ),
                ),
              }
            );
          }
        })();
      const pending = {
        method: request.method,
        consumer,
        fingerprint,
        outcome,
      };
      transientOperations.set(key, pending);
      try {
        return await outcome;
      } finally {
        if (transientOperations.get(key) === pending)
          transientOperations.delete(key);
      }
    }

    if (
      request.method === "interrupt" &&
      v.safeParse(interruptParamsSchema, request.params).success
    ) {
      const parsed = v.parse(interruptParamsSchema, request.params);
      const registrationInput = {
        operationKey,
        runtimeScopeId: options.runtimeScopeId,
        consumer: consumer!,
        generation: options.diagnostics.generation,
        request: parsed,
      };
      const requestFingerprint = canonical(registrationInput);
      const previousFingerprint =
        interruptRequestFingerprints.get(operationKey);
      if (
        previousFingerprint !== undefined &&
        previousFingerprint !== requestFingerprint
      )
        return { error: { code: "operation_key_conflict" } };
      const previous = interruptResults.get(operationKey);
      const knownFailure =
        previous?.status === "failed" ||
        previous?.status === "not_accepted_uncommitted" ||
        previous?.status === "not_accepted_unconfirmed" ||
        previous?.status === "outcome_unknown";
      if (previousFingerprint !== undefined && knownFailure)
        return { error: previous.error };
      const knownAcceptedFailure =
        previous?.status === "accepted_uncommitted" ||
        previous?.status === "accepted_unconfirmed";
      if (previousFingerprint !== undefined && knownAcceptedFailure)
        return {
          error: storeUnavailable(
            operationKey,
            "commit",
            "accepted",
            previous.error,
            previous.result,
          ),
        };

      let registration:
        | ReturnType<ControlStore["registerInterrupt"]>
        | undefined;
      try {
        registration =
          options.controlStore.registerInterrupt(registrationInput);
      } catch (error) {
        wakeWaitersIfStoreUnavailable();
        const known = asMachineError(error);
        if (known.code === "operation_key_conflict") return { error: known };
        try {
          const operation = options.controlStore.getOperation(operationKey);
          if (operation !== undefined) {
            if (
              operation.kind !== "interrupt" ||
              operation.runtimeScopeId !== options.runtimeScopeId ||
              operation.consumer !== consumer ||
              operation.generation !== options.diagnostics.generation ||
              canonical(operation.request) !== canonical(parsed)
            )
              return { error: { code: "operation_key_conflict" } };
            registration = { created: false, operation };
          }
        } catch (readError) {
          return {
            error: storeUnavailable(
              operationKey,
              "register",
              "unknown",
              new Error(
                `${errorMessage(error)}; operation state could not be checked: ${errorMessage(readError)}`,
              ),
            ),
          };
        }
      }

      interruptRequestFingerprints.set(operationKey, requestFingerprint);

      if (registration !== undefined && !registration.created) {
        const known = interruptResults.get(operationKey);
        if (
          known?.status === "failed" ||
          known?.status === "not_accepted_uncommitted" ||
          known?.status === "not_accepted_unconfirmed"
        )
          return { error: known.error };
        switch (registration.operation.status) {
          case "succeeded":
            return { result: registration.operation.result };
          case "failed":
            return { error: registration.operation.error };
          case "pending":
            return { error: { code: "operation_pending", operationKey } };
          case "dispatched": {
            if (
              known?.status === "accepted_uncommitted" ||
              known?.status === "accepted_unconfirmed"
            )
              return {
                error: storeUnavailable(
                  operationKey,
                  "commit",
                  "accepted",
                  known.error,
                  known.result,
                ),
              };
            if (known?.status === "outcome_unknown")
              return { error: known.error };
            return {
              error: { code: "operation_outcome_unknown", operationKey },
            };
          }
          case "outcome_unknown":
            return { error: registration.operation.error };
        }
      }

      const outcome: Promise<{ result: unknown } | { error: MachineError }> =
        (async () => {
          const result = await performSafely(perform);
          if ("result" in result) return result;
          const known = interruptResults.get(operationKey);
          if (
            known?.status === "failed" ||
            known?.status === "not_accepted_uncommitted" ||
            known?.status === "not_accepted_unconfirmed" ||
            known?.status === "accepted_uncommitted" ||
            known?.status === "accepted_unconfirmed" ||
            known?.status === "outcome_unknown"
          )
            return result;
          if (result.error.code === "control_store_unavailable") return result;

          let storedOperation: ControlOperation | undefined;
          try {
            storedOperation = options.controlStore.getOperation(operationKey);
          } catch (error) {
            return {
              error: storeUnavailable(
                operationKey,
                "failure",
                "unknown",
                error,
              ),
            };
          }
          if (storedOperation?.status === "succeeded")
            return { result: storedOperation.result };
          if (storedOperation?.status === "failed") return result;
          if (storedOperation?.status === "outcome_unknown")
            return { error: storedOperation.error };
          if (storedOperation?.status === "dispatched")
            return {
              error: {
                code: "operation_outcome_unknown",
                operationKey,
              } satisfies MachineError,
            };
          try {
            if (storedOperation === undefined)
              options.controlStore.registerInterrupt(registrationInput);
            options.controlStore.failInterrupt(operationKey, result.error);
          } catch (error) {
            wakeWaitersIfStoreUnavailable();
            rememberUncommittedInterruptFailure(
              operationKey,
              result.error,
              error,
            );
            return {
              error: storeUnavailable(
                operationKey,
                "failure",
                "not_dispatched",
                error,
              ),
            };
          }
          return result;
        })();
      const pending = {
        method: request.method,
        consumer,
        fingerprint,
        outcome,
      };
      transientOperations.set(operationKey, pending);
      try {
        return await outcome;
      } finally {
        if (transientOperations.get(operationKey) === pending)
          transientOperations.delete(operationKey);
      }
    }

    const requiredStop = request.method === "interrupt";
    const outcome: Promise<{ result: unknown } | { error: MachineError }> =
      (async () => {
        try {
          if (!requiredStop) await settleEvents();
          if (
            !requiredStop &&
            options.controlStore.health().status !== "available"
          )
            return {
              error: storeUnavailable(
                operationKey,
                "dispatch",
                "not_dispatched",
                eventWriteFailure ?? "Control store is unavailable",
              ),
            };
          const result = await performWithKillOperationContext(
            request.method,
            request.params,
            operationKey,
            perform,
          );
          if (requiredStop && "error" in result) {
            try {
              await settleEvents(operationEventContext);
            } catch (error) {
              const eventFailure = asMachineError(error);
              if (
                eventFailure.code === "control_store_unavailable" &&
                (eventFailure.stage === "event" ||
                  eventFailure.stage === "event_commit")
              ) {
                if (
                  eventFailure.stage === "event" &&
                  killSessionId !== undefined &&
                  eventFailure.sessionId !== killSessionId
                ) {
                  const failedEvent = eventWriteFailures.get(
                    eventFailure.sessionId,
                  );
                  if (failedEvent !== undefined)
                    return {
                      error: eventStoreUnavailable(
                        failedEvent,
                        eventWriteFailure ?? eventFailure.cause,
                        { sessionId: killSessionId, error: result.error },
                      ),
                    };
                }
                return { error: eventFailure };
              }
              const cleanupError =
                result.error.code === "internal_error"
                  ? result.error
                  : killSessionId === undefined
                    ? undefined
                    : eventFailureCleanupFailures.get(killSessionId);
              return {
                error: storeUnavailable(
                  operationKey,
                  "commit",
                  "accepted",
                  eventWriteFailure ?? error,
                  undefined,
                  cleanupError,
                ),
              };
            }
            return result;
          }
          if (requiredStop && "result" in result) {
            try {
              await settleEvents(operationEventContext);
              if (options.controlStore.health().status !== "available")
                throw eventWriteFailure ?? "Control store is unavailable";
            } catch (error) {
              const eventFailure = asMachineError(error);
              if (
                eventFailure.code === "control_store_unavailable" &&
                (eventFailure.stage === "event" ||
                  eventFailure.stage === "event_commit")
              )
                return { error: eventFailure };
              return {
                error: storeUnavailable(
                  operationKey,
                  "commit",
                  "accepted",
                  eventWriteFailure ?? error,
                  undefined,
                  killSessionId === undefined
                    ? undefined
                    : eventFailureCleanupFailures.get(killSessionId),
                ),
              };
            }
            return result;
          }
          await settleEvents();
          return result;
        } catch (error) {
          return { error: asMachineError(error) };
        }
      })();
    const pending = { method: request.method, consumer, fingerprint, outcome };
    transientOperations.set(operationKey, pending);
    return await outcome;
  }

  return {
    execute,
    dispatch,
    acceptEvent,
    beginAutonomousTurn,
    settleEvents,
    subscribeEvents(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    subscribeControlUnavailable(listener) {
      controlUnavailableListeners.add(listener);
      return () => controlUnavailableListeners.delete(listener);
    },
    assertSessionScope,
    list,
    attachInitial,
    readAttachPage,
    async waitForAttachTurn(target) {
      const result = await waitForCommittedTargets({
        targets: [target],
        completion: "all",
        timeoutMs: 0,
      });
      return result;
    },
    isSessionKilled(sessionId) {
      return options.machine.list({ sessionId })[0]?.state === "killed";
    },
    liveSessionIds() {
      return Array.from(
        new Set([
          ...options.machine
            .list()
            .filter((session) => session.state !== "killed")
            .map((session) => session.sessionId),
          ...options.machine.pendingSpawnIds(),
        ]),
      );
    },
    async terminateLiveSessions() {
      const liveSessionIds = options.machine
        .list()
        .filter((session) => session.state !== "killed")
        .map((session) => session.sessionId);
      const pendingCleanup = options.machine.terminatePendingSpawns();
      const results = await Promise.allSettled(
        liveSessionIds.map(async (sessionId) => {
          await options.machine.kill({ sessionId });
        }),
      );
      const pendingResult = await Promise.allSettled([pendingCleanup]);
      const failures = results
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result) => result.reason);
      failures.push(
        ...pendingResult
          .filter(
            (result): result is PromiseRejectedResult =>
              result.status === "rejected",
          )
          .map((result) => result.reason),
      );
      await settleEvents();
      if (failures.length > 0)
        throw new AggregateError(failures, "Worker cleanup failed");
    },
    close() {
      unsubscribeMachine();
      eventListeners.clear();
      controlUnavailableListeners.clear();
      wakeWaiters();
      waitListeners.clear();
      options.controlStore.close();
    },
  };
}
