import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  startUnixAcknowledgementProxy,
  type UnixAcknowledgementProxy,
} from "./packed-runtime-fixtures/ack-proxy.ts";
import {
  isCleanStop,
  startDaemon,
  stopDaemon,
} from "./packed-runtime-fixtures/daemon.ts";
import {
  runLoggedCommand,
  waitForPath,
  waitForPathRemoval,
} from "./packed-runtime-fixtures/process.ts";
import type {
  DaemonHandle,
  LoggedCommandResult,
} from "./packed-runtime-fixtures/types.ts";
import {
  validateReleasePackages,
  writeReleaseOutputs,
} from "./validate-release-package.ts";

type JsonRecord = Record<string, unknown>;

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureSource = fileURLToPath(
  new URL("./packed-runtime-fixtures/", import.meta.url),
);
const daemonGraceMs = 5_000;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObject(path: string): JsonRecord {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(value)) throw new Error(`JSON 对象无效：${path}`);
  return value;
}

function readJsonLines(path: string): JsonRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value)) throw new Error(`JSON 行无效：${path}`);
      return value;
    });
}

function readLastJsonRecord(label: string, stdout: string): JsonRecord {
  const line = stdout.trim().split("\n").filter(Boolean).at(-1);
  if (line === undefined) throw new Error(`${label} 没有返回 JSON 结果`);
  const value: unknown = JSON.parse(line);
  if (!isRecord(value)) throw new Error(`${label} 未返回 JSON 对象`);
  return value;
}

async function runCommand(options: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly label: string;
  readonly logPath: string;
  readonly timeoutMs?: number;
}): Promise<LoggedCommandResult> {
  const result = await runLoggedCommand({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
    logPath: options.logPath,
    timeoutMs: options.timeoutMs ?? 120_000,
  });
  if (
    result.exit.exitCode !== 0 ||
    result.exit.signal !== null ||
    result.exit.timedOut ||
    result.exit.stillRunning
  ) {
    throw new Error(
      `${options.label} 失败（exit=${String(result.exit.exitCode)}, signal=${String(result.exit.signal)}）\n${result.stdout}${result.stderr}\n日志：${result.logPath}`,
    );
  }
  return result;
}

function copyFixtures(destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(fixtureSource)) {
    if (!name.endsWith(".ts")) continue;
    copyFileSync(join(fixtureSource, name), join(destination, name));
  }
}

function createConsumer(
  directory: string,
  name: string,
  dependencies: Record<string, string>,
  packageManager: string,
  localSdkTarball?: string,
): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify(
      {
        name,
        version: "0.0.0",
        private: true,
        type: "module",
        packageManager,
        dependencies,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(directory, "pnpm-workspace.yaml"),
    [
      "packages: []",
      "allowBuilds:",
      '  "@deepseek-ai/dsh-subprocess-local": true',
      '  "@google/genai": false',
      '  "@qodercn-ai/qodercn-agent-sdk": true',
      "  koffi: true",
      "  node-pty: true",
      "  protobufjs: false",
      ...(localSdkTarball === undefined
        ? []
        : [
            "overrides:",
            `  "@ykdz/reins-sdk": ${JSON.stringify(`file:${localSdkTarball}`)}`,
          ]),
      "",
    ].join("\n"),
  );
}

async function installConsumer(
  directory: string,
  logsDirectory: string,
  label: string,
): Promise<void> {
  await runCommand({
    command: "pnpm",
    args: ["install", "--prefer-offline", "--reporter=append-only"],
    cwd: directory,
    label,
    logPath: join(logsDirectory, `${label}.log`),
    timeoutMs: 300_000,
  });
}

async function typecheckConsumer(
  directory: string,
  sources: readonly string[],
  logsDirectory: string,
  label: string,
): Promise<void> {
  await runCommand({
    command: join(repository, "node_modules", ".bin", "tsc"),
    args: [
      "--noEmit",
      "--strict",
      "--noUnusedLocals",
      "--noUnusedParameters",
      "--target",
      "ES2023",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--skipLibCheck",
      "false",
      ...sources,
    ],
    cwd: directory,
    label,
    logPath: join(logsDirectory, `${label}.log`),
  });
}

async function runFixture(
  consumerDirectory: string,
  fixtureName: string,
  env: NodeJS.ProcessEnv,
  logsDirectory: string,
  label: string,
  args: readonly string[] = [],
  timeoutMs = 30_000,
): Promise<LoggedCommandResult> {
  return runCommand({
    command: process.execPath,
    args: [
      "--experimental-strip-types",
      join(consumerDirectory, "fixtures", fixtureName),
      ...args,
    ],
    cwd: consumerDirectory,
    env,
    label,
    logPath: join(logsDirectory, `${label}.log`),
    timeoutMs,
  });
}

async function runSdkMode(
  consumerDirectory: string,
  env: NodeJS.ProcessEnv,
  logsDirectory: string,
  mode: string,
  extraEnv: NodeJS.ProcessEnv = {},
  label = mode,
): Promise<JsonRecord> {
  const result = await runFixture(
    consumerDirectory,
    "sdk-recoverable-control.ts",
    { ...env, ...extraEnv },
    logsDirectory,
    `sdk-${label}`,
    [mode],
  );
  return readLastJsonRecord(`SDK ${mode}`, result.stdout);
}

async function waitForFact(
  label: string,
  path: string,
  matches: (fact: JsonRecord) => boolean,
  timeoutMs = 5_000,
): Promise<JsonRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = readJsonLines(path).find(matches);
    if (found !== undefined) return found;
    if (Date.now() >= deadline) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function assertProcessStopped(label: string, pid: number): void {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (isRecord(error) && error.code === "ESRCH") return;
    throw error;
  }
  throw new Error(`${label} 仍在运行：${pid}`);
}

function assertProcessRunning(label: string, pid: number): void {
  try {
    process.kill(pid, 0);
  } catch (error) {
    throw new Error(`${label} 未运行：${pid}（${String(error)}）`);
  }
}

