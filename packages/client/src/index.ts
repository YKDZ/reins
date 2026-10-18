import type { ProtocolMessage } from "@reins/protocol";
import type { TransportConnection } from "@reins/transport";

import {
  createReinsClient as createControlClient,
  type ClientResult,
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

export type {
  ClientResult,
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
