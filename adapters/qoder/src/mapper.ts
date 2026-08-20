import type { TurnJournal } from "@reins/adapter-kit";
import type { DomainEvent, PermissionOption } from "@reins/protocol";

import type {
  PermissionUpdate,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from "./sdk-seam.ts";

function stringifyToolResult(result: unknown): string | null {
  if (result === undefined || result === null) return null;
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return "[unserializable]";
  }
}

function isTextDelta(
  delta: unknown,
): delta is { type: "text_delta"; text: string } {
  if (typeof delta !== "object" || delta === null || !("type" in delta)) {
    return false;
  }
  const candidate = delta as { type?: unknown; text?: unknown };
  return candidate.type === "text_delta" && typeof candidate.text === "string";
}

function mapStreamEvent(
  session: TurnJournal,
  message: SDKPartialAssistantMessage,
): DomainEvent[] {
  if (session.turnId === null) return [];
  const event = message.event;
  const turnId = session.turnId;
  if (event.type === "message_delta") {
    if (event.usage !== undefined) {
      session.setUsage(event.usage);
    }
    const delta = event.delta;
    if (
      delta !== null &&
      typeof delta === "object" &&
      "stop_reason" in delta &&
      (delta as { stop_reason?: unknown }).stop_reason === "end_turn"
    ) {
      return [session.endTurn("end_turn")];
    }
    return [];
  }
  if (event.type === "content_block_delta" && isTextDelta(event.delta)) {
    return [
      {
        type: "text.delta",
        sessionId: session.sessionId,
        turnId,
        messageId: session.messageId(message.uuid),
        delta: event.delta.text,
      },
    ];
  }
  const block = event.content_block;
  if (
    event.type === "content_block_start" &&
    block !== undefined &&
    block.type === "tool_use" &&
    typeof block.id === "string" &&
    typeof block.name === "string"
  ) {
    session.toolNames.set(block.id, block.name);
    return [
      {
        type: "tool.requested",
        sessionId: session.sessionId,
        turnId,
        toolCallId: session.toolCallId(block.id),
        name: block.name,
      },
    ];
  }
  return [];
}

function mapAssistant(
  session: TurnJournal,
  message: SDKAssistantMessage,
): DomainEvent[] {
  if (session.turnId === null) return [];
  const turnId = session.turnId;
  const events: DomainEvent[] = [];

  for (const block of message.message.content) {
    if (block.type === "thinking") {
      session.transcript("thinking", {
        uuid: message.uuid,
        thinking: block.thinking,
      });
      continue;
    }
    if (
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string" &&
      !session.toolNames.has(block.id)
    ) {
      session.toolNames.set(block.id, block.name);
      events.push({
        type: "tool.requested",
        sessionId: session.sessionId,
        turnId,
        toolCallId: session.toolCallId(block.id),
        name: block.name,
      });
      continue;
    }
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      events.push({
        type: "tool.completed",
        sessionId: session.sessionId,
        turnId,
        toolCallId: session.toolCallId(block.tool_use_id),
        name: session.toolNames.get(block.tool_use_id) ?? "",
        result: stringifyToolResult(block.content),
        isError: block.is_error === true,
      });
    }
  }

  const text = message.message.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("");
  if (text.length > 0) {
    session.setFinalText(text);
    events.push({
      type: "message",
      sessionId: session.sessionId,
      turnId,
      messageId: session.messageId(message.uuid),
      role: "worker",
      content: text,
    });
  }
  if (message.message.usage !== undefined) {
    session.setUsage(message.message.usage);
  }

  if (message.isApiErrorMessage === true) {
    events.push(session.endTurn("failed"));
  } else if (message.aborted === true && session.cancelling) {
    events.push(session.endTurn("cancelled"));
  } else if (message.message.stop_reason === "end_turn") {
    events.push(session.endTurn("end_turn"));
  }
  return events;
}

function mapUserMessage(
  session: TurnJournal,
  message: SDKUserMessage,
): DomainEvent[] {
  if (session.turnId === null) return [];
  const events: DomainEvent[] = [];
  const content = message.message.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      ) {
        events.push({
          type: "tool.completed",
          sessionId: session.sessionId,
          turnId: session.turnId,
          toolCallId: session.toolCallId(block.tool_use_id),
          name: session.toolNames.get(block.tool_use_id) ?? "",
          result: stringifyToolResult(block.content),
          isError: block.is_error === true,
        });
      }
    }
  }
  if (message.tool_use_result === undefined) return events;
  const meta = message.tool_result_meta?.[0];
  const toolCallId = (meta?.id ?? message.parent_tool_use_id)?.toString() ?? "";
  events.push({
    type: "tool.completed",
    sessionId: session.sessionId,
    turnId: session.turnId,
    toolCallId: session.toolCallId(toolCallId),
    name: session.toolNames.get(toolCallId) ?? "",
    result: stringifyToolResult(message.tool_use_result),
    isError: meta?.non_execution_kind !== undefined,
  });
  return events;
}

function mapSystemMessage(
  session: TurnJournal,
  message: SDKSystemMessage,
): DomainEvent[] {
  if (message.subtype !== "session_state_changed") return [];
  if (message.state !== "idle" || session.turnId === null) return [];
  return [session.endTurn(session.cancelling ? "cancelled" : "end_turn")];
}

function mapResult(
  session: TurnJournal,
  message: SDKResultMessage,
): DomainEvent[] {
  if (session.turnId === null) return [];
  if (message.is_error || message.subtype.startsWith("error")) {
    return [session.endTurn("failed")];
  }
  return [];
}

export function mapSdkMessage(
  session: TurnJournal,
  message: SDKMessage,
): DomainEvent[] {
  switch (message.type) {
    case "stream_event":
      return mapStreamEvent(session, message);
    case "assistant":
      return mapAssistant(session, message);
    case "user":
      return mapUserMessage(session, message);
    case "system":
      return mapSystemMessage(session, message);
    case "result":
      return mapResult(session, message);
    default:
      return [];
  }
}

export function derivePermissionOptions(
  suggestions: readonly PermissionUpdate[] | undefined,
): PermissionOption[] {
  const options: PermissionOption[] = [
    { outcome: "allow", scope: "once" },
    { outcome: "deny", feedback: true },
  ];
  const hasSession = (suggestions ?? []).some(
    (update) => update.type === "addRules" && update.destination === "session",
  );
  if (hasSession) options.splice(1, 0, { outcome: "allow", scope: "session" });
  return options;
}
