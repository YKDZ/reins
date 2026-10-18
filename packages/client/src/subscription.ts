import { createHash } from "node:crypto";

import type {
  DomainEvent,
  EventId,
  AttachEnded,
  AttachResult,
  SubscriptionTarget,
  AttachParams,
  PermissionHandle,
  SessionHandle,
  TurnHandle,
  DaemonGeneration,
} from "@reins/protocol";
import {
  encodePermissionHandle,
  encodeTurnHandle,
  permissionHandleSchema,
} from "@reins/protocol";
import * as v from "valibot";

declare const agentFactIdBrand: unique symbol;
declare const messageKeyBrand: unique symbol;
declare const toolKeyBrand: unique symbol;
export type AgentFactId = string & {
  readonly [agentFactIdBrand]: "AgentFactId";
};
export type MessageKey = string & { readonly [messageKeyBrand]: "MessageKey" };
export type ToolKey = string & { readonly [toolKeyBrand]: "ToolKey" };

type PublicFact<E> = E extends DomainEvent
  ? Omit<
      E,
      "sessionId" | "turnId" | "messageId" | "toolCallId" | "permissionId"
    > & {
      sessionHandle: SessionHandle;
    } & (E extends { turnId: unknown } ? { turnHandle: TurnHandle } : {}) &
      (E extends { messageId: unknown } ? { messageKey: MessageKey } : {}) &
      (E extends { toolCallId: unknown } ? { toolKey: ToolKey } : {}) &
      (E extends { permissionId: unknown }
        ? { permissionHandle: PermissionHandle }
        : {})
  : never;

export type AgentFact = PublicFact<DomainEvent> & { factId: AgentFactId };

export type AgentTarget =
  | { scope: "session"; sessionHandle: SessionHandle }
  | { scope: "turn"; turnHandle: TurnHandle };
export type AgentEstablishment = {
  target: AgentTarget;
  window: AttachResult["window"];
  replayed: number;
};
export type FactSubscriptionEnd = {
  target: AgentTarget;
  reason: AttachEnded["reason"];
};
export function projectSubscriptionTarget(
  target: SubscriptionTarget,
): AgentTarget {
  return target.scope === "session"
    ? { scope: "session", sessionHandle: target.sessionId }
    : {
        scope: "turn",
        turnHandle: encodeTurnHandle({
          sessionId: target.sessionId,
          turnId: target.turnId,
        }),
      };
}
export type FactSubscription = AsyncIterableIterator<AgentFact> & {
  readonly establishment: AgentEstablishment;
  readonly done: Promise<FactSubscriptionEnd>;
  readonly checkpoint: string;
  close(): void;
};
export type SubscribeFacts = (
  params: AttachParams,
  signal?: AbortSignal,
) => Promise<FactSubscription>;

function opaqueKey(prefix: string, value: string): string {
  const digest = createHash("sha256").update(value).digest("base64url");
  return `${prefix}1_${digest}`;
}

export function createAgentFact(
  event: DomainEvent,
  eventId: EventId,
  generation: DaemonGeneration,
): AgentFact {
  const source = event as unknown as Record<string, unknown>;
  const { sessionId, turnId, messageId, toolCallId, permissionId, ...fields } =
    source;
  const fact = {
    ...fields,
    sessionHandle: sessionId,
    ...(typeof turnId === "string"
      ? {
          turnHandle: encodeTurnHandle({
            sessionId: sessionId as SessionHandle,
            turnId: turnId as never,
          }),
        }
      : {}),
    ...(typeof messageId === "string" && typeof turnId === "string"
      ? {
          messageKey: opaqueKey(
            "message",
            [generation, sessionId, turnId, messageId].map(String).join("\0"),
          ) as MessageKey,
        }
      : {}),
    ...(typeof toolCallId === "string" && typeof turnId === "string"
      ? {
          toolKey: opaqueKey(
            "tool",
            [generation, sessionId, turnId, toolCallId].map(String).join("\0"),
          ) as ToolKey,
        }
      : {}),
    ...(typeof permissionId === "string" && typeof turnId === "string"
      ? {
          permissionHandle: v.parse(
            permissionHandleSchema,
            encodePermissionHandle({
              sessionId: sessionId as SessionHandle,
              turnId: turnId as never,
              permissionId: permissionId as never,
            }),
          ),
        }
      : {}),
    factId: opaqueKey(
      "fact",
      [generation, sessionId, eventId].map(String).join("\0"),
    ) as AgentFactId,
  };
  return fact as AgentFact;
}
