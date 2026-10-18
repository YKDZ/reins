import {
  createAgentFact,
  projectSubscriptionTarget,
  type SubscribeFacts,
  type FactSubscription,
} from "./subscription.ts";
export type {
  AgentEstablishment,
  AgentTarget,
  AgentFact,
  FactSubscription,
  FactSubscriptionEnd,
} from "./subscription.ts";
import { randomUUID } from "node:crypto";

import type {
  ConsumerContext,
  DaemonGeneration,
  DomainEvent,
  EventId,
  AttachEnded,
  ResumeCursor,
  SideEffectMethod,
  OperationKey,
  MachineError,
  ProtocolMessage,
  ProtocolMethod,
  ProtocolNotification,
  ProtocolParams,
  ProtocolResponse,
  ProtocolResult,
  RuntimeScopeId,
} from "@reins/protocol";
import {
  encodeResumeCursor,
  decodeResumeCursor,
  operationKeyClaimsSchema,
  parseOperationKey,
  serializeOperationKey,
  isSideEffectMethod,
  protocolNotificationSchema,
  protocolResponseSchema,
  protocolResultSchemaFor,
  REINS_PROTOCOL_MAJOR_VERSION,
  requestIdSchema,
} from "@reins/protocol";
import type { TransportConnection } from "@reins/transport";
import * as v from "valibot";

export type NotificationListener = (notification: ProtocolNotification) => void;

export type ClientResult<M extends ProtocolMethod> = ProtocolResult<M>;

export type ProtocolResponseFor<M extends ProtocolMethod> =
  | Extract<ProtocolResponse, { readonly error: unknown }>
  | (Omit<Extract<ProtocolResponse, { readonly result: unknown }>, "result"> & {
      readonly result: ClientResult<M>;
    });

export type ReinsClientOptions = {
  // 消费者绑定由调用方（launcher / 显式 client binding）给出，客户端不猜默认值。
  consumerContext: ConsumerContext;
  runtimeScopeId?: RuntimeScopeId;
};

export type ReinsClient = {
  initialize(timeoutMs?: number): Promise<ProtocolResponseFor<"initialize">>;
  // wait 只使用领域预算；attach 持续到显式关闭或终止，其他请求有传输预算。
  request<M extends ProtocolMethod>(
    method: M,
    params: ProtocolParams<M>,
    timeoutMs?: number,
  ): Promise<ProtocolResponseFor<M>>;
  prepareOperation<Kind extends SideEffectMethod>(
    method: Kind,
  ): OperationKey<Kind>;
  executeOperation<M extends SideEffectMethod>(
    method: M,
    params: ProtocolParams<M>,
    operationKey: OperationKey<M>,
    timeoutMs?: number,
  ): Promise<ProtocolResponseFor<M>>;
  getOperation(
    operationKey: OperationKey,
    timeoutMs?: number,
  ): Promise<ProtocolResponseFor<"getOperation">>;
  onNotification(listener: NotificationListener): () => void;
  onClosed(listener: (reason: MachineError) => void): () => void;
  subscribeFacts: SubscribeFacts;
  close(): void;
};

export class AgentSubscriptionError extends Error {
  readonly failure: MachineError;
  readonly resumeCursor?: ResumeCursor;

  constructor(failure: MachineError, resumeCursor?: ResumeCursor) {
    super(failure.code);
    this.name = "AgentSubscriptionError";
    this.failure = failure;
    if (resumeCursor !== undefined) this.resumeCursor = resumeCursor;
  }
}

export type ReinsClientFailure = MachineError;
export class ReinsClientError extends Error {
  readonly failure: ReinsClientFailure;

  constructor(failure: ReinsClientFailure) {
    super(JSON.stringify(failure));
    this.name = "ReinsClientError";
    this.failure = failure;
  }
}

function createAbortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

type ClientMachineErrorCode =
  | "invalid_daemon_response"
  | "daemon_disconnected"
  | "daemon_timeout";

function clientMachineError(code: ClientMachineErrorCode): MachineError {
  return { code } satisfies MachineError;
}

