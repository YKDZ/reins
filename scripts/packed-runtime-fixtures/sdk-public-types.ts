import {
  connect,
  type AgentTarget,
  type HarnessId,
  type ModelCatalogFailure,
  type ModelCatalogResult,
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
const dynamicModelId: string = "vendor:model-2031-05-preview";
const dynamicReasoningEffort: string = "vendor-calibration-mode";

const spawnInput: SpawnInput = {
  harness: "codex",
  sessionName: "repeated labels remain valid consumer data",
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
// @ts-expect-error Built-in harness identifiers are a closed set.
const invalidHarness: SpawnInput["harness"] = arbitraryHarness;
// @ts-expect-error Generic inference must not widen the built-in harness set.
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
void started;
void activeTurnSend;
void newTurnSend;
void waitInput;
void resumed;
