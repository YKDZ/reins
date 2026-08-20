import type {
  MachineError,
  ProtocolMessage,
  ProtocolMethod,
  ProtocolNotification,
  ProtocolParams,
  ProtocolResponse,
  ProtocolResult,
} from "@reins/protocol";
import {
  protocolNotificationSchema,
  protocolResponseSchema,
  protocolResultSchemaFor,
  requestIdSchema,
} from "@reins/protocol";
import type { TransportConnection } from "@reins/transport";
import * as v from "valibot";

import { machineError } from "./errors.ts";

export type NotificationListener = (notification: ProtocolNotification) => void;

export type ProtocolResponseFor<M extends ProtocolMethod> =
  | Extract<ProtocolResponse, { readonly error: unknown }>
  | (Omit<Extract<ProtocolResponse, { readonly result: unknown }>, "result"> & {
      readonly result: ProtocolResult<M>;
    });

export type ReinsClient = {
  request<M extends ProtocolMethod>(
    method: M,
    params: ProtocolParams<M>,
    timeoutMs?: number,
  ): Promise<ProtocolResponseFor<M>>;
  onNotification(listener: NotificationListener): () => void;
  onClosed(listener: (reason: MachineError) => void): () => void;
  close(): void;
};

// 协议客户端：请求/响应按 requestId 关联，通知分发给订阅者；
// 响应结果按方法 schema 校验后才交给调用方（双端严格校验）。
export function createReinsClient(
  connection: TransportConnection<ProtocolMessage>,
): ReinsClient {
  let seq = 0;
  const pending = new Map<
    string,
    {
      resolve: (response: ProtocolResponse) => void;
      reject: (error: Error) => void;
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
    for (const entry of pending.values()) entry.reject(error);
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
      terminate(machineError({ code: "invalid_daemon_response" }));
      return;
    }
    terminate(machineError({ code: "daemon_disconnected" }));
  });

  return {
    request(method, params, timeoutMs = 30_000) {
      if (closed) {
        return Promise.reject(
          new Error(
            JSON.stringify(machineError({ code: "daemon_disconnected" })),
          ),
        );
      }
      seq += 1;
      const requestId = v.parse(requestIdSchema, `cli${seq}`);
      return new Promise<ProtocolResponseFor<typeof method>>(
        (resolve, reject) => {
          let settled = false;
          const settle = (action: () => void): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            pending.delete(requestId);
            action();
          };
          const timer = setTimeout(() => {
            settle(() =>
              reject(
                new Error(
                  JSON.stringify(machineError({ code: "daemon_timeout" })),
                ),
              ),
            );
          }, timeoutMs);
          pending.set(requestId, {
            resolve: (response) => {
              settle(() => {
                if ("error" in response) {
                  resolve(response);
                  return;
                }
                const parsed = v.safeParse(
                  protocolResultSchemaFor(method),
                  response.result,
                );
                if (!parsed.success) {
                  const reason = machineError({
                    code: "invalid_daemon_response",
                  });
                  reject(new Error(JSON.stringify(reason)));
                  terminate(reason);
                  return;
                }
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
            });
          } catch {
            terminate(machineError({ code: "daemon_disconnected" }));
          }
        },
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
      terminate(machineError({ code: "daemon_disconnected" }));
      closedListeners.clear();
      connection.close();
    },
  };
}
