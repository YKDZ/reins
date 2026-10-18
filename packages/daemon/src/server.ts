import type { SessionMachine } from "@reins/core";
import type {
  AttachParams,
  AttachResult,
  EventId,
  SubscriptionTarget,
  SubscriptionId,
  ConsumerContext,
  DaemonDiagnosticFact,
  DomainEvent,
  InitializeParams,
  InitializeResult,
  MachineError,
  ProtocolMessage,
  ProtocolRequest,
  RuntimeScopeId,
  RequestId,
  SessionId,
  StopReason,
  TransportFailureFact,
} from "@reins/protocol";
import {
  subscriptionIdSchema,
  subscriptionCloseSchema,
  machineErrorSchema,
  makeErrorCause,
  makeTextEvidence,
  parseTransportFailureFact,
  protocolMethodSchema,
  protocolParamsSchemaFor,
  protocolRequestSchema,
  REINS_PROTOCOL_MAJOR_VERSION,
  requestIdSchema,
} from "@reins/protocol";
import {
  createTransportError,
  transportFailureFactOf,
  type TransportConnection,
  type TransportServer,
} from "@reins/transport";
import * as v from "valibot";

import { createConsumerScope, type ConsumerScope } from "./consumer-scope.ts";
import {
  createControlPlane,
  DEFAULT_EVENT_LOG_LIMIT,
  type CommittedEvent,
  type ControlPlane,
} from "./control-plane.ts";
import {
  orderDiagnosticsAcceptance,
  type OrderedDiagnosticsRuntime,
} from "./diagnostics-acceptance.ts";
import type { DiagnosticsRuntime } from "./diagnostics-recorder.ts";
import type { AdapterRegistry } from "./registry.ts";

export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
export { DEFAULT_EVENT_LOG_LIMIT };

const listenIoFailure = parseTransportFailureFact({
  kind: "transport_failure",
  operation: "listen",
  reason: "io_error",
}) as Extract<TransportFailureFact, { operation: "listen" }>;
const connectionIoFailure = parseTransportFailureFact({
  kind: "transport_failure",
  operation: "connection",
  reason: "io_error",
}) as Extract<
  TransportFailureFact,
  { operation: "connection"; reason: "io_error" }
>;
const writeIoFailure = parseTransportFailureFact({
  kind: "transport_failure",
  operation: "write",
  reason: "io_error",
}) as Extract<TransportFailureFact, { operation: "write" }>;

type AttachSubscription = {
  readonly sessionId: SessionId;
  readonly target: SubscriptionTarget;
  readonly subscriptionId: SubscriptionId;
  lastEventId: EventId | null;
  replaying: boolean;
  pendingEvents: CommittedEvent[];
  active: boolean;
  readonly connection: TransportConnection<ProtocolMessage>;
};

function unsupportedProtocolMethod(value: ProtocolRequest["method"]): never {
  throw new Error(`unexpected protocol method: ${String(value)}`);
}

export type ProtocolServer = {
  start(): Promise<void>;
  quiesce(): void;
  stop(): Promise<void>;
};

type ProtocolServerOptions = {
  transport: TransportServer<ProtocolMessage>;
  control: ControlPlane;
  diagnostics: OrderedDiagnosticsRuntime;
  consumerScope: ConsumerScope;
  runtimeScopeId: RuntimeScopeId;
  idleTimeoutMs?: number;
};

type PublicProtocolServerOptions = {
  transport: TransportServer<ProtocolMessage>;
  machine: SessionMachine;
  adapters: AdapterRegistry;
  diagnostics: DiagnosticsRuntime;
  runtimeScopeId: RuntimeScopeId;
  idleTimeoutMs?: number;
  eventLogLimit?: number;
};

type ProtocolServerTestingOptions = {
  beforeAttachReplay?: (sessionId: SessionId) => void;
  onDiagnosticsQueryAccepted?: () => void;
};

export function createProtocolServer(
  options: PublicProtocolServerOptions,
): ProtocolServer {
  const consumerScope = createConsumerScope();
  const diagnostics = orderDiagnosticsAcceptance(
    options.diagnostics,
    consumerScope,
  );
  const control = createControlPlane({
    machine: options.machine,
    adapters: options.adapters,
    diagnostics,
    consumerScope,
    ...(options.eventLogLimit === undefined
      ? {}
      : { eventLogLimit: options.eventLogLimit }),
  });
  return createProtocolServerInternal(
    {
      transport: options.transport,
      control,
      consumerScope,
      diagnostics,
      runtimeScopeId: options.runtimeScopeId,
      ...(options.idleTimeoutMs === undefined
        ? {}
        : { idleTimeoutMs: options.idleTimeoutMs }),
    },
    {},
  );
}

