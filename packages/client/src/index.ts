import type {
  AttachParams,
  ProtocolMessage,
  ProtocolMethod,
  ProtocolParams,
  ProtocolResponse,
} from "@reins/protocol";
import type { TransportConnection } from "@reins/transport";
import type { Publication, WorkspaceError } from "@reins/workspace-protocol";

import {
  createReinsClient as createControlClient,
  type ClientResult as ControlClientResult,
  type CommandOutcomeUnknown,
  type NotificationListener,
  type ReinsClient as ControlReinsClient,
  type ReinsClientOptions,
} from "./control.ts";
import type {
  AgentEstablishment,
  AgentTarget,
  AgentEvent as ControlAgentEvent,
  AgentSubscriptionEnd as ControlAgentSubscriptionEnd,
} from "./subscription.ts";
import {
  createWorkspaceClient,
  projectWorkspaceHistory,
  type WorkspaceAgentEvent,
  type WorkspaceAgentSubscription,
  type WorkspaceAgentSubscriptionEnd,
} from "./workspace.ts";

export {
  commandOutcomeUnknownSchema,
  isCommandOutcomeUnknown,
  parseRetryToken,
} from "./control.ts";
export type {
  CommandOutcomeUnknown,
  NotificationListener,
  ReinsClientOptions,
  AgentEstablishment,
  AgentTarget,
};
export { createWorkspaceClient, projectWorkspaceHistory };
export type { GitImportChanges, GitImportResult } from "./git-import.ts";

export type ClientResult<M extends ProtocolMethod> = ControlClientResult<M> &
  (M extends "wait"
    ? { publications?: Publication[]; publicationError?: WorkspaceError }
    : unknown);

export type ProtocolResponseFor<M extends ProtocolMethod> =
  | Extract<ProtocolResponse, { readonly error: unknown }>
  | (Omit<Extract<ProtocolResponse, { readonly result: unknown }>, "result"> & {
      readonly result: ClientResult<M>;
    });

export type ReinsClient = Omit<
  ControlReinsClient,
  "request" | "subscribe" | "prepareOperation" | "executeOperation"
> & {
  request<M extends ProtocolMethod>(
    method: M,
    params: ProtocolParams<M>,
    timeoutMs?: number,
  ): Promise<ProtocolResponseFor<M>>;
  subscribe(params: AttachParams): Promise<WorkspaceAgentSubscription>;
};

export type AgentEvent = WorkspaceAgentEvent;
export type AgentSubscription = WorkspaceAgentSubscription;
export type AgentSubscriptionEnd = WorkspaceAgentSubscriptionEnd;
export type ControlEvent = ControlAgentEvent;
export type ControlSubscriptionEnd = ControlAgentSubscriptionEnd;

export function createReinsClient(
  connection: TransportConnection<ProtocolMessage>,
  options: ReinsClientOptions,
): ReinsClient {
  return createControlClient(connection, options) as unknown as ReinsClient;
}
