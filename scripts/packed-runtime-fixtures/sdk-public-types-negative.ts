import {
  type AgentTarget,
  type CompletedTurn,
  type DiagnosticId,
  type MessageContentPart,
  type MessageKey,
  type OperationKey,
  type PermissionHandle,
  type ReplayPolicy,
  type ResumeCursor,
  type ReinsFailure,
  type ReinsConnection,
  type SendInput,
  type SessionHandle,
  type ToolKey,
  type TurnHandle,
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
// @ts-expect-error 显式泛型操作种类必须同时接受运行时校验的种类。
parseOperationKey<"send">(serializeOperationKey(spawnOperationKey));
// @ts-expect-error 仅创建记录在本票提供可恢复结果查询。
void connection.getOperation(sendOperationKey);
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
const missingCursor = { mode: "after" } as const;
// @ts-expect-error 续接操作必须提供精确的恢复游标。
const invalidReplay: ReplayPolicy = missingCursor;
const sessionTarget: AgentTarget = { scope: "session", sessionHandle };
// @ts-expect-error 目标范围决定可接受的句柄类型。
const mismatchedTarget: AgentTarget = { scope: "turn", sessionHandle };

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
void wrongSpawnOperationKey;
void invalidSend;
void invalidReplay;
void sessionTarget;
void mismatchedTarget;
void eventFailureWithoutSession;
void operationFailureWithoutKey;
void resumeCursor;
void invalidToolCallPart;
void invalidToolResultPart;
