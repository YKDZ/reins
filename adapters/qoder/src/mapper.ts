import type { TurnJournal } from "@reins/adapter-kit";
import {
  makeTextEvidence,
  UNKNOWN_HARNESS_FAILURE,
  type DomainEvent,
  type PermissionOption,
  type HarnessFailure,
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

// SDK 1.0.23 的结构化 error 标签；billing_error 不能证明余额耗尽。
function classifyAssistantFailure(
  error: SDKAssistantMessage["error"],
): HarnessFailure {
  switch (error) {
    case "authentication_failed":
      return {
        failureCategory: "credential_rejected",
        retryDisposition: "external_state_change",
      };
    case "rate_limit":
      return { failureCategory: "rate_limited", retryDisposition: "wait" };
    case "invalid_request":
      return {
        failureCategory: "request_rejected",
        retryDisposition: "input_change",
      };
    case "server_error":
      return {
        failureCategory: "provider_unavailable",
        retryDisposition: "wait",
      };
    default:
      return UNKNOWN_HARNESS_FAILURE;
  }
}

export type QoderMappingState = {
  currentAssistantId: string | null;
  readonly pendingTextById: Map<string, string>;
  readonly flushedTextIds: Set<string>;
  readonly requestedToolIds: Set<string>;
  readonly completedToolIds: Set<string>;
};

export function createQoderMappingState(): QoderMappingState {
  return {
    currentAssistantId: null,
    pendingTextById: new Map(),
    flushedTextIds: new Set(),
    requestedToolIds: new Set(),
    completedToolIds: new Set(),
  };
}

function flushPendingText(
  session: TurnJournal,
  state: QoderMappingState,
  nativeId?: string,
  nativeTruncatedId?: string,
): DomainEvent[] {
  if (session.turnId === null) return [];
  let pending: ReadonlyArray<readonly [string, string]>;
  if (nativeId === undefined) {
    pending = [...state.pendingTextById.entries()];
  } else {
    const content = state.pendingTextById.get(nativeId);
    pending = content === undefined ? [] : [[nativeId, content]];
  }
  const events: DomainEvent[] = [];
  for (const [id, content] of pending) {
    state.pendingTextById.delete(id);
    if (state.flushedTextIds.has(id)) continue;
    state.flushedTextIds.add(id);
    events.push({
      type: "message",
      sessionId: session.sessionId,
      turnId: session.turnId,
      messageId: session.messageId(id),
      role: "worker",
      content,
      ...(id === nativeTruncatedId ? { nativeTruncated: true as const } : {}),
    });
  }
  return events;
}

function stageTextSnapshot(
  state: QoderMappingState,
  nativeId: string,
  content: string,
): "pending" | "flushed" {
  if (state.flushedTextIds.has(nativeId)) return "flushed";
  state.pendingTextById.set(nativeId, content);
  return "pending";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function requestTool(
  session: TurnJournal,
  state: QoderMappingState,
  turnId: NonNullable<TurnJournal["turnId"]>,
  nativeId: unknown,
  name: unknown,
  input: unknown,
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
    ...(input === undefined ? {} : { input }),
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
    result: result ?? null,
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
    const events = flushPendingText(session, state);
    state.currentAssistantId = isNonEmptyString(event.message?.id)
      ? event.message.id
      : null;
    return events;
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
      const events = flushPendingText(session, state);
      state.currentAssistantId = null;
      events.push(session.endTurn("end_turn"));
      return events;
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
  if (event.type === "message_stop") {
    const nativeId = state.currentAssistantId;
    state.currentAssistantId = null;
    return nativeId === null ? [] : flushPendingText(session, state, nativeId);
  }
  const block = event.content_block;
  if (
    event.type === "content_block_start" &&
    block !== undefined &&
    block.type === "tool_use"
  ) {
    // 工具输入可能还会随 input_json_delta 到达；完整输入以最终 assistant 快照为准。
    return [];
  }
  return [];
}

async function mapAssistant(
  session: TurnJournal,
  state: QoderMappingState,
  message: SDKAssistantMessage,
): Promise<DomainEvent[]> {
  if (session.turnId === null) return [];
  const turnId = session.turnId;
  const events: DomainEvent[] = [];
  if (message.isApiErrorMessage === true) {
    events.push(...flushPendingText(session, state));
    state.currentAssistantId = null;
    const text = message.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    events.push(
      await session.failTurn(classifyAssistantFailure(message.error), {
        kind: "turn_failure",
        operation: "run_turn",
        reason: "worker_reported_failure",
        message: makeTextEvidence(text || "worker reported a failed turn"),
      }),
    );
    return events;
  }
  const nativeMessageId = isNonEmptyString(message.message.id)
    ? message.message.id
    : null;
  if (
    state.currentAssistantId !== null &&
    state.currentAssistantId !== nativeMessageId
  ) {
    events.push(...flushPendingText(session, state, state.currentAssistantId));
  }
  state.currentAssistantId = nativeMessageId;

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
        block.input,
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
  if (text.length > 0) {
    if (nativeMessageId === null) {
      session.setFinalText(text);
    } else if (stageTextSnapshot(state, nativeMessageId, text) === "pending") {
      session.setFinalText(text);
    }
  }
  if (message.message.usage !== undefined) {
    session.setUsage(message.message.usage);
  }

  if (message.aborted === true && session.cancelling) {
    events.push(
      ...flushPendingText(
        session,
        state,
        nativeMessageId ?? undefined,
        nativeMessageId ?? undefined,
      ),
    );
    state.currentAssistantId = null;
    events.push(session.endTurn("cancelled"));
  } else if (message.aborted === true) {
    events.push(
      ...flushPendingText(
        session,
        state,
        nativeMessageId ?? undefined,
        nativeMessageId ?? undefined,
      ),
    );
    state.currentAssistantId = null;
  } else if (message.message.stop_reason === "end_turn") {
    events.push(...flushPendingText(session, state));
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
  const contentToolResults = Array.isArray(content)
    ? content.filter((block) => block.type === "tool_result")
    : [];
  if (contentToolResults.length > 0) {
    for (const block of contentToolResults) {
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
    return events;
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
  const events = flushPendingText(session, state);
  state.currentAssistantId = null;
  events.push(session.endTurn(session.cancelling ? "cancelled" : "end_turn"));
  return events;
}

async function mapResult(
  session: TurnJournal,
  state: QoderMappingState,
  message: SDKResultMessage,
): Promise<DomainEvent[]> {
  if (session.turnId === null) return [];
  if (message.is_error || message.subtype.startsWith("error")) {
    const events = flushPendingText(session, state);
    state.currentAssistantId = null;
    const failed = await session.failTurn(UNKNOWN_HARNESS_FAILURE, {
      kind: "turn_failure",
      operation: "run_turn",
      reason: "worker_reported_failure",
      message: makeTextEvidence("worker reported a failed turn"),
    });
    events.push(failed);
    return events;
  }
  return [];
}

export async function mapSdkMessage(
  session: TurnJournal,
  state: QoderMappingState,
  message: SDKMessage,
): Promise<DomainEvent[]> {
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
