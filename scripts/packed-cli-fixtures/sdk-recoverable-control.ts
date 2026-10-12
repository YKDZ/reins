import {
  connect,
  ReinsSdkError,
  type OperationCredential,
  type ReinsConnection,
  type AgentFact,
  type ResumeCursor,
  type SessionHandle,
  type SpawnInput,
} from "@ykdz/reins-sdk";

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  stdout: { write(value: string): void };
};

type SpawnIntent = {
  readonly credential: OperationCredential<"spawn">;
  readonly input: SpawnInput;
};
type KillIntent = {
  readonly credential: OperationCredential<"kill">;
  readonly sessionHandle: SessionHandle;
};

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "")
    throw new Error(`The installed SDK control fixture needs ${name}`);
  return value;
}

function readIntent<T>(serialized: string): T {
  return JSON.parse(serialized) as T;
}

function publishIntent(value: SpawnIntent | KillIntent): string {
  const serialized = JSON.stringify(value);
  const restored = JSON.parse(serialized) as SpawnIntent | KillIntent;
  if (JSON.stringify(restored) !== serialized)
    throw new Error("The operation intent did not survive JSON serialization");
  return serialized;
}

async function connectSdk(): Promise<ReinsConnection> {
  return connect({
    socketPath: required("REINS_SOCKET"),
    consumerContext: required("REINS_CONSUMER_CONTEXT"),
  });
}

function spawnInput(): SpawnInput {
  return {
    sessionName: "packed-recover",
    harness: "fixture",
    message: "  exact task\nkeep spacing  ",
    cwd: required("REINS_WORKER_CWD"),
    agent: "fixture-agent",
    model: "fixture-model",
    reasoning: "high",
    authorizationMode: "interactive",
    sandbox: "workspace-write",
  };
}

function failure(error: unknown): ReinsSdkError {
  if (!(error instanceof ReinsSdkError))
    throw new Error("The installed SDK returned an untyped operation failure");
  return error;
}

async function expectFailure<T>(
  action: () => Promise<T>,
): Promise<ReinsSdkError> {
  try {
    await action();
  } catch (error) {
    return failure(error);
  }
  throw new Error("The installed SDK unexpectedly accepted the operation");
}

async function prepareSpawn(): Promise<void> {
  const connection = await connectSdk();
  try {
    const credential = connection.prepareOperation("spawn");
    const input = spawnInput();
    const serialized = publishIntent({ credential, input });
    const sessions = await connection.list();
    if (sessions.some((session) => session.sessionName === input.sessionName))
      throw new Error("Preparing an operation created a session");
    process.stdout.write(
      `${JSON.stringify({
        prepared: true,
        serialized: true,
        sessionCount: sessions.length,
        daemonGeneration: connection.handshake.daemonGeneration,
        intent: serialized,
      })}\n`,
    );
  } finally {
    connection.close();
  }
}

async function spawnValidation(): Promise<void> {
  const connection = await connectSdk();
  try {
    const input = spawnInput();
    const invalidCwd = await expectFailure(() =>
      connection.spawn(
        { ...input, cwd: `${input.cwd}/missing-directory` },
        connection.prepareOperation("spawn"),
      ),
    );
    const invalidModel = await expectFailure(() =>
      connection.spawn(
        { ...input, model: "fixture-missing-model" },
        connection.prepareOperation("spawn"),
      ),
    );
    const unsupportedFeature = await expectFailure(() =>
      connection.spawn(
        { ...input, captureHarnessStderr: true },
        connection.prepareOperation("spawn"),
      ),
    );
    const unknownHarness = await expectFailure(() =>
      connection.spawn(
        { ...input, harness: "fixture-missing" },
        connection.prepareOperation("spawn"),
      ),
    );
    const failures = [
      invalidCwd,
      invalidModel,
      unsupportedFeature,
      unknownHarness,
    ];
    if (
      invalidCwd.failure.code !== "invalid_params" ||
      invalidModel.failure.code !== "invalid_params" ||
      unsupportedFeature.failure.code !== "unsupported_feature" ||
      unknownHarness.failure.code !== "unknown_harness"
    )
      throw new Error("The installed SDK omitted spawn validation failures");
    process.stdout.write(
      `${JSON.stringify({ codes: failures.map(({ failure: item }) => item.code) })}\n`,
    );
  } finally {
    connection.close();
  }
}

async function spawnDrop(): Promise<void> {
  const intent = readIntent<SpawnIntent>(
    required("REINS_OPERATION_INTENT_JSON"),
  );
  const connection = await connectSdk();
  try {
    const error = await expectFailure(() =>
      connection.spawn(intent.input, intent.credential),
    );
    if (
      error.failure.code !== "command_outcome_unknown" ||
      error.failure.facts.operation !== "spawn" ||
      error.failure.facts.cause !== "disconnected" ||
      error.stage !== "operation"
    )
      throw new Error("The installed SDK omitted typed spawn recovery facts");
    process.stdout.write(
      `${JSON.stringify({ code: error.failure.code, stage: error.stage })}\n`,
    );
  } finally {
    connection.close();
  }
}

