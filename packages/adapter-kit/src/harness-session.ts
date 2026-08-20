import type {
  DomainEvent,
  MessageId,
  PermissionId,
  PermissionOption,
  SessionId,
  ToolCallId,
  TurnId,
} from "@reins/protocol";

import { noopTranscript, type TranscriptSink } from "./transcript.ts";

export type HarnessSessionOptions<TAttachment> = {
  sessionId: SessionId;
  emit: (event: DomainEvent) => void;
  transcript?: TranscriptSink;
  // 回合终态清空 pending 时，把附件交还 adapter 处置 harness 侧挂起请求。
  onClearPending?: (attachments: TAttachment[]) => void;
};

// mapper 可见的非泛型视图：只暴露回合簿记与转录，不暴露附件类型。
export type TurnJournal = {
  readonly sessionId: SessionId;
  turnId: TurnId | null;
  finalText: string | null;
  readonly toolNames: Map<string, string>;
  cancelling: boolean;
  beginTurn(turnId: TurnId): void;
  setTurnId(turnId: TurnId): void;
  setFinalText(text: string): void;
  setUsage(usage: Record<string, unknown>): void;
  transcript(kind: string, payload: unknown): void;
  messageId(nativeId: string): MessageId;
  toolCallId(nativeId: string): ToolCallId;
  endTurn(stopReason: "end_turn" | "cancelled" | "failed"): DomainEvent;
  failActiveTurn(): void;
};

// adapter 共用的会话骨架：回合簿记、turn.completed 构造、pending 决议结算、
// failed 合成与转录管线。harness 专属逻辑（消息映射、决议翻译）留在各 adapter。
export class HarnessSession<TAttachment = unknown> implements TurnJournal {
  readonly sessionId: SessionId;
  turnId: TurnId | null = null;
  finalText: string | null = null;
  lastUsage: Record<string, unknown> | null = null;
  cancelling = false;
  readonly toolNames = new Map<string, string>();

  private readonly emit: (event: DomainEvent) => void;
  private readonly transcriptSink: TranscriptSink;
  private readonly onClearPending:
    | ((attachments: TAttachment[]) => void)
    | undefined;
  private readonly pending = new Map<string, { attachment: TAttachment }>();
  private permissionSeq = 0;
  private messageSeq = 0;
  private toolCallSeq = 0;
  private readonly messageIds = new Map<string, MessageId>();
  private readonly toolCallIds = new Map<string, ToolCallId>();

  constructor(options: HarnessSessionOptions<TAttachment>) {
    this.sessionId = options.sessionId;
    this.emit = options.emit;
    this.transcriptSink = options.transcript ?? noopTranscript;
    this.onClearPending = options.onClearPending;
  }

  beginTurn(turnId: TurnId): void {
    this.turnId = turnId;
    this.finalText = null;
    this.lastUsage = null;
    this.cancelling = false;
  }

  setTurnId(turnId: TurnId): void {
    this.turnId = turnId;
  }

  setFinalText(text: string): void {
    this.finalText = text;
  }

  setUsage(usage: Record<string, unknown>): void {
    this.lastUsage = usage;
  }

  transcript(kind: string, payload: unknown): void {
    this.transcriptSink(kind, payload);
  }

  requestPermission(
    kind: string,
    input: unknown,
    options: PermissionOption[],
    attachment: TAttachment,
  ): PermissionId {
    this.permissionSeq += 1;
    const permissionId = `p${this.permissionSeq}` as PermissionId;
    this.pending.set(permissionId, { attachment });
    this.emit({
      type: "permission.requested",
      sessionId: this.sessionId,
      turnId: this.requireTurnId(),
      permissionId,
      kind,
      input,
      options,
    });
    return permissionId;
  }

  takePending(permissionId: PermissionId): TAttachment | undefined {
    const entry = this.pending.get(permissionId);
    if (entry === undefined) return undefined;
    this.pending.delete(permissionId);
    return entry.attachment;
  }

  clearPending(): void {
    const attachments = [...this.pending.values()].map(
      (entry) => entry.attachment,
    );
    this.pending.clear();
    if (this.onClearPending !== undefined && attachments.length > 0) {
      this.onClearPending(attachments);
    }
  }

  messageId(nativeId: string): MessageId {
    const existing = this.messageIds.get(nativeId);
    if (existing !== undefined) return existing;
    this.messageSeq += 1;
    const messageId = `m${this.messageSeq}` as MessageId;
    this.messageIds.set(nativeId, messageId);
    return messageId;
  }

  toolCallId(nativeId: string): ToolCallId {
    const existing = this.toolCallIds.get(nativeId);
    if (existing !== undefined) return existing;
    this.toolCallSeq += 1;
    const toolCallId = `c${this.toolCallSeq}` as ToolCallId;
    this.toolCallIds.set(nativeId, toolCallId);
    return toolCallId;
  }

  private requireTurnId(): TurnId {
    if (this.turnId === null) {
      throw new Error("permission requested without an active turn");
    }
    return this.turnId;
  }

  endTurn(stopReason: "end_turn" | "cancelled" | "failed"): DomainEvent {
    const turnId = this.requireTurnId();
    const event: DomainEvent = {
      type: "turn.completed",
      sessionId: this.sessionId,
      turnId,
      stopReason,
      finalReply: stopReason === "end_turn" ? this.finalText : null,
      ...(stopReason === "end_turn" && this.lastUsage !== null
        ? { usage: this.lastUsage }
        : {}),
    };
    this.turnId = null;
    this.finalText = null;
    this.lastUsage = null;
    this.cancelling = false;
    this.clearPending();
    return event;
  }

  failActiveTurn(): void {
    if (this.turnId === null) return;
    const turnId = this.turnId;
    this.emit({
      type: "turn.completed",
      sessionId: this.sessionId,
      turnId,
      stopReason: "failed",
      finalReply: null,
    });
    this.turnId = null;
    this.finalText = null;
    this.lastUsage = null;
    this.cancelling = false;
    this.clearPending();
  }
}
