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
export type AgentPresentation =
  | (Exclude<DomainEvent, { type: "text.delta" | "message" }> extends infer E
      ? E extends DomainEvent
        ? Omit<PublicFact<E>, "messageKey" | "toolKey">
        : never
      : never)
  | {
      type: "text";
      sessionHandle: SessionHandle;
      turnHandle: TurnHandle;
      role: "caller" | "worker";
      content: string;
      operation: "append" | "replace";
      complete: boolean;
      start: boolean;
    };

export type AgentEvent = AgentPresentation & { eventId: EventId };
export type AgentTarget =
  | { scope: "session"; sessionHandle: SessionHandle }
  | { scope: "turn"; turnHandle: TurnHandle };
export type AgentEstablishment = {
  target: AgentTarget;
  window: AttachResult["window"];
  replayed: number;
};
export type AgentSubscriptionEnd = {
  target: AgentTarget;
  reason: AttachEnded["reason"];
  lastEventId: EventId | null;
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
export type AgentSubscription = {
  readonly establishment: AgentEstablishment;
  onEvent(listener: (event: AgentEvent) => void): () => void;
  readonly done: Promise<AgentSubscriptionEnd>;
  close(): void;
};
export type Subscribe = (params: AttachParams) => Promise<AgentSubscription>;

export type FactSubscriptionEnd = Omit<AgentSubscriptionEnd, "lastEventId">;
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

export function createPresentationProjector(): (
  fact: AgentFact,
) => AgentPresentation[] {
  const messages = new Map<
    MessageKey,
    { text: string; complete: boolean; turnHandle: TurnHandle }
  >();
  const tools = new Map<ToolKey, { name: string; turnHandle: TurnHandle }>();
  return (fact) => {
    if (fact.type === "text.delta" || fact.type === "message") {
      const start = !messages.has(fact.messageKey);
      const state = messages.get(fact.messageKey) ?? {
        text: "",
        complete: false,
        turnHandle: fact.turnHandle,
      };
      if (state.complete) return [];
      let content: string;
      let operation: "append" | "replace" = "append";
      if (fact.type === "text.delta") {
        content = fact.delta;
        state.text += content;
      } else {
        operation = fact.content.startsWith(state.text) ? "append" : "replace";
        content =
          operation === "append"
            ? fact.content.slice(state.text.length)
            : fact.content;
        state.text = fact.content;
        state.complete = true;
      }
      messages.set(fact.messageKey, state);
      return [
        {
          type: "text",
          sessionHandle: fact.sessionHandle,
          turnHandle: fact.turnHandle,
          role: fact.type === "message" ? fact.role : "worker",
          content,
          operation,
          complete: state.complete,
          start,
        },
      ];
    }
    if (fact.type === "tool.requested") {
      tools.set(fact.toolKey, {
        name: fact.name,
        turnHandle: fact.turnHandle,
      });
      const { factId: _factId, toolKey: _toolKey, ...presentation } = fact;
      return [presentation];
    }
    if (fact.type === "tool.completed") {
      const requested = tools.get(fact.toolKey);
      tools.delete(fact.toolKey);
      const { factId: _factId, toolKey: _toolKey, ...presentation } = fact;
      return [
        {
          ...presentation,
          ...(requested === undefined ? {} : { name: requested.name }),
        },
      ];
    }
    if (fact.type === "turn.completed") {
      for (const [key, state] of messages)
        if (state.turnHandle === fact.turnHandle) messages.delete(key);
      for (const [key, state] of tools)
        if (state.turnHandle === fact.turnHandle) tools.delete(key);
    }
    const { factId: _factId, ...presentation } = fact;
    return [presentation] as AgentPresentation[];
  };
}
