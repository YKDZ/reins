import type { TurnJournal } from "@reins/adapter-kit";
import {
  makeTextEvidence,
  type DomainEvent,
  type PermissionOption,
  type PermissionResolution,
} from "@reins/protocol";

import type {
  CodexApprovalRequest,
  CodexInboundItem,
  InboundMessage,
} from "./transport.ts";

function isFailedStatus(status: string): boolean {
  return status === "failed" || status === "declined";
}

function mapItemStarted(
  session: TurnJournal,
  item: CodexInboundItem,
): DomainEvent[] {
  if (item.type === "agentMessage" || session.turnId === null) return [];
  session.toolNames.set(item.id, item.type);
  return [
    {
      type: "tool.requested",
      sessionId: session.sessionId,
      turnId: session.turnId,
      toolCallId: session.toolCallId(item.id),
      name: item.type,
    },
  ];
}

function mapItemCompleted(
  session: TurnJournal,
  item: CodexInboundItem,
): DomainEvent[] {
  if (session.turnId === null) return [];
  if (item.type === "agentMessage") {
    session.setFinalText(item.text);
    return [
      {
        type: "message",
        sessionId: session.sessionId,
        turnId: session.turnId,
        messageId: session.messageId(item.id),
        role: "worker",
        content: item.text,
      },
    ];
  }
  if (item.type === "commandExecution") {
    return [
      {
        type: "tool.completed",
        sessionId: session.sessionId,
        turnId: session.turnId,
        toolCallId: session.toolCallId(item.id),
        name: session.toolNames.get(item.id) ?? "commandExecution",
        result: item.output,
        isError: isFailedStatus(item.status),
      },
    ];
  }
  if (item.type === "fileChange") {
    return [
      {
        type: "tool.completed",
        sessionId: session.sessionId,
        turnId: session.turnId,
        toolCallId: session.toolCallId(item.id),
        name: session.toolNames.get(item.id) ?? "fileChange",
        result: item.changes,
        isError: isFailedStatus(item.status),
      },
    ];
  }
  if (item.type === "mcpToolCall") {
    return [
      {
        type: "tool.completed",
        sessionId: session.sessionId,
        turnId: session.turnId,
        toolCallId: session.toolCallId(item.id),
        name: session.toolNames.get(item.id) ?? "mcpToolCall",
        result: item.error?.message ?? item.result,
        isError: isFailedStatus(item.status) || item.error !== null,
      },
    ];
  }
  return [];
}

export function mapNotification(
  session: TurnJournal,
  message: Extract<InboundMessage, { kind: "notification" }>,
): DomainEvent[] {
  switch (message.method) {
    case "item/agentMessage/delta":
      if (session.turnId === null) return [];
      return [
        {
          type: "text.delta",
          sessionId: session.sessionId,
          turnId: session.turnId,
          messageId: session.messageId(message.params.itemId),
          delta: message.params.delta,
        },
      ];
    case "item/started":
      return mapItemStarted(session, message.params.item);
    case "item/completed":
      return mapItemCompleted(session, message.params.item);
    case "thread/tokenUsage/updated":
      session.setUsage({ ...message.params.tokenUsage });
      return [];
    case "turn/completed": {
      if (session.turnId === null) return [];
      const turn = message.params.turn;
      if (turn.status === "completed") return [session.endTurn("end_turn")];
      if (turn.status === "interrupted") return [session.endTurn("cancelled")];
      if (turn.status === "failed") {
        void session.diagnostic({
          kind: "turn_failure",
          operation: "run_turn",
          reason: "worker_reported_failure",
          message: makeTextEvidence(
            turn.error?.message ?? "worker reported a failed turn",
          ),
        });
        return [session.endTurn("failed")];
      }
      return [];
    }
    default:
      return [];
  }
}

export function derivePermissionOptions(
  request: CodexApprovalRequest,
): PermissionOption[] {
  const options: PermissionOption[] = [];
  for (const decision of request.availableDecisions) {
    if (decision === "accept")
      options.push({ outcome: "allow", scope: "once" });
    else if (decision === "acceptForSession")
      options.push({ outcome: "allow", scope: "session" });
    else if (decision === "decline")
      options.push({ outcome: "deny", feedback: false });
    else if (decision === "cancel")
      options.push({ outcome: "deny", feedback: true });
  }
  return options;
}

function grantedSubset(request: CodexApprovalRequest) {
  const requested = request.requestedPermissions;
  return {
    ...(requested.network !== undefined && requested.network !== null
      ? { network: requested.network }
      : {}),
    ...(requested.fileSystem !== undefined && requested.fileSystem !== null
      ? { fileSystem: requested.fileSystem }
      : {}),
  };
}

export function resolutionToResponse(
  request: CodexApprovalRequest,
  resolution: PermissionResolution,
) {
  if (request.method === "item/permissions/requestApproval") {
    if (resolution.outcome === "deny") {
      return { permissions: {}, scope: "turn" };
    }
    return {
      permissions: grantedSubset(request),
      scope: resolution.scope === "session" ? "session" : "turn",
    };
  }
  if (resolution.outcome === "allow") {
    return {
      decision: resolution.scope === "session" ? "acceptForSession" : "accept",
    };
  }
  return { decision: "decline" };
}