async function stopInstalledDaemon(pidPath: string): Promise<void> {
  if (!existsSync(pidPath)) return;
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0)
    throw new Error("运行包启动的 daemon PID 无效");
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (!(isRecord(error) && error.code === "ESRCH")) throw error;
  }
  const deadline = Date.now() + daemonGraceMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (isRecord(error) && error.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!(isRecord(error) && error.code === "ESRCH")) throw error;
  }
  throw new Error(`运行包启动的 daemon 未能按时退出：${pid}`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function startDirectDaemon(options: {
  readonly label: string;
  readonly executable: string;
  readonly env: NodeJS.ProcessEnv;
  readonly socketPath: string;
  readonly logPath: string;
  readonly handles: Set<DaemonHandle>;
}): Promise<DaemonHandle> {
  const handle = await startDaemon({
    label: options.label,
    executable: options.executable,
    args: [],
    env: options.env,
    socketPath: options.socketPath,
    logPath: options.logPath,
    readyTimeoutMs: 10_000,
  });
  options.handles.add(handle);
  assert(!handle.startupTimedOut, `${options.label} 启动超时`);
  return handle;
}

async function stopDirectDaemon(
  handle: DaemonHandle,
  handles: Set<DaemonHandle>,
): Promise<void> {
  const result = await stopDaemon(handle, daemonGraceMs);
  handles.delete(handle);
  assert(isCleanStop(result), `daemon 未干净停止：${JSON.stringify(result)}`);
  await waitForPathRemoval(handle.socketPath, daemonGraceMs);
  await waitForPathRemoval(`${handle.socketPath}.lock`, daemonGraceMs);
}

async function stopAllDaemons(handles: Set<DaemonHandle>): Promise<void> {
  const failures: unknown[] = [];
  for (const handle of handles) {
    try {
      const result = await stopDaemon(handle, daemonGraceMs);
      handles.delete(handle);
      if (!isCleanStop(result))
        failures.push(
          new Error(`${handle.label} 清理未干净：${JSON.stringify(result)}`),
        );
      await waitForPathRemoval(handle.socketPath, daemonGraceMs);
      await waitForPathRemoval(`${handle.socketPath}.lock`, daemonGraceMs);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, "daemon 资源清理失败");
}

async function runRecoveryAcceptance(options: {
  readonly sdkConsumer: string;
  readonly daemonPath: string;
  readonly temporaryRoot: string;
  readonly logsDirectory: string;
  readonly handles: Set<DaemonHandle>;
}): Promise<void> {
  const directory = join(options.temporaryRoot, "sdk-recovery");
  mkdirSync(directory, { recursive: true });
  const socketPath = join(directory, "reins.sock");
  const observationPath = join(directory, "adapter-observations.ndjson");
  const activityPath = join(directory, "worker-activity.ndjson");
  const workerCwd = join(directory, "workspace");
  const modelCatalogModePath = join(directory, "model-catalog-mode.txt");
  const terminateGatePath = join(directory, "terminate.release");
  const directEnv: NodeJS.ProcessEnv = {
    ...process.env,
    REINS_SOCKET: socketPath,
    REINS_STATE_DIR: join(directory, "state"),
    REINS_CONSUMER_CONTEXT: "packed-runtime-recovery",
    REINS_ADAPTERS_MODULE: join(
      options.sdkConsumer,
      "fixtures",
      "adapter-fixture.ts",
    ),
    REINS_IDLE_TIMEOUT_MS: "120000",
    REINS_PACKED_FIXTURE_OBSERVATIONS: observationPath,
    REINS_PACKED_FIXTURE_ACTIVITY: activityPath,
    REINS_PACKED_FIXTURE_MODEL_CATALOG_MODE: modelCatalogModePath,
    REINS_PACKED_FIXTURE_TERMINATE_GATE: terminateGatePath,
    REINS_PACKED_FIXTURE_TERMINATE_FAILURE_MARKER: join(
      directory,
      "terminate-failure-used",
    ),
    REINS_PACKED_FIXTURE_REJECT_PERMISSION_FILE: join(
      directory,
      "reject-permission",
    ),
    REINS_WORKER_CWD: workerCwd,
  };
  mkdirSync(workerCwd, { recursive: true });
  writeFileSync(modelCatalogModePath, "with-model", "utf8");
  let daemon = await startDirectDaemon({
    label: "packed SDK recovery daemon",
    executable: options.daemonPath,
    env: directEnv,
    socketPath,
    logPath: join(options.logsDirectory, "recovery-daemon.log"),
    handles: options.handles,
  });
  let acknowledgementProxy: UnixAcknowledgementProxy | undefined;
  try {
    const query = await runFixture(
      options.sdkConsumer,
      "sdk-query.ts",
      directEnv,
      options.logsDirectory,
      "sdk-only-query",
    );
    const queryResult = readLastJsonRecord("SDK query", query.stdout);
    assert(queryResult.sessionCount === 0, "SDK 初始会话列表不为空");
    assert(
      queryResult.invalidParams === "invalid_params",
      "SDK 未保留类型化查询错误",
    );

    const prepared = await runSdkMode(
      options.sdkConsumer,
      directEnv,
      options.logsDirectory,
      "prepare-spawn",
    );
    assert(
      prepared.prepared === true &&
        prepared.serialized === true &&
        prepared.sessionCount === 0 &&
        typeof prepared.daemonGeneration === "string" &&
        typeof prepared.intent === "string",
      "prepareOperation 执行了远端副作用或未返回可保存输入",
    );
    const spawnIntent = prepared.intent;
    const operationQuery = await runSdkMode(
      options.sdkConsumer,
      directEnv,
      options.logsDirectory,
      "operation-query-validation",
      { REINS_OPERATION_INTENT_JSON: spawnIntent },
    );
    assert(
      operationQuery.malformedCode === "invalid_params" &&
        operationQuery.malformedStage === "query" &&
        operationQuery.validStatus === "unknown",
      "SDK 操作查询未验证无效键或未读取合法身份",
    );

    const workersBeforeValidation = readJsonLines(observationPath).filter(
      ({ type }) => type === "worker_started",
    ).length;
    const validation = await runSdkMode(
      options.sdkConsumer,
      directEnv,
      options.logsDirectory,
      "spawn-validation",
    );
    assert(
      JSON.stringify(validation.codes) ===
        JSON.stringify([
          "invalid_params",
          "invalid_params",
          "unsupported_feature",
          "unknown_harness",
        ]),
      "SDK 与 daemon 未拒绝无效 spawn 输入",
    );
    assert(
      readJsonLines(observationPath).filter(
        ({ type }) => type === "worker_started",
      ).length === workersBeforeValidation,
      "拒绝的 spawn 派发了 worker",
    );

    acknowledgementProxy = await startUnixAcknowledgementProxy({
      socketPath: join(directory, "spawn-ack.sock"),
      targetPath: socketPath,
      method: "spawn",
    });
    const droppedSpawn = await runSdkMode(
      options.sdkConsumer,
      directEnv,
      options.logsDirectory,
      "spawn-drop",
      {
        REINS_SOCKET: acknowledgementProxy.socketPath,
        REINS_OPERATION_INTENT_JSON: spawnIntent,
      },
    );
    const spawnAcknowledgement =
      await acknowledgementProxy.waitForDroppedAcknowledgement();
    await acknowledgementProxy.close();
    acknowledgementProxy = undefined;
    assert(
      droppedSpawn.code === "operation_outcome_unknown" &&
        droppedSpawn.stage === "operation" &&
        spawnAcknowledgement.method === "spawn" &&
        isRecord(spawnAcknowledgement.result) &&
        typeof spawnAcknowledgement.result.sessionId === "string" &&
        typeof spawnAcknowledgement.result.turnId === "string",
      "spawn 场景没有丢弃真实 daemon ACK",
    );

    const modelCatalogQueriesBeforeRecovery = readJsonLines(
      observationPath,
    ).filter(({ type }) => type === "model_catalog_queried").length;
    writeFileSync(modelCatalogModePath, "without-model", "utf8");
    const recoveredSpawn = await runSdkMode(
      options.sdkConsumer,
      directEnv,
      options.logsDirectory,
      "spawn-recover",
      { REINS_OPERATION_INTENT_JSON: spawnIntent },
    );
    const spawnResult = recoveredSpawn.result;
    const listedSession = recoveredSpawn.listed;
    assert(
      isRecord(spawnResult) &&
        isRecord(listedSession) &&
        spawnResult.sessionHandle === spawnAcknowledgement.result.sessionId &&
        spawnResult.cwd === workerCwd &&
        typeof spawnResult.turnHandle === "string" &&
        listedSession.sessionHandle === spawnAcknowledgement.result.sessionId &&
        listedSession.activeTurn === spawnResult.turnHandle,
      "SDK 未恢复 daemon 已接受的原 spawn 结果",
    );
    assert(
      readJsonLines(observationPath).filter(
        ({ type }) => type === "model_catalog_queried",
      ).length === modelCatalogQueriesBeforeRecovery,
      "恢复已接受 spawn 时重新查询了动态能力",
    );
    const newOperationKey = await runSdkMode(
      options.sdkConsumer,
      directEnv,
      options.logsDirectory,
      "spawn-new-operation-key",
      { REINS_OPERATION_INTENT_JSON: spawnIntent },
    );
    assert(
      newOperationKey.code === "invalid_params" &&
        newOperationKey.path === "model",
      "新 spawn operation key 未按变化后的模型目录重新校验",
    );
    writeFileSync(modelCatalogModePath, "with-model", "utf8");

    const workerStarted = await waitForFact(
      "真实 worker 启动",
      observationPath,
      (fact) => fact.type === "worker_started",
    );
    const workerReady = await waitForFact(
      "真实 worker 子进程",
      observationPath,
      (fact) => fact.type === "worker_ready",
    );
    assert(
      isRecord(workerStarted.spec) &&
        typeof workerReady.workerPid === "number" &&
        typeof workerReady.descendantPid === "number" &&
        workerReady.workerCwd === workerCwd,
      "适配器没有提供 worker 进程和工作目录事实",
    );
    const spec = workerStarted.spec;
    const expectedSpec = {
      agent: "fixture-agent",
      authorizationMode: "interactive",
      cwd: workerCwd,
      harness: "codex",
      message: "  exact task\nkeep spacing  ",
      model: "fixture-model",
      messageId: spec.messageId,
      reasoning: "high",
      sandbox: "workspace-write",
      sessionId: spawnAcknowledgement.result.sessionId,
      turnId: spawnAcknowledgement.result.turnId,
    };
    assert(
      JSON.stringify(Object.keys(spec).sort()) ===
        JSON.stringify(Object.keys(expectedSpec).sort()) &&
        typeof spec.messageId === "string" &&
        /^m\d+$/u.test(spec.messageId) &&
        Object.entries(expectedSpec).every(
          ([key, value]) => spec[key] === value,
        ),
      "SDK 未原样保留 spawn 的用户输入和省略字段",
    );
    const spawnConflict = await runSdkMode(
      options.sdkConsumer,
      directEnv,
      options.logsDirectory,
      "spawn-conflict",
      { REINS_OPERATION_INTENT_JSON: spawnIntent },
    );
    assert(
      spawnConflict.code === "operation_key_conflict",
      "spawn 请求指纹冲突未被拒绝",
    );
    assert(
      readJsonLines(observationPath).filter(
        ({ type }) => type === "worker_started",
      ).length ===
        workersBeforeValidation + 1,
      "spawn ACK 恢复重复启动了 worker",
    );

    const deliveredBeforeSend = readJsonLines(observationPath).filter(
      ({ type }) => type === "message_delivered",
    ).length;
    const preparedSend = await runSdkMode(
      options.sdkConsumer,
      directEnv,
      options.logsDirectory,
      "prepare-send",
      { REINS_TARGET_TURN: String(spawnResult.turnHandle) },
    );
    assert(
      preparedSend.prepared === true && typeof preparedSend.intent === "string",
      "SDK 未创建 send 操作凭据",
    );
    const sendIntent = preparedSend.intent;
    assert(
      readJsonLines(observationPath).filter(
        ({ type }) => type === "message_delivered",
      ).length === deliveredBeforeSend,
      "准备 send 凭据时提前派发了消息",
    );
    acknowledgementProxy = await startUnixAcknowledgementProxy({
      socketPath: join(directory, "send-ack.sock"),
      targetPath: socketPath,
      method: "send",
    });
    const droppedSend = await runSdkMode(
      options.sdkConsumer,
      directEnv,
      options.logsDirectory,
      "send-drop",
      {
        REINS_SOCKET: acknowledgementProxy.socketPath,
        REINS_OPERATION_INTENT_JSON: sendIntent,
      },
    );
    const sendAcknowledgement =
      await acknowledgementProxy.waitForDroppedAcknowledgement();
    await acknowledgementProxy.close();
    acknowledgementProxy = undefined;
    assert(
      droppedSend.code === "operation_outcome_unknown" &&
        sendAcknowledgement.method === "send" &&
        isRecord(sendAcknowledgement.result) &&
        sendAcknowledgement.result.sessionId ===
          spawnAcknowledgement.result.sessionId &&
        sendAcknowledgement.result.turnId ===
          spawnAcknowledgement.result.turnId,
      "send 场景没有丢弃真实 daemon ACK",
    );
    const recoveredSend = await runSdkMode(
      options.sdkConsumer,
      directEnv,
      options.logsDirectory,
      "send-recover",
      { REINS_OPERATION_INTENT_JSON: sendIntent },
    );
    assert(
      isRecord(recoveredSend.result) &&
        recoveredSend.result.sessionHandle === spawnResult.sessionHandle &&
        recoveredSend.result.turnHandle === spawnResult.turnHandle &&
        recoveredSend.result.deliveryPoint === "active_turn",
      "SDK 未恢复精确 active-turn send 结果",
    );
    const sendConflict = await runSdkMode(
      options.sdkConsumer,
      directEnv,
      options.logsDirectory,
      "send-conflict",
      { REINS_OPERATION_INTENT_JSON: sendIntent },
    );
    assert(
      sendConflict.code === "operation_key_conflict",
      "send 请求指纹冲突未被拒绝",
    );
    const delivered = readJsonLines(observationPath).filter(
      ({ type }) => type === "message_delivered",
    );
    assert(
      delivered.length === deliveredBeforeSend + 1 &&
        delivered[0]?.sessionId === spawnAcknowledgement.result.sessionId &&
        delivered[0]?.turnId === spawnAcknowledgement.result.turnId &&
        delivered[0]?.message === "  exact delivered note\nkeep spacing  ",
      "send 恢复重复派发或改变了正文",
    );

    const interruptsBefore = readJsonLines(observationPath).filter(
      ({ type }) => type === "interrupt_requested",
    ).length;
    const preparedInterrupt = await runSdkMode(
      options.sdkConsumer,
      directEnv,
      options.logsDirectory,
      "prepare-interrupt",
      { REINS_TARGET_TURN: String(spawnResult.turnHandle) },
    );
    assert(
      preparedInterrupt.prepared === true &&
        typeof preparedInterrupt.intent === "string",
      "SDK 未创建 interrupt 操作凭据",
    );
    const interruptIntent = preparedInterrupt.intent;
    acknowledgementProxy = await startUnixAcknowledgementProxy({
      socketPath: join(directory, "interrupt-ack.sock"),
      targetPath: socketPath,
      method: "interrupt",
    });
    const droppedInterrupt = await runSdkMode(
      options.sdkConsumer,
      directEnv,
      options.logsDirectory,
      "interrupt-drop",
      {
        REINS_SOCKET: acknowledgementProxy.socketPath,
        REINS_OPERATION_INTENT_JSON: interruptIntent,
      },
    );
    const interruptAcknowledgement =
      await acknowledgementProxy.waitForDroppedAcknowledgement();
    await acknowledgementProxy.close();
    acknowledgementProxy = undefined;
    assert(
      droppedInterrupt.code === "operation_outcome_unknown" &&
        interruptAcknowledgement.method === "interrupt" &&
        isRecord(interruptAcknowledgement.result) &&
        interruptAcknowledgement.result.sessionId ===
          spawnAcknowledgement.result.sessionId &&
        interruptAcknowledgement.result.turnId ===
          spawnAcknowledgement.result.turnId,
      "interrupt 场景没有丢弃真实 daemon ACK",
    );
    const recoveredInterrupt = await runSdkMode(
      options.sdkConsumer,
      directEnv,
      options.logsDirectory,
      "interrupt-recover",
      { REINS_OPERATION_INTENT_JSON: interruptIntent },
    );
    assert(
      isRecord(recoveredInterrupt.result) &&
        recoveredInterrupt.result.turnHandle === spawnResult.turnHandle &&
        recoveredInterrupt.result.status === "accepted" &&
        isRecord(recoveredInterrupt.observed) &&
        recoveredInterrupt.observed.status === "timeout" &&
        Array.isArray(recoveredInterrupt.observed.pending) &&
        recoveredInterrupt.observed.pending[0] === spawnResult.turnHandle,
      "interrupt 接受被误当成回合已经结束",
    );
    assert(
      readJsonLines(observationPath).filter(
        ({ type }) => type === "interrupt_requested",
      ).length ===
        interruptsBefore + 1,
      "interrupt ACK 恢复重复派发了中断",
    );

    const preparedKill = await runSdkMode(
      options.sdkConsumer,
      directEnv,
      options.logsDirectory,
      "prepare-kill",
      { REINS_TARGET_SESSION: String(spawnResult.sessionHandle) },
    );
    assert(
      preparedKill.prepared === true && typeof preparedKill.intent === "string",
      "SDK 未创建 kill 操作凭据",
    );
    const killIntent = preparedKill.intent;
    const failedKill = await runSdkMode(
      options.sdkConsumer,
      directEnv,
      options.logsDirectory,
      "kill-failure-replay",
      { REINS_OPERATION_INTENT_JSON: killIntent },
    );
    assert(
      isRecord(failedKill.failure) &&
        failedKill.failure.code === "internal_error",
      "清理失败没有保留原始操作错误",
    );
    const activityWhileFailed = readJsonLines(activityPath);
    assert(
      activityWhileFailed.some(({ type }) => type === "heartbeat") &&
        typeof workerReady.workerPid === "number" &&
        typeof workerReady.descendantPid === "number",
      "第一次 kill 失败没有留下实际运行的 worker 证据",
    );
    assertProcessRunning("worker", workerReady.workerPid);
    assertProcessRunning("worker descendant", workerReady.descendantPid);
    const retry = await runSdkMode(
      options.sdkConsumer,
      directEnv,
      options.logsDirectory,
      "prepare-kill-retry",
      { REINS_OPERATION_INTENT_JSON: killIntent },
    );
    assert(
      retry.prepared === true && typeof retry.intent === "string",
      "未生成新的 kill 重试凭据",
    );
    assert(
      readJsonLines(observationPath).filter(
        ({ type }) => type === "terminate_called",
      ).length === 1,
      "准备新的 kill 凭据时重复执行了清理",
    );
    const retryIntent = retry.intent;
    acknowledgementProxy = await startUnixAcknowledgementProxy({
      socketPath: join(directory, "kill-ack.sock"),
      targetPath: socketPath,
      method: "kill",
    });
    const killDropPromise = runSdkMode(
      options.sdkConsumer,
      directEnv,
      options.logsDirectory,
      "kill-drop",
      {
        REINS_SOCKET: acknowledgementProxy.socketPath,
        REINS_OPERATION_INTENT_JSON: retryIntent,
      },
    );
    await waitForFact(
      "第二次 kill 的受控清理门",
      observationPath,
      (fact) => fact.type === "terminate_waiting" && fact.attempt === 2,
    );
    const killRecoveryStartedPath = join(directory, "kill-recovery.started");
    let pendingKillRecoveryCompleted = false;
    let pendingKillRecoveryFailure: unknown;
    const pendingKillRecoveryPromise = runSdkMode(
      options.sdkConsumer,
      directEnv,
      options.logsDirectory,
      "kill-recover",
      {
        REINS_OPERATION_INTENT_JSON: retryIntent,
        REINS_EXPECTED_TURN_HANDLE: String(spawnResult.turnHandle),
        REINS_KILL_RECOVERY_STARTED: killRecoveryStartedPath,
      },
      "kill-recover-while-pending",
    )
      .then((result) => {
        pendingKillRecoveryCompleted = true;
        return result;
      })
      .catch((error: unknown) => {
        pendingKillRecoveryCompleted = true;
        pendingKillRecoveryFailure = error;
        return undefined;
      });
    await waitForPath(killRecoveryStartedPath, 5_000);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert(
      !pendingKillRecoveryCompleted &&
        readJsonLines(observationPath).filter(
          ({ type }) => type === "terminate_called",
        ).length === 2,
      "恢复中的 kill 未等待已有清理或重复派发了清理",
    );
    writeFileSync(terminateGatePath, "released", "utf8");
    const [killAcknowledgement, droppedKill, pendingKillRecovery] =
      await Promise.all([
        acknowledgementProxy.waitForDroppedAcknowledgement(),
        killDropPromise,
        pendingKillRecoveryPromise,
      ]);
    await acknowledgementProxy.close();
    acknowledgementProxy = undefined;
    assert(
      droppedKill.code === "operation_outcome_unknown" &&
        typeof droppedKill.operationKey === "string" &&
        killAcknowledgement.method === "kill" &&
        isRecord(killAcknowledgement.result) &&
        killAcknowledgement.result.sessionId === spawnResult.sessionHandle,
      "kill 场景没有保留真实 ACK 丢失后的未知结果",
    );
    assert(
      pendingKillRecoveryFailure === undefined &&
        isRecord(pendingKillRecovery?.result) &&
        pendingKillRecovery.result.status === "killed",
      "清理进行中提交的 SDK 恢复没有加入并恢复原 kill 结果",
    );
    const recoveredKill = await runSdkMode(
      options.sdkConsumer,
      directEnv,
      options.logsDirectory,
      "kill-recover",
      {
        REINS_OPERATION_INTENT_JSON: retryIntent,
        REINS_EXPECTED_TURN_HANDLE: String(spawnResult.turnHandle),
      },
    );
    assert(
      isRecord(recoveredKill.result) &&
        recoveredKill.result.sessionHandle === spawnResult.sessionHandle &&
        recoveredKill.result.status === "killed" &&
        isRecord(recoveredKill.session) &&
        recoveredKill.session.state === "killed" &&
        isRecord(recoveredKill.session.lastCompletedTurn) &&
        recoveredKill.session.lastCompletedTurn.turnHandle ===
          spawnResult.turnHandle &&
        recoveredKill.session.lastCompletedTurn.stopReason === "killed",
      "SDK 未恢复已完成 kill 的精确终态",
    );
    const killReplay = await runSdkMode(
      options.sdkConsumer,
      directEnv,
      options.logsDirectory,
      "kill-recover",
      {
        REINS_OPERATION_INTENT_JSON: retryIntent,
        REINS_EXPECTED_TURN_HANDLE: String(spawnResult.turnHandle),
      },
    );
    assert(
      isRecord(killReplay.result) &&
        JSON.stringify(killReplay.result) ===
          JSON.stringify(recoveredKill.result) &&
        readJsonLines(observationPath).filter(
          ({ type }) => type === "terminate_called",
        ).length === 2,
      "重复恢复 kill 没有返回原结果或重复清理",
    );
    const finalActivity = readJsonLines(activityPath);
    for (const [role, pid] of [
      ["worker", workerReady.workerPid],
      ["descendant", workerReady.descendantPid],
    ] as const) {
      assert(
        finalActivity.filter(
          (fact) =>
            fact.type === "opened" && fact.role === role && fact.pid === pid,
        ).length === 1 &&
          finalActivity.filter(
            (fact) =>
              fact.type === "closed" && fact.role === role && fact.pid === pid,
          ).length === 1,
        `${role} 的资源没有恰好关闭一次`,
      );
      assertProcessStopped(role, pid);
    }

    await runPermissionAcceptance({
      consumer: options.sdkConsumer,
      env: directEnv,
      observationsPath: observationPath,
      directory,
      logsDirectory: options.logsDirectory,
    });

    const diagnostics = await runSdkMode(
      options.sdkConsumer,
      directEnv,
      options.logsDirectory,
      "harness-failure-diagnostics",
    );
    assert(
      isRecord(diagnostics.completed) &&
        diagnostics.completed.stopReason === "failed" &&
        isRecord(diagnostics.diagnostic) &&
        diagnostics.diagnostic.source === "adapter" &&
        diagnostics.diagnostic.kind === "turn_failure" &&
        diagnostics.malformedTurnCode === "invalid_params" &&
        diagnostics.mismatchedSessionCode === "invalid_params",
      "SDK 未按精确 turn/session 查询结构化诊断",
    );

    const unknownSpawn = await runSdkMode(
      options.sdkConsumer,
      directEnv,
      options.logsDirectory,
      "unknown-spawn-diagnostics",
    );
    assert(
      unknownSpawn.code === "operation_outcome_unknown" &&
        unknownSpawn.operationStatus === "outcome_unknown" &&
        typeof unknownSpawn.diagnosticId === "string" &&
        unknownSpawn.operationDiagnosticId === unknownSpawn.diagnosticId &&
        unknownSpawn.diagnosticSource === "core" &&
        unknownSpawn.diagnosticKind === "request_failure" &&
        unknownSpawn.diagnosticOperation === "spawn",
      "安装型 SDK 未贯通未知 spawn 的错误、持久操作与可查询诊断",
    );

    const generationBeforeRestart = String(prepared.daemonGeneration);
    await stopDirectDaemon(daemon, options.handles);
    daemon = await startDirectDaemon({
      label: "restarted packed SDK daemon",
      executable: options.daemonPath,
      env: directEnv,
      socketPath,
      logPath: join(options.logsDirectory, "restarted-recovery-daemon.log"),
      handles: options.handles,
    });
    const staleSpawn = await runSdkMode(
      options.sdkConsumer,
      directEnv,
      options.logsDirectory,
      "spawn-stale",
      { REINS_OPERATION_INTENT_JSON: spawnIntent },
    );
    const staleSend = await runSdkMode(
      options.sdkConsumer,
      directEnv,
      options.logsDirectory,
      "send-stale",
      { REINS_OPERATION_INTENT_JSON: sendIntent },
    );
    const staleInterrupt = await runSdkMode(
      options.sdkConsumer,
      directEnv,
      options.logsDirectory,
      "interrupt-stale",
      { REINS_OPERATION_INTENT_JSON: interruptIntent },
    );
    const staleHandle = await runSdkMode(
      options.sdkConsumer,
      directEnv,
      options.logsDirectory,
      "handle-stale",
      { REINS_TARGET_SESSION: String(spawnResult.sessionHandle) },
    );
    assert(
      staleSpawn.code === "stale_operation_key" &&
        staleSend.code === "stale_operation_key" &&
        staleInterrupt.code === "stale_operation_key" &&
        staleSpawn.daemonGeneration !== generationBeforeRestart &&
        staleHandle.status === "not_found" &&
        staleHandle.sessionHandle === spawnResult.sessionHandle,
      "旧世代操作或会话身份被错误地用于新 daemon",
    );
  } finally {
    if (acknowledgementProxy !== undefined) await acknowledgementProxy.close();
    writeFileSync(terminateGatePath, "released", "utf8");
  }
  await stopDirectDaemon(daemon, options.handles);
}

async function runPermissionAcceptance(options: {
  readonly consumer: string;
  readonly env: NodeJS.ProcessEnv;
  readonly observationsPath: string;
  readonly directory: string;
  readonly logsDirectory: string;
}): Promise<void> {
  const permissionSessions: JsonRecord[] = [];
  const spawnPermission = async (name: string): Promise<JsonRecord> => {
    const spawned = await runSdkMode(
      options.consumer,
      options.env,
      options.logsDirectory,
      "spawn-permission",
      { REINS_PERMISSION_SESSION_LABEL: name },
    );
    assert(isRecord(spawned.result), "授权场景未返回真实会话和回合身份");
    permissionSessions.push(spawned.result);
    return spawned.result;
  };
  const observePermission = async (
    sessionHandle: string,
  ): Promise<JsonRecord> => {
    const observed = await runSdkMode(
      options.consumer,
      options.env,
      options.logsDirectory,
      "observe-permission",
      { REINS_TARGET_SESSION: sessionHandle },
    );
    assert(
      observed.sessionHandle === sessionHandle &&
        typeof observed.permissionHandle === "string" &&
        JSON.stringify(observed.options) ===
          JSON.stringify([
            { outcome: "allow", scope: "once" },
            { outcome: "deny", feedback: false },
          ]),
      "SDK 未暴露适配器实际发出的授权选择",
    );
    return observed;
  };
  const preparePermission = async (
    permissionHandle: string,
  ): Promise<string> => {
    const prepared = await runSdkMode(
      options.consumer,
      options.env,
      options.logsDirectory,
      "prepare-permission",
      { REINS_PERMISSION_HANDLE: permissionHandle },
    );
    assert(
      prepared.prepared === true && typeof prepared.intent === "string",
      "SDK 未创建可保存的授权决议操作",
    );
    return prepared.intent;
  };

  const cleanupPermissionSessions = async (): Promise<void> => {
    const activityPath = options.env.REINS_PACKED_FIXTURE_ACTIVITY;
    assert(activityPath !== undefined, "授权场景没有配置 worker 进程事实日志");
    for (const session of permissionSessions) {
      const sessionHandle = session.sessionHandle;
      const turnHandle = session.turnHandle;
      assert(
        typeof sessionHandle === "string" && typeof turnHandle === "string",
        "授权场景没有可清理的会话和回合身份",
      );
      const prepared = await runSdkMode(
        options.consumer,
        options.env,
        options.logsDirectory,
        "prepare-kill",
        { REINS_TARGET_SESSION: sessionHandle },
      );
      assert(
        prepared.prepared === true && typeof prepared.intent === "string",
        "SDK 未创建授权场景清理凭据",
      );
      const killed = await runSdkMode(
        options.consumer,
        options.env,
        options.logsDirectory,
        "kill-recover",
        {
          REINS_OPERATION_INTENT_JSON: prepared.intent,
          REINS_EXPECTED_TURN_HANDLE: turnHandle,
        },
        `permission-cleanup-${sessionHandle}`,
      );
      assert(
        isRecord(killed.result) &&
          killed.result.status === "killed" &&
          isRecord(killed.session) &&
          killed.session.state === "killed",
        "SDK 未清理授权场景会话",
      );
      const workerReady = await waitForFact(
        "授权 worker 进程",
        options.observationsPath,
        (fact) =>
          fact.type === "worker_ready" && fact.sessionId === sessionHandle,
      );
      assert(
        typeof workerReady.workerPid === "number" &&
          typeof workerReady.descendantPid === "number",
        "授权 worker 缺少进程身份",
      );
      const finalActivity = readJsonLines(activityPath);
      for (const [role, pid] of [
        ["worker", workerReady.workerPid],
        ["descendant", workerReady.descendantPid],
      ] as const) {
        assert(
          finalActivity.filter(
            (fact) =>
              fact.type === "opened" && fact.role === role && fact.pid === pid,
          ).length === 1 &&
            finalActivity.filter(
              (fact) =>
                fact.type === "closed" &&
                fact.role === role &&
                fact.pid === pid,
            ).length === 1,
          `授权 ${role} 进程未恰好关闭一次：${pid}`,
        );
        assertProcessStopped(`授权 ${role} 进程`, pid);
      }
    }
  };

  try {
    const firstSession = await spawnPermission("packed-permission-mismatch");
    const firstObserved = await observePermission(
      String(firstSession.sessionHandle),
    );
    const mismatchIntent = await preparePermission(
      String(firstObserved.permissionHandle),
    );
    const callsBeforeMismatch = readJsonLines(options.observationsPath).filter(
      (fact) =>
        fact.sessionId === firstSession.sessionHandle &&
        fact.type === "permission_resolved",
    ).length;
    const mismatch = await runSdkMode(
      options.consumer,
      options.env,
      options.logsDirectory,
      "permission-mismatch-replay",
      { REINS_OPERATION_INTENT_JSON: mismatchIntent },
    );
    assert(
      isRecord(mismatch.mismatch) &&
        mismatch.mismatch.code === "permission_resolution_mismatch" &&
        isRecord(mismatch.replay) &&
        JSON.stringify(mismatch.mismatch) === JSON.stringify(mismatch.replay) &&
        isRecord(mismatch.conflict) &&
        mismatch.conflict.code === "operation_key_conflict" &&
        readJsonLines(options.observationsPath).filter(
          (fact) =>
            fact.sessionId === firstSession.sessionHandle &&
            fact.type === "permission_resolved",
        ).length === callsBeforeMismatch,
      "SDK 未在适配器执行前固定授权菜单错误和请求冲突",
    );
    const acceptedPermissionIntent = await preparePermission(
      String(firstObserved.permissionHandle),
    );
    const acceptedPermission = await runSdkMode(
      options.consumer,
      options.env,
      options.logsDirectory,
      "resolve-permission",
      { REINS_OPERATION_INTENT_JSON: acceptedPermissionIntent },
    );
    assert(
      isRecord(acceptedPermission.result) &&
        acceptedPermission.result.status === "resolved" &&
        acceptedPermission.result.permissionHandle ===
          firstObserved.permissionHandle,
      "SDK 未按当前待处理菜单提交授权决议",
    );

    const lostSession = await spawnPermission("packed-permission-lost-ack");
    const lostObserved = await observePermission(
      String(lostSession.sessionHandle),
    );
    const lostIntent = await preparePermission(
      String(lostObserved.permissionHandle),
    );
    const proxy = await startUnixAcknowledgementProxy({
      socketPath: join(options.directory, "permission-ack.sock"),
      targetPath: options.env.REINS_SOCKET as string,
      method: "resolvePermission",
    });
    try {
      const lost = await runSdkMode(
        options.consumer,
        options.env,
        options.logsDirectory,
        "resolve-permission-drop",
        {
          REINS_SOCKET: proxy.socketPath,
          REINS_OPERATION_INTENT_JSON: lostIntent,
        },
      );
      const acknowledgement = await proxy.waitForDroppedAcknowledgement();
      assert(
        lost.code === "operation_outcome_unknown" &&
          lost.stage === "operation" &&
          acknowledgement.method === "resolvePermission" &&
          isRecord(acknowledgement.result) &&
          acknowledgement.result.sessionId === lostSession.sessionHandle,
        "授权场景没有观察到真实 ACK 丢失",
      );
    } finally {
      await proxy.close();
    }
    const recovered = await runSdkMode(
      options.consumer,
      options.env,
      options.logsDirectory,
      "resolve-permission",
      { REINS_OPERATION_INTENT_JSON: lostIntent },
    );
    const deliveredResolutions = readJsonLines(options.observationsPath).filter(
      (fact) =>
        fact.sessionId === lostSession.sessionHandle &&
        fact.type === "permission_resolved",
    );
    assert(
      isRecord(recovered.result) &&
        recovered.result.status === "resolved" &&
        recovered.result.permissionHandle === lostObserved.permissionHandle &&
        deliveredResolutions.length === 1 &&
        JSON.stringify(deliveredResolutions[0]?.resolution) ===
          JSON.stringify({ outcome: "allow", scope: "once" }),
      "授权 ACK 丢失后恢复重复派发或改变了结果",
    );
  } finally {
    await cleanupPermissionSessions();
  }
}

async function runPermissionDiagnosticFailure(options: {
  readonly consumer: string;
  readonly env: NodeJS.ProcessEnv;
  readonly directory: string;
  readonly logsDirectory: string;
}): Promise<void> {
  const session = await runSdkMode(
    options.consumer,
    options.env,
    options.logsDirectory,
    "spawn-permission",
    { REINS_PERMISSION_SESSION_LABEL: "packed-perm-diagnostic-failure" },
  );
  assert(isRecord(session.result), "诊断故障场景没有创建授权会话");
  const sessionHandle = String(session.result.sessionHandle);
  const turnHandle = String(session.result.turnHandle);
  try {
    const observed = await runSdkMode(
      options.consumer,
      options.env,
      options.logsDirectory,
      "observe-permission",
      { REINS_TARGET_SESSION: sessionHandle },
    );
    assert(typeof observed.permissionHandle === "string", "未观察到待处理授权");
    const prepared = await runSdkMode(
      options.consumer,
      options.env,
      options.logsDirectory,
      "prepare-permission",
      { REINS_PERMISSION_HANDLE: observed.permissionHandle },
    );
    assert(typeof prepared.intent === "string", "未准备诊断故障决议");

    const rejectPath = join(options.directory, "reject-permission");
    writeFileSync(rejectPath, "reject", "utf8");
    const activeDiagnostics = join(
      options.env.REINS_STATE_DIR as string,
      "diagnostics",
      "active.ndjson",
    );
    assert(existsSync(activeDiagnostics), "正式诊断轨迹尚未创建");
    renameSync(activeDiagnostics, `${activeDiagnostics}.saved`);
    mkdirSync(activeDiagnostics);
    const rejected = await runSdkMode(
      options.consumer,
      options.env,
      options.logsDirectory,
      "permission-failure-replay",
      { REINS_OPERATION_INTENT_JSON: String(prepared.intent) },
    );
    assert(
      isRecord(rejected.failure) &&
        rejected.failure.code === "operation_outcome_unknown" &&
        isRecord(rejected.failure.facts) &&
        typeof rejected.failure.facts.operationKey === "string" &&
        isRecord(rejected.failure.facts.cause) &&
        rejected.failure.facts.cause.kind === "exception" &&
        typeof rejected.failure.facts.cause.message === "string" &&
        rejected.failure.facts.cause.message.includes(
          "Fixture rejected permission delivery",
        ) &&
        rejected.failure.facts.diagnosticId === undefined &&
        isRecord(rejected.query) &&
        rejected.query.code === "diagnostics_unavailable",
      "诊断落盘失败掩盖了原授权执行错误",
    );
  } finally {
    const prepared = await runSdkMode(
      options.consumer,
      options.env,
      options.logsDirectory,
      "prepare-kill",
      { REINS_TARGET_SESSION: sessionHandle },
    );
    assert(
      prepared.prepared === true && typeof prepared.intent === "string",
      "SDK 未创建诊断故障场景清理凭据",
    );
    const killed = await runSdkMode(
      options.consumer,
      options.env,
      options.logsDirectory,
      "kill-recover",
      {
        REINS_OPERATION_INTENT_JSON: prepared.intent,
        REINS_EXPECTED_TURN_HANDLE: turnHandle,
      },
    );
    assert(
      isRecord(killed.result) &&
        killed.result.status === "killed" &&
        isRecord(killed.session) &&
        killed.session.state === "killed",
      "SDK 未清理诊断故障授权会话",
    );
  }
}

async function runPermissionFailureAcceptance(options: {
  readonly sdkConsumer: string;
  readonly daemonPath: string;
  readonly temporaryRoot: string;
  readonly logsDirectory: string;
  readonly handles: Set<DaemonHandle>;
}): Promise<void> {
  const directory = join(
    options.temporaryRoot,
    "permission-diagnostic-failure",
  );
  const socketPath = join(directory, "reins.sock");
  const workerCwd = join(directory, "workspace");
  mkdirSync(workerCwd, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REINS_SOCKET: socketPath,
    REINS_STATE_DIR: join(directory, "state"),
    REINS_CONSUMER_CONTEXT: "packed-runtime-permission-failure",
    REINS_ADAPTERS_MODULE: join(
      options.sdkConsumer,
      "fixtures",
      "adapter-fixture.ts",
    ),
    REINS_IDLE_TIMEOUT_MS: "120000",
    REINS_PACKED_FIXTURE_OBSERVATIONS: join(directory, "observations.ndjson"),
    REINS_PACKED_FIXTURE_ACTIVITY: join(directory, "activity.ndjson"),
    REINS_PACKED_FIXTURE_REJECT_PERMISSION_FILE: join(
      directory,
      "reject-permission",
    ),
    REINS_WORKER_CWD: workerCwd,
  };
  const daemon = await startDirectDaemon({
    label: "packed permission diagnostic failure daemon",
    executable: options.daemonPath,
    env,
    socketPath,
    logPath: join(options.logsDirectory, "permission-failure-daemon.log"),
    handles: options.handles,
  });
  try {
    await runPermissionDiagnosticFailure({
      consumer: options.sdkConsumer,
      env,
      directory,
      logsDirectory: options.logsDirectory,
    });
  } finally {
    await stopDirectDaemon(daemon, options.handles);
  }
}

async function runRuntimeFactsAcceptance(options: {
  readonly sdkConsumer: string;
  readonly daemonPath: string;
  readonly temporaryRoot: string;
  readonly logsDirectory: string;
  readonly handles: Set<DaemonHandle>;
}): Promise<void> {
  const directory = join(options.temporaryRoot, "runtime-facts");
  const socketPath = join(directory, "reins.sock");
  const factGate = join(directory, "fact.release");
  const resolutionPath = join(directory, "resolution.json");
  const workerCwd = join(directory, "workspace");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REINS_SOCKET: socketPath,
    REINS_STATE_DIR: join(directory, "state"),
    REINS_CONSUMER_CONTEXT: "packed-runtime-facts",
    REINS_ADAPTERS_MODULE: join(
      options.sdkConsumer,
      "fixtures",
      "adapter-registry.ts",
    ),
    REINS_IDLE_TIMEOUT_MS: "120000",
    REINS_FACT_GATE: factGate,
    REINS_PERMISSION_RESULT: resolutionPath,
    REINS_WORKER_CWD: workerCwd,
  };
  mkdirSync(workerCwd, { recursive: true });
  const daemon = await startDirectDaemon({
    label: "packed runtime fact daemon",
    executable: options.daemonPath,
    env,
    socketPath,
    logPath: join(options.logsDirectory, "facts-daemon.log"),
    handles: options.handles,
  });
  try {
    const facts = await runFixture(
      options.sdkConsumer,
      "sdk-runtime-facts.ts",
      env,
      options.logsDirectory,
      "sdk-runtime-facts",
    );
    const factResult = readLastJsonRecord("runtime facts", facts.stdout);
    assert(
      Array.isArray(factResult.factTypes) &&
        JSON.stringify(factResult.factTypes) ===
          JSON.stringify([
            "message",
            "text.delta",
            "text.delta",
            "message",
            "tool.requested",
            "tool.completed",
            "permission.requested",
            "permission.resolved",
            "turn.completed",
          ]) &&
        factResult.resumedFactCount === factResult.factTypes.length &&
        factResult.waitStatus === "satisfied" &&
        factResult.newTurnDeliveryPoint === "new_turn" &&
        factResult.newTurnStatus === "satisfied" &&
        typeof factResult.sessionHandle === "string" &&
        typeof factResult.turnHandle === "string" &&
        typeof factResult.newTurnHandle === "string",
      "公开 SDK 事实序列或游标续接发生变化",
    );

    const disconnected = await runSdkMode(
      options.sdkConsumer,
      env,
      options.logsDirectory,
      "disconnect-first-fact",
      { REINS_TARGET_SESSION: String(factResult.sessionHandle) },
    );
    assert(
      disconnected.code === "daemon_disconnected" &&
        disconnected.cursorMatchesAcknowledgedFact === true &&
        typeof disconnected.checkpoint === "string" &&
        typeof disconnected.deliveredFactCount === "number" &&
        typeof disconnected.acknowledgedFactCount === "number",
      "消费者断开后未返回最后已确认事实的游标",
    );
    const kill = await runSdkMode(
      options.sdkConsumer,
      env,
      options.logsDirectory,
      "prepare-kill",
      { REINS_TARGET_SESSION: String(factResult.sessionHandle) },
    );
    assert(typeof kill.intent === "string", "无法清理已完成的事实会话");
    const killed = await runSdkMode(
      options.sdkConsumer,
      env,
      options.logsDirectory,
      "kill-recover",
      {
        REINS_OPERATION_INTENT_JSON: String(kill.intent),
        REINS_EXPECTED_TURN_HANDLE: String(factResult.newTurnHandle),
      },
    );
    assert(isRecord(killed.result), "事实会话没有返回关闭结果");
    const resumed = await runSdkMode(
      options.sdkConsumer,
      env,
      options.logsDirectory,
      "replay-facts",
      {
        REINS_TARGET_SESSION: String(factResult.sessionHandle),
        REINS_RESUME_ACKNOWLEDGED_FACT_COUNT: String(
          disconnected.acknowledgedFactCount,
        ),
        REINS_RESUME_CURSOR: String(disconnected.checkpoint),
      },
    );
    assert(
      resumed.checkpointWasAcknowledged === true &&
        resumed.resumedAfterDisconnect === true &&
        Array.isArray(resumed.resumedFacts),
      "SDK 未从断连 checkpoint 精确续接事件",
    );
    const killedList = await runFixture(
      options.sdkConsumer,
      "sdk-killed-list.ts",
      {
        ...env,
        REINS_TARGET_SESSION: String(factResult.sessionHandle),
      },
      options.logsDirectory,
      "sdk-killed-list",
    );
    const killedListResult = readLastJsonRecord(
      "killed session list",
      killedList.stdout,
    );
    assert(
      killedListResult.state === "killed" &&
        killedListResult.sessionHandle === factResult.sessionHandle &&
        isRecord(killedListResult.lastCompletedTurn) &&
        killedListResult.lastCompletedTurn.stopReason === "end_turn",
      "关闭已完成会话后丢失其精确回合终态",
    );
  } finally {
    await stopDirectDaemon(daemon, options.handles);
  }
}

async function runEventHistoryAcceptance(options: {
  readonly sdkConsumer: string;
  readonly daemonPath: string;
  readonly temporaryRoot: string;
  readonly logsDirectory: string;
  readonly handles: Set<DaemonHandle>;
}): Promise<void> {
  const directory = join(options.temporaryRoot, "event-history");
  const socketPath = join(directory, "reins.sock");
  const workerCwd = join(directory, "workspace");
  mkdirSync(workerCwd, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REINS_SOCKET: socketPath,
    REINS_STATE_DIR: join(directory, "state"),
    REINS_CONSUMER_CONTEXT: "packed-runtime-event-history",
    REINS_ADAPTERS_MODULE: join(
      options.sdkConsumer,
      "fixtures",
      "adapter-registry.ts",
    ),
    REINS_IDLE_TIMEOUT_MS: "120000",
    REINS_HISTORY_GATE: join(directory, "history.release"),
    REINS_WORKER_CWD: workerCwd,
  };
  const daemon = await startDirectDaemon({
    label: "packed SDK event-history daemon",
    executable: options.daemonPath,
    env,
    socketPath,
    logPath: join(options.logsDirectory, "event-history-daemon.log"),
    handles: options.handles,
  });
  try {
    const history = await runSdkMode(
      options.sdkConsumer,
      env,
      options.logsDirectory,
      "replay-window",
    );
    assert(
      typeof history.sessionHandle === "string" &&
        typeof history.turnHandle === "string" &&
        typeof history.staleCursor === "string" &&
        history.retainedMessages === 1006 &&
        history.factCount === 1008 &&
        history.resumedFactCount === 1006 &&
        isRecord(history.window) &&
        history.window.truncated === false &&
        typeof history.window.oldest === "number" &&
        history.window.oldest === 1 &&
        typeof history.window.head === "number" &&
        history.window.head === history.factCount + 1,
      "SDK 未返回完整事件历史及旧游标续接事实",
    );
    const prepared = await runSdkMode(
      options.sdkConsumer,
      env,
      options.logsDirectory,
      "prepare-kill",
      { REINS_TARGET_SESSION: String(history.sessionHandle) },
    );
    assert(
      prepared.prepared === true && typeof prepared.intent === "string",
      "SDK 未创建历史场景清理凭据",
    );
    const killed = await runSdkMode(
      options.sdkConsumer,
      env,
      options.logsDirectory,
      "kill-recover",
      {
        REINS_OPERATION_INTENT_JSON: prepared.intent,
        REINS_EXPECTED_TURN_HANDLE: String(history.turnHandle),
      },
    );
    assert(
      isRecord(killed.result) && killed.result.status === "killed",
      "SDK 未清理历史窗口场景会话",
    );
  } finally {
    await stopDirectDaemon(daemon, options.handles);
  }
}

async function runExactWaitAcceptance(options: {
  readonly sdkConsumer: string;
  readonly daemonPath: string;
  readonly temporaryRoot: string;
  readonly logsDirectory: string;
  readonly handles: Set<DaemonHandle>;
}): Promise<void> {
  const directory = join(options.temporaryRoot, "exact-wait");
  const socketPath = join(directory, "reins.sock");
  const workerCwd = join(directory, "workspace");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REINS_SOCKET: socketPath,
    REINS_STATE_DIR: join(directory, "state"),
    REINS_CONSUMER_CONTEXT: "packed-runtime-exact-wait",
    REINS_ADAPTERS_MODULE: join(
      options.sdkConsumer,
      "fixtures",
      "adapter-fixture.ts",
    ),
    REINS_IDLE_TIMEOUT_MS: "120000",
    REINS_PACKED_FIXTURE_OBSERVATIONS: join(directory, "observations.ndjson"),
    REINS_PACKED_FIXTURE_ACTIVITY: join(directory, "activity.ndjson"),
    REINS_WORKER_CWD: workerCwd,
  };
  mkdirSync(workerCwd, { recursive: true });
  const daemon = await startDirectDaemon({
    label: "packed exact wait daemon",
    executable: options.daemonPath,
    env,
    socketPath,
    logPath: join(options.logsDirectory, "exact-wait-daemon.log"),
    handles: options.handles,
  });
  try {
    const result = await runFixture(
      options.sdkConsumer,
      "sdk-exact-wait.ts",
      env,
      options.logsDirectory,
      "sdk-exact-wait",
      [],
      60_000,
    );
    const value = readLastJsonRecord("exact wait", result.stdout);
    assert(
      Array.isArray(value.anyCompleted) &&
        Array.isArray(value.anyPending) &&
        Array.isArray(value.allCompleted) &&
        Array.isArray(value.zeroTimeoutPending) &&
        value.anyCompleted.length === 1 &&
        value.anyPending.length === 1 &&
        value.allCompleted.length === 2 &&
        value.zeroTimeoutPending.length === 1,
      "SDK any/all wait 没有保留精确完成与待处理目标",
    );
  } finally {
    await stopDirectDaemon(daemon, options.handles);
  }
}

