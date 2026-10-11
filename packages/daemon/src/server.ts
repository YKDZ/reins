import { stat } from "node:fs/promises";

import { isAlreadyDiagnosedError } from "@reins/adapter-kit";
import type { SessionMachine } from "@reins/core";
import type {
  AttachParams,
  AttachResult,
  SubscriptionTarget,
  SubscriptionId,
  EventId,
  CapabilitiesResult,
  ConsumerContext,
  DaemonDiagnosticFact,
  DomainEvent,
  DiagnosticsParams,
  HarnessCapability,
  InitializeParams,
  InitializeResult,
  InterruptParams,
  KillParams,
  KillResult,
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
  TransportFailureFact,
  WaitParams,
} from "@reins/protocol";
import {
  isSideEffectMethod,
  decodeResumeCursor,
  eventIdSchema,
  subscriptionIdSchema,
  subscriptionCloseSchema,
  machineErrorSchema,
  harnessCapabilitySchema,
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
  orderDiagnosticsAcceptance,
  type OrderedDiagnosticsRuntime,
} from "./diagnostics-acceptance.ts";
import type { DiagnosticsRuntime } from "./diagnostics-recorder.ts";
import type { AdapterRegistry } from "./registry.ts";

export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_EVENT_LOG_LIMIT = 1000;

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
  pendingEvents: { event: DomainEvent; eventId: EventId }[];
  active: boolean;
  readonly connection: TransportConnection<ProtocolMessage>;
};

type Observation = {
  activeTurnId?: TurnId;
  lastCompleted?: Extract<DomainEvent, { type: "turn.completed" }>;
  killed: boolean;
};

type EventHistory = {
  readonly events: DomainEvent[];
};

function unsupportedProtocolMethod(value: ProtocolRequest["method"]): never {
  throw new Error(`unexpected protocol method: ${String(value)}`);
}

export type ProtocolServer = {
  start(): Promise<void>;
  quiesce(): void;
  stop(): Promise<void>;
  forwardEvent(event: DomainEvent): void;
};

type ProtocolServerOptions = {
  transport: TransportServer<ProtocolMessage>;
  machine: SessionMachine;
  adapters: AdapterRegistry;
  diagnostics: OrderedDiagnosticsRuntime;
  consumerScope: ConsumerScope;
  idleTimeoutMs?: number;
  eventLogLimit?: number;
};

type ProtocolServerTestingOptions = {
  beforeAttachReplay?: (sessionId: SessionId) => void;
  onDiagnosticsQueryAccepted?: () => void;
};

