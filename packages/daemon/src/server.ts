import type { SessionMachine } from "@reins/core";
import type {
  AttachParams,
  CapabilitiesResult,
  DomainEvent,
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
  SpawnParams,
  StopReason,
  WaitParams,
} from "@reins/protocol";
import {
  machineErrorSchema,
  makeErrorCause,
  protocolMethodSchema,
  protocolParamsSchemaFor,
  protocolRequestSchema,
  requestIdSchema,
} from "@reins/protocol";
import type { TransportConnection, TransportServer } from "@reins/transport";
import * as v from "valibot";

import type { AdapterRegistry } from "./registry.ts";

export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_EVENT_LOG_LIMIT = 1000;

type AttachSubscription = {
  readonly sessionId: SessionId;
  readonly exitOn: readonly StopReason[];
  readonly connection: TransportConnection<ProtocolMessage>;
};

function unsupportedProtocolMethod(value: ProtocolRequest["method"]): never {
  throw new Error(`unexpected protocol method: ${String(value)}`);
}

export type ProtocolServer = {
  start(): Promise<void>;
  stop(): Promise<void>;
  forwardEvent(event: DomainEvent): void;
};

export function createProtocolServer(options: {
  transport: TransportServer<ProtocolMessage>;
  machine: SessionMachine;
  adapters: AdapterRegistry;
  idleTimeoutMs?: number;
  eventLogLimit?: number;
}): ProtocolServer {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const eventLogLimit = options.eventLogLimit ?? DEFAULT_EVENT_LOG_LIMIT;
  const connections = new Set<TransportConnection<ProtocolMessage>>();
  const attachSubscriptions = new Set<AttachSubscription>();
  const cleanupByConnection = new Map<
    TransportConnection<ProtocolMessage>,
    Set<() => void>
  >();
  const eventLog = new Map<SessionId, DomainEvent[]>();
  const knownSessions = new Set<SessionId>();
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

  function toMachineError(error: unknown): MachineError {
    return isMachineError(error)
      ? error
      : {
          code: "internal_error",
          cause: makeErrorCause("exception", String(error)),
        };
  }

  function sendSafe(
    connection: TransportConnection<ProtocolMessage>,
    message: ProtocolMessage,
  ): void {
    try {
      connection.send(message);
    } catch {
      cleanupConnection(connection);
    }
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
    for (const subscription of Array.from(attachSubscriptions)) {
      if (subscription.sessionId !== event.sessionId) continue;
      sendSafe(subscription.connection, {
        kind: "notification",
        method: "event",
        params: event,
      });
      if (event.type === "session.killed") {
        endAttach(subscription, "session_killed");
      } else if (
        event.type === "turn.completed" &&
        subscription.exitOn.includes(event.stopReason)
      ) {
        endAttach(subscription, event.stopReason);
      }
    }
    scheduleIdleExit();
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
      (error: unknown) => {
        sendSafe(connection, {
          kind: "response",
          requestId: request.requestId,
          error: toMachineError(error),
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
    results.forEach((result, index) => {
      const harness = entries[index]?.[0];
      if (harness === undefined) return;
      if (result.status === "fulfilled") {
        capabilities.push(result.value);
      } else {
        failures.push({
          harness,
          code: "capability_query_failed",
          cause: makeErrorCause("exception", String(result.reason)),
        });
      }
    });
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
    const replayedCount =
      params.replay === undefined
        ? history.length
        : Math.min(params.replay, history.length);
    const subscription: AttachSubscription = {
      sessionId: params.sessionId,
      exitOn: params.exitOn ?? [],
      connection,
    };
    attachSubscriptions.add(subscription);
    // 回放先于响应，保证事件顺序与"响应确认 attach 建立"之间无交叉。
    for (const event of history.slice(-replayedCount)) {
      sendSafe(connection, {
        kind: "notification",
        method: "event",
        params: event,
      });
    }
    const lastTurn = [...history]
      .reverse()
      .find(
        (event): event is Extract<DomainEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
    if (
      lastTurn !== undefined &&
      subscription.exitOn.includes(lastTurn.stopReason)
    ) {
      endAttach(subscription, lastTurn.stopReason);
    } else if (history.some((event) => event.type === "session.killed")) {
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
        return {
          sessionId: await options.machine.spawn(request.params as SpawnParams),
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
