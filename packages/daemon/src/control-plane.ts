import { stat } from "node:fs/promises";

import { isAlreadyDiagnosedError } from "@reins/adapter-kit";
import type { SessionMachine } from "@reins/core";
import type {
  AttachParams,
  CapabilitiesResult,
  ConsumerContext,
  DaemonDiagnosticFact,
  DiagnosticsParams,
  DomainEvent,
  EventId,
  HarnessCapability,
  MachineError,
  ProtocolMethod,
  SessionId,
  SessionInfo,
  SpawnParams,
  SubscriptionTarget,
  TurnTarget,
  WaitParams,
  WaitResult,
} from "@reins/protocol";
import {
  decodeResumeCursor,
  eventIdSchema,
  harnessCapabilitySchema,
  isSideEffectMethod,
  makeErrorCause,
  makeTextEvidence,
} from "@reins/protocol";
import * as v from "valibot";

import type { ConsumerScope } from "./consumer-scope.ts";
import type { OrderedDiagnosticsRuntime } from "./diagnostics-acceptance.ts";
import type { AdapterRegistry } from "./registry.ts";

export const DEFAULT_EVENT_LOG_LIMIT = 1000;

export type CommittedEvent = {
  readonly event: DomainEvent;
  readonly eventId: EventId;
};

export type AttachReplay = {
  readonly target: SubscriptionTarget;
  readonly entries: readonly CommittedEvent[];
  readonly head: EventId | null;
  readonly oldest: EventId | null;
  readonly truncated: boolean;
  readonly lastEventId: EventId | null;
};

type SessionHistory = {
  head: number;
  readonly entries: CommittedEvent[];
};

