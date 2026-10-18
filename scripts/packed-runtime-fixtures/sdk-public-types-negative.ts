import {
  type AgentTarget,
  type CompletedTurn,
  type DiagnosticRecord,
  type DiagnosticId,
  type MessageContentPart,
  type MessageKey,
  type OperationKey,
  type OperationRecord,
  type PermissionHandle,
  type SubscriptionStart,
  type ResumeCursor,
  type ReinsFailure,
  type ReinsConnection,
  type SendInput,
  type SendResult,
  type SessionHandle,
  type SessionInfo,
  type ToolKey,
  type TurnHandle,
  type WaitResult,
  parseOperationKey,
  serializeDiagnosticId,
  serializeMessageKey,
  serializeOperationKey,
  serializePermissionHandle,
  serializeResumeCursor,
  serializeToolKey,
  serializeTurnHandle,
} from "@ykdz/reins-sdk";

declare const connection: ReinsConnection;
declare const sessionHandle: SessionHandle;
declare const turnHandle: TurnHandle;
declare const spawnOperationKey: OperationKey<"spawn">;
declare const sendOperationKey: OperationKey<"send">;
declare const interruptOperationKey: OperationKey<"interrupt">;
declare const resumeCursor: ResumeCursor;
declare const completed: CompletedTurn;
declare const diagnosticId: DiagnosticId;
declare const messageKey: MessageKey;
declare const permissionHandle: PermissionHandle;
declare const toolKey: ToolKey;
const invalidToolCallPart: MessageContentPart = {
  type: "tool_call",
  // @ts-expect-error 正文中的工具关联必须使用公开 ToolKey。
  toolCallId: toolKey,
};
const invalidToolResultPart: MessageContentPart = {
  type: "tool_result",
  // @ts-expect-error 原生工具调用 ID 不作为 SDK 正文身份公开。
  toolCallId: "native-tool-id",
};

const diagnosticWithUnknownField: DiagnosticRecord = {
  v: 1,
  diagnosticId,
  recordedAt: "2026-10-18T00:00:00.000Z",
  severity: "info",
  source: "daemon",
  kind: "lifecycle",
  operation: "daemon",
  reason: "started",
  // @ts-expect-error 公开诊断记录不能夹带未定义字段。
  privatePayload: "secret",
};
const diagnosticWithUnknownReason: DiagnosticRecord = {
  v: 1,
  diagnosticId,
  recordedAt: "2026-10-18T00:00:00.000Z",
  severity: "info",
  source: "daemon",
  kind: "lifecycle",
  operation: "daemon",
  // @ts-expect-error 来源、阶段、原因必须匹配具体诊断类型。
  reason: "unlisted_reason",
};
const diagnosticWithMismatchedStage: DiagnosticRecord = {
  v: 1,
  diagnosticId,
  recordedAt: "2026-10-18T00:00:00.000Z",
  severity: "error",
  source: "daemon",
  kind: "request_failure",
  operation: "send",
  // @ts-expect-error 请求阶段必须与操作匹配。
  stage: "start_session",
  reason: "upstream_error",
  message: { text: "failed", truncated: false, originalBytes: 6 },
};
const diagnosticWithInvalidWorkerEventState: DiagnosticRecord = {
  v: 1,
  diagnosticId,
  recordedAt: "2026-10-18T00:00:00.000Z",
  severity: "error",
  source: "core",
  sessionHandle,
  kind: "protocol_violation",
  operation: "validate_worker_event",
  reason: "unknown_session",
  eventType: "message",
  // @ts-expect-error unknown_session 只能对应 unknown 状态。
  sessionState: "busy",
};

function readRequiredToolCallId(record: DiagnosticRecord): string | undefined {
  if (
    record.kind === "protocol_violation" &&
    record.operation === "validate_worker_event" &&
    record.reason === "tool_already_requested"
  ) {
    const toolCallId: string = record.toolCallId;
    return toolCallId;
  }
  return undefined;
}