async function runSessionIsolationAcceptance(options: {
  readonly sdkConsumer: string;
  readonly daemonPath: string;
  readonly temporaryRoot: string;
  readonly logsDirectory: string;
  readonly handles: Set<DaemonHandle>;
}): Promise<void> {
  const directory = join(options.temporaryRoot, "session-isolation");
  const socketPath = join(directory, "reins.sock");
  const workerCwd = join(directory, "workspace");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REINS_SOCKET: socketPath,
    REINS_STATE_DIR: join(directory, "state"),
    REINS_CONSUMER_CONTEXT: "packed-runtime-owner",
    REINS_ADAPTERS_MODULE: join(
      options.sdkConsumer,
      "fixtures",
      "adapter-fixture.ts",
    ),
    REINS_IDLE_TIMEOUT_MS: "120000",
    REINS_PACKED_FIXTURE_OBSERVATIONS: join(directory, "observations.ndjson"),
    REINS_PACKED_FIXTURE_ACTIVITY: join(directory, "activity.ndjson"),
    REINS_WORKER_CWD: workerCwd,
  };
  mkdirSync(workerCwd, { recursive: true });
  const daemon = await startDirectDaemon({
    label: "packed session isolation daemon",
    executable: options.daemonPath,
    env,
    socketPath,
    logPath: join(options.logsDirectory, "session-isolation-daemon.log"),
    handles: options.handles,
  });
  try {
    const result = await runFixture(
      options.sdkConsumer,
      "sdk-session-isolation.ts",
      env,
      options.logsDirectory,
      "sdk-session-isolation",
      [],
      60_000,
    );
    const value = readLastJsonRecord("session isolation", result.stdout);
    assert(
      Array.isArray(value.sessions) &&
        value.sessions.length === 2 &&
        value.foreignKill === "not_found" &&
        value.isolatedClose === true &&
        value.clientClosePreservedSession === true &&
        value.processResourcesClosed === true,
      "SDK 消费者归属、会话关闭或 client.close 隔离失效",
    );
  } finally {
    await stopDirectDaemon(daemon, options.handles);
  }
}

