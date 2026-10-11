import { randomUUID } from "node:crypto";

import type {
  ConsumerContext,
  CommandId,
  DaemonGeneration,
  SideEffectMethod,
  MachineError,
  ProtocolMessage,
  ProtocolMethod,
  ProtocolNotification,
  ProtocolParams,
  ProtocolResponse,
  ProtocolResult,
} from "@reins/protocol";
import {
  commandIdSchema,
  daemonGenerationSchema,
  sideEffectMethodSchema,
  sessionIdSchema,
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

export type ProtocolResponseFor<M extends ProtocolMethod> =
  | Extract<ProtocolResponse, { readonly error: unknown }>
  | (Omit<Extract<ProtocolResponse, { readonly result: unknown }>, "result"> & {
      readonly result: ProtocolResult<M>;
    });

export type ReinsClientOptions = {
  // 消费者绑定由调用方（launcher / 显式 client binding）给出，客户端不猜默认值。
  consumerContext: ConsumerContext;
};

export type ReinsClient = {
  initialize(timeoutMs?: number): Promise<ProtocolResponseFor<"initialize">>;
  request<M extends ProtocolMethod>(
    method: M,
    params: ProtocolParams<M>,
    timeoutMs?: number,
  ): Promise<ProtocolResponseFor<M>>;
  retry(
    token: string,
    params: unknown,
    timeoutMs?: number,
  ): Promise<ProtocolResponseFor<SideEffectMethod>>;
  onNotification(listener: NotificationListener): () => void;
  onClosed(listener: (reason: MachineError) => void): () => void;
  close(): void;
};

// 仅保留原目标的目录事实；敏感任务文本、模型输入与授权反馈由调用方重带。
const spawnContextSchema = v.strictObject({
  cwd: v.optional(v.string()),
  cwdIdentity: v.optional(
    v.strictObject({
      device: v.pipe(v.string(), v.regex(/^[0-9]+$/u)),
      inode: v.pipe(v.string(), v.regex(/^[0-9]+$/u)),
    }),
  ),
});
const retryIdentitySchema = v.strictObject({
  method: sideEffectMethodSchema,
  commandId: commandIdSchema,
  daemonGeneration: daemonGenerationSchema,
  spawnContext: v.optional(spawnContextSchema),
});
export function parseRetryToken(
  token: string,
): v.InferOutput<typeof retryIdentitySchema> {
  if (!/^retry1_[A-Za-z0-9_-]+$/.test(token))
    throw new Error("Invalid RetryToken");
  const identity = v.parse(
    retryIdentitySchema,
    JSON.parse(Buffer.from(token.slice(7), "base64url").toString("utf8")),
  );
  if (identity.commandId.split(":")[0] !== identity.daemonGeneration)
    throw new Error("Invalid RetryToken generation");
  if (identity.spawnContext !== undefined && identity.method !== "spawn")
    throw new Error("Invalid RetryToken context");
  return identity;
}
export const commandOutcomeUnknownSchema = v.strictObject({
  code: v.literal("command_outcome_unknown"),
  cause: v.picklist(["timeout", "disconnected", "invalid_daemon_response"]),
  method: sideEffectMethodSchema,
  commandId: commandIdSchema,
  daemonGeneration: daemonGenerationSchema,
  retryToken: v.string(),
  targets: v.optional(v.array(sessionIdSchema)),
});
export type CommandOutcomeUnknown = v.InferOutput<
  typeof commandOutcomeUnknownSchema
>;
export function isCommandOutcomeUnknown(
  value: unknown,
): value is CommandOutcomeUnknown {
  return v.safeParse(commandOutcomeUnknownSchema, value).success;
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
  const pending = new Map<
    string,
    {
      resolve: (response: ProtocolResponse) => void;
      reject: (error: Error) => void;
      unknown?: (cause: CommandOutcomeUnknown["cause"]) => Error;
    }
  >();
  const listeners = new Set<NotificationListener>();
  const closedListeners = new Set<(reason: MachineError) => void>();
  let closed = false;
  let terminalReason: MachineError | undefined;
  const terminate = (reason: MachineError): void => {
    if (closed) return;
    closed = true;
    terminalReason = reason;
    const error = new Error(JSON.stringify(reason));
    for (const entry of pending.values())
      entry.reject(
        entry.unknown?.(
          reason.code === "invalid_daemon_response"
            ? "invalid_daemon_response"
            : "disconnected",
        ) ?? error,
      );
    pending.clear();
    for (const listener of Array.from(closedListeners)) listener(reason);
  };
  const unsubscribe = connection.onEvent((event) => {
    if (event.kind === "message") {
      const message = event.message;
      const response = v.safeParse(protocolResponseSchema, message);
      if (response.success) {
        const responseMessage = response.output;
        const entry = pending.get(responseMessage.requestId);
        if (entry === undefined) return;
        entry.resolve(responseMessage);
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
    originalId?: CommandId,
  ): Promise<ProtocolResponseFor<M>> => {
    if (closed) {
      return Promise.reject(
        new Error(JSON.stringify(clientMachineError("daemon_disconnected"))),
      );
    }
    const effect = isSideEffectMethod(method);
    if (effect && generation === undefined)
      return Promise.reject(
        new Error(JSON.stringify({ code: "protocol_error" })),
      );
    const commandId = effect
      ? (originalId ??
        v.parse(commandIdSchema, generation + ":" + randomUUID()))
      : undefined;
    const supplied = params as Record<string, unknown>;
    const targets = v.safeParse(
      v.array(sessionIdSchema),
      supplied.sessionId === undefined
        ? (supplied.ids ?? [])
        : [supplied.sessionId],
    );
    const spawnContext =
      method === "spawn"
        ? v.safeParse(spawnContextSchema, {
            ...(supplied.cwd === undefined ? {} : { cwd: supplied.cwd }),
            ...(supplied.cwdIdentity === undefined
              ? {}
              : { cwdIdentity: supplied.cwdIdentity }),
          })
        : undefined;
    const unknown = (cause: CommandOutcomeUnknown["cause"]): Error => {
      const identity = {
        method,
        commandId,
        daemonGeneration: commandId?.split(":")[0],
      };
      const retryToken =
        "retry1_" +
        Buffer.from(
          JSON.stringify({
            ...identity,
            ...(spawnContext?.success &&
            Object.keys(spawnContext.output).length > 0
              ? { spawnContext: spawnContext.output }
              : {}),
          }),
        ).toString("base64url");
      return new Error(
        JSON.stringify({
          code: "command_outcome_unknown",
          cause,
          ...identity,
          retryToken,
          ...(targets.success && targets.output.length > 0
            ? { targets: targets.output }
            : {}),
        }),
      );
    };
    seq += 1;
    const requestId = v.parse(requestIdSchema, `cli${seq}`);
    return new Promise<ProtocolResponseFor<M>>((resolve, reject) => {
      let settled = false;
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        pending.delete(requestId);
        action();
      };
      // wait 的观察预算由 daemon 的领域计时器拥有，传输断连仍独立报错。
      const timer = method === "wait" ? null : setTimeout(() => {
        settle(() =>
          reject(
            commandId === undefined
              ? new Error(JSON.stringify(clientMachineError("daemon_timeout")))
              : unknown("timeout"),
          ),
        );
      }, timeoutMs);
      pending.set(requestId, {
        ...(commandId === undefined ? {} : { unknown }),
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
            if (method === "initialize")
              generation = (parsed.output as ProtocolResult<"initialize">)
                .daemonGeneration;
            resolve({ ...response, result: parsed.output });
          });
        },
        reject: (error) => settle(() => reject(error)),
      });
      try {
        connection.send({
          kind: "request",
          requestId,
          method,
          params,
          ...(commandId === undefined ? {} : { commandId }),
        });
      } catch {
        terminate(clientMachineError("daemon_disconnected"));
      }
    });
  };

  return {
    initialize(timeoutMs) {
      return request(
        "initialize",
        {
          protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
          consumerContext: options.consumerContext,
        },
        timeoutMs,
      );
    },
    request,
    retry(token, params, timeoutMs) {
      const identity = parseRetryToken(token);
      const restored =
        identity.spawnContext !== undefined &&
        params !== null &&
        typeof params === "object" &&
        !Array.isArray(params)
          ? { ...identity.spawnContext, ...params }
          : params;
      return request(
        identity.method,
        restored as ProtocolParams<SideEffectMethod>,
        timeoutMs,
        identity.commandId,
      );
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
