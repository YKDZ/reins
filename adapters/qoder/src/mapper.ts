import type { TurnJournal } from "@reins/adapter-kit";
import {
  makeTextEvidence,
  type DomainEvent,
  type PermissionOption,
} from "@reins/protocol";

import type {
  PermissionUpdate,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from "./sdk-seam.ts";

export type QoderMappingState = {
  currentAssistantId: string | null;
  readonly emittedTextMessageIds: Set<string>;
  readonly requestedToolIds: Set<string>;
  readonly completedToolIds: Set<string>;
};

export function createQoderMappingState(): QoderMappingState {
  return {
    currentAssistantId: null,
    emittedTextMessageIds: new Set(),
    requestedToolIds: new Set(),
    completedToolIds: new Set(),
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function stringifyToolResult(result: unknown): string | null {
  if (result === undefined || result === null) return null;
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return "[unserializable]";
  }
}

function requestTool(
  session: TurnJournal,
  state: QoderMappingState,
  turnId: NonNullable<TurnJournal["turnId"]>,
  nativeId: unknown,
  name: unknown,
): DomainEvent | null {
  if (
    !isNonEmptyString(nativeId) ||
    !isNonEmptyString(name) ||
    state.requestedToolIds.has(nativeId)
  ) {
    return null;
  }
  state.requestedToolIds.add(nativeId);
  session.toolNames.set(nativeId, name);
  return {
    type: "tool.requested",
    sessionId: session.sessionId,
    turnId,
    toolCallId: session.toolCallId(nativeId),
    name,
  };
}

function completeTool(
  session: TurnJournal,
  state: QoderMappingState,
  turnId: NonNullable<TurnJournal["turnId"]>,
  nativeId: unknown,
  result: unknown,
  isError: boolean,
): DomainEvent | null {
  if (
    !isNonEmptyString(nativeId) ||
    !state.requestedToolIds.has(nativeId) ||
    state.completedToolIds.has(nativeId)
  ) {
    return null;
  }
  const name = session.toolNames.get(nativeId);
  if (name === undefined) return null;
  state.completedToolIds.add(nativeId);
  return {
    type: "tool.completed",
    sessionId: session.sessionId,
    turnId,
    toolCallId: session.toolCallId(nativeId),
    name,
    result: stringifyToolResult(result),
    isError,
  };
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
  state: QoderMappingState,
  message: SDKPartialAssistantMessage,
): DomainEvent[] {
  if (session.turnId === null) return [];
  const event = message.event;
  const turnId = session.turnId;
  if (event.type === "message_start") {
    state.currentAssistantId = isNonEmptyString(event.message?.id)
      ? event.message.id
      : null;
    return [];
  }
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
      state.currentAssistantId = null;
      return [session.endTurn("end_turn")];
    }
    return [];
  }
  if (event.type === "content_block_delta" && isTextDelta(event.delta)) {
    const nativeId = state.currentAssistantId;
    if (nativeId === null) return [];
    return [
      {
        type: "text.delta",
        sessionId: session.sessionId,
        turnId,
        messageId: session.messageId(nativeId),
        delta: event.delta.text,
      },
    ];
  }
  const block = event.content_block;
  if (
    event.type === "content_block_start" &&
    block !== undefined &&
    block.type === "tool_use"
  ) {
    const requested = requestTool(session, state, turnId, block.id, block.name);
    return requested === null ? [] : [requested];
  }
  return [];
}