async function runInstalledApplicationAcceptance(options: {
  readonly runtimeConsumer: string;
  readonly daemonPath: string;
  readonly temporaryRoot: string;
  readonly logsDirectory: string;
}): Promise<void> {
  const directory = join(options.temporaryRoot, "installed-application");
  mkdirSync(directory, { recursive: true });
  const socketPath = join(directory, "reins.sock");
  const pidPath = join(directory, "daemon.pid");
  const workerCwd = join(directory, "workspace");
  mkdirSync(workerCwd, { recursive: true });
  const launcherPath = join(directory, "daemon-launcher");
  writeFileSync(
    launcherPath,
    `#!/bin/sh\nprintf '%s\\n' "$$" > ${shellQuote(pidPath)}\nexec ${shellQuote(options.daemonPath)} "$@"\n`,
    { mode: 0o700 },
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REINS_SOCKET: socketPath,
    REINS_STATE_DIR: join(directory, "state"),
    REINS_CONSUMER_CONTEXT: "packed-runtime-application",
    REINS_DAEMON_BIN: launcherPath,
    REINS_ADAPTERS_MODULE: join(
      options.runtimeConsumer,
      "fixtures",
      "adapter-fixture.ts",
    ),
    REINS_IDLE_TIMEOUT_MS: "120000",
    REINS_PACKED_FIXTURE_OBSERVATIONS: join(directory, "observations.ndjson"),
    REINS_PACKED_FIXTURE_ACTIVITY: join(directory, "activity.ndjson"),
    REINS_WORKER_CWD: workerCwd,
  };
  try {
    const result = await runFixture(
      options.runtimeConsumer,
      "application-query.ts",
      env,
      options.logsDirectory,
      "installed-application-query",
      [],
      60_000,
    );
    const value = readLastJsonRecord("installed application", result.stdout);
    assert(
      value.status === "queried" &&
        value.modelCatalogHarness === "codex" &&
        value.sessionCount === 0 &&
        value.failureCode === "invalid_params" &&
        value.failureStage === "query" &&
        value.closeReason === "killed" &&
        typeof value.sessionHandle === "string" &&
        typeof value.turnHandle === "string",
      "已安装运行包未通过公开 openLocal API 完成正式操作",
    );
  } finally {
    await stopInstalledDaemon(pidPath);
  }
}

