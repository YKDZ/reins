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
  AgentFact,
  FactSubscription,
  FactSubscriptionEnd,
} from "./subscription.ts";

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
  AgentEstablishment,
  AgentTarget,
  AgentFact,
  FactSubscription,
  FactSubscriptionEnd,
};
export type ReinsClient = Omit<
  ControlReinsClient,
  "prepareOperation" | "executeOperation"
>;
export function createReinsClient(
  connection: TransportConnection<ProtocolMessage>,
  options: ReinsClientOptions,
): ReinsClient {
  return createControlClient(connection, options);
}
