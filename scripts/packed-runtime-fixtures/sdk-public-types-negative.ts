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

// @ts-expect-error session and turn handles have separate public identities.
const wrongTurn: TurnHandle = sessionHandle;
// @ts-expect-error a spawn operation cannot consume a send credential.
const wrongSpawnCredential: OperationCredential<"spawn"> =
  connection.prepareOperation("send");
// @ts-expect-error credentials retain the operation kind in generic inference.
const wrongOperation: OperationCredential<"send"> = spawnCredential;

const invalidSend: SendInput = {
  placement: "active_turn",
  turnHandle,
  // @ts-expect-error an active turn cannot also include a session target.
  sessionHandle,
  message: "ambiguous target",
};
const missingCursor = { mode: "after" } as const;
// @ts-expect-error continuation requires its exact resume cursor.
const invalidReplay: ReplayPolicy = missingCursor;
const sessionTarget: AgentTarget = { scope: "session", sessionHandle };
// @ts-expect-error target scope determines which handle is accepted.
const mismatchedTarget: AgentTarget = { scope: "turn", sessionHandle };

if (completed.stopReason === "end_turn") {
  // @ts-expect-error a successful end-turn result has no failure branch.
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
