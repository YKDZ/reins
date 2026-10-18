import type { TurnJournal } from "@reins/adapter-kit";
import {
  makeTextEvidence,
  UNKNOWN_HARNESS_FAILURE,
  type DomainEvent,
  type MessageContent,
  type MessageContentPart,
  type MessageId,
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
  readonly pendingBodyById: Map<string, MessageContent>;
  readonly flushedTextIds: Set<string>;
  readonly requestedToolIds: Set<string>;
  readonly completedToolIds: Set<string>;
};

export function createQoderMappingState(): QoderMappingState {
  return {
    currentAssistantId: null,
    pendingTextById: new Map(),
    pendingBodyById: new Map(),
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
    const body = state.pendingBodyById.get(id) ?? content;
    state.pendingBodyById.delete(id);
    if (state.flushedTextIds.has(id)) continue;
    state.flushedTextIds.add(id);
    events.push({
      type: "message",
      sessionId: session.sessionId,
      turnId: session.turnId,
      messageId: session.messageId(id),
      role: "worker",
      content: body,
      ...(id === nativeTruncatedId ? { nativeTruncated: true as const } : {}),
    });
  }
  return events;
}

function stageTextSnapshot(
  state: QoderMappingState,
  nativeId: string,
  content: string,
  body: MessageContent,
): "pending" | "flushed" {
  if (state.flushedTextIds.has(nativeId)) return "flushed";
  state.pendingTextById.set(nativeId, content);
  state.pendingBodyById.set(
    nativeId,
    mergeMessageBody(state.pendingBodyById.get(nativeId), body),
  );
  return "pending";
}

