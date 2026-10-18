import { createHash } from "node:crypto";

import type {
  DomainEvent,
  EventId,
  AttachEnded,
  AttachInitial,
  ResumeCursor,
  SessionInfo,
  SubscriptionTarget,
  AttachParams,
  PermissionHandle,
  SessionHandle,
  TurnHandle,
  DaemonGeneration,
  MessageKey,
  MessageContentPart,
  ToolKey,
  SessionId,
  BackgroundActivitySource,
  BackgroundActivityStatus,
  TurnOrigin as ProtocolTurnOrigin,
  AutonomousTurnCause as ProtocolAutonomousTurnCause,
} from "@reins/protocol";
import {
  encodePermissionHandle,
  encodeMessageKey,
  encodeToolKey,
  encodeTurnHandle,
  decodeResumeCursor,
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

type ToPublicMessageContentPart<TPart> = TPart extends {
  toolCallId: unknown;
}
  ? Omit<TPart, "toolCallId"> & { toolKey: ToolKey }
  : TPart;
type PublicMessageContentPart = ToPublicMessageContentPart<MessageContentPart>;

type PublicBackgroundCause = {
  turnHandle: TurnHandle;
  toolKey?: ToolKey | undefined;
};
type PublicAutonomousTurnCause =
  | {
      source: BackgroundActivitySource;
      causedBy?: PublicBackgroundCause | undefined;
    }
  | { source?: undefined; causedBy: PublicBackgroundCause };
type PublicTurnOrigin = ProtocolTurnOrigin;

type PublicFact<E> = E extends DomainEvent
  ? Omit<
      E,
      | "sessionId"
      | "turnId"
      | "messageId"
      | "toolCallId"
      | "permissionId"
      | (E extends { type: "turn.started" } ? "origin" : never)
      | (E extends { type: "turn.started" } ? "cause" : never)
      | (E extends { type: "background.activity" } ? "causedBy" : never)
      | (E extends { type: "message" } ? "content" : never)
    > & {
      sessionHandle: SessionHandle;
    } & (E extends { turnId: unknown } ? { turnHandle: TurnHandle } : {}) &
      (E extends { messageId: unknown } ? { messageKey: MessageKey } : {}) &
      (E extends { type: "message" }
        ? { content: string | PublicMessageContentPart[] }
        : {}) &
      (E extends { toolCallId: unknown } ? { toolKey: ToolKey } : {}) &
      (E extends { type: "permission.requested" }
        ? { toolKey?: ToolKey }
        : {}) &
      (E extends { permissionId: unknown }
        ? { permissionHandle: PermissionHandle }
        : {}) &
      (E extends { type: "turn.started" }
        ? {
            origin?: PublicTurnOrigin;
            cause?: PublicAutonomousTurnCause;
          }
        : {}) &
      (E extends { type: "background.activity" }
        ? {
            source: BackgroundActivitySource;
            status: BackgroundActivityStatus;
            causedBy?: PublicBackgroundCause;
          }
        : {})
  : never;

export type AgentFact = PublicFact<DomainEvent> & { factId: AgentFactId };

export type AgentTarget =
  | { scope: "session"; sessionHandle: SessionHandle }
  | { scope: "turn"; turnHandle: TurnHandle };
export type AgentSubscriptionInitial =
  | {
      mode: "snapshot";
      target: AgentTarget;
      cursor: ResumeCursor;
      window: AttachInitial["window"];
      baseline: AgentSubscriptionBaseline;
    }
  | {
      mode: "history" | "after";
      target: AgentTarget;
      cursor: ResumeCursor;
      window: AttachInitial["window"];
      replayed: number;
    };
export type AgentSubscriptionBaseline = {
  session: SessionInfo;
  activeTurnCause?: PublicAutonomousTurnCause;
  confirmedTerminals: Extract<
    AgentFact,
    { type: "turn.completed" | "session.killed" }
  >[];
  pendingPermissions: Extract<AgentFact, { type: "permission.requested" }>[];
  backgroundActivities: Extract<AgentFact, { type: "background.activity" }>[];
};

export function projectAgentSubscriptionInitial(
  initial: AttachInitial,
): AgentSubscriptionInitial {
  const target = projectSubscriptionTarget(initial.target);
  if (initial.mode !== "snapshot")
    return {
      ...initial,
      target,
    };
  const generation = decodeResumeCursor(initial.cursor).daemonGeneration;
  const projectEvent = (entry: { event: DomainEvent; eventId: EventId }) =>
    createAgentFact(entry.event, entry.eventId, generation);
  return {
    ...initial,
    target,
    baseline: {
      session: initial.baseline.session,
      ...(initial.baseline.activeTurnCause === undefined
        ? {}
        : {
            activeTurnCause: projectAutonomousTurnCause(
              initial.baseline.activeTurnCause,
              initial.baseline.session.sessionId,
              generation,
            ),
          }),
      confirmedTerminals: initial.baseline.confirmedTerminals.map(
        projectEvent,
      ) as AgentSubscriptionBaseline["confirmedTerminals"],
      pendingPermissions: initial.baseline.pendingPermissions.map(
        projectEvent,
      ) as AgentSubscriptionBaseline["pendingPermissions"],
      backgroundActivities: initial.baseline.backgroundActivities.map(
        projectEvent,
      ) as AgentSubscriptionBaseline["backgroundActivities"],
    },
  };
}

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
  readonly initial: AgentSubscriptionInitial;
  readonly done: Promise<FactSubscriptionEnd>;
  readonly checkpoint: ResumeCursor;
  acknowledge(fact: AgentFact): void;
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
  const publicContent = Array.isArray(fields.content)
    ? fields.content.map((part) => {
        if (
          typeof part !== "object" ||
          part === null ||
          !("toolCallId" in part) ||
          parsedTurnId === undefined
        )
          return part;
        const parsedPartToolCallId = v.parse(toolCallIdSchema, part.toolCallId);
        const contentPart = Object.fromEntries(
          Object.entries(part).filter(([key]) => key !== "toolCallId"),
        );
        return {
          ...contentPart,
          toolKey: encodeToolKey({
            generation,
            sessionId: parsedSessionId,
            turnId: parsedTurnId,
            toolCallId: parsedPartToolCallId,
          }),
        };
      })
    : fields.content;
  const origin = fields.origin as ProtocolTurnOrigin | undefined;
  const publicOrigin =
    origin === undefined ? undefined : projectTurnOrigin(origin);
  const publicTurnCause =
    event.type === "turn.started" && event.cause !== undefined
      ? projectAutonomousTurnCause(event.cause, parsedSessionId, generation)
      : undefined;
  const publicBackgroundCause =
    event.type === "background.activity" && event.causedBy !== undefined
      ? projectBackgroundCause(event.causedBy, parsedSessionId, generation)
      : undefined;
  const fact = {
    ...fields,
    ...(fields.content === undefined ? {} : { content: publicContent }),
    ...(publicOrigin === undefined ? {} : { origin: publicOrigin }),
    ...(publicTurnCause === undefined ? {} : { cause: publicTurnCause }),
    ...(event.type === "background.activity" &&
    publicBackgroundCause !== undefined
      ? { causedBy: publicBackgroundCause }
      : {}),
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

function projectTurnOrigin(origin: ProtocolTurnOrigin): PublicTurnOrigin {
  return origin;
}

function projectBackgroundCause(
  cause: { turnId: string; toolCallId?: string | undefined },
  sessionId: SessionId,
  generation: DaemonGeneration,
): PublicBackgroundCause {
  const turnId = v.parse(turnIdSchema, cause.turnId);
  return {
    turnHandle: encodeTurnHandle({ sessionId, turnId }),
    ...(cause.toolCallId === undefined
      ? {}
      : {
          toolKey: encodeToolKey({
            generation,
            sessionId,
            turnId,
            toolCallId: v.parse(toolCallIdSchema, cause.toolCallId),
          }),
        }),
  };
}

function projectAutonomousTurnCause(
  cause: ProtocolAutonomousTurnCause,
  sessionId: SessionId,
  generation: DaemonGeneration,
): PublicAutonomousTurnCause {
  if (cause.source !== undefined)
    return {
      source: cause.source,
      ...(cause.causedBy === undefined
        ? {}
        : {
            causedBy: projectBackgroundCause(
              cause.causedBy,
              sessionId,
              generation,
            ),
          }),
    };
  return {
    causedBy: projectBackgroundCause(cause.causedBy, sessionId, generation),
  };
}
