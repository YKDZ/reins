import {
  connect,
  parseDiagnosticId,
  parseOperationCredential,
  parseSessionHandle,
  parseTurnHandle,
  serializeDiagnosticId,
  serializeOperationCredential,
  serializeSessionHandle,
  serializeTurnHandle,
  type AgentTarget,
  type AgentFact,
  type HarnessId,
  type ModelCatalogFailure,
  type ModelCatalogResult,
  type DiagnosticId,
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
declare const diagnosticId: DiagnosticId;
const dynamicModelId: string = "vendor:model-2031-05-preview";
const dynamicReasoningEffort: string = "vendor-calibration-mode";

const spawnInput: SpawnInput = {
  harness: "codex",
  sessionLabel: "repeated labels remain valid consumer data",
  message: "dynamic task input",
  cwd: "/consumer/workspace",
  model: dynamicModelId,
  reasoning: dynamicReasoningEffort,
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
const restoredSessionHandle = parseSessionHandle(
  serializeSessionHandle(sessionHandle),
);
const restoredTurnHandle = parseTurnHandle(serializeTurnHandle(turnHandle));
const restoredCredential = parseOperationCredential(
  "spawn",
  serializeOperationCredential("spawn", spawnCredential),
);
const restoredDiagnosticId = parseDiagnosticId(
  serializeDiagnosticId(diagnosticId),
);

const supportedHarness: HarnessId = "qoder";
function spawnWithHarness<Harness extends SpawnInput["harness"]>(
  harness: Harness,
) {
  return connection.spawn(
    { ...spawnInput, harness },
    connection.prepareOperation("spawn"),
  );
}
const arbitraryHarness: string = "third-party-harness";
// @ts-expect-error 内置 harness 标识保持闭集。
const invalidHarness: SpawnInput["harness"] = arbitraryHarness;
// @ts-expect-error 泛型推断不能扩大内置 harness 标识集合。
const invalidSpawn = spawnWithHarness(arbitraryHarness);

async function inspectModelCatalog(): Promise<
  [
    ModelCatalogResult["catalogs"][number] | undefined,
    ModelCatalogFailure | undefined,
  ]
> {
  const result = await connection.modelCatalog();
  const failure: ModelCatalogFailure | undefined = result.failures[0];
  return [result.catalogs[0], failure];
}

void connect;
void supportedHarness;
declare const publicFact: AgentFact;
if (publicFact.type === "tool.requested") {
  const completeToolInput: unknown = publicFact.input;
  void completeToolInput;
}
if (publicFact.type === "tool.completed") {
  const completeToolOutput: unknown = publicFact.result;
  void completeToolOutput;
}
if (publicFact.type === "message") {
  const nativeTruncation: true | undefined = publicFact.nativeTruncated;
  void nativeTruncation;
}
void invalidHarness;
void invalidSpawn;
void inspectModelCatalog;
void started;
void activeTurnSend;
void newTurnSend;
void waitInput;
void resumed;
void restoredSessionHandle;
void restoredTurnHandle;
void restoredCredential;
void restoredDiagnosticId;
