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
  type HarnessId,
  type ModelCatalogFailure,
  type ModelCatalogResult,
  type DiagnosticId,
  type ReinsConnection,
  type ReinsFailure,
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
async function inspectSpawnOperation(): Promise<DiagnosticId | undefined> {
  const operation = await connection.getOperation(spawnOperationKey);
  if (operation.status === "succeeded") return undefined;
  if (operation.status === "outcome_unknown" && operation.diagnosticId) {
    const evidence = await connection.diagnostics({
      diagnosticId: operation.diagnosticId,
    });
    if ("record" in evidence) return evidence.record.diagnosticId;
  }
  return undefined;
}

function inspectUnknownSpawnFailure(
  failure: ReinsFailure,
): DiagnosticId | undefined {
  return failure.code === "operation_outcome_unknown"
    ? failure.facts.diagnosticId
    : undefined;
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

void connect;
void supportedHarness;
void invalidHarness;
void invalidSpawn;
void inspectModelCatalog;
void inspectSpawnOperation;
void inspectUnknownSpawnFailure;
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
