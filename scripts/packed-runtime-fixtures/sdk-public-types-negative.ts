import {
  type AgentTarget,
  type CompletedTurn,
  type OperationCredential,
  type ReplayPolicy,
  type ResumeCursor,
  type ReinsConnection,
  type SendInput,
  type SessionHandle,
  type TurnHandle,
} from "@ykdz/reins-sdk";

declare const connection: ReinsConnection;
declare const sessionHandle: SessionHandle;
declare const turnHandle: TurnHandle;
declare const spawnCredential: OperationCredential<"spawn">;
declare const resumeCursor: ResumeCursor;
declare const completed: CompletedTurn;

// @ts-expect-error 会话句柄与回合句柄具有不同的公开身份。
const wrongTurn: TurnHandle = sessionHandle;
// @ts-expect-error spawn 操作不能使用 send 凭据。
const wrongSpawnCredential: OperationCredential<"spawn"> =
  connection.prepareOperation("send");
// @ts-expect-error 凭据会在泛型推断中保留操作类型。
const wrongOperation: OperationCredential<"send"> = spawnCredential;

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

if (completed.stopReason === "end_turn") {
  // @ts-expect-error 成功结束回合的结果没有失败分支。
  void completed.failure;
}

void wrongTurn;
void wrongOperation;
void wrongSpawnCredential;
void invalidSend;
void invalidReplay;
void sessionTarget;
void mismatchedTarget;
void resumeCursor;