async function runControlChannelAcceptance(options: {
  readonly sdkConsumer: string;
  readonly runtimeConsumer: string;
  readonly temporaryRoot: string;
  readonly logsDirectory: string;
}): Promise<void> {
  const directory = join(options.temporaryRoot, "installed-control-channel");
  mkdirSync(directory, { recursive: true });
  const otherDirectory = join(directory, "other-target");
  mkdirSync(otherDirectory, { recursive: true });
  const socketPath = join(directory, "reins.sock");
  const pidPath = join(directory, "daemon.pid");
  const launchLogPath = join(directory, "daemon-launches.log");
  const otherSocketPath = join(otherDirectory, "reins.sock");
  const otherPidPath = join(otherDirectory, "daemon.pid");
  const otherLaunchLogPath = join(otherDirectory, "daemon-launches.log");
  const workerCwd = join(directory, "workspace");
  mkdirSync(workerCwd, { recursive: true });
  const openGate = join(directory, "channel-open.release");
  const recoveryGate = join(directory, "channel-recovery.release");
  const backpressureGate = join(directory, "channel-backpressure.release");
  const daemonPath = join(
    options.runtimeConsumer,
    "node_modules",
    ".bin",
    "reins-daemon",
  );
  const launcherPath = join(directory, "daemon-launcher");
  const otherLauncherPath = join(otherDirectory, "daemon-launcher");
  writeFileSync(
    launcherPath,
    `#!/bin/sh\nprintf '%s\\n' "$$" > ${shellQuote(pidPath)}\nprintf '%s\\n' launch >> ${shellQuote(launchLogPath)}\nexec ${shellQuote(daemonPath)} "$@"\n`,
    { mode: 0o700 },
  );
  writeFileSync(
    otherLauncherPath,
    `#!/bin/sh\nprintf '%s\\n' "$$" > ${shellQuote(otherPidPath)}\nprintf '%s\\n' launch >> ${shellQuote(otherLaunchLogPath)}\nexec ${shellQuote(daemonPath)} "$@"\n`,
    { mode: 0o700 },
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REINS_SOCKET: socketPath,
    REINS_STATE_DIR: join(directory, "state"),
    REINS_DAEMON_BIN: launcherPath,
    REINS_ADAPTERS_MODULE: join(
      options.runtimeConsumer,
      "fixtures",
      "adapter-registry.ts",
    ),
    REINS_IDLE_TIMEOUT_MS: "120000",
    REINS_PACKED_FIXTURE_OBSERVATIONS: join(directory, "observations.ndjson"),
    REINS_PACKED_FIXTURE_ACTIVITY: join(directory, "activity.ndjson"),
    REINS_PACKED_CHANNEL_OPEN_GATE: openGate,
    REINS_PACKED_CHANNEL_FACT_GATE: recoveryGate,
    REINS_PACKED_CHANNEL_BACKPRESSURE_GATE: backpressureGate,
    REINS_CONTROL_FAILURE_SOCKET: join(directory, "failure.sock"),
    REINS_CONTROL_FAILURE_STATE: join(directory, "failure-state"),
    REINS_WORKER_CWD: workerCwd,
  };
  const otherEnv: NodeJS.ProcessEnv = {
    ...env,
    REINS_SOCKET: otherSocketPath,
    REINS_STATE_DIR: join(otherDirectory, "state"),
    REINS_DAEMON_BIN: otherLauncherPath,
    REINS_PACKED_FIXTURE_OBSERVATIONS: join(
      otherDirectory,
      "observations.ndjson",
    ),
    REINS_PACKED_FIXTURE_ACTIVITY: join(otherDirectory, "activity.ndjson"),
    REINS_WORKER_CWD: join(otherDirectory, "workspace"),
  };
  mkdirSync(otherEnv.REINS_WORKER_CWD!, { recursive: true });
  try {
    const targetResult = await runFixture(
      options.runtimeConsumer,
      "runtime-control-target.ts",
      env,
      options.logsDirectory,
      "installed-control-target",
    );
    const target = readLastJsonRecord("control target", targetResult.stdout);
    assert(
      typeof target.command === "string" &&
        Array.isArray(target.args) &&
        target.args.length === 1 &&
        typeof target.args[0] === "string" &&
        existsSync(target.args[0]) &&
        typeof target.runtimeScopeId === "string",
      "安装运行包没有从目标部署材料描述控制入口",
    );
    const otherTargetResult = await runFixture(
      options.runtimeConsumer,
      "runtime-control-target.ts",
      otherEnv,
      options.logsDirectory,
      "installed-other-control-target",
    );
    const otherTarget = readLastJsonRecord(
      "other control target",
      otherTargetResult.stdout,
    );
    assert(
      typeof otherTarget.command === "string" &&
        Array.isArray(otherTarget.args) &&
        typeof otherTarget.runtimeScopeId === "string",
      "第二个安装目标没有描述正式控制入口",
    );
    const result = await runFixture(
      options.sdkConsumer,
      "sdk-control-channel.ts",
      {
        ...env,
        REINS_CONTROL_RUNTIME_TARGET: JSON.stringify(target),
        REINS_CONTROL_OTHER_TARGET: JSON.stringify(otherTarget),
        REINS_CONTROL_OTHER_SOCKET: otherSocketPath,
        REINS_CONTROL_OTHER_STATE: otherEnv.REINS_STATE_DIR,
        REINS_CONTROL_OTHER_DAEMON_BIN: otherLauncherPath,
      },
      options.logsDirectory,
      "installed-sdk-control-channel",
      [],
      90_000,
    );
    const value = readLastJsonRecord(
      "installed SDK byte channel",
      result.stdout,
    );
    const launchAttempts = readFileSync(launchLogPath, "utf8")
      .split("\n")
      .filter(Boolean);
    const otherLaunchAttempts = existsSync(otherLaunchLogPath)
      ? readFileSync(otherLaunchLogPath, "utf8").split("\n").filter(Boolean)
      : [];
    assert(
      value.status === "byte-channel-accepted" &&
        value.sessionSurvivedClose === true &&
        value.sessionSurvivedReconnect === true &&
        value.scopeMismatch === "handshake" &&
        value.diagnosticsWereSeparate === true &&
        value.fragmentedResponses === true &&
        value.processPipeBackpressureDrained === true &&
        value.operationAndCursorRecovered === true &&
        value.otherTargetRejectedOldIdentity === true &&
        launchAttempts.length === 1 &&
        otherLaunchAttempts.length === 1,
      "已安装 SDK 没有经正式 stdio byte 通道完成握手、会话复用与清理",
    );
  } finally {
    await stopInstalledDaemon(pidPath);
    await stopInstalledDaemon(otherPidPath);
  }
}