async function spawnRecover(): Promise<void> {
  const intent = readIntent<SpawnIntent>(
    required("REINS_OPERATION_INTENT_JSON"),
  );
  const connection = await connectSdk();
  try {
    const result = await connection.spawn(intent.input, intent.credential);
    const sessions = await connection.list({
      sessionHandle: result.sessionHandle,
    });
    if (
      sessions.length !== 1 ||
      sessions[0]?.sessionHandle !== result.sessionHandle ||
      sessions[0]?.state !== "busy" ||
      sessions[0]?.activeTurn !== result.turnHandle
    )
      throw new Error(
        "The SDK did not recover its exact live session and turn",
      );
    process.stdout.write(
      `${JSON.stringify({ result, listed: sessions[0] })}\n`,
    );
  } finally {
    connection.close();
  }
}

async function spawnConflict(): Promise<void> {
  const intent = readIntent<SpawnIntent>(
    required("REINS_OPERATION_INTENT_JSON"),
  );
  const connection = await connectSdk();
  try {
    const error = await expectFailure(() =>
      connection.spawn(
        { ...intent.input, message: `${intent.input.message} changed` },
        intent.credential,
      ),
    );
    if (error.failure.code !== "command_id_conflict")
      throw new Error("The SDK did not preserve the daemon operation conflict");
    process.stdout.write(`${JSON.stringify({ code: error.failure.code })}\n`);
  } finally {
    connection.close();
  }
}

async function spawnWithNewCredential(): Promise<void> {
  const intent = readIntent<SpawnIntent>(
    required("REINS_OPERATION_INTENT_JSON"),
  );
  const connection = await connectSdk();
  try {
    const error = await expectFailure(() =>
      connection.spawn(
        {
          ...intent.input,
          sessionName: "packed-capability-retry",
        },
        connection.prepareOperation("spawn"),
      ),
    );
    if (
      error.failure.code !== "invalid_params" ||
      !error.failure.facts.issues.some(
        (issue) => issue.issue === "invalid_value" && issue.path === "model",
      )
    )
      throw new Error(
        "A new spawn credential did not revalidate the current model capability",
      );
    process.stdout.write(
      `${JSON.stringify({ code: error.failure.code, path: "model" })}\n`,
    );
  } finally {
    connection.close();
  }
}

async function prepareKill(): Promise<void> {
  const connection = await connectSdk();
  try {
    const intent: KillIntent = {
      credential: connection.prepareOperation("kill"),
      sessionHandle: required("REINS_TARGET_SESSION") as SessionHandle,
    };
    process.stdout.write(
      `${JSON.stringify({ prepared: true, intent: publishIntent(intent) })}\n`,
    );
  } finally {
    connection.close();
  }
}

async function killFailureReplay(): Promise<void> {
  const intent = readIntent<KillIntent>(
    required("REINS_OPERATION_INTENT_JSON"),
  );
  const firstConnection = await connectSdk();
  let first: ReinsSdkError;
  try {
    first = await expectFailure(() =>
      firstConnection.kill(
        { sessionHandle: intent.sessionHandle },
        intent.credential,
      ),
    );
  } finally {
    firstConnection.close();
  }
  const secondConnection = await connectSdk();
  try {
    const second = await expectFailure(() =>
      secondConnection.kill(
        { sessionHandle: intent.sessionHandle },
        intent.credential,
      ),
    );
    if (
      first.failure.code !== "internal_error" ||
      JSON.stringify(first.failure) !== JSON.stringify(second.failure)
    )
      throw new Error(
        "Recovering the failed kill did not return its saved error",
      );
    process.stdout.write(`${JSON.stringify({ failure: first.failure })}\n`);
  } finally {
    secondConnection.close();
  }
}

async function prepareKillRetry(): Promise<void> {
  const intent = readIntent<KillIntent>(
    required("REINS_OPERATION_INTENT_JSON"),
  );
  const connection = await connectSdk();
  try {
    const prepared = {
      ...intent,
      credential: connection.prepareOperation("kill"),
    } satisfies KillIntent;
    process.stdout.write(
      `${JSON.stringify({ prepared: true, intent: publishIntent(prepared) })}\n`,
    );
  } finally {
    connection.close();
  }
}

async function killDrop(): Promise<void> {
  const intent = readIntent<KillIntent>(
    required("REINS_OPERATION_INTENT_JSON"),
  );
  const connection = await connectSdk();
  try {
    const error = await expectFailure(() =>
      connection.kill(
        { sessionHandle: intent.sessionHandle },
        intent.credential,
      ),
    );
    if (
      error.failure.code !== "command_outcome_unknown" ||
      error.failure.facts.operation !== "kill"
    )
      throw new Error("The installed SDK omitted typed kill recovery facts");
    process.stdout.write(
      `${JSON.stringify({ code: error.failure.code, stage: error.stage })}\n`,
    );
  } finally {
    connection.close();
  }
}