export type ControlPlane = {
  execute(
    request: {
      readonly method: ProtocolMethod;
      readonly params: unknown;
      readonly commandId?: string;
    },
    consumer: ConsumerContext | undefined,
    perform: () => Promise<{ result: unknown } | { error: MachineError }>,
  ): Promise<{ result: unknown } | { error: MachineError }>;
  dispatch(
    method: ProtocolMethod,
    params: unknown,
    consumer: ConsumerContext | undefined,
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
  const histories = new Map<SessionId, SessionHistory>();
  const eventListeners = new Set<(entry: CommittedEvent) => void>();
  const commands = new Map<
    string,
    {
      consumer: ConsumerContext | undefined;
      fingerprint: string;
      outcome: Promise<{ result: unknown } | { error: MachineError }>;
    }
  >();
  const unsubscribeMachine = options.machine.subscribe((event) => {
    void acceptEvent(event).catch(() => undefined);
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

  async function verifiedCapabilityDiagnostic(error: unknown, harness: string) {
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
        record.operation === "capabilities" &&
        record.stage === "query"
        ? error.diagnosticId
        : undefined;
    } catch {
      return undefined;
    }
  }

  async function aggregateCapabilities(): Promise<CapabilitiesResult> {
    const entries = Array.from(options.adapters.entries());
    const results = await Promise.allSettled(
      entries.map(async ([harness, adapter]) =>
        adapter.capabilities(async (input) => {
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
    const capabilities: HarnessCapability[] = [];
    const failures: CapabilitiesResult["failures"] = [];
    for (const [index, result] of results.entries()) {
      const harness = entries[index]?.[0];
      if (harness === undefined) continue;
      if (result.status === "fulfilled") {
        const parsed = v.safeParse(harnessCapabilitySchema, result.value);
        if (parsed.success && parsed.output.harness === harness) {
          capabilities.push(parsed.output);
          continue;
        }
        const reason = new Error("Capability result did not match its harness");
        const diagnosticId = await recordDiagnostic({
          harness,
          kind: "request_failure",
          operation: "capabilities",
          stage: "query",
          reason: "upstream_error",
          message: makeTextEvidence(String(reason)),
        });
        failures.push({
          harness,
          code: "capability_query_failed",
          failure: {
            failureCategory: "unclassified",
            retryDisposition: "unknown",
          },
          ...(diagnosticId === undefined ? {} : { diagnosticId }),
        });
      } else {
        const suppliedDiagnosticId = await verifiedCapabilityDiagnostic(
          result.reason,
          harness,
        );
        const diagnosticId =
          suppliedDiagnosticId ??
          (await recordDiagnostic({
            kind: "request_failure",
            operation: "capabilities",
            stage: "query",
            reason: "upstream_error",
            harness,
            message: makeTextEvidence(String(result.reason)),
          }));
        failures.push({
          harness,
          code: "capability_query_failed",
          failure: {
            failureCategory: "unclassified",
            retryDisposition: "unknown",
          },
          ...(diagnosticId === undefined ? {} : { diagnosticId }),
        });
      }
    }
    return { capabilities, failures };
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
  ): Promise<unknown> {
    switch (method) {
      case "capabilities":
        return await aggregateCapabilities();
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
        const currentCapabilities = await aggregateCapabilities();
        const knownHarnesses = new Set([
          ...currentCapabilities.capabilities.map(({ harness }) => harness),
          ...currentCapabilities.failures.map(({ harness }) => harness),
        ]);
        if (!knownHarnesses.has(spawnParams.harness))
          throw {
            code: "unknown_harness",
            harness: spawnParams.harness,
            availableHarnesses: [...knownHarnesses],
          } satisfies MachineError;
        const capability = currentCapabilities.capabilities.find(
          ({ harness }) => harness === spawnParams.harness,
        );
        if (capability !== undefined && spawnParams.model !== undefined) {
          const model = capability.models.find(
            ({ id }) => id === spawnParams.model,
          );
          if (model === undefined)
            throw {
              code: "invalid_params",
              issues: [{ issue: "invalid_value", path: "model" }],
            } satisfies MachineError;
          if (
            spawnParams.reasoning !== undefined &&
            !model.reasoningEfforts.includes(spawnParams.reasoning)
          )
            throw {
              code: "invalid_params",
              issues: [{ issue: "invalid_value", path: "reasoning" }],
            } satisfies MachineError;
        }
        const result = await options.machine.spawn(spawnParams);
        if (consumer !== undefined)
          options.consumerScope.claim(result.sessionId, consumer);
        return result;
      }
      case "send": {
        const params = rawParams as Parameters<SessionMachine["send"]>[0];
        assertSessionScope(params.sessionId, consumer);
        return await options.machine.send(params);
      }
      case "wait": {
        const params = rawParams as WaitParams;
        for (const target of params.targets)
          assertSessionScope(target.sessionId, consumer);
        return await options.machine.wait(params);
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
    const sessions = options.machine.list(filter);
    return consumer === undefined
      ? sessions
      : sessions.filter((session) =>
          options.consumerScope.inScope(consumer, session.sessionId),
        );
  }

  function recordEvent(event: DomainEvent): void | Promise<void> {
    if (event.type === "session.created") {
      const consumer = options.consumerScope.current();
      if (consumer !== undefined)
        options.consumerScope.claim(event.sessionId, consumer);
    }
    const history = histories.get(event.sessionId) ?? { head: 0, entries: [] };
    const entry: CommittedEvent = {
      event,
      eventId: v.parse(eventIdSchema, history.head + 1),
    };
    history.head = entry.eventId;
    history.entries.push(entry);
    if (history.entries.length > eventLogLimit)
      history.entries.splice(0, history.entries.length - eventLogLimit);
    histories.set(event.sessionId, history);
    for (const listener of Array.from(eventListeners)) listener(entry);
  }

  // 目前事件记录和通知是同步内存操作，因此保留 machine apply 后立即记录、再通知的顺序。
  // 队列保持原生回调顺序；将记录改为异步时，调用者仍通过同一 Promise 接缝等待已接收事件。
  const pendingEventCommits = new Set<Promise<void>>();
  const eventQueue: Array<{
    readonly event: DomainEvent;
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  let committingEvent = false;

  function drainEventQueue(): void {
    if (committingEvent) return;
    while (eventQueue.length > 0) {
      const queued = eventQueue.shift();
      if (queued === undefined) return;
      committingEvent = true;
      let committed: void | Promise<void>;
      try {
        committed = recordEvent(queued.event);
      } catch (error) {
        queued.reject(error);
        committingEvent = false;
        continue;
      }
      if (committed !== undefined) {
        void committed.then(queued.resolve, queued.reject).finally(() => {
          committingEvent = false;
          drainEventQueue();
        });
        return;
      }
      queued.resolve();
      committingEvent = false;
    }
  }

  function acceptEvent(event: DomainEvent): Promise<void> {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const accepted = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    pendingEventCommits.add(accepted);
    void accepted.then(
      () => pendingEventCommits.delete(accepted),
      () => pendingEventCommits.delete(accepted),
    );
    eventQueue.push({ event, resolve, reject });
    drainEventQueue();
    return accepted;
  }

  async function settleEvents(): Promise<void> {
    let failure: unknown;
    let hasFailure = false;
    while (pendingEventCommits.size > 0) {
      const results = await Promise.allSettled(Array.from(pendingEventCommits));
      const failed = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failed !== undefined && !hasFailure) {
        failure = failed.reason;
        hasFailure = true;
      }
    }
    if (hasFailure) throw failure;
  }

  function attachReplay(
    params: AttachParams,
    consumer?: ConsumerContext,
  ): AttachReplay {
    assertSessionScope(params.sessionId, consumer);
    const history = histories.get(params.sessionId);
    if (history === undefined)
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
    const head =
      history.head === 0 ? null : v.parse(eventIdSchema, history.head);
    const first = history.entries[0];
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
        : history.entries.filter(
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

  return {
    async execute(request, consumer, perform) {
      const run = async () => {
        try {
          await settleEvents();
          const outcome = await perform();
          await settleEvents();
          return outcome;
        } catch (error) {
          const failure: MachineError = {
            code: "internal_error",
            cause: makeErrorCause("exception", String(error)),
          };
          return {
            error: failure,
          };
        }
      };
      if (!isSideEffectMethod(request.method)) return run();
      const commandId = request.commandId;
      if (commandId === undefined) return { error: { code: "protocol_error" } };
      if (commandId.split(":")[0] !== options.diagnostics.generation)
        return { error: { code: "stale_command_id" } };
      const fingerprint = canonical({
        method: request.method,
        params: request.params,
      });
      const existing = commands.get(commandId);
      if (existing !== undefined)
        return existing.consumer === consumer &&
          existing.fingerprint === fingerprint
          ? existing.outcome
          : { error: { code: "command_id_conflict" } };
      const outcome = run();
      commands.set(commandId, { consumer, fingerprint, outcome });
      return outcome;
    },
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
      const result = await options.machine.wait({
        targets: [target],
        completion: "all",
        timeoutMs: 0,
      });
      await settleEvents();
      return result;
    },
    isSessionKilled(sessionId) {
      return options.machine.list({ sessionId })[0]?.state === "killed";
    },
    liveSessionIds() {
      return options.machine
        .list()
        .filter((session) => session.state !== "killed")
        .map((session) => session.sessionId);
    },
    async terminateLiveSessions() {
      const liveSessionIds = options.machine
        .list()
        .filter((session) => session.state !== "killed")
        .map((session) => session.sessionId);
      const results = await Promise.allSettled(
        liveSessionIds.map(async (sessionId) => {
          await options.machine.kill({ sessionId });
        }),
      );
      const failures = results
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result) => result.reason);
      await settleEvents();
      if (failures.length > 0)
        throw new AggregateError(failures, "Worker cleanup failed");
    },
    close() {
      unsubscribeMachine();
      eventListeners.clear();
    },
  };
}
