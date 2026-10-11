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
} from "@reins/protocol";
import {
  encodePermissionHandle,
  encodeTurnHandle,
  permissionHandleSchema,
} from "@reins/protocol";
import type { Publication } from "@reins/workspace-protocol";
import * as v from "valibot";

// 关联键仅用于 client 内部配对；消费者只收到完整领域句柄与可读内容。
type PublicEvent<E> = E extends DomainEvent
  ? Omit<
      E,
      "sessionId" | "turnId" | "messageId" | "toolCallId" | "permissionId"
    > & {
      sessionHandle: SessionHandle;
    } & (E extends { turnId: unknown } ? { turnHandle: TurnHandle } : {}) &
      (E extends { permissionId: unknown }
        ? { permissionHandle: PermissionHandle }
        : {})
  : never;
type ProjectedEvent =
  | PublicEvent<Exclude<DomainEvent, { type: "text.delta" | "message" }>>
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
export type AgentEvent =
  | (ProjectedEvent & { eventId: EventId })
  | { type: "publication.ready"; publication: Publication };
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

export function createEventProjector(): (
  event: DomainEvent,
) => ProjectedEvent[] {
  const messages = new Map<string, { text: string; complete: boolean }>();
  const tools = new Map<string, string>();
  return (event) => {
    const { sessionId, ...withoutSession } = event;
    const base = {
      sessionHandle: sessionId,
      ...("turnId" in event
        ? { turnHandle: encodeTurnHandle({ sessionId, turnId: event.turnId }) }
        : {}),
    };
    if (event.type === "text.delta" || event.type === "message") {
      const key = `${sessionId}/${event.turnId}/${event.messageId}`;
      const start = !messages.has(key);
      const state = messages.get(key) ?? { text: "", complete: false };
      if (state.complete) return [];
      let content: string;
      let operation: "append" | "replace" = "append";
      if (event.type === "text.delta") {
        content = event.delta;
        state.text += content;
      } else {
        operation = event.content.startsWith(state.text) ? "append" : "replace";
        content =
          operation === "append"
            ? event.content.slice(state.text.length)
            : event.content;
        state.text = event.content;
        state.complete = true;
      }
      messages.set(key, state);
      return [
        {
          type: "text",
          sessionHandle: sessionId,
          turnHandle: encodeTurnHandle({ sessionId, turnId: event.turnId }),
          role: event.type === "message" ? event.role : "worker",
          content,
          operation,
          complete: state.complete,
          start,
        },
      ];
    }
    const {
      turnId: _turn,
      messageId: _message,
      toolCallId: _tool,
      permissionId: _permission,
      ...fields
    } = withoutSession as typeof withoutSession & {
      turnId?: string;
      messageId?: string;
      toolCallId?: string;
      permissionId?: string;
    };
    if (event.type === "tool.requested")
      tools.set(`${event.turnId}/${event.toolCallId}`, event.name);
    if (event.type === "tool.completed") {
      const key = `${event.turnId}/${event.toolCallId}`;
      const name = tools.get(key) ?? event.name;
      tools.delete(key);
      return [{ ...fields, ...base, name } as ProjectedEvent];
    }
    if (event.type === "turn.completed") {
      for (const key of messages.keys())
        if (key.startsWith(`${sessionId}/${event.turnId}/`))
          messages.delete(key);
      for (const key of tools.keys())
        if (key.startsWith(`${event.turnId}/`)) tools.delete(key);
    }
    return [
      {
        ...fields,
        ...base,
        ...("permissionId" in event
          ? {
              permissionHandle: v.parse(
                permissionHandleSchema,
                encodePermissionHandle({
                  sessionId,
                  turnId: event.turnId,
                  permissionId: event.permissionId,
                }),
              ),
            }
          : {}),
      } as ProjectedEvent,
    ];
  };
}
