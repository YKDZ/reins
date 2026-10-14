import type { ProtocolMessage } from "@reins/protocol";
import type { TransportConnection } from "@reins/transport";

import {
  createReinsClient as createControlClient,
  type ClientResult,
  type CommandOutcomeUnknown,
  type NotificationListener,
  type ReinsClient as ControlReinsClient,
  type ProtocolResponseFor,
  type ReinsClientOptions,
} from "./control.ts";
import type {
  AgentEstablishment,
  AgentTarget,
  AgentEvent,
  AgentSubscription,
  AgentSubscriptionEnd,
} from "./subscription.ts";
import { createWorkspaceClient } from "./workspace.ts";

export {
  commandOutcomeUnknownSchema,
  isCommandOutcomeUnknown,
  parseRetryToken,
} from "./control.ts";
export type {
  ClientResult,
  CommandOutcomeUnknown,
  NotificationListener,
  ProtocolResponseFor,
  ReinsClientOptions,
  AgentEvent,
  AgentSubscription,
  AgentSubscriptionEnd,
  AgentEstablishment,
  AgentTarget,
};
export type ReinsClient = Omit<
  ControlReinsClient,
  "prepareOperation" | "executeOperation"
>;
export type ControlEvent = AgentEvent;
export type ControlSubscriptionEnd = AgentSubscriptionEnd;
export { createWorkspaceClient };
export type { GitImportChanges, GitImportResult } from "./git-import.ts";

export function createReinsClient(
  connection: TransportConnection<ProtocolMessage>,
  options: ReinsClientOptions,
): ReinsClient {
  return createControlClient(connection, options);
}
