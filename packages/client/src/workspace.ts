import type {
  ConsumerContext,
  WaitResult,
  ProtocolMessage,
  ProtocolMethod,
  ProtocolParams,
  ProtocolResponse,
  ProtocolResult,
  SideEffectMethod,
  AttachParams,
} from "@reins/protocol";
import {
  createUnixSocketClient,
  type TransportConnection,
} from "@reins/transport";
import {
  WORKSPACE_PROTOCOL_MAJOR_VERSION,
  workspaceResponseSchema,
  workspaceErrorSchema,
  type WorkspaceError,
  workspaceNotificationSchema,
  type Publication,
  workspaceResultSchemaFor,
  type WorkspaceMessage,
  type WorkspaceMethod,
  type WorkspaceParams,
  type WorkspaceResults,
  type WorkspaceHandle,
  type WorkspaceHistory,
} from "@reins/workspace-protocol";
import * as v from "valibot";

import {
  createReinsClient,
  parseRetryToken,
  type ReinsClient,
  type ProtocolResponseFor,
} from "./control.ts";
import { importGitPublication } from "./git-import.ts";
import { receivePublication, listReceipts, removeReceipt } from "./receipts.ts";
import {
  createAgentFact,
  createPresentationProjector,
  type AgentEvent,
  type AgentSubscription,
  type AgentSubscriptionEnd,
} from "./subscription.ts";

export type WorkspaceAgentEvent =
  | AgentEvent
  | { type: "publication.ready"; publication: Publication };
export type WorkspaceAgentSubscriptionEnd = AgentSubscriptionEnd & {
  publicationError?: WorkspaceError;
};
export type WorkspaceAgentSubscription = Omit<
  AgentSubscription,
  "done" | "onEvent"
> & {
  readonly done: Promise<WorkspaceAgentSubscriptionEnd>;
  onEvent(listener: (event: WorkspaceAgentEvent) => void): () => void;
};
type WorkspaceControlResult<M extends ProtocolMethod> = ProtocolResult<M> &
  (M extends "wait"
    ? { publications?: Publication[]; publicationError?: WorkspaceError }
    : unknown);
type WorkspaceProtocolResponseFor<M extends ProtocolMethod> =
  | Extract<ProtocolResponse, { readonly error: unknown }>
  | (Omit<Extract<ProtocolResponse, { readonly result: unknown }>, "result"> & {
      readonly result: WorkspaceControlResult<M>;
    });
export type WorkspaceControlClient = Omit<
  ReinsClient,
  "request" | "subscribe" | "prepareOperation" | "executeOperation"
> & {
  request<M extends ProtocolMethod>(
    method: M,
    params: ProtocolParams<M>,
    timeoutMs?: number,
  ): Promise<WorkspaceProtocolResponseFor<M>>;
  retry(
    token: string,
    params: unknown,
    timeoutMs?: number,
  ): Promise<ProtocolResponseFor<SideEffectMethod>>;
  subscribe(params: AttachParams): Promise<WorkspaceAgentSubscription>;
};