// 协议客户端：请求/响应按 requestId 关联，通知分发给订阅者；
// 响应结果按方法 schema 校验后才交给调用方（双端严格校验）。
export function createReinsClient(
  connection: TransportConnection<ProtocolMessage>,
  options: ReinsClientOptions,
): ReinsClient {
  let seq = 0;
  let generation: DaemonGeneration | undefined;
  let runtimeScopeId: RuntimeScopeId | undefined;
  const pending = new Map<
    string,
    {
      resolve: (response: ProtocolResponse) => void;
      reject: (error: Error) => void;
      unknown?: () => Error;
    }
  >();
  const cancelledResponses = new Map<
    string,
    (response: ProtocolResponse) => void
  >();
  const listeners = new Set<NotificationListener>();
  const closedListeners = new Set<(reason: MachineError) => void>();
  let closed = false;
  let terminalReason: MachineError | undefined;
  const terminate = (reason: MachineError): void => {
    if (closed) return;
    closed = true;
    terminalReason = reason;
    const error = new ReinsClientError(reason);
    for (const entry of pending.values())
      entry.reject(entry.unknown?.() ?? error);
    pending.clear();
    cancelledResponses.clear();
    for (const listener of Array.from(closedListeners)) listener(reason);
  };

  const createOperationKey = <Kind extends SideEffectMethod>(
    method: Kind,
  ): OperationKey<Kind> => {
    if (generation === undefined || runtimeScopeId === undefined)
      throw new ReinsClientError({ code: "protocol_error" });
    return serializeOperationKey(
      v.parse(operationKeyClaimsSchema, {
        runtimeScopeId,
        consumer: options.consumerContext,
        kind: method,
        generation,
        nonce: randomUUID(),
      }),
    ) as OperationKey<Kind>;
  };
  const unsubscribe = connection.onEvent((event) => {
    if (event.kind === "message") {
      const message = event.message;
      const response = v.safeParse(protocolResponseSchema, message);
      if (response.success) {
        const responseMessage = response.output;
        const entry = pending.get(responseMessage.requestId);
        if (entry !== undefined) {
          entry.resolve(responseMessage);
          return;
        }
        const closeCancelled = cancelledResponses.get(
          responseMessage.requestId,
        );
        if (closeCancelled !== undefined) {
          cancelledResponses.delete(responseMessage.requestId);
          closeCancelled(responseMessage);
        }
        return;
      }
      const notification = v.safeParse(protocolNotificationSchema, message);
      if (notification.success) {
        for (const listener of Array.from(listeners)) {
          listener(notification.output);
        }
        return;
      }
      terminate(clientMachineError("invalid_daemon_response"));
      return;
    }
    terminate(clientMachineError("daemon_disconnected"));
  });

  const request = <M extends ProtocolMethod>(
    method: M,
    params: ProtocolParams<M>,
    timeoutMs = 30_000,
    operationKey?: OperationKey,
    signal?: AbortSignal,
    onCancelledResponse?: (response: ProtocolResponse) => void,
  ): Promise<ProtocolResponseFor<M>> => {
    if (signal?.aborted) return Promise.reject(createAbortError());
    if (closed) {
      return Promise.reject(
        new ReinsClientError(clientMachineError("daemon_disconnected")),
      );
    }
    const effect = isSideEffectMethod(method);
    if (effect && generation === undefined)
      return Promise.reject(new ReinsClientError({ code: "protocol_error" }));
    const requestOperationKey = effect
      ? (operationKey ?? createOperationKey(method))
      : undefined;
    const unknown = (): ReinsClientError => {
      return new ReinsClientError({
        code: "operation_outcome_unknown",
        operationKey: requestOperationKey!,
      });
    };
    seq += 1;
    const requestId = v.parse(requestIdSchema, `req${seq}`);
    return new Promise<ProtocolResponseFor<M>>((resolve, reject) => {
      let settled = false;
      let abortListener: (() => void) | undefined;
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (abortListener !== undefined)
          signal?.removeEventListener("abort", abortListener);
        pending.delete(requestId);
        action();
      };
      // wait 的预算由 daemon 拥有，attach 不继承普通请求时限；断连仍独立报错。
      const timer =
        method === "wait" || method === "attach"
          ? null
          : setTimeout(() => {
              settle(() =>
                reject(
                  requestOperationKey === undefined
                    ? new ReinsClientError(clientMachineError("daemon_timeout"))
                    : unknown(),
                ),
              );
            }, timeoutMs);
      if (signal !== undefined) {
        abortListener = () => {
          if (settled) return;
          if (onCancelledResponse !== undefined)
            cancelledResponses.set(requestId, onCancelledResponse);
          settle(() => reject(createAbortError()));
        };
      }
      pending.set(requestId, {
        ...(requestOperationKey === undefined ? {} : { unknown }),
        resolve: (response) => {
          if ("error" in response) {
            settle(() => resolve(response));
            return;
          }
          const parsed = v.safeParse(
            protocolResultSchemaFor(method),
            response.result,
          );
          if (!parsed.success) {
            terminate(clientMachineError("invalid_daemon_response"));
            return;
          }
          settle(() => {
            if (method === "initialize") {
              const initialized = parsed.output as ProtocolResult<"initialize">;
              generation = initialized.daemonGeneration;
              runtimeScopeId = initialized.runtimeScopeId;
            }
            resolve({ ...response, result: parsed.output });
          });
        },
        reject: (error) => settle(() => reject(error)),
      });
      if (signal !== undefined && abortListener !== undefined) {
        signal.addEventListener("abort", abortListener, { once: true });
        if (signal.aborted) {
          abortListener();
          return;
        }
      }
      try {
        connection.send({
          kind: "request",
          requestId,
          method,
          ...(requestOperationKey === undefined
            ? {}
            : { operationKey: requestOperationKey }),
          params,
        });
      } catch {
        terminate(clientMachineError("daemon_disconnected"));
      }
    });
  };

  type RawEvent = { event: DomainEvent; eventId: EventId };
  type RawSubscriptionEnd = {
    target: ReturnType<typeof projectSubscriptionTarget>;
    reason: AttachEnded["reason"];
    lastEventId: EventId | null;
  };
  type RawSubscription = AsyncIterableIterator<RawEvent> & {
    readonly establishment: NonNullable<ProtocolResult<"attach">>;
    readonly done: Promise<RawSubscriptionEnd>;
    readonly checkpoint: ResumeCursor;
    close(): void;
  };

  const subscribeRaw = async (
    params: ProtocolParams<"attach">,
    signal?: AbortSignal,
  ) => {
    const queued: RawEvent[] = [];
    const initial: ProtocolNotification[] = [];
    let establishment: ProtocolResult<"attach"> | undefined;
    let ended = false;
    let localClose = false;
    let lastDeliveredPosition = 0;
    let failure: Error | undefined;
    const waiters: Array<() => void> = [];
    let resolveDone!: (end: RawSubscriptionEnd) => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<RawSubscriptionEnd>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    void done.catch(() => undefined);
    const wake = () => {
      for (const resume of waiters.splice(0)) resume();
    };
    const cleanup = () => {
      listeners.delete(receive);
      closedListeners.delete(disconnect);
    };
    const cursorAt = (position: number): ResumeCursor =>
      encodeResumeCursor({
        target: establishment!.target,
        daemonGeneration: generation!,
        eventId: position,
      });
    const disconnect = (reason: MachineError) => {
      if (ended) return;
      ended = true;
      failure = new AgentSubscriptionError(
        reason,
        reason.code === "daemon_disconnected" &&
          establishment !== undefined &&
          generation !== undefined
          ? cursorAt(lastDeliveredPosition)
          : undefined,
      );
      cleanup();
      rejectDone(failure);
      wake();
    };
    const receive = (notification: ProtocolNotification) => {
      if (establishment === undefined) {
        initial.push(notification);
        return;
      }
      if (
        notification.params.subscriptionId !== establishment.subscriptionId ||
        ended
      )
        return;
      if (notification.method === "event") {
        queued.push({
          event: notification.params.event,
          eventId: notification.params.eventId,
        });
      } else {
        ended = true;
        cleanup();
        const end = {
          target: projectSubscriptionTarget(notification.params.target),
          reason: notification.params.reason,
          lastEventId: notification.params.lastEventId,
        };
        resolveDone(end);
      }
      wake();
    };
    listeners.add(receive);
    closedListeners.add(disconnect);
    try {
      const response = await request(
        "attach",
        params,
        30_000,
        undefined,
        signal,
        (lateResponse) => {
          if ("error" in lateResponse) return;
          const parsed = v.safeParse(
            protocolResultSchemaFor("attach"),
            lateResponse.result,
          );
          if (!parsed.success) {
            terminate(clientMachineError("invalid_daemon_response"));
            return;
          }
          try {
            connection.send({
              kind: "control",
              method: "subscription.close",
              subscriptionId: parsed.output.subscriptionId,
            });
          } catch {
            terminate(clientMachineError("daemon_disconnected"));
          }
        },
      );
      if (signal?.aborted) {
        if (!("error" in response)) {
          try {
            connection.send({
              kind: "control",
              method: "subscription.close",
              subscriptionId: response.result.subscriptionId,
            });
          } catch {
            terminate(clientMachineError("daemon_disconnected"));
          }
        }
        throw createAbortError();
      }
      if ("error" in response) throw new ReinsClientError(response.error);
      establishment = response.result;
      lastDeliveredPosition =
        params.replay.mode === "after"
          ? decodeResumeCursor(params.replay.cursor).eventId
          : params.replay.mode === "none"
            ? (establishment.window.head ?? 0)
            : (establishment.window.oldest ?? 1) - 1;
      const beforeReady = initial.splice(0);
      for (const notification of beforeReady) receive(notification);
    } catch (error) {
      cleanup();
      throw error;
    }
    const raw: RawSubscription = {
      establishment,
      done,
      get checkpoint() {
        return cursorAt(lastDeliveredPosition);
      },
      async next() {
        while (queued.length === 0 && !ended && !localClose)
          await new Promise<void>((resolve) => waiters.push(resolve));
        if (queued.length > 0) {
          const value = queued.shift()!;
          lastDeliveredPosition = value.eventId;
          return { value, done: false };
        }
        if (failure instanceof AgentSubscriptionError) {
          throw new AgentSubscriptionError(
            failure.failure,
            failure.resumeCursor === undefined
              ? undefined
              : cursorAt(lastDeliveredPosition),
          );
        }
        if (failure !== undefined) throw failure;
        return { value: undefined, done: true };
      },
      async return() {
        raw.close();
        return { value: undefined, done: true };
      },
      async throw(error?: unknown) {
        raw.close();
        throw error;
      },
      [Symbol.asyncIterator]() {
        return raw;
      },
      close() {
        if (ended || localClose) return;
        localClose = true;
        queued.length = 0;
        try {
          connection.send({
            kind: "control",
            method: "subscription.close",
            subscriptionId: establishment.subscriptionId,
          });
        } catch {
          terminate(clientMachineError("daemon_disconnected"));
          return;
        }
        ended = true;
        cleanup();
        const end = {
          target: projectSubscriptionTarget(establishment.target),
          reason: "closed" as const,
          lastEventId:
            lastDeliveredPosition === 0
              ? null
              : (lastDeliveredPosition as EventId),
        };
        resolveDone(end);
        wake();
      },
    };
    return raw;
  };

  const subscribeFacts: SubscribeFacts = async (params, signal) => {
    if (signal?.aborted) throw createAbortError();
    const raw = await subscribeRaw(params, signal);
    const factDone = raw.done.then(({ target, reason }) => ({
      target,
      reason,
    }));
    let finished = false;
    const abort = () => raw.close();
    if (signal !== undefined) {
      if (signal.aborted) raw.close();
      else signal.addEventListener("abort", abort, { once: true });
      void factDone.then(
        () => signal.removeEventListener("abort", abort),
        () => signal.removeEventListener("abort", abort),
      );
    }
    const subscription: FactSubscription = {
      establishment: {
        target: projectSubscriptionTarget(raw.establishment.target),
        window: raw.establishment.window,
        replayed: raw.establishment.replayed,
      },
      done: factDone,
      get checkpoint() {
        return raw.checkpoint;
      },
      async next() {
        if (finished) return { value: undefined, done: true };
        const result = await raw.next();
        if (result.done) {
          finished = true;
          return { value: undefined, done: true };
        }
        if (generation === undefined)
          throw new AgentSubscriptionError(
            clientMachineError("invalid_daemon_response"),
          );
        return {
          value: createAgentFact(
            result.value.event,
            result.value.eventId,
            generation,
          ),
          done: false,
        };
      },
      async return() {
        finished = true;
        raw.close();
        return { value: undefined, done: true };
      },
      async throw(error?: unknown) {
        finished = true;
        raw.close();
        throw error;
      },
      [Symbol.asyncIterator]() {
        return subscription;
      },
      close() {
        finished = true;
        raw.close();
      },
    };
    return subscription;
  };

  return {
    initialize(timeoutMs) {
      return request(
        "initialize",
        {
          protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
          consumerContext: options.consumerContext,
          ...(options.runtimeScopeId === undefined
            ? {}
            : { runtimeScopeId: options.runtimeScopeId }),
        },
        timeoutMs,
      );
    },
    request,
    subscribeFacts,
    prepareOperation<Kind extends SideEffectMethod>(
      method: Kind,
    ): OperationKey<Kind> {
      return createOperationKey(method);
    },
    executeOperation(method, params, key, timeoutMs) {
      let claims: ReturnType<typeof parseOperationKey>;
      try {
        claims = parseOperationKey(key, method);
      } catch {
        throw new ReinsClientError({ code: "operation_key_conflict" });
      }
      if (
        claims.runtimeScopeId !== runtimeScopeId ||
        claims.consumer !== options.consumerContext
      )
        throw new ReinsClientError({ code: "operation_key_scope_mismatch" });
      if (claims.generation !== generation)
        throw new ReinsClientError({ code: "stale_operation_key" });
      return request(method, params, timeoutMs, key);
    },
    getOperation(key, timeoutMs) {
      let claims: ReturnType<typeof parseOperationKey>;
      try {
        claims = parseOperationKey(key);
      } catch {
        throw new ReinsClientError({ code: "operation_key_conflict" });
      }
      if (
        claims.runtimeScopeId !== runtimeScopeId ||
        claims.consumer !== options.consumerContext
      )
        throw new ReinsClientError({ code: "operation_key_scope_mismatch" });
      return request("getOperation", { operationKey: key }, timeoutMs);
    },
    onNotification(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onClosed(listener) {
      if (terminalReason !== undefined) {
        listener(terminalReason);
        return () => {};
      }
      closedListeners.add(listener);
      return () => {
        closedListeners.delete(listener);
      };
    },
    close() {
      unsubscribe();
      terminate(clientMachineError("daemon_disconnected"));
      closedListeners.clear();
      connection.close();
    },
  };
}
