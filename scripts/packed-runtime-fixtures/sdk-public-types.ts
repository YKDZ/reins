import {
  connect,
  type AgentTarget,
  type ReinsConnection,
  type ResumeCursor,
  type SendInput,
  type SessionHandle,
  type SpawnInput,
  type TurnHandle,
  type WaitInput,
} from "@ykdz/reins-sdk";

declare const connection: ReinsConnection;
declare const sessionHandle: SessionHandle;
declare const turnHandle: TurnHandle;
declare const resumeCursor: ResumeCursor;

const spawnInput: SpawnInput = {
  harness: "a-runtime-defined-harness",
  sessionLabel: "repeated labels remain valid consumer data",
  message: "dynamic task input",
  cwd: "/consumer/workspace",
  model: "dynamic-model-id",
};
const spawnCredential = connection.prepareOperation("spawn");
const started = connection.spawn(spawnInput, spawnCredential);
const activeTurnSend: SendInput = {
  placement: "active_turn",
  turnHandle,
  message: "follow-up",
};
const newTurnSend: SendInput = {
  placement: "new_turn",
  sessionHandle,
  message: "next turn",
};
const target: AgentTarget = { scope: "turn", turnHandle };
const waitInput: WaitInput = {
  targets: [turnHandle],
  completion: "all",
  timeoutMs: 0,
};
const resumed = connection.attach(target, {
  mode: "after",
  cursor: resumeCursor,
});

void connect;
void started;
void activeTurnSend;
void newTurnSend;
void waitInput;
void resumed;