// @ts-expect-error 会话句柄与回合句柄具有不同的公开身份。
const wrongTurn: TurnHandle = sessionHandle;
// @ts-expect-error 回合句柄序列化器不能接收会话句柄。
serializeTurnHandle(sessionHandle);
// @ts-expect-error 消息身份与工具身份不能互换。
const wrongToolKey: ToolKey = messageKey;
// @ts-expect-error 授权身份不能序列化为诊断身份。
serializeDiagnosticId(permissionHandle);
// @ts-expect-error 游标和工具身份不能互换。
serializeResumeCursor(toolKey);
// @ts-expect-error 工具身份不能序列化为消息身份。
serializeMessageKey(toolKey);
// @ts-expect-error 授权句柄不能序列化为工具身份。
serializeToolKey(permissionHandle);
// @ts-expect-error 诊断身份不能序列化为授权句柄。
serializePermissionHandle(diagnosticId);
// @ts-expect-error spawn 操作不能使用 send 操作键。
const wrongSpawnOperationKey: OperationKey<"spawn"> =
  connection.prepareOperation("send");
// @ts-expect-error 操作键会在泛型推断中保留操作类型。
const wrongOperation: OperationKey<"send"> = spawnOperationKey;
const activeTurnVariableWithPrecondition = {
  placement: "active_turn" as const,
  turnHandle,
  ifLastCompletedTurn: turnHandle,
  message: "invalid active turn precondition",
};
// @ts-expect-error active_turn 不接受新回合前置条件，即使变量带有该字段。
const invalidActiveTurnSend: SendInput = activeTurnVariableWithPrecondition;
// @ts-expect-error active_turn 不接受新回合前置条件，即使变量带有该字段。
void connection.send(activeTurnVariableWithPrecondition);
void invalidActiveTurnSend;
declare const sendRecord: OperationRecord<"send">;
// @ts-expect-error send 查询记录不能伪装成 spawn 查询记录。
const wrongSendRecord: OperationRecord<"spawn"> = sendRecord;
declare const interruptRecord: OperationRecord<"interrupt">;
// @ts-expect-error interrupt 操作记录不能被当作 send 查询记录。
const wrongInterruptRecord: OperationRecord<"send"> = interruptRecord;
void wrongInterruptRecord;
// @ts-expect-error 显式泛型操作种类必须同时接受运行时校验的种类。
parseOperationKey<"send">(serializeOperationKey(spawnOperationKey));
async function inspectSendRecordKind(): Promise<void> {
  const operation = await connection.getOperation(sendOperationKey);
  if (operation.status !== "succeeded") return;
  const result: SendResult = operation.result;
  // @ts-expect-error send 结果不能读取 spawn 专属的工作目录。
  const cwd: string = operation.result.cwd;
  void result;
  void cwd;
}
void connection.spawn(
  { harness: "codex", cwd: "/tmp", message: "x" },
  {
    // @ts-expect-error 显式操作键必须和动作种类一致。
    operationKey: sendOperationKey,
  },
);

