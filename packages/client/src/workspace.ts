import type { ConsumerContext } from "@reins/protocol";
import type { TransportConnection } from "@reins/transport";
import {
  WORKSPACE_PROTOCOL_MAJOR_VERSION,
  workspaceResponseSchema,
  workspaceResultSchemaFor,
  type WorkspaceMessage,
  type WorkspaceMethod,
  type WorkspaceParams,
  type WorkspaceResults,
} from "@reins/workspace-protocol";
import * as v from "valibot";

export function createWorkspaceClient(
  connection: TransportConnection<WorkspaceMessage>,
  options: { consumerContext: ConsumerContext },
) {
  let sequence = 0;
  let closed = false;
  const pending = new Map<
    string,
    { resolve: (message: unknown) => void; reject: (reason: unknown) => void }
  >();
  const fail = (code: string) => {
    closed = true;
    for (const entry of pending.values()) entry.reject({ code });
    pending.clear();
  };
  const unsubscribe = connection.onEvent((event) => {
    if (event.kind !== "message") {
      fail("manager_disconnected");
      return;
    }
    const response = v.safeParse(workspaceResponseSchema, event.message);
    if (!response.success) {
      fail("invalid_manager_response");
      return;
    }
    pending.get(response.output.requestId)?.resolve(response.output);
  });
  const request = <M extends WorkspaceMethod>(
    method: M,
    params: WorkspaceParams[M],
    timeoutMs?: number,
  ): Promise<WorkspaceResults[M]> => {
    if (closed) return Promise.reject({ code: "manager_disconnected" });
    const requestId = `workspace${++sequence}`;
    return new Promise((resolve, reject) => {
      // detach 等待实际释放完成；普通短请求保留传输预算，显式期限仍由调用方决定。
      const budget = timeoutMs ?? (method === "workspace.detach" ? null : 30_000);
      const timer =
        budget === null
          ? null
          : setTimeout(() => {
              pending.delete(requestId);
              reject({ code: "manager_timeout" });
            }, budget);
      pending.set(requestId, {
        resolve(message) {
          if (timer !== null) clearTimeout(timer);
          pending.delete(requestId);
          const response = v.parse(workspaceResponseSchema, message);
          if ("error" in response) {
            reject(response.error);
            return;
          }
          const parsed = v.safeParse(
            workspaceResultSchemaFor(method),
            response.result,
          );
          if (!parsed.success) {
            reject({ code: "invalid_manager_response" });
            return;
          }
          resolve(parsed.output as WorkspaceResults[M]);
        },
        reject(reason) {
          if (timer !== null) clearTimeout(timer);
          reject(reason);
        },
      });
      try {
        connection.send({
          kind: "request",
          requestId,
          method,
          params,
        } as WorkspaceMessage);
      } catch {
        fail("manager_disconnected");
      }
    });
  };
  return {
    initialize: () =>
      request("initialize", {
        protocolMajorVersion: WORKSPACE_PROTOCOL_MAJOR_VERSION,
        consumerContext: options.consumerContext,
      }),
    request,
    close() {
      unsubscribe();
      fail("manager_disconnected");
      connection.close();
    },
  };
}
