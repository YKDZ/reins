import {
  connect,
  parseDiagnosticId,
  parsePermissionHandle,
  parseResumeCursor,
  parseSessionHandle,
  parseTurnHandle,
  ReinsSdkError,
  serializeOperationKey,
  type OperationKey,
  type ReinsConnection,
  type AgentFact,
  type InterruptInput,
  type PermissionHandle,
  type PermissionResolution,
  type ResumeCursor,
  type SessionHandle,
  type SendInput,
  type SpawnInput,
  type TurnHandle,
} from "@ykdz/reins-sdk";

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  stdout: { write(value: string): void };
  getBuiltinModule(name: string): unknown;
};

type SpawnIntent = {
  readonly operationKey: OperationKey<"spawn">;
  readonly input: SpawnInput;
};
type KillIntent = {
  readonly operationKey: OperationKey<"kill">;
  readonly sessionHandle: SessionHandle;
};
type SendIntent = {
  readonly operationKey: OperationKey<"send">;
  readonly input: SendInput;
};
type InterruptIntent = {
  readonly operationKey: OperationKey<"interrupt">;
  readonly input: InterruptInput;
};
type PermissionIntent = {
  readonly operationKey: OperationKey<"resolvePermission">;
  readonly permissionHandle: PermissionHandle;
  readonly resolution: PermissionResolution;
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

function publishIntent(
  value:
    | SpawnIntent
    | KillIntent
    | SendIntent
    | InterruptIntent
    | PermissionIntent,
): string {
  const serialized = JSON.stringify(value);
  const restored = JSON.parse(serialized) as
    | SpawnIntent
    | KillIntent
    | SendIntent
    | InterruptIntent
    | PermissionIntent;
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
    sessionLabel: "packed-recover",
    harness: "codex",
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
    const sessionsBefore = await connection.list();
    const operationKey = connection.prepareOperation("spawn");
    const input = spawnInput();
    const serialized = publishIntent({ operationKey, input });
    const sessionsAfter = await connection.list();
    if (sessionsAfter.length !== sessionsBefore.length)
      throw new Error("Preparing an operation created a session");
    process.stdout.write(
      `${JSON.stringify({
        prepared: true,
        serialized: true,
        sessionCount: sessionsAfter.length,
        daemonGeneration: connection.handshake.daemonGeneration,
        intent: serialized,
      })}\n`,
    );
  } finally {
    connection.close();
  }
}

