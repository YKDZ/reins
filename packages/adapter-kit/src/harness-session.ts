import type {
  AdapterDiagnosticFact,
  DiagnosticId,
  DomainEvent,
  HarnessFailure,
  MessageId,
  PermissionId,
  PermissionOption,
  PermissionResolution,
  MachineError,
  SessionId,
  ToolCallId,
  TurnId,
} from "@reins/protocol";
import {
  isPermissionResolutionAllowed,
  UNKNOWN_HARNESS_FAILURE,
} from "@reins/protocol";

import {
  acceptDiagnostic,
  noopDiagnosticSink,
  type DiagnosticSink,
} from "./diagnostic.ts";

type SessionDiagnosticFact = AdapterDiagnosticFact extends infer TInput
  ? TInput extends { kind: string }
    ? Omit<TInput, "sessionId" | "turnId">
    : never
  : never;

export type HarnessSessionOptions<TAttachment> = {
  sessionId: SessionId;
  emit: (event: DomainEvent) => void;
  diagnostics?: DiagnosticSink;
  // 回合终态清空 pending 时，把附件交还 adapter 处置 harness 侧挂起请求。
  onClearPending?: (attachments: TAttachment[]) => void;
};

// mapper 可见的非泛型视图：只暴露回合簿记与诊断，不暴露附件类型。
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
  diagnostic(input: SessionDiagnosticFact): Promise<DiagnosticId | undefined>;
  messageId(nativeId: string): MessageId;
  toolCallId(nativeId: string): ToolCallId;
  endTurn(stopReason: "end_turn" | "cancelled"): DomainEvent;
  failTurn(
    failure: HarnessFailure,
    evidence?: SessionDiagnosticFact,
  ): Promise<DomainEvent>;
  failActiveTurn(
    failure?: HarnessFailure,
    evidence?: SessionDiagnosticFact,
  ): Promise<void>;
};

// adapter 共用的会话骨架：回合簿记、turn.completed 构造、pending 决议结算、
// failed 合成与诊断管线。harness 专属逻辑（消息映射、决议翻译）留在各 adapter。
export class HarnessSession<TAttachment = unknown> implements TurnJournal {
  readonly sessionId: SessionId;
  turnId: TurnId | null = null;
  finalText: string | null = null;
  lastUsage: Record<string, unknown> | null = null;
  cancelling = false;
  readonly toolNames = new Map<string, string>();

  private readonly emit: (event: DomainEvent) => void;
  private readonly diagnosticSink: DiagnosticSink;
  private readonly onClearPending:
    | ((attachments: TAttachment[]) => void)
    | undefined;
  private readonly pending = new Map<
    string,
    { attachment: TAttachment; options: PermissionOption[] }
  >();
  private permissionSeq = 0;
  private messageSeq = 0;
  private toolCallSeq = 0;
  private readonly messageIds = new Map<string, MessageId>();
  private readonly toolCallIds = new Map<string, ToolCallId>();

  constructor(options: HarnessSessionOptions<TAttachment>) {
    this.sessionId = options.sessionId;
    this.emit = options.emit;
    this.diagnosticSink = options.diagnostics ?? noopDiagnosticSink;
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

  async diagnostic(
    input: SessionDiagnosticFact,
  ): Promise<DiagnosticId | undefined> {
    return await acceptDiagnostic(() =>
      this.diagnosticSink({
        ...input,
        sessionId: this.sessionId,
        ...(this.turnId === null ? {} : { turnId: this.turnId }),
      }),
    );
  }

  requestPermission(
    kind: string,
    input: unknown,
    options: PermissionOption[],
    attachment: TAttachment,
  ): PermissionId {
    this.permissionSeq += 1;
    const permissionId = `p${this.permissionSeq}` as PermissionId;
    this.pending.set(permissionId, { attachment, options });
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

  takePending(
    permissionId: PermissionId,
    resolution?: PermissionResolution,
  ): TAttachment | undefined {
    const entry = this.pending.get(permissionId);
    if (entry === undefined) return undefined;
    if (
      resolution !== undefined &&
      !isPermissionResolutionAllowed(entry.options, resolution)
    ) {
      throw {
        code: "permission_resolution_mismatch",
        sessionId: this.sessionId,
        permissionId,
      } satisfies MachineError;
    }
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

  endTurn(stopReason: "end_turn" | "cancelled"): DomainEvent {
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
    this.clearTurn();
    return event;
  }

  async failTurn(
    failure: HarnessFailure,
    evidence?: SessionDiagnosticFact,
  ): Promise<DomainEvent> {
    const turnId = this.requireTurnId();
    const acceptance =
      evidence === undefined ? undefined : this.diagnostic(evidence);
    this.clearTurn();
    const diagnosticId = await acceptance;
    return {
      type: "turn.completed",
      sessionId: this.sessionId,
      turnId,
      stopReason: "failed",
      failure,
      finalReply: null,
      ...(diagnosticId === undefined ? {} : { diagnosticId }),
    };
  }

  async failActiveTurn(
    failure: HarnessFailure = UNKNOWN_HARNESS_FAILURE,
    evidence?: SessionDiagnosticFact,
  ): Promise<void> {
    if (this.turnId === null) return;
    this.emit(await this.failTurn(failure, evidence));
  }

  private clearTurn(): void {
    this.turnId = null;
    this.finalText = null;
    this.lastUsage = null;
    this.cancelling = false;
    this.clearPending();
  }
}