function dshMessagesResponse(
  messageId: string,
  block: JsonRecord,
  stopReason: "end_turn" | "tool_use",
): string {
  const events: JsonRecord[] = [
    {
      type: "message_start",
      message: {
        id: messageId,
        model: "deepseek-flash",
        usage: { input_tokens: 2, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: block },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: stopReason },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
  return events
    .map(
      (event) =>
        `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join("");
}

async function startDshProviderFixture(backgroundGatePath: string): Promise<{
  readonly baseUrl: string;
  readonly requests: JsonRecord[];
  readonly scenarios: string[];
  close(): Promise<void>;
}> {
  const requests: JsonRecord[] = [];
  const scenarios: string[] = [];
  let firstRequestStarted!: () => void;
  const firstRequest = new Promise<void>((resolve) => {
    firstRequestStarted = resolve;
  });
  let releaseFirstRequest!: () => void;
  const releaseFirst = new Promise<void>((resolve) => {
    releaseFirstRequest = resolve;
  });
  let interruptTargetStarted!: () => void;
  const interruptTargetRequest = new Promise<void>((resolve) => {
    interruptTargetStarted = resolve;
  });
  let releaseInterruptTargetRequest!: () => void;
  const releaseInterruptTarget = new Promise<void>((resolve) => {
    releaseInterruptTargetRequest = resolve;
  });
  let backgroundWakeStarted!: () => void;
  const backgroundWakeRequest = new Promise<void>((resolve) => {
    backgroundWakeStarted = resolve;
  });
  const server: Server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/wait-first") {
      void firstRequest.then(() => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("ready");
      });
      return;
    }
    if (request.method === "GET" && request.url === "/release-first") {
      releaseFirstRequest();
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("released");
      return;
    }
    if (request.method === "GET" && request.url === "/wait-interrupt-target") {
      void interruptTargetRequest.then(() => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("ready");
      });
      return;
    }
    if (
      request.method === "GET" &&
      request.url === "/release-interrupt-target"
    ) {
      releaseInterruptTargetRequest();
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("released");
      return;
    }
    if (request.method === "GET" && request.url === "/release-background-job") {
      writeFileSync(backgroundGatePath, "released\n");
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("released");
      return;
    }
    if (request.method === "GET" && request.url === "/wait-background-wake") {
      void backgroundWakeRequest.then(() => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("ready");
      });
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(404);
      response.end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      void (async () => {
        const parsed: unknown = JSON.parse(body);
        assert(isRecord(parsed), "DSH provider 请求不是对象");
        requests.push(parsed);
        const messages = JSON.stringify(parsed.messages ?? null);
        const scenario = messages.includes(
          "Generate the session title from this JSON array",
        )
          ? "session-title"
          : messages.includes("finished [status: completed")
            ? "background-wake"
            : messages.includes("started background job bash-")
              ? "background-result"
              : messages.includes("DSH_BACKGROUND_JOB_START")
                ? "background-start"
                : messages.includes("DSH_AFTER_INTERRUPT_CONFIRMED")
                  ? "after-interrupt"
                  : messages.includes("DSH_INTERRUPT_TARGET")
                    ? "interrupt-target"
                    : messages.includes("DSH_NEW_TURN_CONFIRMED")
                      ? "new-turn"
                      : messages.includes("OFFICIAL_TOOL_READ_ONCE")
                        ? "tool-result"
                        : messages.includes("Read evidence.txt")
                          ? "initial"
                          : "unknown";
        scenarios.push(scenario);
        assert(scenario !== "unknown", "官方 DSH 发出了未分类模型请求");
        if (scenario === "initial") {
          firstRequestStarted();
          await releaseFirst;
        }
        if (scenario === "interrupt-target") {
          interruptTargetStarted();
          await releaseInterruptTarget;
        }
        if (scenario === "background-wake") backgroundWakeStarted();
        const toolCall =
          scenario === "initial" || scenario === "background-start";
        const text =
          scenario === "session-title"
            ? "DSH_TITLE_CONFIRMED"
            : scenario === "tool-result"
              ? "DSH_READ_CONFIRMED"
              : scenario === "after-interrupt"
                ? "DSH_AFTER_INTERRUPT_CONFIRMED"
                : scenario === "background-result"
                  ? "DSH_BACKGROUND_START_CONFIRMED"
                  : scenario === "background-wake"
                    ? "DSH_BACKGROUND_WAKE_CONFIRMED"
                    : "DSH_NEW_TURN_CONFIRMED";
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          dshMessagesResponse(
            `packed-dsh-${requests.length}`,
            toolCall
              ? scenario === "background-start"
                ? {
                    type: "tool_use",
                    id: "packed-dsh-background-bash",
                    name: "bash",
                    input: {
                      command:
                        "while [ ! -f release-background-job ]; do sleep 0.02; done; printf 'DSH_BACKGROUND_JOB_RESULT'",
                      description:
                        "Wait for the packed DSH background-job test release gate",
                      run_in_background: true,
                    },
                  }
                : {
                    type: "tool_use",
                    id: "packed-dsh-read-once",
                    name: "read",
                    input: { file_path: "evidence.txt" },
                  }
              : {
                  type: "text",
                  text,
                },
            toolCall ? "tool_use" : "end_turn",
          ),
        );
      })().catch(() => response.destroy());
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert(
    address !== null && typeof address !== "string",
    "DSH 验收服务未能绑定 TCP 端口",
  );
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    scenarios,
    async close() {
      releaseFirstRequest();
      releaseInterruptTargetRequest();
      backgroundWakeStarted();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    },
  };
}

async function runDshRuntimeAcceptance(options: {
  readonly runtimeConsumer: string;
  readonly daemonPath: string;
  readonly temporaryRoot: string;
  readonly logsDirectory: string;
}): Promise<void> {
  const directory = join(options.temporaryRoot, "dsh-official-profile");
  const socketPath = join(directory, "reins.sock");
  const pidPath = join(directory, "daemon.pid");
  const workerCwd = join(directory, "workspace");
  const launcherPath = join(directory, "daemon-launcher");
  mkdirSync(workerCwd, { recursive: true });
  writeFileSync(join(workerCwd, "evidence.txt"), "OFFICIAL_TOOL_READ_ONCE\n");
  writeFileSync(
    launcherPath,
    `#!/bin/sh\nprintf '%s\\n' "$$" > ${shellQuote(pidPath)}\nexec ${shellQuote(options.daemonPath)} "$@"\n`,
    { mode: 0o700 },
  );
  const provider = await startDshProviderFixture(
    join(workerCwd, "release-background-job"),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REINS_SOCKET: socketPath,
    REINS_STATE_DIR: join(directory, "state"),
    REINS_CONSUMER_CONTEXT: "packed-dsh-runtime",
    REINS_DAEMON_BIN: launcherPath,
    REINS_IDLE_TIMEOUT_MS: "120000",
    REINS_DSH_WORKSPACE: workerCwd,
    REINS_DSH_FIXTURE_BASE_URL: provider.baseUrl,
    DSH_HOME: join(directory, "dsh-home"),
    DSH_PERMISSION_MODE: "danger-full-access",
    DSH_TELEMETRY_DISABLED: "1",
    DEEPSEEK_API_KEY: "LOCAL_FIXTURE_NO_VENDOR_CALL",
    DEEPSEEK_BASE_URL: provider.baseUrl,
  };
  delete env.REINS_ADAPTERS_MODULE;
  try {
    await runFixture(
      options.runtimeConsumer,
      "sdk-dsh-runtime.ts",
      env,
      options.logsDirectory,
      "sdk-dsh-official-profile",
      [],
      180_000,
    );
    const requestFor = (scenario: string): JsonRecord | undefined => {
      const index = provider.scenarios.indexOf(scenario);
      return index < 0 ? undefined : provider.requests[index];
    };
    const serializedRequest = (scenario: string): string =>
      JSON.stringify(requestFor(scenario)) ?? "";
    assert(
      provider.requests.length === 9 &&
        provider.scenarios.filter((scenario) => scenario === "initial")
          .length === 1 &&
        provider.scenarios.filter((scenario) => scenario === "session-title")
          .length === 1 &&
        provider.scenarios.filter((scenario) => scenario === "tool-result")
          .length === 1 &&
        provider.scenarios.filter((scenario) => scenario === "new-turn")
          .length === 1 &&
        provider.scenarios.filter((scenario) => scenario === "interrupt-target")
          .length === 1 &&
        provider.scenarios.filter((scenario) => scenario === "after-interrupt")
          .length === 1 &&
        provider.scenarios.filter((scenario) => scenario === "background-start")
          .length === 1 &&
        provider.scenarios.filter(
          (scenario) => scenario === "background-result",
        ).length === 1 &&
        provider.scenarios.filter((scenario) => scenario === "background-wake")
          .length === 1 &&
        serializedRequest("initial").includes('"name":"read"') &&
        serializedRequest("tool-result").includes("OFFICIAL_TOOL_READ_ONCE") &&
        serializedRequest("tool-result").includes(
          "DSH_ACTIVE_STEER_CONFIRMED",
        ) &&
        serializedRequest("new-turn").includes("DSH_NEW_TURN_CONFIRMED") &&
        serializedRequest("interrupt-target").includes(
          "DSH_INTERRUPT_TARGET",
        ) &&
        serializedRequest("after-interrupt").includes(
          "DSH_AFTER_INTERRUPT_CONFIRMED",
        ) &&
        !serializedRequest("after-interrupt").includes(
          "DSH_DRAIN_INPUT_MUST_NOT_EXECUTE",
        ) &&
        serializedRequest("background-start").includes('"name":"bash"') &&
        serializedRequest("background-result").includes(
          "started background job bash-",
        ) &&
        serializedRequest("background-wake").includes(
          "finished [status: completed",
        ),
      "完整官方 DSH profile 未完成标题、原生 Read 工具及同会话后续回合",
    );
  } finally {
    try {
      await stopInstalledDaemon(pidPath);
    } finally {
      await provider.close();
    }
  }
}

async function main(): Promise<void> {
  const rootManifest = readJsonObject(join(repository, "package.json"));
  const packageManager = rootManifest.packageManager;
  assert(
    typeof packageManager === "string",
    "根 manifest 必须声明正式消费者使用的包管理器版本",
  );
  const rootEngines = rootManifest.engines;
  assert(
    isRecord(rootEngines) &&
      typeof rootEngines.node === "string" &&
      process.versions.node === rootEngines.node,
    `正式制品验收要求根 manifest 声明的 Node，当前为 ${process.versions.node}`,
  );
  const packageGroup = validateReleasePackages({ repository });
  const runtimeArtifact = packageGroup.artifacts.find(
    ({ packageName }) => packageName === "@ykdz/reins",
  );
  const sdkArtifact = packageGroup.artifacts.find(
    ({ packageName }) => packageName === "@ykdz/reins-sdk",
  );
  assert(runtimeArtifact !== undefined, "正式制品组缺少运行包");
  assert(sdkArtifact !== undefined, "正式制品组缺少轻 SDK");
  assert(
    process.platform === "linux" && process.arch === "x64",
    "当前发行包仅支持 linux-x64",
  );

  const temporaryRoot = mkdtempSync(join(tmpdir(), "reins-packed-runtime-"));
  assert(
    !temporaryRoot.startsWith(`${repository}/`),
    "消费者安装必须位于工作区之外",
  );
  const logsDirectory = join(temporaryRoot, "logs");
  mkdirSync(logsDirectory, { recursive: true });
  const sdkConsumer = join(temporaryRoot, "sdk-only-consumer");
  const runtimeConsumer = join(temporaryRoot, "runtime-sdk-consumer");
  const handles = new Set<DaemonHandle>();
  let primaryFailure: unknown;
  let cleanupFailure: unknown;
  try {
    createConsumer(
      sdkConsumer,
      "reins-packed-sdk-consumer",
      {
        "@ykdz/reins-sdk": `file:${sdkArtifact.path}`,
      },
      packageManager,
    );
    copyFixtures(join(sdkConsumer, "fixtures"));
    await installConsumer(sdkConsumer, logsDirectory, "sdk-only-install");
    assert(
      !existsSync(join(sdkConsumer, "node_modules", "@ykdz", "reins")),
      "轻 SDK 独立安装意外引入完整运行包",
    );
    await typecheckConsumer(
      sdkConsumer,
      [
        join(sdkConsumer, "fixtures", "sdk-public-types.ts"),
        join(sdkConsumer, "fixtures", "sdk-public-types-negative.ts"),
        join(sdkConsumer, "fixtures", "sdk-control-channel-types.ts"),
        join(sdkConsumer, "fixtures", "sdk-control-channel-types-negative.ts"),
        join(sdkConsumer, "fixtures", "sdk-recoverable-control.ts"),
        join(sdkConsumer, "fixtures", "sdk-exact-wait.ts"),
      ],
      logsDirectory,
      "sdk-only-types",
    );

    createConsumer(
      runtimeConsumer,
      "reins-packed-runtime-consumer",
      {
        "@ykdz/reins": `file:${runtimeArtifact.path}`,
        "@ykdz/reins-sdk": `file:${sdkArtifact.path}`,
      },
      packageManager,
      sdkArtifact.path,
    );
    copyFixtures(join(runtimeConsumer, "fixtures"));
    await installConsumer(
      runtimeConsumer,
      logsDirectory,
      "runtime-sdk-install",
    );
    const installedRuntimePath = join(
      runtimeConsumer,
      "node_modules",
      "@ykdz",
      "reins",
    );
    const installedSdkPath = join(
      runtimeConsumer,
      "node_modules",
      "@ykdz",
      "reins-sdk",
    );
    const installedRuntime = readJsonObject(
      join(installedRuntimePath, "package.json"),
    );
    const installedSdk = readJsonObject(join(installedSdkPath, "package.json"));
    assert(
      installedRuntime.name === "@ykdz/reins" &&
        installedRuntime.version === runtimeArtifact.version &&
        installedSdk.name === "@ykdz/reins-sdk" &&
        installedSdk.version === sdkArtifact.version,
      "本地安装消费了错误包或不匹配版本",
    );
    const runtimeExports = installedRuntime.exports;
    const runtimeBins = installedRuntime.bin;
    assert(
      isRecord(runtimeExports) &&
        JSON.stringify(Object.keys(runtimeExports)) ===
          JSON.stringify([".", "./control-entry"]) &&
        isRecord(runtimeBins) &&
        JSON.stringify(Object.keys(runtimeBins).sort()) ===
          JSON.stringify(["reins-control-entry", "reins-daemon"]),
      "运行包没有公开应用 API、daemon 与 stdio 控制入口",
    );
    const daemonPath = join(
      runtimeConsumer,
      "node_modules",
      ".bin",
      "reins-daemon",
    );
    assert(existsSync(daemonPath), "真实安装没有提供 reins-daemon 机器入口");
    const controlEntryPath = join(
      runtimeConsumer,
      "node_modules",
      ".bin",
      "reins-control-entry",
    );
    assert(existsSync(controlEntryPath), "真实安装没有提供 stdio 控制入口");
    await typecheckConsumer(
      runtimeConsumer,
      [
        join(runtimeConsumer, "fixtures", "application-public-types.ts"),
        join(runtimeConsumer, "fixtures", "runtime-control-target.ts"),
        join(runtimeConsumer, "fixtures", "sdk-dsh-runtime.ts"),
      ],
      logsDirectory,
      "runtime-application-types",
    );

    await runInstalledApplicationAcceptance({
      runtimeConsumer,
      daemonPath,
      temporaryRoot,
      logsDirectory,
    });
    await runControlChannelAcceptance({
      sdkConsumer,
      runtimeConsumer,
      temporaryRoot,
      logsDirectory,
    });
    await runDshRuntimeAcceptance({
      runtimeConsumer,
      daemonPath,
      temporaryRoot,
      logsDirectory,
    });
    await runRecoveryAcceptance({
      sdkConsumer,
      daemonPath,
      temporaryRoot,
      logsDirectory,
      handles,
    });
    await runPermissionFailureAcceptance({
      sdkConsumer,
      daemonPath,
      temporaryRoot,
      logsDirectory,
      handles,
    });
    await runExactWaitAcceptance({
      sdkConsumer,
      daemonPath,
      temporaryRoot,
      logsDirectory,
      handles,
    });
    await runRuntimeFactsAcceptance({
      sdkConsumer,
      daemonPath,
      temporaryRoot,
      logsDirectory,
      handles,
    });
    await runEventHistoryAcceptance({
      sdkConsumer,
      daemonPath,
      temporaryRoot,
      logsDirectory,
      handles,
    });
    await runSessionIsolationAcceptance({
      sdkConsumer,
      daemonPath,
      temporaryRoot,
      logsDirectory,
      handles,
    });
  } catch (error) {
    primaryFailure = error;
  } finally {
    try {
      await stopAllDaemons(handles);
    } catch (error) {
      cleanupFailure = error;
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
  if (primaryFailure !== undefined) {
    if (cleanupFailure !== undefined)
      throw new AggregateError(
        [primaryFailure, cleanupFailure],
        "正式制品验收与资源清理都失败",
      );
    throw primaryFailure;
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;

  writeReleaseOutputs(packageGroup);
  process.stdout.write("双包制品与公开 SDK 消费验收通过\n");
}

await main();