function sameMessagePart(
  left: MessageContentPart,
  right: MessageContentPart,
): boolean {
  if (left.type === "tool_call" && right.type === "tool_call") {
    return left.toolCallId === right.toolCallId;
  }
  if (left.type === "tool_result" && right.type === "tool_result") {
    return left.toolCallId === right.toolCallId;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeMessageBody(
  previous: MessageContent | undefined,
  incoming: MessageContent,
): MessageContent {
  if (previous === undefined) return incoming;
  const previousParts: MessageContentPart[] =
    typeof previous === "string"
      ? [{ type: "text", text: previous }]
      : previous;
  const incomingParts: MessageContentPart[] =
    typeof incoming === "string"
      ? [{ type: "text", text: incoming }]
      : incoming;
  const incomingText = incomingParts.filter(
    (part): part is Extract<MessageContentPart, { type: "text" }> =>
      part.type === "text",
  );
  const merged = [...previousParts];
  if (incomingText.length > 0) {
    const firstTextIndex = merged.findIndex((part) => part.type === "text");
    if (firstTextIndex === -1) {
      merged.push(...incomingText);
    } else {
      for (let index = merged.length - 1; index >= 0; index -= 1) {
        if (merged[index]?.type === "text") merged.splice(index, 1);
      }
      merged.splice(firstTextIndex, 0, ...incomingText);
    }
  }
  for (const part of incomingParts) {
    if (part.type === "text") continue;
    if (!merged.some((candidate) => sameMessagePart(candidate, part))) {
      merged.push(part);
    }
  }
  if (
    merged.every(
      (part) =>
        part.type === "text" &&
        part.annotations === undefined &&
        part.textElements === undefined,
    )
  ) {
    return merged
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
  }
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function qoderMessageBody(
  session: TurnJournal,
  content: string | SDKAssistantMessage["message"]["content"],
): MessageContent {
  if (typeof content === "string") return content;
  if (
    content.every(
      (block) =>
        block.type === "text" &&
        typeof block.text === "string" &&
        (block.citations === undefined || block.citations === null),
    )
  ) {
    return content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
  }
  const parts: MessageContentPart[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push({
        type: "text",
        text: block.text,
        ...(block.citations === undefined || block.citations === null
          ? {}
          : { annotations: block.citations }),
      });
    } else if (
      block.type === "thinking" &&
      typeof block.thinking === "string"
    ) {
      parts.push({
        type: "thinking",
        text: block.thinking,
        ...(typeof block.signature === "string"
          ? { signature: block.signature }
          : {}),
      });
    } else if (
      block.type === "redacted_thinking" &&
      typeof block.data === "string"
    ) {
      parts.push({ type: "redacted_thinking", data: block.data });
    } else if (block.type === "tool_use" && typeof block.id === "string") {
      parts.push({
        type: "tool_call",
        toolCallId: session.toolCallId(block.id),
      });
    } else if (
      block.type === "tool_result" &&
      typeof block.tool_use_id === "string"
    ) {
      parts.push({
        type: "tool_result",
        toolCallId: session.toolCallId(block.tool_use_id),
      });
    } else if (block.type === "image" && isRecord(block.source)) {
      const source = block.source;
      if (
        source.type === "base64" &&
        typeof source.data === "string" &&
        typeof source.media_type === "string"
      ) {
        parts.push({
          type: "image",
          source: "bytes",
          data: source.data,
          mediaType: source.media_type,
        });
      } else if (source.type === "url" && typeof source.url === "string") {
        parts.push({ type: "image", source: "url", url: source.url });
      } else {
        parts.push({
          type: "opaque",
          harness: "qoder",
          nativeType: block.type,
          value: block,
        });
      }
    } else if (block.type === "audio" && isRecord(block.source)) {
      const source = block.source;
      if (
        source.type === "base64" &&
        typeof source.data === "string" &&
        typeof source.media_type === "string"
      ) {
        parts.push({
          type: "audio",
          source: "bytes",
          data: source.data,
          mediaType: source.media_type,
        });
      } else if (source.type === "url" && typeof source.url === "string") {
        parts.push({ type: "audio", source: "url", url: source.url });
      } else {
        parts.push({
          type: "opaque",
          harness: "qoder",
          nativeType: block.type,
          value: block,
        });
      }
    } else {
      parts.push({
        type: "opaque",
        harness: "qoder",
        nativeType: block.type,
        value: block,
      });
    }
  }
  return parts;
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
    const nativeMessageId = isNonEmptyString(message.message.id)
      ? message.message.id
      : null;
    const body = qoderMessageBody(session, message.message.content);
    if (
      nativeMessageId !== null &&
      body !== "" &&
      (!Array.isArray(body) || body.length > 0)
    ) {
      stageTextSnapshot(state, nativeMessageId, text, body);
      events.push(...flushPendingText(session, state, nativeMessageId));
    }
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
  const body = qoderMessageBody(session, message.message.content);
  const hasBody = text.length > 0 || (Array.isArray(body) && body.length > 0);
  const staged =
    nativeMessageId !== null && hasBody
      ? stageTextSnapshot(state, nativeMessageId, text, body)
      : null;
  if (text.length > 0 && (nativeMessageId === null || staged === "pending")) {
    session.setFinalText(text);
  }
  if (message.message.usage !== undefined) {
    session.setUsage(message.message.usage);
  }

  if (message.aborted === true) {
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
  callerMessageId?: MessageId,
): DomainEvent[] {
  if (session.turnId === null) return [];
  const events: DomainEvent[] = [];
  const content = message.message.content;
  const contentToolResults = Array.isArray(content)
    ? content.filter((block) => block.type === "tool_result")
    : [];
  if (contentToolResults.length > 0) {
    if (
      contentToolResults.some(
        (block) =>
          typeof block.tool_use_id === "string" &&
          state.requestedToolIds.has(block.tool_use_id),
      )
    ) {
      events.push(...flushPendingText(session, state));
    }
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
    if (callerMessageId === undefined) return events;
  }
  if (message.tool_use_result !== undefined) {
    const meta = message.tool_result_meta?.find(
      (candidate) =>
        isNonEmptyString(candidate.id) &&
        state.requestedToolIds.has(candidate.id),
    );
    const parentId = isNonEmptyString(message.parent_tool_use_id)
      ? message.parent_tool_use_id
      : null;
    const toolCallId = meta?.id ?? parentId;
    if (toolCallId !== null && state.requestedToolIds.has(toolCallId)) {
      events.push(...flushPendingText(session, state));
    }
    const completed = completeTool(
      session,
      state,
      session.turnId,
      toolCallId,
      message.tool_use_result,
      meta?.non_execution_kind !== undefined,
    );
    if (completed !== null) events.push(completed);
  }
  if (callerMessageId !== undefined) {
    events.push({
      type: "message",
      sessionId: session.sessionId,
      turnId: session.turnId,
      messageId: callerMessageId,
      role: "caller",
      content: qoderMessageBody(session, content),
    });
  }
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
  events.push(session.endTurn("end_turn"));
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
  callerMessageId?: MessageId,
): Promise<DomainEvent[]> {
  switch (message.type) {
    case "stream_event":
      return mapStreamEvent(session, state, message);
    case "assistant":
      return mapAssistant(session, state, message);
    case "user":
      return mapUserMessage(session, state, message, callerMessageId);
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