// 包内测试缝；不从 @reins/daemon 的公共入口导出。
export function createProtocolServerInternal(
  options: ProtocolServerOptions,
  testing: ProtocolServerTestingOptions,
): ProtocolServer {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const connections = new Set<TransportConnection<ProtocolMessage>>();
  const attachSubscriptions = new Set<AttachSubscription>();
  const afterAttachAck = new Map<ProtocolRequest, () => void>();
  const cleanupByConnection = new Map<
    TransportConnection<ProtocolMessage>,
    Set<() => void>
  >();
  let subscriptionSequence = 0;
  // initialize 握手建立的连接级消费者绑定；连接关闭即释放。
  const consumerBindings = new Map<
    TransportConnection<ProtocolMessage>,
    ConsumerContext
  >();
  const consumerScope = options.consumerScope;
  async function execute(
    connection: TransportConnection<ProtocolMessage>,
    request: ProtocolRequest,
  ): Promise<{ result: unknown } | { error: MachineError }> {
    const consumer = consumerBindings.get(connection);
    if (request.method !== "initialize" && consumer === undefined)
      return { error: { code: "protocol_error" } };
    const perform = async (): Promise<
      { result: unknown } | { error: MachineError }
    > => {
      try {
        const parsed = v.safeParse(
          protocolParamsSchemaFor(request.method),
          request.params,
        );
        if (!parsed.success) {
          const issues = parsed.issues.map((issue) => ({
            issue: "invalid_value" as const,
            path: issue.path?.map((item) => String(item.key)).join(".") ?? "",
          }));
          return {
            error: {
              code: "invalid_params" as const,
              issues: [
                issues[0] ?? { issue: "invalid_value" as const, path: "" },
                ...issues.slice(1),
              ],
            },
          };
        }
        return { result: await dispatch(connection, request, consumer) };
      } catch (error) {
        return { error: await toMachineError(error) };
      }
    };
    return options.control.execute(
      {
        method: request.method,
        params: request.params,
        ...(request.commandId === undefined
          ? {}
          : { commandId: request.commandId }),
      },
      consumer,
      perform,
    );
  }
  const transportFailureConnections = new WeakMap<
    TransportConnection<ProtocolMessage>,
    | { status: "pending"; queued: TransportFailureFact | undefined }
    | { status: "accepted" }
  >();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let quiescing = false;
  let shuttingDown = false;
  let daemonStarted = false;
  let daemonStopReason: "stopped" | "idle_exit" | undefined;
  let acceptingRequests = false;
  let inFlightRequests = 0;
  let startSetup: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let shutdownFailure: unknown;
  const pendingMessages: Array<{
    connection: TransportConnection<ProtocolMessage>;
    message: ProtocolMessage;
  }> = [];
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

  async function recordDiagnostic(input: DaemonDiagnosticFact) {
    if (options.diagnostics.health().status === "degraded") return undefined;
    const unsafe = input as unknown as Record<string, unknown>;
    if ("source" in unsafe) return undefined;
    try {
      return await options.diagnostics.record({ ...input, source: "daemon" });
    } catch {
      return undefined;
    }
  }

  function sendSafe(
    connection: TransportConnection<ProtocolMessage>,
    message: ProtocolMessage,
  ): void {
    try {
      connection.send(message);
    } catch (error) {
      recordTransportFailure(
        connection,
        transportFailureFactOf(error) ?? writeIoFailure,
      );
      cleanupConnection(connection);
    }
  }

  function rejectDuringShutdown(
    connection: TransportConnection<ProtocolMessage>,
    message: ProtocolMessage,
  ): void {
    if (message.kind !== "request") return;
    sendSafe(connection, {
      kind: "response",
      requestId: message.requestId,
      error: { code: "daemon_shutting_down" },
    });
  }

  function quiesce(): void {
    if (quiescing) return;
    quiescing = true;
    acceptingRequests = false;
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    for (const pending of pendingMessages.splice(0)) {
      rejectDuringShutdown(pending.connection, pending.message);
    }
  }

  function recordTransportFailure(
    connection: TransportConnection<ProtocolMessage>,
    fact: TransportFailureFact,
  ): void {
    const current = transportFailureConnections.get(connection);
    if (current?.status === "accepted") return;
    if (current?.status === "pending") {
      current.queued ??= fact;
      return;
    }
    const pending: {
      status: "pending";
      queued: TransportFailureFact | undefined;
    } = {
      status: "pending",
      queued: undefined,
    };
    transportFailureConnections.set(connection, pending);
    const transportFailureConsumer = consumerBindings.get(connection);
    const runTransportFailureCausal = (): Promise<void> =>
      options.diagnostics.runCausal(async (record) => {
        let candidate: TransportFailureFact | undefined = fact;
        while (candidate !== undefined) {
          let accepted = false;
          try {
            accepted =
              (await record({
                ...candidate,
                source: "daemon",
              })) !== undefined;
          } catch {
            accepted = false;
          }
          if (accepted) {
            transportFailureConnections.set(connection, { status: "accepted" });
            return;
          }
          candidate = pending.queued;
          pending.queued = undefined;
        }
        transportFailureConnections.delete(connection);
      });
    const causalAttempt =
      transportFailureConsumer === undefined
        ? runTransportFailureCausal()
        : consumerScope.within(
            transportFailureConsumer,
            runTransportFailureCausal,
          );
    void causalAttempt.catch(() => undefined);
  }

  function hasLiveSessions(): boolean {
    return options.control.liveSessionIds().length > 0;
  }

  function isIdle(): boolean {
    return (
      connections.size === 0 && inFlightRequests === 0 && !hasLiveSessions()
    );
  }

  function scheduleIdleExit(): void {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
    if (quiescing) return;
    if (!isIdle()) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      void shutdown("idle_exit");
    }, idleTimeoutMs);
  }

  function shutdown(reason: "stopped" | "idle_exit"): Promise<void> {
    if (shutdownPromise !== undefined) return shutdownPromise;
    quiesce();
    shuttingDown = true;
    shutdownFailure = undefined;
    const attempt = (async () => {
      try {
        await startSetup;
      } catch {
        // start 的原始失败由 start() 所有；shutdown 仍负责收口 transport。
      }
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      for (const unsubscribers of cleanupByConnection.values()) {
        for (const unsubscribe of unsubscribers) unsubscribe();
      }
      cleanupByConnection.clear();
      attachSubscriptions.clear();
      pendingMessages.length = 0;
      try {
        await options.control.settleEvents();
        if (daemonStarted && daemonStopReason === undefined) {
          await recordDiagnostic({
            kind: "lifecycle",
            operation: "daemon",
            reason,
          });
          daemonStopReason = reason;
        }
        await options.transport.close();
      } catch (error) {
        shutdownFailure = error;
        throw error;
      } finally {
        unsubscribeControlEvents();
        options.control.close();
        startedResolve?.();
        startedResolve = null;
      }
    })();
    shutdownPromise = attempt;
    void attempt.catch(() => {
      if (shutdownPromise === attempt) shutdownPromise = undefined;
    });
    return attempt;
  }

  function endAttach(
    subscription: AttachSubscription,
    reason: StopReason | "session_killed" | "closed",
  ): void {
    if (!subscription.active) return;
    subscription.active = false;
    attachSubscriptions.delete(subscription);
    sendSafe(subscription.connection, {
      kind: "notification",
      method: "attach.ended",
      params: {
        sessionId: subscription.sessionId,
        subscriptionId: subscription.subscriptionId,
        target: subscription.target,
        lastEventId: subscription.lastEventId,
        reason,
      },
    });
  }

  function forwardCommittedEvent(entry: CommittedEvent): void {
    const { event, eventId } = entry;
    for (const subscription of Array.from(attachSubscriptions)) {
      if (subscription.sessionId !== event.sessionId) continue;
      if (subscription.replaying) subscription.pendingEvents.push(entry);
      else forwardToSubscription(subscription, event, eventId);
    }
    scheduleIdleExit();
  }

  function forwardToSubscription(
    subscription: AttachSubscription,
    event: DomainEvent,
    eventId: EventId,
  ): void {
    if (!subscription.active) return;
    if (
      subscription.target.scope === "turn" &&
      (!("turnId" in event) || event.turnId !== subscription.target.turnId)
    )
      return;
    subscription.lastEventId = eventId;
    sendSafe(subscription.connection, {
      kind: "notification",
      method: "event",
      params: { subscriptionId: subscription.subscriptionId, eventId, event },
    });
    if (event.type === "session.killed") {
      endAttach(subscription, "session_killed");
    } else if (
      event.type === "turn.completed" &&
      subscription.target.scope === "turn" &&
      subscription.target.turnId === event.turnId
    ) {
      endAttach(subscription, event.stopReason);
    }
  }

  const unsubscribeControlEvents = options.control.subscribeEvents(
    forwardCommittedEvent,
  );

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
    const control = v.safeParse(subscriptionCloseSchema, raw);
    if (control.success) {
      for (const subscription of attachSubscriptions) {
        if (
          subscription.connection === connection &&
          subscription.subscriptionId === control.output.subscriptionId
        )
          endAttach(subscription, "closed");
      }
      return;
    }
    const parsed = v.safeParse(protocolRequestSchema, raw);
    if (!parsed.success) {
      void recordDiagnostic({
        kind: "protocol_violation",
        operation: "validate_daemon_request",
        stage: "envelope",
        reason: "invalid_shape",
      }).catch(() => undefined);
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
    inFlightRequests += 1;
    void execute(connection, request)
      .then((outcome) => {
        sendSafe(connection, {
          kind: "response",
          requestId: request.requestId,
          ...outcome,
        });
        const release = afterAttachAck.get(request);
        afterAttachAck.delete(request);
        if ("result" in outcome) release?.();
      })
      .catch(async (error: unknown) => {
        sendSafe(connection, {
          kind: "response",
          requestId: request.requestId,
          error: await toMachineError(error),
        });
      })
      .finally(() => {
        inFlightRequests -= 1;
        scheduleIdleExit();
      });
  }

  async function attach(
    connection: TransportConnection<ProtocolMessage>,
    params: AttachParams,
    request: ProtocolRequest,
    consumer: ConsumerContext | undefined,
  ): Promise<AttachResult> {
    const replay = options.control.attachReplay(params, consumer);
    const { target } = replay;
    const subscription: AttachSubscription = {
      sessionId: params.sessionId,
      target,
      subscriptionId: v.parse(
        subscriptionIdSchema,
        "subscription-" + ++subscriptionSequence,
      ),
      lastEventId: replay.lastEventId,
      connection,
      replaying: true,
      pendingEvents: [],
      active: true,
    };
    // 先完整验证再注册；注册后到 ACK 释放之间的事件进入同一队列。
    attachSubscriptions.add(subscription);
    let terminal: StopReason | undefined;
    try {
      testing.beforeAttachReplay?.(params.sessionId);
      if (target.scope === "turn") {
        const snapshot = await options.control.waitForAttachTurn({
          sessionId: target.sessionId,
          turnId: target.turnId,
        });
        terminal = snapshot.completed[0]?.stopReason;
      }
    } catch (error) {
      subscription.active = false;
      attachSubscriptions.delete(subscription);
      throw error;
    }
    afterAttachAck.set(request, () => {
      if (!subscription.active) return;
      for (const entry of replay.entries)
        forwardToSubscription(subscription, entry.event, entry.eventId);
      subscription.replaying = false;
      for (const entry of subscription.pendingEvents.splice(0))
        forwardToSubscription(subscription, entry.event, entry.eventId);
      if (!subscription.active) return;
      if (terminal !== undefined) endAttach(subscription, terminal);
      else if (options.control.isSessionKilled(params.sessionId))
        endAttach(subscription, "session_killed");
    });
    return {
      sessionId: params.sessionId,
      subscriptionId: subscription.subscriptionId,
      target,
      window: {
        truncated: replay.truncated,
        oldest: replay.oldest,
        head: replay.head,
      },
      replayed: replay.entries.length,
    };
  }

  async function dispatch(
    connection: TransportConnection<ProtocolMessage>,
    request: ProtocolRequest,
    consumer: ConsumerContext | undefined,
  ): Promise<unknown> {
    // 请求因果贯穿整条处理链：诊断归属、会话声明与范围检查共用这一份绑定。
    switch (request.method) {
      case "initialize": {
        const params = request.params as InitializeParams;
        if (params.protocolMajorVersion !== REINS_PROTOCOL_MAJOR_VERSION) {
          throw {
            code: "protocol_version_mismatch",
            requestedProtocolMajorVersion: params.protocolMajorVersion,
            supportedProtocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
          } satisfies MachineError;
        }
        if (
          params.runtimeScopeId !== undefined &&
          params.runtimeScopeId !== options.runtimeScopeId
        ) {
          throw {
            code: "runtime_scope_mismatch",
            requestedRuntimeScopeId: params.runtimeScopeId,
            actualRuntimeScopeId: options.runtimeScopeId,
          } satisfies MachineError;
        }
        const bound = consumerBindings.get(connection);
        if (bound !== undefined && bound !== params.consumerContext) {
          throw { code: "protocol_error" } satisfies MachineError;
        }
        consumerBindings.set(connection, params.consumerContext);
        return {
          protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
          daemonGeneration: options.diagnostics.generation,
          runtimeScopeId: options.runtimeScopeId,
        } satisfies InitializeResult;
      }
      case "modelCatalog":
      case "spawn":
      case "send":
      case "wait":
      case "interrupt":
      case "kill":
      case "list":
      case "resolvePermission":
        return await options.control.dispatch(
          request.method,
          request.params,
          consumer,
        );
      case "diagnostics":
        testing.onDiagnosticsQueryAccepted?.();
        return await options.control.dispatch(
          request.method,
          request.params,
          consumer,
        );
      case "attach":
        return attach(
          connection,
          request.params as AttachParams,
          request,
          consumer,
        );
      default:
        return unsupportedProtocolMethod(request.method);
    }
  }

  // 请求因果贯穿整条处理链：诊断归属、会话声明与范围检查共用这一份绑定。
  function handleMessageWithBinding(
    connection: TransportConnection<ProtocolMessage>,
    message: ProtocolMessage,
  ): void {
    const consumer = consumerBindings.get(connection);
    if (consumer === undefined) {
      handleMessage(connection, message);
      return;
    }
    consumerScope.within(consumer, () => handleMessage(connection, message));
  }

  function handleConnection(
    connection: TransportConnection<ProtocolMessage>,
  ): void {
    connections.add(connection);
    const cleanup = new Set<() => void>();
    cleanupByConnection.set(connection, cleanup);
    const unsubscribe = connection.onEvent((event) => {
      if (event.kind === "message") {
        if (quiescing) rejectDuringShutdown(connection, event.message);
        else if (acceptingRequests)
          handleMessageWithBinding(connection, event.message);
        else pendingMessages.push({ connection, message: event.message });
      }
      if (event.kind === "error") {
        recordTransportFailure(
          connection,
          transportFailureFactOf(event.error) ?? connectionIoFailure,
        );
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
    consumerBindings.delete(connection);
    for (const subscription of Array.from(attachSubscriptions)) {
      if (subscription.connection === connection) {
        subscription.active = false;
        attachSubscriptions.delete(subscription);
      }
    }
    cleanupByConnection.get(connection)?.forEach((unsubscribe) => {
      unsubscribe();
    });
    cleanupByConnection.delete(connection);
    connections.delete(connection);
    for (let index = pendingMessages.length - 1; index >= 0; index -= 1) {
      if (pendingMessages[index]?.connection === connection) {
        pendingMessages.splice(index, 1);
      }
    }
    scheduleIdleExit();
  }

  return {
    async start() {
      if (quiescing) {
        const activeShutdown = shutdownPromise;
        if (activeShutdown !== undefined) await activeShutdown;
        if (shutdownFailure !== undefined) throw shutdownFailure;
        return;
      }
      options.transport.onConnection(handleConnection);
      startSetup = (async () => {
        try {
          await options.transport.listen();
        } catch (error) {
          const fact = transportFailureFactOf(error);
          await recordDiagnostic(fact ?? listenIoFailure);
          if (fact !== undefined) throw error;
          throw createTransportError({
            code: "io_error",
            fact: listenIoFailure,
          });
        }
        const diagnosticId = await recordDiagnostic({
          kind: "lifecycle",
          operation: "daemon",
          reason: "started",
        });
        if (diagnosticId === undefined) {
          throw new Error("Daemon start lifecycle was not accepted");
        }
        daemonStarted = true;
        if (shuttingDown) return;
        acceptingRequests = true;
        for (const pending of pendingMessages.splice(0)) {
          if (connections.has(pending.connection)) {
            handleMessageWithBinding(pending.connection, pending.message);
          }
        }
        scheduleIdleExit();
      })();
      try {
        await startSetup;
      } catch (startError) {
        try {
          await shutdown("stopped");
        } catch (closeError) {
          throw new AggregateError(
            [startError, closeError],
            "Daemon startup and cleanup failed",
            { cause: startError },
          );
        }
        throw startError;
      }
      if (shuttingDown) {
        const activeShutdown = shutdownPromise;
        if (activeShutdown !== undefined) await activeShutdown;
        if (shutdownFailure !== undefined) throw shutdownFailure;
        return;
      }
      await started;
      if (shutdownFailure !== undefined) throw shutdownFailure;
    },
    quiesce,
    async stop() {
      await shutdown("stopped");
    },
  };
}
