import {
  connect,
  parseDiagnosticId,
  parseOperationKey,
  parseSessionHandle,
  parseTurnHandle,
  serializeDiagnosticId,
  serializeOperationKey,
  serializeSessionHandle,
  serializeTurnHandle,
  type AgentTarget,
  type AgentFact,
  type HarnessId,
  type MessageContentPart,
  type ModelCatalogFailure,
  type ModelCatalogResult,
  type DiagnosticId,
  type ReinsFailure,
  type ReinsConnection,
  type ResumeCursor,
  type SendInput,
  type SessionHandle,
  type SpawnInput,
  type TurnHandle,
  type ToolKey,
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
const spawnOperationKey = connection.prepareOperation("spawn");
const started = connection.spawn(spawnInput, {
  operationKey: spawnOperationKey,
});
const generatedOperation = connection.spawn(spawnInput);
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
const restoredOperationKey = parseOperationKey(
  serializeOperationKey(spawnOperationKey),
  "spawn",
);
const restoredDiagnosticId = parseDiagnosticId(
  serializeDiagnosticId(diagnosticId),
);

const supportedHarness: HarnessId = "qoder";
async function inspectSpawnOperation() {
  const operation = await connection.getOperation(spawnOperationKey);
  if (operation.status === "succeeded") return operation.result.cwd;
  return undefined;
}

function spawnWithHarness<Harness extends SpawnInput["harness"]>(
  harness: Harness,
) {
  return connection.spawn(
    { ...spawnInput, harness },
    { operationKey: connection.prepareOperation("spawn") },
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

declare const storeFailure: Extract<
  ReinsFailure,
  {
    code: "control_store_unavailable";
  }
>;
if (storeFailure.facts.stage === "event") {
  const affectedSession: SessionHandle = storeFailure.facts.sessionHandle;
  const affectedTurn: TurnHandle | undefined = storeFailure.facts.turnHandle;
  const cleanupSession: SessionHandle | undefined =
    storeFailure.facts.cleanupSessionHandle;
  const failedEventType: string = storeFailure.facts.eventType;
  void affectedSession;
  void affectedTurn;
  void cleanupSession;
  void failedEventType;
}
if (storeFailure.facts.stage === "event_commit") {
  const accepted: "accepted" = storeFailure.facts.acceptance;
  const operationKey: string = storeFailure.facts.operationKey;
  void accepted;
  void operationKey;
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
  const publicContent: string | MessageContentPart[] = publicFact.content;
  void publicContent;
  if (Array.isArray(publicFact.content)) {
    for (const part of publicFact.content) {
      if (part.type === "tool_call" || part.type === "tool_result") {
        const relatedTool: ToolKey = part.toolKey;
        void relatedTool;
      }
    }
  }
}
void invalidHarness;
void invalidSpawn;
void inspectModelCatalog;
void inspectSpawnOperation;
void started;
void generatedOperation;
void activeTurnSend;
void newTurnSend;
void waitInput;
void resumed;
void restoredSessionHandle;
void restoredTurnHandle;
void restoredOperationKey;
void restoredDiagnosticId;
