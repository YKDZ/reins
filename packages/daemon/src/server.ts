import type { SessionMachine } from "@reins/core";
import type {
  AttachParams,
  CapabilitiesResult,
  DomainEvent,
  DiagnosticsParams,
  HarnessCapability,
  InterruptParams,
  KillParams,
  ListFilter,
  MachineError,
  ProtocolMessage,
  ProtocolRequest,
  RequestId,
  ResolvePermissionParams,
  SendParams,
  SessionId,
  TurnId,
  SpawnParams,
  StopReason,
  WaitParams,
} from "@reins/protocol";
import {
  machineErrorSchema,
  harnessCapabilitySchema,
  makeErrorCause,
  makeTextEvidence,
  protocolMethodSchema,
  protocolParamsSchemaFor,
  protocolRequestSchema,
  requestIdSchema,
} from "@reins/protocol";
import type { TransportConnection, TransportServer } from "@reins/transport";
import * as v from "valibot";

import type { DiagnosticsRuntime } from "./diagnostics-recorder.ts";
import type { AdapterRegistry } from "./registry.ts";

export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_EVENT_LOG_LIMIT = 1000;

type AttachSubscription = {
  readonly sessionId: SessionId;
  readonly exitOn: readonly StopReason[];
  targetTurnId?: TurnId;
  replaying: boolean;
  pendingEvents: DomainEvent[];
  active: boolean;
  readonly connection: TransportConnection<ProtocolMessage>;
};

type Observation = {
  activeTurnId?: TurnId;
  lastCompleted?: Extract<DomainEvent, { type: "turn.completed" }>;
  killed: boolean;
};

function unsupportedProtocolMethod(value: ProtocolRequest["method"]): never {
  throw new Error(`unexpected protocol method: ${String(value)}`);
}

export type ProtocolServer = {
  start(): Promise<void>;
  stop(): Promise<void>;
  forwardEvent(event: DomainEvent): void;
};

type ProtocolServerOptions = {
  transport: TransportServer<ProtocolMessage>;
  machine: SessionMachine;
  adapters: AdapterRegistry;
  diagnostics: DiagnosticsRuntime;
  idleTimeoutMs?: number;
  eventLogLimit?: number;
};

type ProtocolServerTestingOptions = {
  beforeAttachReplay?: (sessionId: SessionId) => void;
};

export function createProtocolServer(
  options: ProtocolServerOptions,
): ProtocolServer {
  return createProtocolServerInternal(options, {});
}

