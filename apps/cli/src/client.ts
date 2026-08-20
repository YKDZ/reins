import type {
  ProtocolMessage,
  ProtocolMethod,
  ProtocolNotification,
  ProtocolParams,
  ProtocolResponse,
} from "@reins/protocol";
import { protocolResultSchemaFor } from "@reins/protocol";
import type { TransportConnection } from "@reins/transport";
import * as v from "valibot";

import { machineError } from "./errors.ts";

export type NotificationListener = (notification: ProtocolNotification) => void;

export type ReinsClient = {
  request<M extends ProtocolMethod>(
    method: M,
    params: ProtocolParams<M>,
    timeoutMs?: number,
  ): Promise<ProtocolResponse>;
  onNotification(listener: NotificationListener): () => void;
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
  const unsubscribe = connection.onEvent((event) => {
    if (event.kind === "message") {
      const message = event.message;
      if (message.kind === "response") {
        const entry = pending.get(message.requestId);
        if (entry === undefined) return;
        pending.delete(message.requestId);
        entry.resolve(message);
      } else if (message.kind === "notification") {
        for (const listener of Array.from(listeners)) {
          listener(message);
        }
      }
      return;
    }
    const error = machineError("internal_error", {
      transport: event.kind,
      message:
        event.kind === "closed" ? "connection closed" : "transport error",
    });
    for (const entry of pending.values()) {
      entry.reject(new Error(JSON.stringify(error)));
    }
    pending.clear();
  });

  return {
    request(method, params, timeoutMs = 30_000) {
      seq += 1;
      const requestId = `cli${seq}`;
      return new Promise<ProtocolResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(
            new Error(
              JSON.stringify(
                machineError("protocol_error", {
                  method,
                  timeoutMs,
                }),
              ),
            ),
          );
        }, timeoutMs);
        pending.set(requestId, {
          resolve: (response) => {
            clearTimeout(timer);
            if ("error" in response) {
              resolve(response);
              return;
            }
            const parsed = v.safeParse(
              protocolResultSchemaFor(method),
              response.result,
            );
            if (!parsed.success) {
              reject(
                new Error(
                  JSON.stringify(
                    machineError("protocol_error", {
                      method,
                      reason: "invalid_result",
                    }),
                  ),
                ),
              );
              return;
            }
            resolve({ ...response, result: parsed.output });
          },
          reject,
        });
        connection.send({
          kind: "request",
          requestId,
          method,
          params,
        });
      });
    },
    onNotification(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      unsubscribe();
      connection.close();
    },
  };
}
