import { stat } from "node:fs/promises";

import { isAlreadyDiagnosedError } from "@reins/adapter-kit";
import {
  SpawnCommitFailure,
  SpawnStartFailure,
  type SessionMachine,
} from "@reins/core";
import type {
  ControlOperation,
  ControlStore,
  StoredCommittedEvent,
  StoredSession,
} from "@reins/event-journal";
import type {
  AttachParams,
  ConsumerContext,
  DaemonDiagnosticFact,
  DiagnosticsParams,
  DomainEvent,
  EventId,
  HarnessId,
  HarnessModelCatalog,
  ModelCatalogResult,
  MachineError,
  OperationKey,
  OperationRecord,
  ProtocolMethod,
  RuntimeScopeId,
  SessionId,
  SessionInfo,
  SpawnAck,
  SpawnParams,
  SubscriptionTarget,
  TurnTarget,
  WaitParams,
  WaitResult,
} from "@reins/protocol";
import {
  decodeResumeCursor,
  eventIdSchema,
  harnessModelCatalogSchema,
  isSideEffectMethod,
  makeErrorCause,
  makeTextEvidence,
  machineErrorSchema,
  operationRecordSchema,
  parseOperationKey,
  spawnParamsSchema,
} from "@reins/protocol";
import * as v from "valibot";

import type { ConsumerScope } from "./consumer-scope.ts";
import type { OrderedDiagnosticsRuntime } from "./diagnostics-acceptance.ts";
import type { AdapterRegistry } from "./registry.ts";

export const DEFAULT_EVENT_LOG_LIMIT = 1000;

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