const invalidSend: SendInput = {
  placement: "active_turn",
  turnHandle,
  // @ts-expect-error 活跃回合目标不能同时包含会话目标。
  sessionHandle,
  message: "ambiguous target",
};
const unreachableSessionFields = {
  sessionHandle,
  harness: "qoder" as const,
  model: null,
  reasoning: null,
  cwd: "/consumer/workspace",
  spawnedAt: "2026-10-18T00:00:00.000Z",
  turns: 1,
};
// @ts-expect-error 已知 busy 状态必须保留活动回合。
const unreachableBusyWithoutActiveTurn: SessionInfo = {
  ...unreachableSessionFields,
  state: "unreachable",
  lastKnownState: "busy",
  unreachableReason: "control_lost",
};
// @ts-expect-error 已知 idle 状态必须保留最近完成回合。
const unreachableIdleWithoutCompletedTurn: SessionInfo = {
  ...unreachableSessionFields,
  state: "unreachable",
  lastKnownState: "idle",
  unreachableReason: "previous_generation",
};
const unreachableIdleWithActiveTurn: SessionInfo = {
  ...unreachableSessionFields,
  state: "unreachable",
  lastKnownState: "idle",
  lastCompletedTurn: { turnHandle, stopReason: "end_turn" },
  // @ts-expect-error idle 状态不能携带活动回合。
  lastKnownActiveTurn: turnHandle,
  unreachableReason: "previous_generation",
};
// @ts-expect-error unreachable 结果必须说明至少一个不可达目标。
const unreachableWaitWithoutTargets: WaitResult = {
  status: "unreachable",
  completed: [],
  pending: [],
};
void unreachableIdleWithActiveTurn;
void unreachableBusyWithoutActiveTurn;
void unreachableIdleWithoutCompletedTurn;
void unreachableWaitWithoutTargets;
const missingCursor = { mode: "after" } as const;
// @ts-expect-error 续接操作必须提供精确的恢复游标。
const invalidAfterStart: SubscriptionStart = missingCursor;
const conflictingSnapshotStart = {
  mode: "snapshot",
  cursor: resumeCursor,
} as const;
// @ts-expect-error snapshot 开始方式不能夹带 after 游标变量。
const invalidSnapshotStart: SubscriptionStart = conflictingSnapshotStart;
const sessionTarget: AgentTarget = { scope: "session", sessionHandle };
// @ts-expect-error 目标范围决定可接受的句柄类型。
const mismatchedTarget: AgentTarget = { scope: "turn", sessionHandle };
function attachWithStart<Start extends SubscriptionStart>(start: Start) {
  return connection.attach(sessionTarget, start);
}
// @ts-expect-error 泛型入口也必须拒绝互相矛盾的开始方式字段。
void attachWithStart(conflictingSnapshotStart);
// @ts-expect-error 公开 attach 不能接受带冲突游标的变量。
void connection.attach(sessionTarget, conflictingSnapshotStart);
void invalidAfterStart;
void invalidSnapshotStart;

const eventFailureWithoutSession: Extract<
  ReinsFailure,
  {
    code: "control_store_unavailable";
  }
> = {
  code: "control_store_unavailable",
  // @ts-expect-error 事件存储故障必须关联真实会话。
  facts: {
    stage: "event",
    eventType: "message",
    cause: { kind: "io", message: "failed" },
  },
};
if (eventFailureWithoutSession.facts.stage === "event") {
  // @ts-expect-error 异步事件故障没有 caller 操作键。
  void eventFailureWithoutSession.facts.operationKey;
}

const operationFailureWithoutKey: Extract<
  ReinsFailure,
  {
    code: "control_store_unavailable";
  }
> = {
  code: "control_store_unavailable",
  // @ts-expect-error 操作阶段故障必须关联实际操作键。
  facts: {
    stage: "commit",
    acceptance: "accepted",
    cause: { kind: "io", message: "failed" },
  },
};

if (completed.stopReason === "end_turn") {
  // @ts-expect-error 成功结束回合的结果没有失败分支。
  void completed.failure;
}

void wrongTurn;
void wrongToolKey;
void wrongOperation;
void wrongSendRecord;
void inspectSendRecordKind;
async function inspectInterruptRecordKind(): Promise<void> {
  const operation = await connection.getOperation(interruptOperationKey);
  if (operation.status !== "succeeded") return;
  // @ts-expect-error interrupt 结果只有精确中断确认，不包含 send 的 messageKey。
  const messageKey: MessageKey = operation.result.messageKey;
  void messageKey;
}
void inspectInterruptRecordKind;
void wrongSpawnOperationKey;
void invalidSend;
void invalidAfterStart;
void invalidSnapshotStart;
void sessionTarget;
void mismatchedTarget;
void eventFailureWithoutSession;
void operationFailureWithoutKey;
void resumeCursor;
void invalidToolCallPart;
void invalidToolResultPart;
void diagnosticWithUnknownField;
void diagnosticWithUnknownReason;
void diagnosticWithMismatchedStage;
void diagnosticWithInvalidWorkerEventState;
void readRequiredToolCallId;