export function createProtocolServer(
  options: Omit<ProtocolServerOptions, "diagnostics" | "consumerScope"> & {
    diagnostics: DiagnosticsRuntime;
  },
): ProtocolServer {
  const consumerScope = createConsumerScope();
  return createProtocolServerInternal(
    {
      ...options,
      consumerScope,
      diagnostics: orderDiagnosticsAcceptance(
        options.diagnostics,
        consumerScope,
      ),
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
  const eventLogLimit = options.eventLogLimit ?? DEFAULT_EVENT_LOG_LIMIT;
  const connections = new Set<TransportConnection<ProtocolMessage>>();
  const attachSubscriptions = new Set<AttachSubscription>();
  const afterAttachAck = new Map<ProtocolRequest, () => void>();
  const cleanupByConnection = new Map<
    TransportConnection<ProtocolMessage>,
    Set<() => void>
  >();
  const eventLog = new Map<SessionId, EventHistory>();
  const eventPositions = new WeakMap<DomainEvent, EventId>();
  const eventHeads = new Map<SessionId, EventId>();
  let subscriptionSequence = 0;
  const observations = new Map<SessionId, Observation>();
  const knownSessions = new Set<SessionId>();
  // initialize 握手建立的连接级消费者绑定；连接关闭即释放。
  const consumerBindings = new Map<
    TransportConnection<ProtocolMessage>,
    ConsumerContext
  >();
  const consumerScope = options.consumerScope;
  // 账本归属于 daemon 世代；断连只移除观察者，不取消原执行。
  const commands = new Map<
    string,
    {
      consumer: ConsumerContext | undefined;
      fingerprint: string;
      outcome: Promise<{ result: unknown } | { error: MachineError }>;
    }
  >();
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
        return { result: await dispatch(connection, request) };
      } catch (error) {
        return { error: await toMachineError(error) };
      }
    };
    if (!isSideEffectMethod(request.method)) return perform();
    if (request.commandId === undefined)
      return { error: { code: "protocol_error" } };
    if (request.commandId.split(":")[0] !== options.diagnostics.generation)
      return { error: { code: "stale_command_id" } };
    const fingerprint = canonical({
      method: request.method,
      params: request.params,
    });
    const key = request.commandId;
    const existing = commands.get(key);
    if (existing !== undefined)
      return existing.consumer === consumer &&
        existing.fingerprint === fingerprint
        ? existing.outcome
        : { error: { code: "command_id_conflict" } };
    // 先登记再调用业务，确保同步发起的重入也只能加入原 Promise。
    const outcome = Promise.resolve().then(perform);
    commands.set(key, { consumer, fingerprint, outcome });
    return outcome;
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
    return options.machine.list().some((session) => session.state !== "killed");
  }

  function isIdle(): boolean {
    return connections.size === 0 && !hasLiveSessions();
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

  function appendLog(event: DomainEvent): void {
    const history = eventLog.get(event.sessionId) ?? {
      events: [],
    };
    history.events.push(event);
    if (history.events.length > eventLogLimit)
      history.events.splice(0, history.events.length - eventLogLimit);
    eventLog.set(event.sessionId, history);
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

  function forwardEvent(event: DomainEvent): void {
    if (event.type === "session.created") {
      knownSessions.add(event.sessionId);
      // 归属在会话身份产生的那一刻确立，早于任何成功返回。
      const consumer = consumerScope.current();
      if (consumer !== undefined)
        consumerScope.claim(event.sessionId, consumer);
    }
    const eventId = v.parse(
      eventIdSchema,
      (eventHeads.get(event.sessionId) ?? 0) + 1,
    );
    eventHeads.set(event.sessionId, eventId);
    eventPositions.set(event, eventId);
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
      if (subscription.replaying)
        subscription.pendingEvents.push({ event, eventId });
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
    void execute(connection, request).then((outcome) => {
      sendSafe(connection, {
        kind: "response",
        requestId: request.requestId,
        ...outcome,
      });
      const release = afterAttachAck.get(request);
      afterAttachAck.delete(request);
      if ("result" in outcome) release?.();
    });
  }

  async function aggregateCapabilities(): Promise<CapabilitiesResult> {
    async function verifiedCapabilityDiagnostic(
      error: unknown,
      harness: string,
    ) {
      if (!isAlreadyDiagnosedError(error) || error.diagnosticId === undefined) {
        return undefined;
      }
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

    const entries = Array.from(options.adapters.entries());
    const results = await Promise.allSettled(
      entries.map(async ([harness, adapter]) =>
        adapter.capabilities(async (input) => {
          const unsafe = input as unknown as Record<string, unknown>;
          if ("source" in unsafe || "harness" in unsafe) {
            return undefined;
          }
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

  async function attach(
    connection: TransportConnection<ProtocolMessage>,
    params: AttachParams,
    request: ProtocolRequest,
  ): Promise<AttachResult> {
    assertSessionScope(params.sessionId);
    if (!knownSessions.has(params.sessionId))
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
        ? { scope: "turn", sessionId: params.sessionId, turnId: params.turnId }
        : { scope: "session", sessionId: params.sessionId };
    const history = eventLog.get(params.sessionId);
    const head = eventHeads.get(params.sessionId) ?? null;
    const first = history?.events[0];
    const oldest = first === undefined ? null : eventPositions.get(first)!;
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
      ) {
        throw {
          code: "invalid_params",
          issues: [{ issue: "invalid_value", path: "replay.cursor" }],
        } satisfies MachineError;
      }
      if (
        head !== null &&
        (oldest === null || oldest > 1) &&
        cursor.eventId < (oldest ?? head + 1)
      )
        throw {
          code: "event_cursor_expired",
          oldest,
          head,
        } satisfies MachineError;
      after = cursor.eventId;
    }
    const replayEvents =
      params.replay.mode === "none"
        ? []
        : (history?.events ?? []).filter(
            (event) =>
              (after === undefined || eventPositions.get(event)! > after) &&
              (target.scope === "session" ||
                ("turnId" in event && event.turnId === target.turnId)),
          );
    const subscription: AttachSubscription = {
      sessionId: params.sessionId,
      target,
      subscriptionId: v.parse(
        subscriptionIdSchema,
        "subscription-" + ++subscriptionSequence,
      ),
      lastEventId:
        after === undefined
          ? head
          : after === 0
            ? null
            : v.parse(eventIdSchema, after),
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
        const snapshot = await options.machine.wait({
          targets: [{ sessionId: target.sessionId, turnId: target.turnId }],
          completion: "all",
          timeoutMs: 0,
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
      for (const event of replayEvents)
        forwardToSubscription(subscription, event, eventPositions.get(event)!);
      subscription.replaying = false;
      for (const { event, eventId } of subscription.pendingEvents.splice(0))
        forwardToSubscription(subscription, event, eventId);
      if (!subscription.active) return;
      if (terminal !== undefined) endAttach(subscription, terminal);
      else if (observations.get(params.sessionId)?.killed)
        endAttach(subscription, "session_killed");
    });
    return {
      sessionId: params.sessionId,
      subscriptionId: subscription.subscriptionId,
      target,
      window: {
        truncated:
          head !== null &&
          (first === undefined || eventPositions.get(first)! > 1),
        oldest: first === undefined ? null : eventPositions.get(first)!,
        head,
      },
      replayed: replayEvents.length,
    };
  }

  // 会话归属之外的消费者把该会话按不存在呈现，投影与"未知 id"完全一致。
  function isForeignSession(sessionId: SessionId): boolean {
    const consumer = consumerScope.current();
    return (
      consumer !== undefined && !consumerScope.inScope(consumer, sessionId)
    );
  }

  function assertSessionScope(sessionId: SessionId): void {
    if (isForeignSession(sessionId)) {
      throw { code: "session_not_found", sessionId } satisfies MachineError;
    }
  }

  async function dispatch(
    connection: TransportConnection<ProtocolMessage>,
    request: ProtocolRequest,
  ): Promise<unknown> {
    // execute 已在接纳时核验并捕获绑定；连接随后关闭不能取消已接纳命令。
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
        const bound = consumerBindings.get(connection);
        if (bound !== undefined && bound !== params.consumerContext) {
          throw { code: "protocol_error" } satisfies MachineError;
        }
        consumerBindings.set(connection, params.consumerContext);
        return {
          protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
          daemonGeneration: options.diagnostics.generation,
        } satisfies InitializeResult;
      }
      case "capabilities":
        return await aggregateCapabilities();
      case "spawn":
        const spawnParams = request.params as SpawnParams;
        try {
          const directory = await stat(spawnParams.cwd, { bigint: true });
          if (
            !directory.isDirectory() ||
            (spawnParams.cwdIdentity !== undefined &&
              (spawnParams.cwdIdentity.device !== String(directory.dev) ||
                spawnParams.cwdIdentity.inode !== String(directory.ino)))
          ) {
            throw new Error("Not a directory");
          }
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
        ) {
          throw {
            code: "unsupported_feature",
            feature: "capture_harness_stderr",
          } satisfies MachineError;
        }
        return await options.machine.spawn(spawnParams);
      case "send": {
        const params = request.params as SendParams;
        assertSessionScope(params.sessionId);
        return await options.machine.send(params);
      }
      case "wait": {
        const params = request.params as WaitParams;
        for (const target of params.targets)
          assertSessionScope(target.sessionId);
        return await options.machine.wait(params);
      }
      case "interrupt": {
        const params = request.params as InterruptParams;
        assertSessionScope(params.sessionId);
        return await options.machine.interrupt(params);
      }
      case "kill": {
        const params = request.params as KillParams;
        return isForeignSession(params.sessionId)
          ? ({
              sessionId: params.sessionId,
              status: "not_found",
            } satisfies KillResult)
          : await options.machine.kill(params);
      }
      case "list": {
        const listed = options.machine.list(
          request.params as ListFilter | undefined,
        );
        const consumer = consumerScope.current();
        return consumer === undefined
          ? listed
          : listed.filter((session) =>
              consumerScope.inScope(consumer, session.sessionId),
            );
      }
      case "attach":
        return attach(connection, request.params as AttachParams, request);
      case "resolvePermission": {
        const params = request.params as ResolvePermissionParams;
        assertSessionScope(params.sessionId);
        await options.machine.resolvePermission(params);
        return {
          sessionId: params.sessionId,
          permissionId: params.permissionId,
          turnId: params.turnId,
        };
      }
      case "diagnostics":
        testing.onDiagnosticsQueryAccepted?.();
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
    forwardEvent,
  };
}