async function operationQueryValidation(): Promise<void> {
  const intent = readIntent<SpawnIntent>(
    required("REINS_OPERATION_INTENT_JSON"),
  );
  const connection = await connectSdk();
  try {
    const malformed = await expectFailure(() =>
      connection.getOperation("invalid-operation-key" as OperationKey<"spawn">),
    );
    if (
      malformed.stage !== "query" ||
      malformed.failure.code !== "invalid_params" ||
      !malformed.failure.facts.issues.some(
        (issue) =>
          issue.issue === "invalid_value" && issue.path === "operationKey",
      )
    )
      throw new Error("已安装 SDK 未将无效操作键映射为查询参数错误");
    const operation = await connection.getOperation(intent.operationKey);
    if (
      operation.status !== "unknown" ||
      operation.operationKey !== intent.operationKey
    )
      throw new Error("已安装 SDK 未能查询有效的新操作键");
    process.stdout.write(
      `${JSON.stringify({
        malformedCode: malformed.failure.code,
        malformedStage: malformed.stage,
        validStatus: operation.status,
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
        { operationKey: connection.prepareOperation("spawn") },
      ),
    );
    const invalidModel = await expectFailure(() =>
      connection.spawn(
        { ...input, model: "fixture-missing-model" },
        { operationKey: connection.prepareOperation("spawn") },
      ),
    );
    const unsupportedFeature = await expectFailure(() =>
      connection.spawn(
        { ...input, captureHarnessStderr: true },
        { operationKey: connection.prepareOperation("spawn") },
      ),
    );
    const unknownHarness = await expectFailure(() =>
      connection.spawn(
        { ...input, harness: "qoder" },
        { operationKey: connection.prepareOperation("spawn") },
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
      connection.spawn(intent.input, { operationKey: intent.operationKey }),
    );
    if (
      error.failure.code !== "operation_outcome_unknown" ||
      error.failure.facts.operationKey !== intent.operationKey ||
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
    const result = await connection.spawn(intent.input, {
      operationKey: intent.operationKey,
    });
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
        { operationKey: intent.operationKey },
      ),
    );
    if (error.failure.code !== "operation_key_conflict")
      throw new Error("The SDK did not preserve the daemon operation conflict");
    process.stdout.write(`${JSON.stringify({ code: error.failure.code })}\n`);
  } finally {
    connection.close();
  }
}

async function spawnWithNewOperationKey(): Promise<void> {
  const intent = readIntent<SpawnIntent>(
    required("REINS_OPERATION_INTENT_JSON"),
  );
  const connection = await connectSdk();
  try {
    const error = await expectFailure(() =>
      connection.spawn(
        {
          ...intent.input,
          sessionLabel: "packed-model-catalog-retry",
        },
        { operationKey: connection.prepareOperation("spawn") },
      ),
    );
    if (
      error.failure.code !== "invalid_params" ||
      !error.failure.facts.issues.some(
        (issue) => issue.issue === "invalid_value" && issue.path === "model",
      )
    )
      throw new Error(
        "A new spawn operationKey did not revalidate the current model catalog",
      );
    process.stdout.write(
      `${JSON.stringify({ code: error.failure.code, path: "model" })}\n`,
    );
  } finally {
    connection.close();
  }
}

function sendInput(): SendInput {
  return {
    placement: "active_turn",
    turnHandle: parseTurnHandle(required("REINS_TARGET_TURN")),
    message: "  exact delivered note\nkeep spacing  ",
  };
}

async function prepareSend(): Promise<void> {
  const connection = await connectSdk();
  try {
    const intent: SendIntent = {
      operationKey: connection.prepareOperation("send"),
      input: sendInput(),
    };
    process.stdout.write(
      `${JSON.stringify({ prepared: true, intent: publishIntent(intent) })}\n`,
    );
  } finally {
    connection.close();
  }
}

async function prepareNewTurn(): Promise<void> {
  const connection = await connectSdk();
  try {
    const intent: SendIntent = {
      operationKey: connection.prepareOperation("send"),
      input: {
        placement: "new_turn",
        sessionHandle: parseSessionHandle(required("REINS_TARGET_SESSION")),
        message: required("REINS_NEW_TURN_MESSAGE"),
      },
    };
    process.stdout.write(
      `${JSON.stringify({ prepared: true, intent: publishIntent(intent) })}\n`,
    );
  } finally {
    connection.close();
  }
}

async function sendNewTurn(): Promise<void> {
  const intent = readIntent<SendIntent>(
    required("REINS_OPERATION_INTENT_JSON"),
  );
  if (intent.input.placement !== "new_turn")
    throw new Error("The saved send intent was not a new-turn send");
  const connection = await connectSdk();
  try {
    const result = await connection.send(intent.input, {
      operationKey: intent.operationKey,
    });
    if (
      result.sessionHandle !== intent.input.sessionHandle ||
      result.deliveryPoint !== "new_turn"
    )
      throw new Error("The SDK did not accept the exact new-turn send");
    process.stdout.write(`${JSON.stringify({ result })}\n`);
  } finally {
    connection.close();
  }
}

async function waitOrdered(): Promise<void> {
  const parsedTargets: unknown = JSON.parse(required("REINS_TARGET_TURNS"));
  if (
    !Array.isArray(parsedTargets) ||
    parsedTargets.length < 2 ||
    !parsedTargets.every((target) => typeof target === "string")
  )
    throw new Error("The installed SDK wait needs ordered exact turn handles");
  const completion = required("REINS_WAIT_COMPLETION");
  if (completion !== "any" && completion !== "all")
    throw new Error("The installed SDK wait completion mode is invalid");
  const timeoutMs = Number(required("REINS_WAIT_TIMEOUT_MS"));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)
    throw new Error("The installed SDK wait timeout is invalid");
  const connection = await connectSdk();
  try {
    const result = await connection.wait({
      targets: parsedTargets.map((target) => parseTurnHandle(target)),
      completion,
      timeoutMs,
    });
    process.stdout.write(`${JSON.stringify({ result })}\n`);
  } finally {
    connection.close();
  }
}

async function sendDrop(): Promise<void> {
  const intent = readIntent<SendIntent>(
    required("REINS_OPERATION_INTENT_JSON"),
  );
  const connection = await connectSdk();
  try {
    const error = await expectFailure(() =>
      connection.send(intent.input, { operationKey: intent.operationKey }),
    );
    if (
      error.failure.code !== "operation_outcome_unknown" ||
      error.failure.facts.operationKey !== intent.operationKey ||
      error.stage !== "operation"
    )
      throw new Error("The installed SDK omitted typed send recovery facts");
    process.stdout.write(
      `${JSON.stringify({ code: error.failure.code, stage: error.stage })}\n`,
    );
  } finally {
    connection.close();
  }
}

async function sendRecover(): Promise<void> {
  const intent = readIntent<SendIntent>(
    required("REINS_OPERATION_INTENT_JSON"),
  );
  const connection = await connectSdk();
  try {
    const result = await connection.send(intent.input, {
      operationKey: intent.operationKey,
    });
    if (intent.input.placement !== "active_turn")
      throw new Error("The saved send intent was not an active-turn send");
    if (
      result.turnHandle !== intent.input.turnHandle ||
      result.deliveryPoint !== "active_turn"
    )
      throw new Error("The SDK did not recover the exact active-turn send");
    process.stdout.write(`${JSON.stringify({ result })}\n`);
  } finally {
    connection.close();
  }
}

async function sendConflict(): Promise<void> {
  const intent = readIntent<SendIntent>(
    required("REINS_OPERATION_INTENT_JSON"),
  );
  const connection = await connectSdk();
  try {
    const error = await expectFailure(() =>
      connection.send(
        { ...intent.input, message: `${intent.input.message} changed` },
        { operationKey: intent.operationKey },
      ),
    );
    if (error.failure.code !== "operation_key_conflict")
      throw new Error("The SDK did not preserve the send parameter conflict");
    process.stdout.write(`${JSON.stringify({ code: error.failure.code })}\n`);
  } finally {
    connection.close();
  }
}

async function prepareInterrupt(): Promise<void> {
  const connection = await connectSdk();
  try {
    const intent: InterruptIntent = {
      operationKey: connection.prepareOperation("interrupt"),
      input: { turnHandle: parseTurnHandle(required("REINS_TARGET_TURN")) },
    };
    process.stdout.write(
      `${JSON.stringify({ prepared: true, intent: publishIntent(intent) })}\n`,
    );
  } finally {
    connection.close();
  }
}

async function interruptDrop(): Promise<void> {
  const intent = readIntent<InterruptIntent>(
    required("REINS_OPERATION_INTENT_JSON"),
  );
  const connection = await connectSdk();
  try {
    const error = await expectFailure(() =>
      connection.interrupt(intent.input, { operationKey: intent.operationKey }),
    );
    if (
      error.failure.code !== "operation_outcome_unknown" ||
      error.failure.facts.operationKey !== intent.operationKey ||
      error.stage !== "operation"
    )
      throw new Error(
        "The installed SDK omitted typed interrupt recovery facts",
      );
    process.stdout.write(
      `${JSON.stringify({ code: error.failure.code, stage: error.stage })}\n`,
    );
  } finally {
    connection.close();
  }
}

async function interruptRecover(): Promise<void> {
  const intent = readIntent<InterruptIntent>(
    required("REINS_OPERATION_INTENT_JSON"),
  );
  const connection = await connectSdk();
  try {
    const result = await connection.interrupt(intent.input, {
      operationKey: intent.operationKey,
    });
    const observed = await connection.wait({
      targets: [intent.input.turnHandle],
      completion: "all",
      timeoutMs: 0,
    });
    if (
      result.turnHandle !== intent.input.turnHandle ||
      result.status !== "accepted" ||
      observed.status !== "timeout" ||
      observed.completed.length !== 0 ||
      observed.pending.length !== 1 ||
      observed.pending[0] !== intent.input.turnHandle
    )
      throw new Error("The SDK confused interrupt acceptance with completion");
    process.stdout.write(`${JSON.stringify({ result, observed })}\n`);
  } finally {
    connection.close();
  }
}

async function prepareKill(): Promise<void> {
  const connection = await connectSdk();
  try {
    const intent: KillIntent = {
      operationKey: connection.prepareOperation("kill"),
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
        { operationKey: intent.operationKey },
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
        { operationKey: intent.operationKey },
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
      operationKey: connection.prepareOperation("kill"),
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
        { operationKey: intent.operationKey },
      ),
    );
    if (
      error.failure.code !== "operation_outcome_unknown" ||
      error.failure.facts.operationKey !== intent.operationKey
    )
      throw new Error("The installed SDK omitted typed kill recovery facts");
    process.stdout.write(
      `${JSON.stringify({
        code: error.failure.code,
        operationKey: serializeOperationKey(error.failure.facts.operationKey),
        stage: error.stage,
      })}\n`,
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
    const startedPath = process.env.REINS_KILL_RECOVERY_STARTED;
    if (startedPath !== undefined) {
      const fileSystem = process.getBuiltinModule("node:fs/promises") as {
        writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
      };
      await fileSystem.writeFile(startedPath, "started", "utf8");
    }
    const result = await connection.kill(
      { sessionHandle: intent.sessionHandle },
      { operationKey: intent.operationKey },
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
      connection.spawn(intent.input, { operationKey: intent.operationKey }),
    );
    if (error.failure.code !== "stale_operation_key")
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

async function staleSend(): Promise<void> {
  const intent = readIntent<SendIntent>(
    required("REINS_OPERATION_INTENT_JSON"),
  );
  const connection = await connectSdk();
  try {
    const error = await expectFailure(() =>
      connection.send(intent.input, { operationKey: intent.operationKey }),
    );
    if (error.failure.code !== "stale_operation_key")
      throw new Error("The SDK did not preserve the stale send failure");
    process.stdout.write(`${JSON.stringify({ code: error.failure.code })}\n`);
  } finally {
    connection.close();
  }
}

async function staleInterrupt(): Promise<void> {
  const intent = readIntent<InterruptIntent>(
    required("REINS_OPERATION_INTENT_JSON"),
  );
  const connection = await connectSdk();
  try {
    const error = await expectFailure(() =>
      connection.interrupt(intent.input, { operationKey: intent.operationKey }),
    );
    if (error.failure.code !== "stale_operation_key")
      throw new Error("The SDK did not preserve the stale interrupt failure");
    process.stdout.write(`${JSON.stringify({ code: error.failure.code })}\n`);
  } finally {
    connection.close();
  }
}

async function staleHandle(): Promise<void> {
  const sessionHandle = parseSessionHandle(required("REINS_TARGET_SESSION"));
  const connection = await connectSdk();
  try {
    const result = await connection.kill(
      { sessionHandle },
      { operationKey: connection.prepareOperation("kill") },
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

async function preparePermission(): Promise<void> {
  const connection = await connectSdk();
  try {
    const intent: PermissionIntent = {
      operationKey: connection.prepareOperation("resolvePermission"),
      permissionHandle: parsePermissionHandle(
        required("REINS_PERMISSION_HANDLE"),
      ),
      resolution: { outcome: "allow", scope: "once" },
    };
    process.stdout.write(
      `${JSON.stringify({ prepared: true, intent: publishIntent(intent) })}\n`,
    );
  } finally {
    connection.close();
  }
}

async function spawnPermission(): Promise<void> {
  const connection = await connectSdk();
  try {
    const result = await connection.spawn(
      {
        sessionLabel: required("REINS_PERMISSION_SESSION_LABEL"),
        harness: "codex",
        message: "packed-permission",
        cwd: required("REINS_WORKER_CWD"),
      },
      { operationKey: connection.prepareOperation("spawn") },
    );
    process.stdout.write(`${JSON.stringify({ result })}\n`);
  } finally {
    connection.close();
  }
}

async function observePermission(): Promise<void> {
  const sessionHandle = parseSessionHandle(required("REINS_TARGET_SESSION"));
  const connection = await connectSdk();
  const subscription = await connection.attach(
    { scope: "session", sessionHandle },
    { mode: "available" },
  );
  try {
    for await (const fact of subscription) {
      if (fact.type !== "permission.requested") continue;
      process.stdout.write(
        `${JSON.stringify({
          sessionHandle: fact.sessionHandle,
          turnHandle: fact.turnHandle,
          permissionHandle: fact.permissionHandle,
          options: fact.options,
        })}\n`,
      );
      return;
    }
    throw new Error("The installed SDK observed no permission request");
  } finally {
    subscription.close();
    connection.close();
  }
}

function permissionIntent(): PermissionIntent {
  return readIntent<PermissionIntent>(required("REINS_OPERATION_INTENT_JSON"));
}

async function permissionMismatchReplay(): Promise<void> {
  const intent = permissionIntent();
  const connection = await connectSdk();
  try {
    const mismatch = await expectFailure(() =>
      connection.resolvePermission(
        intent.permissionHandle,
        { outcome: "allow", scope: "session" },
        { operationKey: intent.operationKey },
      ),
    );
    const replay = await expectFailure(() =>
      connection.resolvePermission(
        intent.permissionHandle,
        { outcome: "allow", scope: "session" },
        { operationKey: intent.operationKey },
      ),
    );
    const conflict = await expectFailure(() =>
      connection.resolvePermission(
        intent.permissionHandle,
        { outcome: "deny" },
        { operationKey: intent.operationKey },
      ),
    );
    if (
      mismatch.failure.code !== "permission_resolution_mismatch" ||
      mismatch.failure.facts.permissionHandle !== intent.permissionHandle ||
      JSON.stringify(mismatch.failure) !== JSON.stringify(replay.failure) ||
      conflict.failure.code !== "operation_key_conflict"
    )
      throw new Error(
        "The installed SDK did not preserve permission failure replay and conflict facts",
      );
    process.stdout.write(
      `${JSON.stringify({
        mismatch: mismatch.failure,
        replay: replay.failure,
        conflict: conflict.failure,
      })}\n`,
    );
  } finally {
    connection.close();
  }
}

async function resolvePermission(): Promise<void> {
  const intent = permissionIntent();
  const connection = await connectSdk();
  try {
    const result = await connection.resolvePermission(
      intent.permissionHandle,
      intent.resolution,
      { operationKey: intent.operationKey },
    );
    if (
      result.status !== "resolved" ||
      result.permissionHandle !== intent.permissionHandle
    )
      throw new Error("The installed SDK did not resolve the exact handle");
    process.stdout.write(`${JSON.stringify({ result })}\n`);
  } finally {
    connection.close();
  }
}

async function resolvePermissionDrop(): Promise<void> {
  const intent = permissionIntent();
  const connection = await connectSdk();
  try {
    const error = await expectFailure(() =>
      connection.resolvePermission(intent.permissionHandle, intent.resolution, {
        operationKey: intent.operationKey,
      }),
    );
    if (
      error.failure.code !== "operation_outcome_unknown" ||
      error.failure.facts.operationKey !== intent.operationKey ||
      error.stage !== "operation"
    )
      throw new Error(
        "The installed SDK omitted typed permission response-loss facts",
      );
    process.stdout.write(
      `${JSON.stringify({ code: error.failure.code, stage: error.stage })}\n`,
    );
  } finally {
    connection.close();
  }
}

async function resolvePermissionFailureReplay(): Promise<void> {
  const intent = permissionIntent();
  const connection = await connectSdk();
  try {
    const first = await expectFailure(() =>
      connection.resolvePermission(intent.permissionHandle, intent.resolution, {
        operationKey: intent.operationKey,
      }),
    );
    const replay = await expectFailure(() =>
      connection.resolvePermission(intent.permissionHandle, intent.resolution, {
        operationKey: intent.operationKey,
      }),
    );
    const query = await expectFailure(() => connection.diagnostics());
    if (
      first.failure.code !== "internal_error" ||
      JSON.stringify(first.failure) !== JSON.stringify(replay.failure) ||
      first.failure.facts.diagnosticId !== undefined ||
      first.failure.facts.cause?.kind !== "exception" ||
      !first.failure.facts.cause.message.includes(
        "Fixture rejected permission delivery",
      ) ||
      query.failure.code !== "diagnostics_unavailable"
    )
      throw new Error(
        "The SDK changed the permission failure after diagnostic persistence failed",
      );
    process.stdout.write(
      `${JSON.stringify({ failure: first.failure, replay: replay.failure, query: query.failure })}\n`,
    );
  } finally {
    connection.close();
  }
}

async function stalePermission(): Promise<void> {
  const intent = permissionIntent();
  const connection = await connectSdk();
  try {
    const error = await expectFailure(() =>
      connection.resolvePermission(intent.permissionHandle, intent.resolution, {
        operationKey: intent.operationKey,
      }),
    );
    if (error.failure.code !== "stale_operation_key")
      throw new Error(
        "The SDK accepted a previous-generation permission operationKey",
      );
    process.stdout.write(`${JSON.stringify({ code: error.failure.code })}\n`);
  } finally {
    connection.close();
  }
}

async function harnessFailureDiagnostics(): Promise<void> {
  const connection = await connectSdk();
  try {
    const input = {
      ...spawnInput(),
      message: "packed-harness-failure",
      sessionLabel: "packed-harness-diagnostics",
    };
    const spawned = await connection.spawn(input, {
      operationKey: connection.prepareOperation("spawn"),
    });
    const waited = await connection.wait({
      targets: [spawned.turnHandle],
      completion: "all",
      timeoutMs: 10_000,
    });
    const failedTurn = waited.completed[0];
    if (
      waited.status !== "satisfied" ||
      failedTurn?.stopReason !== "failed" ||
      failedTurn.failure.failureCategory !== "rate_limited" ||
      failedTurn.failure.retryDisposition !== "wait" ||
      failedTurn.diagnosticId === undefined
    )
      throw new Error("The installed SDK omitted typed Harness failure facts");
    const result = await connection.diagnostics({
      diagnosticId: parseDiagnosticId(failedTurn.diagnosticId),
    });
    if (
      !("record" in result) ||
      result.record.diagnosticId !== failedTurn.diagnosticId ||
      result.record.source !== "adapter" ||
      result.record.kind !== "turn_failure" ||
      result.record.sessionHandle !== spawned.sessionHandle ||
      result.record.turnHandle !== spawned.turnHandle ||
      "sessionId" in result.record ||
      "turnId" in result.record
    )
      throw new Error(
        "The installed SDK did not query its projected diagnostic",
      );
    const turnQuery = await connection.diagnostics({
      turnHandle: spawned.turnHandle,
    });
    if (
      !("records" in turnQuery) ||
      !turnQuery.records.some(
        (record) => record.diagnosticId === failedTurn.diagnosticId,
      )
    )
      throw new Error(
        "The installed SDK did not query diagnostics with only a turn handle",
      );
    const malformedTurn = await expectFailure(() =>
      connection.diagnostics({ turnHandle: "invalid" as TurnHandle }),
    );
    if (
      malformedTurn.stage !== "query" ||
      malformedTurn.failure.code !== "invalid_params" ||
      !malformedTurn.failure.facts.issues.some(
        (issue) =>
          issue.issue === "invalid_value" && issue.path === "turnHandle",
      )
    )
      throw new Error(
        "The installed SDK did not type an invalid diagnostic turn handle",
      );
    const sessionScopeId = spawned.sessionHandle.split(":")[1];
    const otherScopeId =
      sessionScopeId === "00000000-0000-4000-8000-000000000000"
        ? "00000000-0000-4000-8000-000000000001"
        : "00000000-0000-4000-8000-000000000000";
    const mismatchedSession = await expectFailure(() =>
      connection.diagnostics({
        sessionHandle: `session:${otherScopeId}:different:1` as SessionHandle,
        turnHandle: spawned.turnHandle,
      }),
    );
    if (
      mismatchedSession.failure.code !== "invalid_params" ||
      !mismatchedSession.failure.facts.issues.some(
        (issue) =>
          issue.issue === "invalid_combination" &&
          issue.paths.includes("sessionHandle") &&
          issue.paths.includes("turnHandle"),
      )
    )
      throw new Error(
        "The installed SDK accepted a mismatched diagnostic session handle",
      );
    const killed = await connection.kill(
      { sessionHandle: spawned.sessionHandle },
      { operationKey: connection.prepareOperation("kill") },
    );
    if (killed.status !== "killed")
      throw new Error("The Harness failure worker was not cleaned up");
    process.stdout.write(
      `${JSON.stringify({
        sessionHandle: spawned.sessionHandle,
        turnHandle: spawned.turnHandle,
        completed: failedTurn,
        diagnostic: result.record,
        turnQueryCount: "records" in turnQuery ? turnQuery.records.length : 0,
        malformedTurnCode: malformedTurn.failure.code,
        mismatchedSessionCode: mismatchedSession.failure.code,
      })}\n`,
    );
  } finally {
    connection.close();
  }
}

async function replayFacts(): Promise<void> {
  const sessionHandle = parseSessionHandle(required("REINS_TARGET_SESSION"));
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
  const deliveredFactCount = Number(process.env.REINS_RESUME_FACT_COUNT ?? "1");
  const checkpoint = checkpoints[deliveredFactCount - 1];
  if (
    facts.length < 2 ||
    !Number.isInteger(deliveredFactCount) ||
    deliveredFactCount < 1 ||
    checkpoint === undefined
  )
    throw new Error("The installed SDK did not receive replayable facts");
  const disconnectedCheckpoint = process.env.REINS_RESUME_CURSOR;
  if (
    disconnectedCheckpoint !== undefined &&
    disconnectedCheckpoint !== checkpoint
  )
    throw new Error(
      "The disconnect checkpoint did not identify the last delivered fact",
    );

  const resumedConnection = await connectSdk();
  const resumedFacts: AgentFact[] = [];
  let replayed = 0;
  try {
    const subscription = await resumedConnection.attach(target, {
      mode: "after",
      cursor: parseResumeCursor(disconnectedCheckpoint ?? checkpoint),
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
  if (deliveredFactCount > facts.length)
    throw new Error("The resume cursor did not identify a delivered fact");
  const expectedSuffix = facts.slice(deliveredFactCount);
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
      resumedAfterDisconnect: disconnectedCheckpoint !== undefined,
    })}\n`,
  );
}

async function disconnectAfterFirstFact(): Promise<void> {
  const sessionHandle = required("REINS_TARGET_SESSION") as SessionHandle;
  const connection = await connectSdk();
  const subscription = await connection.attach(
    { scope: "session", sessionHandle },
    { mode: "available" },
  );
  const first = await subscription.next();
  if (first.done) throw new Error("The installed SDK received no first fact");
  const deliveredFacts = [first.value];
  connection.close();
  let disconnected: ReinsSdkError | undefined;
  try {
    for (;;) {
      const item = await subscription.next();
      if (item.done) break;
      deliveredFacts.push(item.value);
    }
  } catch (error) {
    disconnected = failure(error);
  } finally {
    subscription.close();
  }
  const checkpoint = subscription.checkpoint;
  if (
    disconnected?.failure.code !== "daemon_disconnected" ||
    disconnected.failure.facts.resumeCursor !== checkpoint ||
    deliveredFacts.length < 2
  )
    throw new Error(
      "The installed SDK did not return its last queued-and-delivered fact checkpoint on disconnect",
    );
  process.stdout.write(
    `${JSON.stringify({
      firstFactId: first.value.factId,
      firstFactType: first.value.type,
      deliveredFactIds: deliveredFacts.map((fact) => fact.factId),
      queuedFactCount: deliveredFacts.length - 1,
      deliveredFactCount: deliveredFacts.length,
      checkpoint,
      code: disconnected.failure.code,
      cursorMatchesDeliveredFact: true,
    })}\n`,
  );
}

async function replayWindow(): Promise<void> {
  const connection = await connectSdk();
  try {
    const input: SpawnInput = {
      sessionLabel: "packed-history-window",
      harness: "qoder",
      message: JSON.stringify({
        gate: required("REINS_HISTORY_GATE"),
        messages: 1005,
        reply: "window complete",
      }),
      cwd: required("REINS_WORKER_CWD"),
    };
    const spawned = await connection.spawn(input, {
      operationKey: connection.prepareOperation("spawn"),
    });
    const target = {
      scope: "turn" as const,
      turnHandle: spawned.turnHandle,
    };
    const live = await connection.attach(target, { mode: "none" });
    const staleCursor = live.checkpoint;
    live.close();
    await live.done;
    const fileSystem = process.getBuiltinModule("node:fs/promises") as {
      writeFile(
        path: string,
        contents: string,
        encoding: "utf8",
      ): Promise<void>;
    };
    await fileSystem.writeFile(
      required("REINS_HISTORY_GATE"),
      "released",
      "utf8",
    );
    const deadline = Date.now() + 5_000;
    for (;;) {
      const [session] = await connection.list({
        sessionHandle: spawned.sessionHandle,
      });
      if (session?.state === "idle") break;
      if (Date.now() >= deadline)
        throw new Error("The history fixture turn did not complete");
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }

    const available = await connection.attach(target, { mode: "available" });
    const window = available.establishment.window;
    const facts: AgentFact[] = [];
    try {
      for await (const fact of available) facts.push(fact);
      const end = await available.done;
      if (end.reason !== "end_turn")
        throw new Error("The truncated turn replay had the wrong end reason");
    } finally {
      available.close();
    }
    let accepted: Awaited<ReturnType<ReinsConnection["attach"]>> | undefined;
    let expired: ReinsSdkError | undefined;
    try {
      accepted = await connection.attach(target, {
        mode: "after",
        cursor: staleCursor,
      });
    } catch (error) {
      expired = failure(error);
    }
    if (expired === undefined) {
      accepted?.close();
      throw new Error(
        `The installed SDK accepted an expired cursor: oldest=${window.oldest}, head=${window.head}, cursor=${staleCursor}`,
      );
    }
    const retainedMessages = facts.filter((fact) => fact.type === "message");
    if (
      !window.truncated ||
      window.oldest === null ||
      window.oldest <= 1 ||
      window.head === null ||
      facts.length !== 1000 ||
      retainedMessages.length !== 999 ||
      expired.failure.code !== "event_cursor_expired" ||
      expired.failure.facts.oldest !== window.oldest ||
      expired.failure.facts.head !== window.head
    )
      throw new Error(
        "The installed SDK did not report the bounded replay window and typed cursor gap",
      );
    process.stdout.write(
      `${JSON.stringify({
        sessionHandle: spawned.sessionHandle,
        turnHandle: spawned.turnHandle,
        staleCursor,
        retainedMessages: retainedMessages.length,
        window,
        factCount: facts.length,
        expired: expired.failure,
      })}\n`,
    );
  } finally {
    connection.close();
  }
}

async function unknownSpawnDiagnostics(): Promise<void> {
  const connection = await connectSdk();
  try {
    const operationKey = connection.prepareOperation("spawn");
    const error = await expectFailure(() =>
      connection.spawn(
        { ...spawnInput(), message: "packed-unknown-spawn-diagnostic" },
        { operationKey },
      ),
    );
    if (error.failure.code !== "operation_outcome_unknown")
      throw new Error("未知 spawn 没有保留类型化操作错误");
    if (
      error.failure.facts.cause?.message !== "夹具原生启动回执丢失" ||
      error.failure.facts.cleanupCause?.message !== "夹具无法确认原生清理"
    )
      throw new Error("未知 spawn 没有同时保留主因和清理次因");
    const diagnosticId = error.failure.facts.diagnosticId;
    if (diagnosticId === undefined)
      throw new Error("未知 spawn 错误没有可查询的主诊断引用");

    const operation = await connection.getOperation(operationKey);
    if (
      operation.status !== "outcome_unknown" ||
      operation.diagnosticId !== diagnosticId ||
      operation.cause?.message !== "夹具原生启动回执丢失" ||
      operation.cleanupCause?.message !== "夹具无法确认原生清理"
    )
      throw new Error("操作查询没有保留原始诊断引用");
    const queried = await connection.diagnostics({ diagnosticId });
    if (
      !("record" in queried) ||
      queried.record.diagnosticId !== diagnosticId ||
      queried.record.source !== "core" ||
      queried.record.kind !== "request_failure" ||
      queried.record.operation !== "spawn"
    )
      throw new Error("SDK 无法按操作诊断引用读取正式诊断记录");

    process.stdout.write(
      `${JSON.stringify({
        code: error.failure.code,
        diagnosticId,
        operationStatus: operation.status,
        operationDiagnosticId: operation.diagnosticId,
        diagnosticSource: queried.record.source,
        diagnosticKind: queried.record.kind,
        diagnosticOperation: queried.record.operation,
      })}\n`,
    );
  } finally {
    connection.close();
  }
}

const mode = process.argv[2];
switch (mode) {
  case "prepare-spawn":
    await prepareSpawn();
    break;
  case "operation-query-validation":
    await operationQueryValidation();
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
  case "spawn-new-operation-key":
    await spawnWithNewOperationKey();
    break;
  case "prepare-send":
    await prepareSend();
    break;
  case "prepare-new-turn":
    await prepareNewTurn();
    break;
  case "send-new-turn":
    await sendNewTurn();
    break;
  case "wait-ordered":
    await waitOrdered();
    break;
  case "send-drop":
    await sendDrop();
    break;
  case "send-recover":
    await sendRecover();
    break;
  case "send-conflict":
    await sendConflict();
    break;
  case "prepare-interrupt":
    await prepareInterrupt();
    break;
  case "interrupt-drop":
    await interruptDrop();
    break;
  case "interrupt-recover":
    await interruptRecover();
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
  case "send-stale":
    await staleSend();
    break;
  case "interrupt-stale":
    await staleInterrupt();
    break;
  case "handle-stale":
    await staleHandle();
    break;
  case "prepare-permission":
    await preparePermission();
    break;
  case "spawn-permission":
    await spawnPermission();
    break;
  case "observe-permission":
    await observePermission();
    break;
  case "permission-mismatch-replay":
    await permissionMismatchReplay();
    break;
  case "resolve-permission":
    await resolvePermission();
    break;
  case "resolve-permission-drop":
    await resolvePermissionDrop();
    break;
  case "permission-failure-replay":
    await resolvePermissionFailureReplay();
    break;
  case "permission-stale":
    await stalePermission();
    break;
  case "harness-failure-diagnostics":
    await harnessFailureDiagnostics();
    break;
  case "unknown-spawn-diagnostics":
    await unknownSpawnDiagnostics();
    break;
  case "replay-facts":
    await replayFacts();
    break;
  case "disconnect-first-fact":
    await disconnectAfterFirstFact();
    break;
  case "replay-window":
    await replayWindow();
    break;
  default:
    throw new Error("Invalid installed SDK control fixture mode");
}