async function killRecover(): Promise<void> {
  const intent = readIntent<KillIntent>(
    required("REINS_OPERATION_INTENT_JSON"),
  );
  const connection = await connectSdk();
  try {
    const result = await connection.kill(
      { sessionHandle: intent.sessionHandle },
      intent.credential,
    );
    const sessions = await connection.list({
      sessionHandle: intent.sessionHandle,
    });
    if (
      result.status !== "killed" ||
      sessions.length !== 1 ||
      sessions[0]?.state !== "killed" ||
      sessions[0]?.lastCompletedTurn?.turnHandle !==
        required("REINS_EXPECTED_TURN_HANDLE")
    )
      throw new Error("The SDK did not recover the completed kill result");
    process.stdout.write(
      `${JSON.stringify({ result, session: sessions[0] })}\n`,
    );
  } finally {
    connection.close();
  }
}

async function staleSpawn(): Promise<void> {
  const intent = readIntent<SpawnIntent>(
    required("REINS_OPERATION_INTENT_JSON"),
  );
  const connection = await connectSdk();
  try {
    const error = await expectFailure(() =>
      connection.spawn(intent.input, intent.credential),
    );
    if (error.failure.code !== "stale_command_id")
      throw new Error("The SDK did not preserve the stale-generation failure");
    process.stdout.write(
      `${JSON.stringify({
        code: error.failure.code,
        daemonGeneration: connection.handshake.daemonGeneration,
      })}\n`,
    );
  } finally {
    connection.close();
  }
}

async function staleHandle(): Promise<void> {
  const sessionHandle = required("REINS_TARGET_SESSION") as SessionHandle;
  const connection = await connectSdk();
  try {
    const result = await connection.kill(
      { sessionHandle },
      connection.prepareOperation("kill"),
    );
    if (result.status !== "not_found" || result.sessionHandle !== sessionHandle)
      throw new Error("The SDK did not reject the previous-generation handle");
    process.stdout.write(
      `${JSON.stringify({ status: result.status, sessionHandle })}\n`,
    );
  } finally {
    connection.close();
  }
}

async function replayFacts(): Promise<void> {
  const sessionHandle = required("REINS_TARGET_SESSION") as SessionHandle;
  const target = { scope: "session" as const, sessionHandle };
  const connection = await connectSdk();
  const facts: AgentFact[] = [];
  const checkpoints: ResumeCursor[] = [];
  let endReason: string | undefined;
  try {
    const subscription = await connection.attach(target, { mode: "available" });
    try {
      for (;;) {
        const item = await subscription.next();
        if (item.done) break;
        facts.push(item.value);
        checkpoints.push(subscription.checkpoint);
      }
      endReason = (await subscription.done).reason;
    } finally {
      subscription.close();
    }
  } finally {
    connection.close();
  }
  const checkpoint = checkpoints[0];
  if (facts.length < 2 || checkpoint === undefined)
    throw new Error("The installed SDK did not receive replayable facts");

  const resumedConnection = await connectSdk();
  const resumedFacts: AgentFact[] = [];
  let replayed = 0;
  try {
    const subscription = await resumedConnection.attach(target, {
      mode: "after",
      cursor: checkpoint,
    });
    replayed = subscription.establishment.replayed;
    try {
      for await (const fact of subscription) resumedFacts.push(fact);
      await subscription.done;
    } finally {
      subscription.close();
    }
  } finally {
    resumedConnection.close();
  }
  const expectedSuffix = facts.slice(1);
  if (JSON.stringify(resumedFacts) !== JSON.stringify(expectedSuffix))
    throw new Error(
      "The installed SDK replay skipped or changed delivered facts",
    );
  process.stdout.write(
    `${JSON.stringify({
      facts,
      resumedFacts,
      replayed,
      endReason,
      checkpointWasDelivered: true,
    })}\n`,
  );
}

const mode = process.argv[2];
switch (mode) {
  case "prepare-spawn":
    await prepareSpawn();
    break;
  case "spawn-drop":
    await spawnDrop();
    break;
  case "spawn-validation":
    await spawnValidation();
    break;
  case "spawn-recover":
    await spawnRecover();
    break;
  case "spawn-conflict":
    await spawnConflict();
    break;
  case "spawn-new-credential":
    await spawnWithNewCredential();
    break;
  case "prepare-kill":
    await prepareKill();
    break;
  case "kill-failure-replay":
    await killFailureReplay();
    break;
  case "prepare-kill-retry":
    await prepareKillRetry();
    break;
  case "kill-drop":
    await killDrop();
    break;
  case "kill-recover":
    await killRecover();
    break;
  case "spawn-stale":
    await staleSpawn();
    break;
  case "handle-stale":
    await staleHandle();
    break;
  case "replay-facts":
    await replayFacts();
    break;
  default:
    throw new Error("Invalid installed SDK control fixture mode");
}