export function projectWorkspaceHistory(history: WorkspaceHistory) {
  return {
    ...history,
    entries: history.entries.map(({ events, ...attachment }) => {
      const project = createPresentationProjector();
      return {
        ...attachment,
        events: events.flatMap(({ daemonGeneration, eventId, event }) =>
          project(createAgentFact(event, eventId, daemonGeneration)),
        ),
      };
    }),
  };
}

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
  const observations = new Map<string, (publication: Publication) => void>();
  const managerClosed = new Set<() => void>();
  const fail = (code: string) => {
    closed = true;
    for (const entry of pending.values()) entry.reject({ code });
    pending.clear();
    observations.clear();
    for (const listener of managerClosed) listener();
  };
  const unsubscribe = connection.onEvent((event) => {
    if (event.kind !== "message") {
      fail("manager_disconnected");
      return;
    }
    if (event.message.kind === "notification") {
      const notification = v.safeParse(
        workspaceNotificationSchema,
        event.message,
      );
      if (!notification.success) {
        fail("invalid_manager_response");
        return;
      }
      observations.get(notification.output.params.observationId)?.(
        notification.output.params.publication,
      );
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
      const budget =
        timeoutMs ?? (method === "workspace.detach" ? null : 30_000);
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
  const discover = async (
    cwd: string,
  ): Promise<
    { publications: Publication[] } | { publicationError: WorkspaceError }
  > => {
    try {
      return { publications: await request("publication.list", { cwd }) };
    } catch (error) {
      const failure = v.safeParse(workspaceErrorSchema, error);
      return {
        publicationError: failure.success
          ? failure.output
          : { code: "invalid_manager_response" },
      };
    }
  };
  return {
    initialize: () =>
      request("initialize", {
        protocolMajorVersion: WORKSPACE_PROTOCOL_MAJOR_VERSION,
        consumerContext: options.consumerContext,
      }),
    request,
    async receivePublication(
      publicationId: string,
      destination: { directory: string; activeRoot: string },
    ) {
      return receivePublication(
        options.consumerContext,
        await request("publication.read", { publicationId }),
        destination,
      );
    },
    receipts: (directory: string) =>
      listReceipts(options.consumerContext, directory),
    removeReceipt: (directory: string, receiptId: string) =>
      removeReceipt(options.consumerContext, directory, receiptId),
    async history(params: WorkspaceParams["workspace.history"]) {
      return projectWorkspaceHistory(
        await request("workspace.history", params),
      );
    },
    async importGitPublication(
      publicationId: string,
      destination: { repository: string; reference: string; commit: string },
    ) {
      return importGitPublication(
        await request("publication.read", { publicationId }),
        destination,
      );
    },
    async control(
      context: string | { workspaceHandle: WorkspaceHandle },
    ): Promise<WorkspaceControlClient> {
      const cwd =
        typeof context === "string"
          ? context
          : (await request("workspace.locate", context)).cwd;
      const route = await request("workspace.route", { cwd });
      const client = createReinsClient(
        await createUnixSocketClient<ProtocolMessage>(route.socket),
        options,
      );
      const onManagerClosed = () => client.close();
      managerClosed.add(onManagerClosed);
      const admit = async <M extends ProtocolMethod>(
        action: M,
        params: ProtocolParams<M>,
      ) => {
        await request("workspace.admit", { cwd: route.cwd, action, params });
      };
      return {
        ...client,
        async request(method, params, timeoutMs) {
          await admit(method, params);
          const response = await client.request(method, params, timeoutMs);
          if (method === "wait" && "result" in response)
            return {
              ...response,
              result: {
                ...(response.result as WaitResult),
                ...(await discover(route.cwd)),
              },
            };
          return response;
        },
        async subscribe(params) {
          const observationId = `observation${++sequence}`;
          const seen = new Set<string>();
          const queued: WorkspaceAgentEvent[] = [];
          const listeners = new Set<(event: WorkspaceAgentEvent) => void>();
          let active = true;
          const emit = (event: WorkspaceAgentEvent) => {
            if (!active) return;
            queued.push(event);
            if (listeners.size === 0) return;
            for (const item of queued.splice(0))
              for (const listener of Array.from(listeners)) listener(item);
          };
          const receive = (publication: Publication) => {
            if (seen.has(publication.publicationId)) return;
            seen.add(publication.publicationId);
            emit({ type: "publication.ready", publication });
          };
          const cleanup = () => {
            active = false;
            observations.delete(observationId);
            void request("publication.unobserve", { observationId }).catch(
              () => undefined,
            );
          };
          observations.set(observationId, receive);
          try {
            // 成果是工作区快照与live事实，不借用daemon的有界事件游标。
            for (const publication of await request("publication.observe", {
              cwd: route.cwd,
              observationId,
            }))
              receive(publication);
            const subscription = await client.subscribe(params);
            const unsubscribe = subscription.onEvent(emit);
            const done = subscription.done
              .then(async (end) => {
                // 两条既有连接的到达顺序独立，结束前查询补齐已保存成果。
                const discovered = await discover(route.cwd);
                if ("publicationError" in discovered)
                  return {
                    ...end,
                    publicationError: discovered.publicationError,
                  };
                for (const publication of discovered.publications)
                  receive(publication);
                return end;
              })
              .finally(() => {
                unsubscribe();
                cleanup();
              });
            void done.catch(() => undefined);
            return {
              establishment: subscription.establishment,
              done,
              onEvent(listener) {
                listeners.add(listener);
                for (const event of queued.splice(0))
                  for (const current of Array.from(listeners)) current(event);
                return () => {
                  listeners.delete(listener);
                };
              },
              close() {
                subscription.close();
              },
            };
          } catch (error) {
            cleanup();
            throw error;
          }
        },
        close() {
          managerClosed.delete(onManagerClosed);
          client.close();
        },
        async retry(token, params, timeoutMs) {
          const parsed = parseRetryToken(token);
          // 与原 retry 同样恢复内部目录投影，再做 Manager 准入；敏感 caller 输入仍由调用方重带。
          const restored =
            parsed.spawnContext !== undefined &&
            params !== null &&
            typeof params === "object" &&
            !Array.isArray(params)
              ? { ...parsed.spawnContext, ...params }
              : params;
          await request("workspace.admit", {
            cwd: route.cwd,
            action: parsed.method,
            params: restored,
            commandId: parsed.commandId,
          });
          return await client.retry(token, params, timeoutMs);
        },
      };
    },
    close() {
      unsubscribe();
      fail("manager_disconnected");
      connection.close();
    },
  };
}
