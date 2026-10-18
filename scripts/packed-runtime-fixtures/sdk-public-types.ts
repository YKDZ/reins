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
  type MessageKey,
  type OperationRecord,
  type OperationKey,
  type ReinsConnection,
  type ReinsFailure,
  type ResumeCursor,
  type SendInput,
  type SendResult,
  type SessionHandle,
  type SessionInfo,
  type SessionState,
  type SpawnInput,
  type TurnHandle,
  type ToolKey,
  type WaitInput,
  type WaitResult,
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
  ifLastCompletedTurn: turnHandle,
  message: "next turn",
};
const sendOperationKey = connection.prepareOperation("send");
const interruptOperationKey = connection.prepareOperation("interrupt");
const generatedSend = connection.send(newTurnSend);
const keyedSend = connection.send(newTurnSend, {
  operationKey: sendOperationKey,
});
const sendOperationQuery: Promise<OperationRecord<"send">> =
  connection.getOperation(sendOperationKey);
const interruptOperationQuery: Promise<OperationRecord<"interrupt">> =
  connection.getOperation(interruptOperationKey);
void interruptOperationQuery;
function inspectUncommittedSendFailure(record: OperationRecord<"send">): void {
  if (
    record.status !== "not_accepted_uncommitted" &&
    record.status !== "not_accepted_unconfirmed" &&
    record.status !== "partial_effect_uncommitted" &&
    record.status !== "partial_effect_unconfirmed"
  )
    return;
  if (record.cause.kind === "io") {
    const causeKind: "io" = record.cause.kind;
    void causeKind;
  }
  const failureCode: ReinsFailure["code"] = record.error.code;
  void failureCode;
  if (
    record.status === "partial_effect_uncommitted" ||
    record.status === "partial_effect_unconfirmed"
  ) {
    const phase: "execution_phase_cancelled" = record.error.facts.effect.kind;
    const target: TurnHandle = record.error.facts.effect.turnHandle;
    void phase;
    void target;
  }
}
void inspectUncommittedSendFailure;
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
const unreachableState: SessionState = "unreachable";
async function inspectSpawnOperation(): Promise<
  string | DiagnosticId | undefined
> {
  const operation = await connection.getOperation(spawnOperationKey);
  if (operation.status === "succeeded") return operation.result.cwd;
  if (operation.status === "outcome_unknown" && operation.diagnosticId) {
    const evidence = await connection.diagnostics({
      diagnosticId: operation.diagnosticId,
    });
    if ("record" in evidence) return evidence.record.diagnosticId;
  }
  return undefined;
}

async function inspectSendOperation(): Promise<MessageKey | undefined> {
  const operation = await connection.getOperation(sendOperationKey);
  if (operation.status !== "succeeded") return undefined;
  const result: SendResult = operation.result;
  return result.messageKey;
}

async function inspectInterruptOperation(): Promise<"accepted" | undefined> {
  const operation = await connection.getOperation(interruptOperationKey);
  if (operation.status !== "succeeded") return undefined;
  const result = operation.result;
  return result.status;
}
void inspectInterruptOperation;

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
  const operationKey: OperationKey<"kill"> = storeFailure.facts.operationKey;
  void accepted;
  void operationKey;
}

function inspectWaitResult(result: WaitResult): string[] {
  if (result.status === "unreachable")
    return result.unreachable.map(
      ({ turnHandle, reason }) => `${reason}:${turnHandle}`,
    );
  return result.pending;
}

function inspectUnreachableSession(
  session: SessionInfo,
): TurnHandle | undefined {
  if (session.state !== "unreachable") return undefined;
  if (session.lastKnownState === "busy") return session.lastKnownActiveTurn;
  return session.lastCompletedTurn.turnHandle;
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
void unreachableState;
void invalidHarness;
void invalidSpawn;
void inspectModelCatalog;
void inspectWaitResult;
void inspectUnreachableSession;
void inspectSpawnOperation;
void inspectSendOperation;
void inspectUnknownSpawnFailure;
void started;
void generatedOperation;
void activeTurnSend;
void newTurnSend;
void generatedSend;
void keyedSend;
void sendOperationQuery;
void waitInput;
void resumed;
void restoredSessionHandle;
void restoredTurnHandle;
void restoredOperationKey;
void restoredDiagnosticId;
