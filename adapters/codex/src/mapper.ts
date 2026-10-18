import { readFile } from "node:fs/promises";

import type { TurnJournal } from "@reins/adapter-kit";
import {
  makeTextEvidence,
  UNKNOWN_HARNESS_FAILURE,
  type DomainEvent,
  type HarnessFailure,
  type MessageContent,
  type MessageContentPart,
  type MessageId,
  type PermissionOption,
  type PermissionResolution,
} from "@reins/protocol";

import type {
  CodexApprovalRequest,
  CodexInboundItem,
  InboundMessage,
} from "./transport.ts";

// codex-cli 0.162.0 app-server 的 CodexErrorInfo；未知标签与 HTTP 状态不猜测。
function classifyFailure(info: unknown): HarnessFailure {
  switch (info) {
    case "usageLimitExceeded":
      return {
        failureCategory: "quota_exhausted",
        retryDisposition: "external_state_change",
      };
    case "rateLimitExceeded":
      return { failureCategory: "rate_limited", retryDisposition: "wait" };
    case "unauthorized":
      return {
        failureCategory: "credential_rejected",
        retryDisposition: "external_state_change",
      };
    case "contextWindowExceeded":
    case "badRequest":
      return {
        failureCategory: "request_rejected",
        retryDisposition: "input_change",
      };
    case "serverOverloaded":
    case "internalServerError":
      return {
        failureCategory: "provider_unavailable",
        retryDisposition: "wait",
      };
    case "sandboxError":
      return {
        failureCategory: "runtime_unavailable",
        retryDisposition: "external_state_change",
      };
    default:
      return UNKNOWN_HARNESS_FAILURE;
  }
}

function isFailedStatus(status: string): boolean {
  return status === "failed" || status === "declined";
}

function mapItemStarted(
  session: TurnJournal,
  item: CodexInboundItem,
): DomainEvent[] {
  if (
    item.type === "agentMessage" ||
    item.type === "userMessage" ||
    session.turnId === null
  )
    return [];
  session.toolNames.set(item.id, item.type);
  const input =
    item.type === "commandExecution"
      ? item.command
      : item.type === "fileChange"
        ? item.changes
        : item.type === "mcpToolCall"
          ? item.arguments
          : item.type === "dynamicToolCall"
            ? item.arguments
            : undefined;
  const name =
    item.type === "dynamicToolCall"
      ? item.namespace === null
        ? item.tool
        : `${item.namespace}.${item.tool}`
      : item.type;
  return [
    {
      type: "tool.requested",
      sessionId: session.sessionId,
      turnId: session.turnId,
      toolCallId: session.toolCallId(item.id),
      name,
      ...(input === undefined ? {} : { input }),
    },
  ];
}

function mapItemCompleted(
  session: TurnJournal,
  item: CodexInboundItem,
): DomainEvent[] {
  if (session.turnId === null) return [];
  if (item.type === "userMessage") return [];
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
        result: item.result,
        ...(item.error === null ? {} : { error: item.error }),
        isError: isFailedStatus(item.status) || item.error !== null,
      },
    ];
  }
  if (item.type === "dynamicToolCall") {
    const name =
      item.namespace === null ? item.tool : `${item.namespace}.${item.tool}`;
    return [
      {
        type: "tool.completed",
        sessionId: session.sessionId,
        turnId: session.turnId,
        toolCallId: session.toolCallId(item.id),
        name,
        result: item.contentItems,
        isError: isFailedStatus(item.status) || item.success === false,
      },
    ];
  }
  return [];
}

async function codexMessageBody(
  content: Extract<CodexInboundItem, { type: "userMessage" }>["content"],
): Promise<MessageContent> {
  const parts: MessageContentPart[] = [];
  for (const input of content) {
    switch (input.type) {
      case "text":
        parts.push({
          type: "text",
          text: input.text,
          ...(input.text_elements.length === 0
            ? {}
            : {
                textElements: input.text_elements.map((element) => ({
                  byteRange: { ...element.byteRange },
                  placeholder: element.placeholder,
                })),
              }),
        });
        break;
      case "image":
        parts.push({
          type: "image",
          source: "url",
          url: input.url,
          ...(input.detail === undefined ? {} : { detail: input.detail }),
        });
        break;
      case "localImage":
        try {
          const data = await readFile(input.path);
          parts.push({
            type: "image",
            source: "bytes",
            data: data.toString("base64"),
            ...(input.detail === undefined ? {} : { detail: input.detail }),
          });
        } catch {
          parts.push({
            type: "image",
            source: "unavailable",
            reason: "read_failed",
          });
        }
        break;
      case "audio":
        parts.push({ type: "audio", source: "url", url: input.url });
        break;
      case "localAudio":
        try {
          const data = await readFile(input.path);
          parts.push({
            type: "audio",
            source: "bytes",
            data: data.toString("base64"),
          });
        } catch {
          parts.push({
            type: "audio",
            source: "unavailable",
            reason: "read_failed",
          });
        }
        break;
      case "skill":
      case "mention":
        parts.push({
          type: "reference",
          referenceType: input.type,
          name: input.name,
        });
        break;
      default:
        input satisfies never;
    }
  }
  return parts;
}

async function mapCallerMessage(
  session: TurnJournal,
  item: Extract<CodexInboundItem, { type: "userMessage" }>,
  messageId: MessageId | undefined,
): Promise<DomainEvent[]> {
  if (session.turnId === null || messageId === undefined) return [];
  return [
    {
      type: "message",
      sessionId: session.sessionId,
      turnId: session.turnId,
      messageId,
      role: "caller",
      content: await codexMessageBody(item.content),
    },
  ];
}

export async function mapNotification(
  session: TurnJournal,
  message: Extract<InboundMessage, { kind: "notification" }>,
  callerMessageId?: MessageId,
): Promise<DomainEvent[]> {
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
      if (message.params.item.type === "userMessage")
        return mapCallerMessage(session, message.params.item, callerMessageId);
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
        const failed = await session.failTurn(
          classifyFailure(turn.error?.codexErrorInfo),
          {
            kind: "turn_failure",
            operation: "run_turn",
            reason: "worker_reported_failure",
            message: makeTextEvidence(
              turn.error?.message ?? "worker reported a failed turn",
            ),
          },
        );
        return [failed];
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
    // cancel 不携带反馈文本，不能映射为要求调用方反馈的 deny。
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