export type AttachReplay = {
  readonly target: SubscriptionTarget;
  readonly entries: readonly CommittedEvent[];
  readonly head: EventId | null;
  readonly oldest: EventId | null;
  readonly truncated: boolean;
  readonly lastEventId: EventId | null;
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
  settleEvents(): Promise<void>;
  subscribeEvents(listener: (entry: CommittedEvent) => void): () => void;
  assertSessionScope(sessionId: SessionId, consumer?: ConsumerContext): void;
  list(
    filter: Parameters<SessionMachine["list"]>[0],
    consumer?: ConsumerContext,
  ): SessionInfo[];
  attachReplay(params: AttachParams, consumer?: ConsumerContext): AttachReplay;
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
  eventLogLimit?: number;
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
  const eventLogLimit = options.eventLogLimit ?? DEFAULT_EVENT_LOG_LIMIT;
  const eventListeners = new Set<(entry: CommittedEvent) => void>();
  const waitListeners = new Set<(entry?: CommittedEvent) => void>();
  const committedEvents = new Map<SessionId, StoredCommittedEvent[]>();
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
  let eventWriteFailure: unknown;
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
      consumer === undefined ||
      claims.runtimeScopeId !== options.runtimeScopeId ||
      claims.consumer !== consumer
    )
      throw { code: "operation_key_scope_mismatch" } satisfies MachineError;
    const known = spawnResults.get(operationKey);
    const knownUnknownRecord = (): OperationRecord => {
      const error =
        known?.status === "outcome_unknown" &&
        known.error.code === "operation_outcome_unknown"
          ? known.error
          : undefined;
      return v.parse(operationRecordSchema, {
        status: "outcome_unknown",
        operationKey,
        ...(error?.cause === undefined ? {} : { cause: error.cause }),
        ...(error?.cleanupCause === undefined
          ? {}
          : { cleanupCause: error.cleanupCause }),
        ...(error?.diagnosticId === undefined
          ? {}
          : { diagnosticId: error.diagnosticId }),
      });
    };
    if (transientOperations.get(operationKey)?.method === "spawn")
      return v.parse(operationRecordSchema, {
        status: "pending",
        operationKey,
      });
    const knownAcceptedRecord = (
      status: "accepted_uncommitted" | "accepted_unconfirmed",
    ) => {
      if (known === undefined || known.status === "outcome_unknown")
        throw new Error("No accepted spawn result is recorded");
      return v.parse(operationRecordSchema, {
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
        if (known?.status === "accepted_uncommitted")
          return knownAcceptedRecord("accepted_unconfirmed");
        if (known?.status === "outcome_unknown") return knownUnknownRecord();
        return v.parse(operationRecordSchema, {
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
        operation.generation !== claims.generation
      )
        throw { code: "operation_key_scope_mismatch" } satisfies MachineError;
      switch (operation.status) {
        case "pending":
          return v.parse(operationRecordSchema, {
            status: "pending",
            operationKey,
          });
        case "dispatched":
          if (transientOperations.get(operationKey)?.method === "spawn")
            return v.parse(operationRecordSchema, {
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
          return v.parse(operationRecordSchema, {
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
          });
        case "succeeded":
          return v.parse(operationRecordSchema, {
            status: "succeeded",
            operationKey,
            result: operation.result,
          });
        case "failed":
          return v.parse(operationRecordSchema, {
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
      if (known?.status === "outcome_unknown") return knownUnknownRecord();
      return v.parse(operationRecordSchema, {
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
        const params = rawParams as Parameters<SessionMachine["send"]>[0];
        assertSessionScope(params.sessionId, consumer);
        await assertWriterLease();
        return await options.machine.send(params);
      }
      case "wait": {
        const params = rawParams as WaitParams;
        for (const target of params.targets)
          assertSessionScope(target.sessionId, consumer);
        return await waitForCommittedTargets(params);
      }
      case "interrupt": {
        const params = rawParams as Parameters<SessionMachine["interrupt"]>[0];
        assertSessionScope(params.sessionId, consumer);
        return await options.machine.interrupt(params);
      }
      case "kill": {
        const params = rawParams as Parameters<SessionMachine["kill"]>[0];
        if (
          consumer !== undefined &&
          !options.consumerScope.inScope(consumer, params.sessionId)
        )
          return { sessionId: params.sessionId, status: "not_found" };
        return await options.machine.kill(params);
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
      eventWriteFailure ??= error;
      wakeWaiters();
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
      )
        wakeWaiters();
    } catch {
      wakeWaiters();
    }
  }

  async function settleEvents(): Promise<void> {
    if (eventWriteFailure !== undefined) throw eventWriteFailure;
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
    const events = new Map<SessionId, readonly StoredCommittedEvent[]>();
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
      let history = events.get(target.sessionId);
      if (history === undefined) {
        history = options.controlStore.sessionEvents(target.sessionId);
        events.set(target.sessionId, history);
      }
      const targetEvents = history.filter(
        ({ event }) => "turnId" in event && event.turnId === target.turnId,
      );
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

  function attachReplay(
    params: AttachParams,
    consumer?: ConsumerContext,
  ): AttachReplay {
    assertSessionScope(params.sessionId, consumer);
    const storedSession = options.controlStore.getSession(params.sessionId);
    if (storedSession === undefined)
      throw {
        code: "session_not_found",
        sessionId: params.sessionId,
      } satisfies MachineError;
    if (params.scope === "turn")
      options.machine.assertTurnTarget({
        sessionId: params.sessionId,
        turnId: params.turnId,
      });
    const target: SubscriptionTarget =
      params.scope === "turn"
        ? {
            scope: "turn",
            sessionId: params.sessionId,
            turnId: params.turnId,
          }
        : { scope: "session", sessionId: params.sessionId };
    const history = options.controlStore.sessionEvents(params.sessionId);
    const head = options.controlStore.eventWindow(params.sessionId).head;
    const available = history.slice(-eventLogLimit);
    const first = available[0];
    const oldest = first?.eventId ?? null;
    let after: number | undefined;
    if (params.replay.mode === "after") {
      const cursor = decodeResumeCursor(params.replay.cursor);
      if (
        cursor.daemonGeneration !== options.diagnostics.generation ||
        cursor.target.scope !== target.scope ||
        cursor.target.sessionId !== target.sessionId ||
        (target.scope === "turn" &&
          (cursor.target.scope !== "turn" ||
            cursor.target.turnId !== target.turnId)) ||
        cursor.eventId > (head ?? 0)
      )
        throw {
          code: "invalid_params",
          issues: [{ issue: "invalid_value", path: "replay.cursor" }],
        } satisfies MachineError;
      if (
        (oldest === null || oldest > 1) &&
        cursor.eventId < (oldest ?? (head ?? 0) + 1)
      )
        throw {
          code: "event_cursor_expired",
          oldest,
          head,
        } satisfies MachineError;
      after = cursor.eventId;
    }
    const entries =
      params.replay.mode === "none"
        ? []
        : available.filter(
            ({ event, eventId }) =>
              (after === undefined || eventId > after) &&
              (target.scope === "session" ||
                ("turnId" in event && event.turnId === target.turnId)),
          );
    return {
      target,
      entries,
      head,
      oldest,
      truncated: head !== null && (oldest === null || oldest > 1),
      lastEventId:
        after === undefined
          ? head
          : after === 0
            ? null
            : v.parse(eventIdSchema, after),
    };
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
    result?: SpawnAck,
    cleanupError?: unknown,
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

    const requiredStop =
      request.method === "kill" || request.method === "interrupt";
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
          const result = await performSafely(perform);
          if (requiredStop && "error" in result) {
            try {
              await settleEvents();
            } catch (error) {
              return {
                error: withCleanupCause(result.error, error, "io"),
              };
            }
            return result;
          }
          if (requiredStop && "result" in result) {
            const noSessionToStop =
              request.method === "kill" &&
              typeof result.result === "object" &&
              result.result !== null &&
              "status" in result.result &&
              result.result.status === "not_found";
            if (noSessionToStop) return result;
            try {
              await settleEvents();
              if (options.controlStore.health().status !== "available")
                throw eventWriteFailure ?? "Control store is unavailable";
            } catch (error) {
              return {
                error: storeUnavailable(
                  operationKey,
                  "commit",
                  "accepted",
                  error,
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
    settleEvents,
    subscribeEvents(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    assertSessionScope,
    list,
    attachReplay,
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
      wakeWaiters();
      waitListeners.clear();
      options.controlStore.close();
    },
  };
}