// 包内测试缝；不从 @reins/daemon 的公共入口导出。
export function createProtocolServerInternal(
  options: ProtocolServerOptions,
  testing: ProtocolServerTestingOptions,
): ProtocolServer {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const eventLogLimit = options.eventLogLimit ?? DEFAULT_EVENT_LOG_LIMIT;
  const connections = new Set<TransportConnection<ProtocolMessage>>();
  const attachSubscriptions = new Set<AttachSubscription>();
  const cleanupByConnection = new Map<
    TransportConnection<ProtocolMessage>,
    Set<() => void>
  >();
  const eventLog = new Map<SessionId, DomainEvent[]>();
  const observations = new Map<SessionId, Observation>();
  const knownSessions = new Set<SessionId>();
  const transportFailureConnections = new WeakSet<
    TransportConnection<ProtocolMessage>
  >();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let shuttingDown = false;
  let startedResolve: (() => void) | null = null;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });

  function isMachineError(value: unknown): value is MachineError {
    return (
      typeof value === "object" &&
      value !== null &&
      v.safeParse(machineErrorSchema, value).success
    );
  }

  async function toMachineError(error: unknown): Promise<MachineError> {
    if (isMachineError(error)) return error;
    const cause = makeErrorCause("exception", String(error));
    const diagnosticId = await recordDiagnostic({
      source: "daemon",
      kind: "lifecycle",
      operation: "diagnostics_store",
      reason: "invariant_failed",
      message: makeTextEvidence(String(error)),
    });
    return {
      code: "internal_error",
      cause,
      ...(diagnosticId === undefined ? {} : { diagnosticId }),
    };
  }

  async function recordDiagnostic(
    input: Parameters<DiagnosticsRuntime["record"]>[0],
  ) {
    if (options.diagnostics.health().status === "degraded") return undefined;
    return await options.diagnostics.record(input);
  }

  function sendSafe(
    connection: TransportConnection<ProtocolMessage>,
    message: ProtocolMessage,
  ): void {
    try {
      connection.send(message);
    } catch (error) {
      recordTransportFailure(connection, "write", error);
      cleanupConnection(connection);
    }
  }

  function recordTransportFailure(
    connection: TransportConnection<ProtocolMessage>,
    operation: "read" | "write",
    error: unknown,
  ): void {
    if (transportFailureConnections.has(connection)) return;
    transportFailureConnections.add(connection);
    void recordDiagnostic({
      source: "daemon",
      kind: "transport_failure",
      operation,
      reason: "io_error",
      message: makeTextEvidence(String(error)),
    }).catch(() => undefined);
  }

  function hasLiveSessions(): boolean {
    return options.machine.list().some((session) => session.state !== "killed");
  }

  function isIdle(): boolean {
    return connections.size === 0 && !hasLiveSessions();
  }

  function scheduleIdleExit(): void {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
    if (!isIdle()) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      void shutdown();
    }, idleTimeoutMs);
  }

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    for (const unsubscribers of cleanupByConnection.values()) {
      for (const unsubscribe of unsubscribers) unsubscribe();
    }
    cleanupByConnection.clear();
    attachSubscriptions.clear();
    try {
      await options.transport.close();
    } finally {
      startedResolve?.();
      startedResolve = null;
    }
  }

  function appendLog(event: DomainEvent): void {
    const history = eventLog.get(event.sessionId) ?? [];
    history.push(event);
    if (history.length > eventLogLimit) {
      history.splice(0, history.length - eventLogLimit);
    }
    eventLog.set(event.sessionId, history);
  }

  function endAttach(
    subscription: AttachSubscription,
    reason: StopReason | "session_killed",
  ): void {
    if (!subscription.active) return;
    subscription.active = false;
    attachSubscriptions.delete(subscription);
    sendSafe(subscription.connection, {
      kind: "notification",
      method: "attach.ended",
      params: { sessionId: subscription.sessionId, reason },
    });
  }

  function forwardEvent(event: DomainEvent): void {
    if (event.type === "session.created") {
      knownSessions.add(event.sessionId);
    }
    appendLog(event);
    const observation = observations.get(event.sessionId) ?? { killed: false };
    if (event.type === "turn.started") observation.activeTurnId = event.turnId;
    if (event.type === "turn.completed") {
      delete observation.activeTurnId;
      observation.lastCompleted = event;
    }
    if (event.type === "session.killed") observation.killed = true;
    observations.set(event.sessionId, observation);
    for (const subscription of Array.from(attachSubscriptions)) {
      if (subscription.sessionId !== event.sessionId) continue;
      if (subscription.replaying) subscription.pendingEvents.push(event);
      else forwardToSubscription(subscription, event);
    }
    scheduleIdleExit();
  }

  function forwardToSubscription(
    subscription: AttachSubscription,
    event: DomainEvent,
  ): void {
    if (!subscription.active) return;
    sendSafe(subscription.connection, {
      kind: "notification",
      method: "event",
      params: event,
    });
    if (event.type === "session.killed") {
      endAttach(subscription, "session_killed");
    } else if (
      event.type === "turn.completed" &&
      subscription.targetTurnId === event.turnId &&
      subscription.exitOn.includes(event.stopReason)
    ) {
      endAttach(subscription, event.stopReason);
    }
  }

  function requestIdOf(raw: unknown): RequestId | null {
    if (typeof raw !== "object" || raw === null) return null;
    const value = (raw as { requestId?: unknown }).requestId;
    const parsed = v.safeParse(requestIdSchema, value);
    return parsed.success ? parsed.output : null;
  }

  function isKnownMethod(method: unknown): boolean {
    return (
      typeof method === "string" &&
      v.safeParse(protocolMethodSchema, method).success
    );
  }

  function handleMessage(
    connection: TransportConnection<ProtocolMessage>,
    raw: unknown,
  ): void {
    const parsed = v.safeParse(protocolRequestSchema, raw);
    if (!parsed.success) {
      const requestId = requestIdOf(raw);
      if (requestId === null) return;
      const method =
        typeof raw === "object" && raw !== null
          ? (raw as { method?: unknown }).method
          : undefined;
      const methodText = typeof method === "string" ? method : "";
      const error: MachineError = isKnownMethod(method)
        ? { code: "protocol_error" }
        : { code: "method_not_found", method: methodText || "unknown" };
      sendSafe(connection, { kind: "response", requestId, error });
      return;
    }
    const request = parsed.output;
    const paramsParsed = v.safeParse(
      protocolParamsSchemaFor(request.method),
      request.params,
    );
    if (!paramsParsed.success) {
      const issues = paramsParsed.issues.map((issue) => ({
        issue: "invalid_value" as const,
        path: issue.path?.map((item) => String(item.key)).join(".") ?? "",
      }));
      const error: MachineError = {
        code: "invalid_params",
        issues: [
          issues[0] ?? { issue: "invalid_value", path: "" },
          ...issues.slice(1),
        ],
      };
      sendSafe(connection, {
        kind: "response",
        requestId: request.requestId,
        error,
      });
      return;
    }
    void dispatch(connection, request).then(
      (result: unknown) => {
        sendSafe(connection, {
          kind: "response",
          requestId: request.requestId,
          result,
        });
      },
      async (error: unknown) => {
        sendSafe(connection, {
          kind: "response",
          requestId: request.requestId,
          error: await toMachineError(error),
        });
      },
    );
  }

  async function aggregateCapabilities(): Promise<CapabilitiesResult> {
    const entries = Array.from(options.adapters.entries());
    const results = await Promise.allSettled(
      entries.map(async ([, adapter]) => adapter.capabilities()),
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
        const cause = makeErrorCause("exception", String(reason));
        const diagnosticId = await recordDiagnostic({
          source: "daemon",
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
          cause,
          ...(diagnosticId === undefined ? {} : { diagnosticId }),
        });
      } else {
        const cause = makeErrorCause("exception", String(result.reason));
        const diagnosticId = await recordDiagnostic({
          source: "daemon",
          kind: "request_failure",
          operation: "capabilities",
          stage: "query",
          reason: "upstream_error",
          harness,
          message: makeTextEvidence(String(result.reason)),
        });
        failures.push({
          harness,
          code: "capability_query_failed",
          cause,
          ...(diagnosticId === undefined ? {} : { diagnosticId }),
        });
      }
    }
    return { capabilities, failures };
  }

  function attach(
    connection: TransportConnection<ProtocolMessage>,
    params: AttachParams,
  ): { sessionId: SessionId; replayed: number } {
    if (!knownSessions.has(params.sessionId)) {
      throw {
        code: "session_not_found",
        sessionId: params.sessionId,
      } satisfies MachineError;
    }
    const history = eventLog.get(params.sessionId) ?? [];
    const observation = observations.get(params.sessionId) ?? { killed: false };
    const replayedCount =
      params.replay === undefined
        ? history.length
        : Math.min(params.replay, history.length);
    const replayEvents = history.slice(
      replayedCount === 0 ? history.length : -replayedCount,
    );
    const targetTurnId =
      params.exitOn === undefined || params.exitOn.length === 0
        ? undefined
        : (observation.activeTurnId ?? observation.lastCompleted?.turnId);
    const subscription: AttachSubscription = {
      sessionId: params.sessionId,
      exitOn: params.exitOn ?? [],
      ...(targetTurnId === undefined ? {} : { targetTurnId }),
      connection,
      replaying: true,
      pendingEvents: [],
      active: true,
    };
    attachSubscriptions.add(subscription);
    try {
      testing.beforeAttachReplay?.(params.sessionId);
    } catch (error) {
      subscription.active = false;
      attachSubscriptions.delete(subscription);
      subscription.pendingEvents.length = 0;
      throw error;
    }
    // 回放先于响应，保证事件顺序与"响应确认 attach 建立"之间无交叉。
    for (const event of replayEvents) {
      sendSafe(connection, {
        kind: "notification",
        method: "event",
        params: event,
      });
    }
    subscription.replaying = false;
    for (const event of subscription.pendingEvents.splice(0)) {
      forwardToSubscription(subscription, event);
      if (!subscription.active) break;
    }
    const lastTurn = observation.lastCompleted;
    if (
      lastTurn !== undefined &&
      subscription.targetTurnId === lastTurn.turnId &&
      subscription.exitOn.includes(lastTurn.stopReason)
    ) {
      endAttach(subscription, lastTurn.stopReason);
    } else if (observation.killed) {
      endAttach(subscription, "session_killed");
    }
    return { sessionId: params.sessionId, replayed: replayedCount };
  }

  async function dispatch(
    connection: TransportConnection<ProtocolMessage>,
    request: ProtocolRequest,
  ): Promise<unknown> {
    switch (request.method) {
      case "initialize":
        return {};
      case "capabilities":
        return await aggregateCapabilities();
      case "spawn":
        const spawnParams = request.params as SpawnParams;
        if (
          spawnParams.captureHarnessStderr === true &&
          options.adapters.has(spawnParams.harness) &&
          options.adapters.get(spawnParams.harness)?.canCaptureHarnessStderr !==
            true
        ) {
          throw {
            code: "unsupported_feature",
            feature: "capture_harness_stderr",
          } satisfies MachineError;
        }
        return {
          sessionId: await options.machine.spawn(spawnParams),
        };
      case "send":
        return await options.machine.send(request.params as SendParams);
      case "wait":
        return await options.machine.wait(request.params as WaitParams);
      case "interrupt":
        return await options.machine.interrupt(
          request.params as InterruptParams,
        );
      case "kill":
        return await options.machine.kill(request.params as KillParams);
      case "list":
        return options.machine.list(request.params as ListFilter | undefined);
      case "attach":
        return attach(connection, request.params as AttachParams);
      case "resolvePermission":
        await options.machine.resolvePermission(
          request.params as ResolvePermissionParams,
        );
        return {};
      case "diagnostics":
        if (options.diagnostics.health().status === "degraded") {
          throw { code: "diagnostics_unavailable" } satisfies MachineError;
        }
        const diagnosticsParams = request.params as DiagnosticsParams;
        try {
          return await options.diagnostics.query(diagnosticsParams);
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "diagnostic_not_found"
          ) {
            if ("diagnosticId" in diagnosticsParams) {
              throw {
                code: "diagnostic_not_found",
                diagnosticId: diagnosticsParams.diagnosticId,
              } satisfies MachineError;
            }
          }
          throw { code: "diagnostics_unavailable" } satisfies MachineError;
        }
      default:
        return unsupportedProtocolMethod(request.method);
    }
  }

  function handleConnection(
    connection: TransportConnection<ProtocolMessage>,
  ): void {
    connections.add(connection);
    const cleanup = new Set<() => void>();
    cleanupByConnection.set(connection, cleanup);
    const unsubscribe = connection.onEvent((event) => {
      if (event.kind === "message") handleMessage(connection, event.message);
      if (event.kind === "error") {
        recordTransportFailure(connection, "read", event.error);
        cleanupConnection(connection);
      }
      if (event.kind === "closed") cleanupConnection(connection);
    });
    cleanup.add(unsubscribe);
    scheduleIdleExit();
  }

  function cleanupConnection(
    connection: TransportConnection<ProtocolMessage>,
  ): void {
    for (const subscription of Array.from(attachSubscriptions)) {
      if (subscription.connection === connection) {
        attachSubscriptions.delete(subscription);
      }
    }
    cleanupByConnection.get(connection)?.forEach((unsubscribe) => {
      unsubscribe();
    });
    cleanupByConnection.delete(connection);
    connections.delete(connection);
    scheduleIdleExit();
  }

  return {
    start() {
      options.transport.onConnection(handleConnection);
      return options.transport.listen().then(() => {
        scheduleIdleExit();
        return started;
      });
    },
    async stop() {
      await shutdown();
    },
    forwardEvent,
  };
}
