import type { TurnJournal } from "@reins/adapter-kit";
import type {
  DomainEvent,
  PermissionOption,
  PermissionResolution,
} from "@reins/protocol";

import type { CommandExecutionApprovalDecision } from "#/generated/v2/CommandExecutionApprovalDecision";
import type { FileChangeApprovalDecision } from "#/generated/v2/FileChangeApprovalDecision";
import type { GrantedPermissionProfile } from "#/generated/v2/GrantedPermissionProfile";
import type { PermissionGrantScope } from "#/generated/v2/PermissionGrantScope";
import type { ThreadItem } from "#/generated/v2/ThreadItem";
import type { TurnStatus } from "#/generated/v2/TurnStatus";

const toolItems = new Set(["commandExecution", "fileChange", "mcpToolCall"]);

function isFailedStatus(status: string): boolean {
  return status === "failed" || status === "declined";
}

function mapItemStarted(session: TurnJournal, item: ThreadItem): DomainEvent[] {
  if (item.type === "reasoning") {
    session.transcript("reasoning", item);
    return [];
  }
  if (!toolItems.has(item.type) || session.turnId === null) return [];
  session.toolNames.set(item.id, item.type);
  return [
    {
      type: "tool.requested",
      sessionId: session.sessionId,
      turnId: session.turnId,
      toolCallId: item.id,
      name: item.type,
    },
  ];
}

function mapItemCompleted(
  session: TurnJournal,
  item: ThreadItem,
): DomainEvent[] {
  if (session.turnId === null) return [];
  if (item.type === "agentMessage") {
    session.setFinalText(item.text);
    return [
      {
        type: "message",
        sessionId: session.sessionId,
        turnId: session.turnId,
        messageId: item.id,
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
        toolCallId: item.id,
        name: session.toolNames.get(item.id) ?? "commandExecution",
        result: item.aggregatedOutput,
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
        toolCallId: item.id,
        name: session.toolNames.get(item.id) ?? "fileChange",
        result: JSON.stringify(item.changes),
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
        toolCallId: item.id,
        name: session.toolNames.get(item.id) ?? "mcpToolCall",
        result: item.error?.message ?? JSON.stringify(item.result),
        isError: isFailedStatus(item.status) || item.error !== null,
      },
    ];
  }
  return [];
}

export function mapNotification(
  session: TurnJournal,
  method: string,
  params: unknown,
): DomainEvent[] {
  const p = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case "item/agentMessage/delta":
      if (session.turnId === null || typeof p.delta !== "string") return [];
      return [
        {
          type: "text.delta",
          sessionId: session.sessionId,
          turnId: session.turnId,
          messageId: typeof p.itemId === "string" ? p.itemId : "",
          delta: p.delta,
        },
      ];
    case "item/started":
      return mapItemStarted(session, p.item as ThreadItem);
    case "item/completed":
      return mapItemCompleted(session, p.item as ThreadItem);
    case "thread/tokenUsage/updated":
      session.setUsage((p.tokenUsage ?? null) as Record<string, unknown>);
      return [];
    case "turn/completed": {
      if (session.turnId === null) return [];
      const turn = p.turn as
        | { status?: TurnStatus; error?: unknown }
        | undefined;
      if (turn === undefined) return [];
      if (turn.status === "completed") return [session.endTurn("end_turn")];
      if (turn.status === "interrupted") return [session.endTurn("cancelled")];
      if (turn.status === "failed") {
        session.transcript("turn_failed", turn.error);
        return [session.endTurn("failed")];
      }
      return [];
    }
    default:
      return [];
  }
}

const approvalMethods = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

export function isApprovalRequest(method: string): boolean {
  return approvalMethods.has(method);
}

export function derivePermissionOptions(
  method: string,
  params: Record<string, unknown>,
): PermissionOption[] {
  const options: PermissionOption[] = [];
  for (const decision of (params.availableDecisions ?? []) as Array<
    CommandExecutionApprovalDecision | FileChangeApprovalDecision
  >) {
    if (decision === "accept")
      options.push({ outcome: "allow", scope: "once" });
    else if (decision === "acceptForSession")
      options.push({ outcome: "allow", scope: "session" });
    else if (decision === "decline")
      options.push({ outcome: "deny", feedback: false });
  }
  if (options.length === 0) {
    options.push(
      { outcome: "allow", scope: "once" },
      { outcome: "allow", scope: "session" },
      { outcome: "deny", feedback: false },
    );
  }
  return options;
}

function grantedSubset(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const requested = params.permissions as
    | { network?: unknown; fileSystem?: unknown }
    | undefined;
  if (requested === undefined) return {};
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
  method: string,
  resolution: PermissionResolution,
  params: Record<string, unknown>,
):
  | { decision: CommandExecutionApprovalDecision | FileChangeApprovalDecision }
  | { permissions: GrantedPermissionProfile; scope: PermissionGrantScope } {
  if (method === "item/permissions/requestApproval") {
    if (resolution.outcome === "deny") {
      return { permissions: {}, scope: "turn" };
    }
    return {
      permissions: grantedSubset(params),
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