function mapAssistant(
  session: TurnJournal,
  state: QoderMappingState,
  message: SDKAssistantMessage,
): DomainEvent[] {
  if (session.turnId === null) return [];
  const turnId = session.turnId;
  const events: DomainEvent[] = [];
  const nativeMessageId = isNonEmptyString(message.message.id)
    ? message.message.id
    : null;
  if (nativeMessageId !== null) state.currentAssistantId = nativeMessageId;

  for (const block of message.message.content) {
    if (block.type === "thinking") {
      continue;
    }
    if (block.type === "tool_use") {
      const requested = requestTool(
        session,
        state,
        turnId,
        block.id,
        block.name,
      );
      if (requested !== null) events.push(requested);
      continue;
    }
    if (block.type === "tool_result") {
      const completed = completeTool(
        session,
        state,
        turnId,
        block.tool_use_id,
        block.content,
        block.is_error === true,
      );
      if (completed !== null) events.push(completed);
    }
  }

  const text = message.message.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("");
  if (text.length > 0 && nativeMessageId !== null) {
    session.setFinalText(text);
    if (!state.emittedTextMessageIds.has(nativeMessageId)) {
      state.emittedTextMessageIds.add(nativeMessageId);
      events.push({
        type: "message",
        sessionId: session.sessionId,
        turnId,
        messageId: session.messageId(nativeMessageId),
        role: "worker",
        content: text,
      });
    }
  }
  if (message.message.usage !== undefined) {
    session.setUsage(message.message.usage);
  }

  if (message.isApiErrorMessage === true) {
    void session.diagnostic({
      kind: "turn_failure",
      operation: "run_turn",
      reason: "worker_reported_failure",
      message: makeTextEvidence("worker reported a failed turn"),
    });
    state.currentAssistantId = null;
    events.push(session.endTurn("failed"));
  } else if (message.aborted === true && session.cancelling) {
    state.currentAssistantId = null;
    events.push(session.endTurn("cancelled"));
  } else if (message.message.stop_reason === "end_turn") {
    state.currentAssistantId = null;
    events.push(session.endTurn("end_turn"));
  }
  return events;
}

function mapUserMessage(
  session: TurnJournal,
  state: QoderMappingState,
  message: SDKUserMessage,
): DomainEvent[] {
  if (session.turnId === null) return [];
  const events: DomainEvent[] = [];
  const content = message.message.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "tool_result") {
        const completed = completeTool(
          session,
          state,
          session.turnId,
          block.tool_use_id,
          block.content,
          block.is_error === true,
        );
        if (completed !== null) events.push(completed);
      }
    }
  }
  if (message.tool_use_result === undefined) return events;
  const meta = message.tool_result_meta?.find(
    (candidate) =>
      isNonEmptyString(candidate.id) &&
      state.requestedToolIds.has(candidate.id),
  );
  const parentId = isNonEmptyString(message.parent_tool_use_id)
    ? message.parent_tool_use_id
    : null;
  const toolCallId = meta?.id ?? parentId;
  const completed = completeTool(
    session,
    state,
    session.turnId,
    toolCallId,
    message.tool_use_result,
    meta?.non_execution_kind !== undefined,
  );
  if (completed !== null) events.push(completed);
  return events;
}

function mapSystemMessage(
  session: TurnJournal,
  state: QoderMappingState,
  message: SDKSystemMessage,
): DomainEvent[] {
  if (message.subtype !== "session_state_changed") return [];
  if (message.state !== "idle" || session.turnId === null) return [];
  state.currentAssistantId = null;
  return [session.endTurn(session.cancelling ? "cancelled" : "end_turn")];
}

function mapResult(
  session: TurnJournal,
  state: QoderMappingState,
  message: SDKResultMessage,
): DomainEvent[] {
  if (session.turnId === null) return [];
  if (message.is_error || message.subtype.startsWith("error")) {
    void session.diagnostic({
      kind: "turn_failure",
      operation: "run_turn",
      reason: "worker_reported_failure",
      message: makeTextEvidence("worker reported a failed turn"),
    });
    state.currentAssistantId = null;
    return [session.endTurn("failed")];
  }
  return [];
}

export function mapSdkMessage(
  session: TurnJournal,
  state: QoderMappingState,
  message: SDKMessage,
): DomainEvent[] {
  switch (message.type) {
    case "stream_event":
      return mapStreamEvent(session, state, message);
    case "assistant":
      return mapAssistant(session, state, message);
    case "user":
      return mapUserMessage(session, state, message);
    case "system":
      return mapSystemMessage(session, state, message);
    case "result":
      return mapResult(session, state, message);
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
