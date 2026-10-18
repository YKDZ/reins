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
  MessageKey,
  ToolKey,
} from "@reins/protocol";
import {
  encodePermissionHandle,
  encodeMessageKey,
  encodeToolKey,
  encodeTurnHandle,
  messageIdSchema,
  permissionHandleSchema,
  permissionIdSchema,
  sessionIdSchema,
  toolCallIdSchema,
  turnIdSchema,
} from "@reins/protocol";
import * as v from "valibot";

declare const agentFactIdBrand: unique symbol;
export type AgentFactId = string & {
  readonly [agentFactIdBrand]: "AgentFactId";
};

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
  const parsedSessionId = v.parse(sessionIdSchema, sessionId);
  const parsedTurnId =
    typeof turnId === "string" ? v.parse(turnIdSchema, turnId) : undefined;
  const parsedMessageId =
    typeof messageId === "string"
      ? v.parse(messageIdSchema, messageId)
      : undefined;
  const parsedToolCallId =
    typeof toolCallId === "string"
      ? v.parse(toolCallIdSchema, toolCallId)
      : undefined;
  const parsedPermissionId =
    typeof permissionId === "string"
      ? v.parse(permissionIdSchema, permissionId)
      : undefined;
  const fact = {
    ...fields,
    sessionHandle: parsedSessionId,
    ...(parsedTurnId !== undefined
      ? {
          turnHandle: encodeTurnHandle({
            sessionId: parsedSessionId,
            turnId: parsedTurnId,
          }),
        }
      : {}),
    ...(parsedMessageId !== undefined && parsedTurnId !== undefined
      ? {
          messageKey: encodeMessageKey({
            generation,
            sessionId: parsedSessionId,
            turnId: parsedTurnId,
            messageId: parsedMessageId,
          }),
        }
      : {}),
    ...(parsedToolCallId !== undefined && parsedTurnId !== undefined
      ? {
          toolKey: encodeToolKey({
            generation,
            sessionId: parsedSessionId,
            turnId: parsedTurnId,
            toolCallId: parsedToolCallId,
          }),
        }
      : {}),
    ...(parsedPermissionId !== undefined && parsedTurnId !== undefined
      ? {
          permissionHandle: v.parse(
            permissionHandleSchema,
            encodePermissionHandle({
              sessionId: parsedSessionId,
              turnId: parsedTurnId,
              permissionId: parsedPermissionId,
            }),
          ),
        }
      : {}),
    factId: opaqueKey(
      "fact",
      [generation, parsedSessionId, eventId].map(String).join("\0"),
    ) as AgentFactId,
  };
  return fact as AgentFact;
}
