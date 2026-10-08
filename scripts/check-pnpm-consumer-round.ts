// 正式候选在独立 pnpm 消费者工作区中的完整 worker/session 回合入口。
// 与 npm smoke 共用 scripts/packed-cli-fixtures 的窄共享接缝：环境准备之外的一切进程
// 生命周期（spawn、就绪、超时、停止、自启动起的完整日志）与逐项留证都走同一支持模块；
// 本入口只保留场景输入、业务断言与清理事实，不复制 npm 的整套安装断言。
//
// 用法：<group-dir> <adapter-module> <evidence-dir>
//   group-dir：验收输入组（candidate/ + consumer/ + input.json）。本入口只读，
//              不重算锁、不写回组内任何文件；组身份由 input.json 的成员摘要绑定。
//   adapter-module：场景作者提供的、受正式注册表类型约束的 adapter 模块
//              （唯一替换点是 daemon 现有的 REINS_ADAPTERS_MODULE 接缝）。
//   evidence-dir：调用方明确提供的外部证据目录。临时安装、socket、state 与子进程
//              全部由本入口拥有并在结束前回收；证据不随回收消失。
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import {
  isCleanStop,
  startDaemon,
  stopDaemon,
} from "./packed-cli-fixtures/daemon.ts";
import {
  createFactRecorder,
  type FactRecorder,
} from "./packed-cli-fixtures/evidence.ts";
import {
  runLoggedCommand,
  waitForPathRemoval,
} from "./packed-cli-fixtures/process.ts";
import { locateInstalledSdk } from "./packed-cli-fixtures/sdk.ts";
import type {
  DaemonHandle,
  LoggedCommandResult,
} from "./packed-cli-fixtures/types.ts";

type ScenarioRun = {
  readonly groupDirectory: string;
  readonly adapterModule: string;
  readonly evidenceDirectory: string;
};

// 本次运行拥有的资源：调用方证据目录之外的安装/运行目录与本次启动的守护进程。
type OwnedResources = {
  temporaryRoot: string | undefined;
  daemon: DaemonHandle | undefined;
};

type InputIdentity = {
  readonly pnpmVersion: string;
  readonly files: Record<string, string>;
  readonly candidateDigest: string;
  readonly packageName: string;
  readonly candidateFile: string;
};

const installTimeoutMs = 900_000;
const cliTimeoutMs = 30_000;
const daemonReadyTimeoutMs = 10_000;
const daemonStopGraceMs = 5_000;
const pathRemovalTimeoutMs = 5_000;

// 场景作者创作的输入与期望：能力目录、worker 文本与显式 harness/model/reasoning
// 选项全部在此声明，并与 scripts/packed-cli-fixtures/simulated-adapter.ts 中
// 同一作者创作的注册表模块保持一致。控制面不得补值、换模型或改写这些内容。
const scenario = {
  harness: "simulated",
  model: "simulated-model",
  modelDisplayName: "Simulated model",
  reasoning: "low",
  providedSessionName: "s2b2a-provided",
  omittedSessionName: "s2b2a-omitted",
  firstMessage: "simulated round first input",
  followUpMessage: "simulated round follow-up input",
  finalReply: "simulated reply",
} as const;

const reasoningEfforts = ["low", "high"] as const;

// 两个回合都未提供的可选字段：driver 实际收到的 spec 必须完全不含这些键。
const neverProvidedFields = [
  "agent",
  "authorizationMode",
  "captureHarnessStderr",
  "sandbox",
] as const;

// 只有第一个回合提供的字段。
const providedOnlyOnFirstTurn = ["model", "reasoning"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function collectFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function readJsonRecord(label: string, text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error(`${label} did not return a JSON object: ${text}`);
  }
  return parsed;
}

function readJsonRecordFile(path: string): Record<string, unknown> {
  return readJsonRecord(path, readFileSync(path, "utf8"));
}

function readJsonArray(text: string): unknown[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected a JSON array, got: ${text}`);
  }
  return parsed;
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  context: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`${context} has no string field ${key}: ${key in record}`);
  }
  return value;
}

function fail(context: string, detail: string): never {
  throw new Error(`${context}: ${detail}`);
}

// 输入组身份：input.json 绑定的每个成员都必须逐字节一致，组内不得出现未登记成员。
function readInputIdentity(groupDirectory: string): InputIdentity {
  const input = readJsonRecordFile(join(groupDirectory, "input.json"));
  const pnpmVersion = requiredString(input, "pnpmVersion", "input.json");
  if (!isRecord(input.files)) {
    throw new Error("input.json must bind a files object");
  }
  const files: Record<string, string> = {};
  for (const [path, digest] of Object.entries(input.files)) {
    if (typeof digest !== "string" || digest === "") {
      throw new Error(`input.json bound an unusable digest for ${path}`);
    }
    files[path] = digest;
  }
  const members = collectFiles(groupDirectory)
    .map((path) => relative(groupDirectory, path))
    .filter((path) => path !== "input.json")
    .sort((left, right) => left.localeCompare(right));
  for (const member of members) {
    if (!(member in files)) {
      throw new Error(
        `Acceptance input member is not bound by input.json: ${member}`,
      );
    }
    const actual = sha256File(join(groupDirectory, member));
    if (actual !== files[member]) {
      throw new Error(
        `Acceptance input member digest changed: ${member} expected ${files[member]} actual ${actual}`,
      );
    }
  }
  for (const member of Object.keys(files).sort((a, b) => a.localeCompare(b))) {
    if (!members.includes(member)) {
      throw new Error(`Acceptance input member is missing: ${member}`);
    }
  }

  // candidate/ 必须恰好是 SHA256SUMS 与唯一 tarball，且校验行与实际摘要一致。
  const candidateFiles = Object.keys(files)
    .filter((member) => member.startsWith("candidate/"))
    .sort((left, right) => left.localeCompare(right));
  const tarballs = candidateFiles.filter((member) => member.endsWith(".tgz"));
  if (
    tarballs.length !== 1 ||
    candidateFiles.length !== 2 ||
    !candidateFiles.includes("candidate/SHA256SUMS")
  ) {
    throw new Error(
      `Acceptance input candidate directory is not SHA256SUMS plus one tarball: ${candidateFiles.join(", ")}`,
    );
  }
  const candidateFile = tarballs[0];
  if (candidateFile === undefined) {
    throw new Error("Acceptance input has no candidate tarball");
  }
  const candidateDigest = files[candidateFile];
  if (candidateDigest === undefined) {
    throw new Error("Candidate tarball is not bound by input.json");
  }
  const checksums = readFileSync(
    join(groupDirectory, "candidate/SHA256SUMS"),
    "utf8",
  );
  const tarballName = relative("candidate", candidateFile);
  if (checksums !== `${candidateDigest}  ${tarballName}\n`) {
    throw new Error(
      `candidate/SHA256SUMS does not match the bound tarball digest: ${checksums}`,
    );
  }

  // 消费者清单必须只用稳定相对路径引用组内同一 tarball。
  if (!("consumer/package.json" in files)) {
    throw new Error("Acceptance input has no consumer manifest");
  }
  const consumerManifest = readJsonRecordFile(
    join(groupDirectory, "consumer/package.json"),
  );
  if (!isRecord(consumerManifest.dependencies)) {
    throw new Error("Consumer manifest has no dependencies object");
  }
  const dependencyNames = Object.keys(consumerManifest.dependencies);
  if (dependencyNames.length !== 1) {
    throw new Error(
      `Consumer manifest must depend on exactly the candidate package: ${dependencyNames.join(", ")}`,
    );
  }
  const packageName = dependencyNames[0];
  if (packageName === undefined) {
    throw new Error("Consumer manifest dependency name is unreadable");
  }
  const specifier = consumerManifest.dependencies[packageName];
  if (specifier !== `file:../${candidateFile}`) {
    throw new Error(
      `Consumer manifest does not reference the group candidate in place: ${String(specifier)}`,
    );
  }

  return {
    pnpmVersion,
    files,
    candidateDigest,
    packageName,
    candidateFile,
  };
}

function requireCleanExit(label: string, logged: LoggedCommandResult): string {
  if (
    logged.exit.exitCode !== 0 ||
    logged.exit.signal !== null ||
    logged.exit.timedOut ||
    logged.exit.stillRunning
  ) {
    throw new Error(
      `${label} did not complete cleanly: exit=${String(logged.exit.exitCode)} signal=${String(logged.exit.signal)} timedOut=${String(logged.exit.timedOut)} stillRunning=${String(logged.exit.stillRunning)}\n${logged.stdout}${logged.stderr}\nFull log: ${logged.logPath}`,
    );
  }
  return logged.stdout;
}

type CliContext = {
  readonly recorder: FactRecorder;
  readonly logsDirectory: string;
  readonly cli: string;
  readonly environment: NodeJS.ProcessEnv;
};

// 每次 CLI 调用都经共享进程夹具执行：完整输出自启动即落盘，退出事实逐项留证。
async function runCli(
  context: CliContext,
  label: string,
  args: readonly string[],
): Promise<string> {
  const logPath = join(context.logsDirectory, `cli-${label}.log`);
  const logged = await runLoggedCommand({
    command: context.cli,
    args: [...args],
    env: context.environment,
    logPath,
    timeoutMs: cliTimeoutMs,
  });
  context.recorder.record(`cli_${label}`, {
    args: [...args],
    exit: logged.exit,
    stdout: logged.stdout,
    stderr: logged.stderr,
    logPath,
  });
  return requireCleanExit(`reins ${label}`, logged);
}

function parseEventNotifications(text: string): {
  readonly events: Record<string, unknown>[];
  readonly ended: Record<string, unknown> | undefined;
} {
  const events: Record<string, unknown>[] = [];
  let ended: Record<string, unknown> | undefined;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const notification = readJsonRecord("attach notification", line);
    if (notification.kind !== "notification") {
      throw new Error(`Unexpected attach output line: ${line}`);
    }
    const method = requiredString(
      notification,
      "method",
      "attach notification",
    );
    if (method === "event" || method === "attach.ended") {
      if (!isRecord(notification.params)) {
        throw new Error(`Attach notification ${method} has no params object`);
      }
      if (method === "event") events.push(notification.params);
      else ended = notification.params;
      continue;
    }
    throw new Error(`Unexpected attach notification method: ${method}`);
  }
  return { events, ended };
}

function observationRecords(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) {
    throw new Error(`Simulated adapter observation log is missing: ${path}`);
  }
  const records: Record<string, unknown>[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line === "") continue;
    records.push(readJsonRecord("adapter observation", line));
  }
  return records;
}

function findStartSpec(
  records: Record<string, unknown>[],
  sessionName: string,
): Record<string, unknown> {
  for (const record of records) {
    if (record.operation !== "start" || !isRecord(record.spec)) continue;
    if (record.spec.sessionName === sessionName) return record.spec;
  }
  throw new Error(
    `Simulated adapter recorded no start input for session ${sessionName}`,
  );
}

function findDeliverMessage(
  records: Record<string, unknown>[],
  sessionId: string,
): string {
  for (const record of records) {
    if (record.operation !== "deliver" || record.sessionId !== sessionId) {
      continue;
    }
    return requiredString(record, "message", "deliver observation");
  }
  throw new Error(
    `Simulated adapter recorded no deliver for session ${sessionId}`,
  );
}

function assertFieldsAbsent(
  spec: Record<string, unknown>,
  fields: readonly string[],
  context: string,
): void {
  const present = fields.filter((field) => field in spec);
  if (present.length > 0) {
    fail(
      context,
      `unexpected keys present in the driver spec: ${present.join(", ")}`,
    );
  }
}

// 回合场景：能力目录（保留已接受 S2b1 语义）→ 带显式选项的 spawn → 等待首个回合
// → 空闲会话 send 追问 → 等待第二个回合 → attach 回放完整事件流 → 会话清单
// → 省略可选字段的第二个会话（最小干扰证据由 driver 侧的 spec 原文提供）→ kill。
async function runWorkerRound(
  run: ScenarioRun,
  identity: InputIdentity,
  recorder: FactRecorder,
  owned: OwnedResources,
  logsDirectory: string,
  observationPath: string,
): Promise<void> {
  const groupDirectory = run.groupDirectory;
  owned.temporaryRoot = mkdtempSync(join(tmpdir(), "reins-pnpm-round-"));
  const temporaryRoot = owned.temporaryRoot;
  const workingGroup = join(temporaryRoot, "group");
  const consumerDirectory = join(workingGroup, "consumer");
  const runtimeDirectory = join(temporaryRoot, "runtime");
  const daemonDirectory = join(runtimeDirectory, "daemon");
  mkdirSync(runtimeDirectory);
  mkdirSync(daemonDirectory);

  // 只读消费输入组：安装永远发生在组副本内，组内成员摘要在收尾时再次核对。
  cpSync(groupDirectory, workingGroup, { recursive: true });

  const pnpmVersionLog = join(logsDirectory, "pnpm-version.log");
  const pnpmVersion = await runLoggedCommand({
    command: "pnpm",
    args: ["--version"],
    logPath: pnpmVersionLog,
    timeoutMs: cliTimeoutMs,
  });
  recorder.record("install_tool_version", {
    exit: pnpmVersion.exit,
    stdout: pnpmVersion.stdout,
    logPath: pnpmVersionLog,
  });
  const observedPnpmVersion = requireCleanExit(
    "pnpm --version",
    pnpmVersion,
  ).trim();
  if (observedPnpmVersion !== identity.pnpmVersion) {
    throw new Error(
      `The acceptance input is bound to pnpm ${identity.pnpmVersion}; host provides ${observedPnpmVersion}`,
    );
  }

  const lockPath = join(consumerDirectory, "pnpm-lock.yaml");
  const boundLockDigest = identity.files["consumer/pnpm-lock.yaml"];
  if (boundLockDigest === undefined) {
    throw new Error("Acceptance input does not bind the consumer lock");
  }
  const lockBeforeInstall = sha256File(lockPath);
  if (lockBeforeInstall !== boundLockDigest) {
    throw new Error(
      `Consumer lock digest differs from the bound identity before install: ${lockBeforeInstall}`,
    );
  }

  // 冻结安装：失败即失败，绝不重新生成锁；安装前后的锁摘要必须一致。
  const installLog = join(logsDirectory, "pnpm-install.log");
  const install = await runLoggedCommand({
    command: "pnpm",
    args: ["install", "--frozen-lockfile"],
    cwd: consumerDirectory,
    logPath: installLog,
    timeoutMs: installTimeoutMs,
  });
  recorder.record("pnpm_frozen_install", {
    exit: install.exit,
    logPath: installLog,
    lockSha256Before: lockBeforeInstall,
    lockSha256After: sha256File(lockPath),
    boundLockSha256: boundLockDigest,
  });
  requireCleanExit("pnpm install --frozen-lockfile", install);
  const lockAfterInstall = sha256File(lockPath);
  if (
    lockAfterInstall !== lockBeforeInstall ||
    lockAfterInstall !== boundLockDigest
  ) {
    throw new Error(
      `Frozen install rewrote the consumer lock: ${lockAfterInstall} vs ${boundLockDigest}`,
    );
  }

  const nodeModules = join(consumerDirectory, "node_modules");
  const binDirectory = join(nodeModules, ".bin");
  const cli = join(binDirectory, "reins");
  const daemonExecutable = join(binDirectory, "reins-daemon");
  const installedPackageLink = join(nodeModules, identity.packageName);
  if (!existsSync(cli) || !existsSync(daemonExecutable)) {
    throw new Error("Frozen install did not expose both runtime executables");
  }
  // Node 默认按 realpath 解析模块；pnpm 的消费者链接指向 .pnpm 虚拟仓库目录，
  // 因此发行包上下文必须取其真实目录，否则解析起点不在该包自己的依赖视图内。
  const installedPackage = realpathSync(installedPackageLink);
  recorder.record("installed_package_layout", {
    consumerNodeModules: nodeModules,
    packageLinkPath: installedPackageLink,
    packageRealPath: installedPackage,
    resolvedThroughVirtualStore: installedPackage.includes(
      join("node_modules", ".pnpm"),
    ),
  });
  const installedManifest = readJsonRecordFile(
    join(installedPackage, "package.json"),
  );
  if (installedManifest.name !== identity.packageName) {
    throw new Error(
      `Installed package name diverged from the consumer manifest: ${String(installedManifest.name)}`,
    );
  }
  const installedVersion = requiredString(
    installedManifest,
    "version",
    "installed manifest",
  );
  recorder.record("installed_package_identity", {
    packageName: identity.packageName,
    version: installedVersion,
    candidateSha256: identity.candidateDigest,
    installTool: "pnpm",
    installToolVersion: observedPnpmVersion,
  });

  // 正常模块解析定位已安装发行包的 SDK 上下文，并核对安装脚本实际取得的厂商运行时。
  // 该运行时由 SDK 安装脚本在线下载，不在消费者包锁冻结范围，身份单独逐项留证。
  const sdk = locateInstalledSdk(installedPackage);
  if (sdk.runtimeEntrypointBytes < 10 * 1024 * 1024) {
    throw new Error("Qoder postinstall did not provision its worker runtime");
  }
  // pnpm 的非扁平虚拟仓库必须出现在解析结果里：证明这里走的是正常模块解析，
  // 而不是对 npm 式扁平 node_modules 布局的路径猜测。
  if (!sdk.sdkEntryPath.includes("/node_modules/.pnpm/")) {
    throw new Error(
      `Installed SDK did not resolve through the pnpm virtual store: ${sdk.sdkEntryPath}`,
    );
  }
  recorder.record("installed_sdk_identity", {
    ...sdk,
    sdkAcquisition:
      "pnpm frozen install ran the SDK postinstall script for its vendor runtime",
    vendorRuntimeLockCoverage:
      "the consumer lock pins the SDK package, not the vendor runtime download",
  });

  // 场景 adapter 素材：复制到运行目录后交给现有注册表接缝；本入口不新增产品 hook。
  const adaptersModule = join(runtimeDirectory, "simulated-adapter.ts");
  copyFileSync(run.adapterModule, adaptersModule);
  recorder.record("adapter_module", {
    sourcePath: run.adapterModule,
    sourceSha256: sha256File(run.adapterModule),
    copiedPath: adaptersModule,
    copiedSha256: sha256File(adaptersModule),
  });

  const socketPath = join(daemonDirectory, "reins.sock");
  const stateDirectory = join(daemonDirectory, "state");
  const daemonEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    REINS_SOCKET: socketPath,
    REINS_STATE_DIR: stateDirectory,
    REINS_ADAPTERS_MODULE: adaptersModule,
    REINS_IDLE_TIMEOUT_MS: "60000",
    REINS_SIMULATED_OBSERVATION_LOG: observationPath,
  };
  // 显式守护进程由本入口启动；剥离宿主 REINS_DAEMON_BIN，避免任何自动拉起兜底
  // 借用宿主构建的 daemon 而掩盖本次安装的发行包事实。
  delete daemonEnvironment.REINS_DAEMON_BIN;
  const daemonLogPath = join(logsDirectory, "daemon.log");
  owned.daemon = await startDaemon({
    label: "packed pnpm consumer daemon",
    executable: daemonExecutable,
    args: [],
    env: daemonEnvironment,
    socketPath,
    logPath: daemonLogPath,
    readyTimeoutMs: daemonReadyTimeoutMs,
  });
  recorder.record("daemon_start", {
    label: "packed pnpm consumer daemon",
    socketPath,
    logPath: daemonLogPath,
    startupTimedOut: owned.daemon.startupTimedOut,
  });
  if (owned.daemon.startupTimedOut) {
    throw new Error(
      `Daemon did not become ready within ${daemonReadyTimeoutMs} ms (log: ${daemonLogPath})`,
    );
  }

  const context: CliContext = {
    recorder,
    logsDirectory,
    cli,
    environment: { ...daemonEnvironment },
  };
  delete context.environment.REINS_SIMULATED_OBSERVATION_LOG;

  const capabilitiesOutput = await runCli(context, "capabilities", [
    "capabilities",
  ]);
  const capabilities = readJsonRecord(
    "capabilities output",
    capabilitiesOutput,
  );
  const expectedCapabilities = {
    capabilities: [
      {
        harness: scenario.harness,
        models: [
          {
            id: scenario.model,
            displayName: scenario.modelDisplayName,
            reasoningEfforts: [...reasoningEfforts],
          },
        ],
      },
    ],
    failures: [],
  };
  if (JSON.stringify(capabilities) !== JSON.stringify(expectedCapabilities)) {
    throw new Error(
      `Registry capabilities diverged from the authored catalog: ${capabilitiesOutput}`,
    );
  }

  const providedListOutput = await runCli(context, "list-before", ["list"]);
  if (JSON.stringify(readJsonArray(providedListOutput)) !== "[]") {
    throw new Error(
      `Daemon started with pre-existing sessions: ${providedListOutput}`,
    );
  }

  const spawnProvidedOutput = await runCli(context, "spawn-provided", [
    "spawn",
    scenario.harness,
    scenario.firstMessage,
    "--name",
    scenario.providedSessionName,
    "--model",
    scenario.model,
    "--reasoning",
    scenario.reasoning,
  ]);
  const providedSessionId = requiredString(
    readJsonRecord("spawn output", spawnProvidedOutput),
    "sessionId",
    "spawn output",
  );

  const waitFirstOutput = await runCli(context, "wait-first", [
    "wait",
    providedSessionId,
    "--timeout",
    "10000",
  ]);
  assertCompletedTurn(waitFirstOutput, providedSessionId);

  const sendOutput = await runCli(context, "send-follow-up", [
    "send",
    providedSessionId,
    scenario.followUpMessage,
  ]);
  const ack = readJsonRecord("send ack", sendOutput);
  if (requiredString(ack, "sessionId", "send ack") !== providedSessionId) {
    throw new Error(`Send ack referenced another session: ${sendOutput}`);
  }
  const ackTurnId = requiredString(ack, "turnId", "send ack");
  const ackMessageId = requiredString(ack, "messageId", "send ack");
  if (requiredString(ack, "deliveryPoint", "send ack") !== "new_turn") {
    throw new Error(
      `Follow-up on an idle session was not delivered as a new turn: ${sendOutput}`,
    );
  }

  const waitSecondOutput = await runCli(context, "wait-second", [
    "wait",
    providedSessionId,
    "--timeout",
    "10000",
  ]);
  const secondTurn = assertCompletedTurn(waitSecondOutput, providedSessionId);
  if (secondTurn.turnId !== ackTurnId) {
    throw new Error(
      `Waited turn ${secondTurn.turnId} is not the acked turn ${ackTurnId}`,
    );
  }

  const attachOutput = await runCli(context, "attach-provided", [
    "attach",
    providedSessionId,
    "--replay",
    "32",
    "--exit-on",
    "end_turn",
  ]);
  const attach = parseEventNotifications(attachOutput);
  const eventTypes = attach.events.map((event) =>
    requiredString(event, "type", "domain event"),
  );
  const expectedEventTypes = [
    "session.created",
    "turn.started",
    "turn.completed",
    "turn.started",
    "message",
    "turn.completed",
  ];
  if (
    JSON.stringify(eventTypes) !== JSON.stringify(expectedEventTypes) ||
    attach.ended === undefined ||
    attach.ended.reason !== "end_turn"
  ) {
    throw new Error(
      `Event stream diverged: ${JSON.stringify(eventTypes)} ended=${JSON.stringify(attach.ended ?? null)}`,
    );
  }
  const turnIds = new Set<string>();
  for (const event of attach.events) {
    if (
      requiredString(event, "sessionId", "domain event") !== providedSessionId
    ) {
      throw new Error(
        `Domain event belongs to another session: ${JSON.stringify(event)}`,
      );
    }
    const type = requiredString(event, "type", "domain event");
    if (
      type === "turn.started" ||
      type === "turn.completed" ||
      type === "message"
    ) {
      turnIds.add(requiredString(event, "turnId", "domain event"));
    }
    if (type === "session.created") {
      if (event.harness !== scenario.harness) {
        throw new Error(
          `Session created with another harness: ${JSON.stringify(event)}`,
        );
      }
      if (
        event.model !== scenario.model ||
        event.reasoning !== scenario.reasoning
      ) {
        throw new Error(
          `Session created without the authored model/reasoning selection: ${JSON.stringify(event)}`,
        );
      }
      if (event.sessionName !== scenario.providedSessionName) {
        throw new Error(`Session name diverged: ${JSON.stringify(event)}`);
      }
      if (event.cwd !== process.cwd()) {
        throw new Error(
          `Session cwd is not the daemon working directory: ${String(event.cwd)}`,
        );
      }
      continue;
    }
    if (type === "message") {
      if (
        event.role !== "caller" ||
        event.content !== scenario.followUpMessage
      ) {
        throw new Error(
          `Follow-up message event lost the authored input: ${JSON.stringify(event)}`,
        );
      }
      if (requiredString(event, "messageId", "domain event") !== ackMessageId) {
        throw new Error(
          `Message event id diverged from the ack: ${JSON.stringify(event)}`,
        );
      }
      continue;
    }
    if (type === "turn.completed") {
      if (
        event.stopReason !== "end_turn" ||
        event.finalReply !== scenario.finalReply
      ) {
        throw new Error(
          `Turn did not complete as authored: ${JSON.stringify(event)}`,
        );
      }
      if ("usage" in event) {
        throw new Error(
          `Simulated turn reported usage the scenario never provided: ${JSON.stringify(event)}`,
        );
      }
    }
  }
  if (turnIds.size !== 2) {
    throw new Error(
      `Two turns were expected, saw turn ids: ${JSON.stringify([...turnIds])}`,
    );
  }

  const listOutput = await runCli(context, "list-provided", [
    "list",
    "--name",
    scenario.providedSessionName,
  ]);
  const listed = readJsonArray(listOutput);
  if (listed.length !== 1 || !isRecord(listed[0])) {
    throw new Error(`Session list diverged: ${listOutput}`);
  }
  const providedInfo = listed[0];
  if (
    providedInfo.sessionId !== providedSessionId ||
    providedInfo.harness !== scenario.harness ||
    providedInfo.state !== "idle" ||
    providedInfo.model !== scenario.model ||
    providedInfo.reasoning !== scenario.reasoning ||
    providedInfo.turns !== 2 ||
    providedInfo.lastStopReason !== "end_turn"
  ) {
    throw new Error(
      `Provided session facts diverged: ${JSON.stringify(providedInfo)}`,
    );
  }

  // 省略可选字段的第二个会话：driver 侧原样落盘的 spec 是「未提供即不存在」的证据。
  const spawnOmittedOutput = await runCli(context, "spawn-omitted", [
    "spawn",
    scenario.harness,
    scenario.firstMessage,
    "--name",
    scenario.omittedSessionName,
  ]);
  const omittedSessionId = requiredString(
    readJsonRecord("spawn output", spawnOmittedOutput),
    "sessionId",
    "spawn output",
  );
  const waitOmittedOutput = await runCli(context, "wait-omitted", [
    "wait",
    omittedSessionId,
    "--timeout",
    "10000",
  ]);
  assertCompletedTurn(waitOmittedOutput, omittedSessionId);
  const omittedListOutput = await runCli(context, "list-omitted", [
    "list",
    "--name",
    scenario.omittedSessionName,
  ]);
  const omittedListed = readJsonArray(omittedListOutput);
  if (omittedListed.length !== 1 || !isRecord(omittedListed[0])) {
    throw new Error(`Omitted session list diverged: ${omittedListOutput}`);
  }
  const omittedInfo = omittedListed[0];
  if (
    omittedInfo.model !== null ||
    omittedInfo.reasoning !== null ||
    omittedInfo.turns !== 1
  ) {
    throw new Error(
      `Control plane filled options the scenario never provided: ${JSON.stringify(omittedInfo)}`,
    );
  }

  const observations = observationRecords(observationPath);
  const providedSpec = findStartSpec(
    observations,
    scenario.providedSessionName,
  );
  const omittedSpec = findStartSpec(observations, scenario.omittedSessionName);
  if (
    providedSpec.sessionId !== providedSessionId ||
    omittedSpec.sessionId !== omittedSessionId
  ) {
    throw new Error(
      `Driver spec session ids diverged: ${JSON.stringify(providedSpec)} ${JSON.stringify(omittedSpec)}`,
    );
  }
  for (const spec of [providedSpec, omittedSpec]) {
    if (
      spec.harness !== scenario.harness ||
      spec.message !== scenario.firstMessage ||
      spec.cwd !== process.cwd()
    ) {
      throw new Error(
        `Driver spec lost the authored input: ${JSON.stringify(spec)}`,
      );
    }
    assertFieldsAbsent(spec, neverProvidedFields, "Simulated driver spec");
  }
  if (
    providedSpec.model !== scenario.model ||
    providedSpec.reasoning !== scenario.reasoning
  ) {
    throw new Error(
      `Provided model/reasoning never reached the driver: ${JSON.stringify(providedSpec)}`,
    );
  }
  assertFieldsAbsent(
    omittedSpec,
    providedOnlyOnFirstTurn,
    "Omitted-field session driver spec",
  );
  const deliveredMessage = findDeliverMessage(observations, providedSessionId);
  if (deliveredMessage !== scenario.followUpMessage) {
    throw new Error(
      `Follow-up input never reached the driver: ${JSON.stringify(deliveredMessage)}`,
    );
  }

  const killOutput = await runCli(context, "kill-sessions", [
    "kill",
    providedSessionId,
    omittedSessionId,
  ]);
  const killed = readJsonArray(killOutput);
  if (
    killed.length !== 2 ||
    !killed.every((entry) => isRecord(entry) && entry.status === "killed")
  ) {
    throw new Error(`Sessions were not killed as reported: ${killOutput}`);
  }
  // terminate 由产品 kill 路径在发布 session.killed 之前 await，因此必须重读日志：
  // kill 之前的快照不含 terminate，用旧快照断言会把真实执行误判成缺失。
  const postKillObservations = observationRecords(observationPath);
  const terminatedSessions = postKillObservations
    .filter((record) => record.operation === "terminate")
    .map((record) => String(record.sessionId));
  if (
    !terminatedSessions.includes(providedSessionId) ||
    !terminatedSessions.includes(omittedSessionId)
  ) {
    throw new Error(
      `Driver terminate never ran for both sessions: ${JSON.stringify(terminatedSessions)}`,
    );
  }

  recorder.record("worker_round", { status: "passed", ackMessageId });

  // 产品清理与场景执行是不同事实：守护进程正常停止、socket 与锁消失单独留证。
  const handle = owned.daemon;
  const stopFact = await stopDaemon(handle, daemonStopGraceMs);
  owned.daemon = undefined;
  recorder.record("daemon_stop", stopFact);
  if (!isCleanStop(stopFact)) {
    throw new Error(
      `Daemon did not stop cleanly: ${JSON.stringify(stopFact)} (log: ${handle.logPath})`,
    );
  }
  await waitForPathRemoval(socketPath, pathRemovalTimeoutMs);
  await waitForPathRemoval(`${socketPath}.lock`, pathRemovalTimeoutMs);
  recorder.record("product_socket_cleanup", {
    socketPath,
    lockPath: `${socketPath}.lock`,
    socketPresent: existsSync(socketPath),
    lockPresent: existsSync(`${socketPath}.lock`),
    stateDirectory,
  });
}

// wait 结果的业务断言：完成状态、本次回合的终态与场景作者创作的 worker 文本。
function assertCompletedTurn(
  output: string,
  sessionId: string,
): { readonly turnId: string; readonly stopReason: string } {
  const result = readJsonRecord("wait result", output);
  if (result.status !== "completed") {
    throw new Error(`Wait did not complete: ${output}`);
  }
  if (!Array.isArray(result.results) || result.results.length !== 1) {
    throw new Error(`Wait result is unexpected: ${output}`);
  }
  const entry = result.results[0];
  if (!isRecord(entry) || entry.status !== "completed") {
    throw new Error(`Wait entry is not completed: ${output}`);
  }
  if (entry.sessionId !== sessionId) {
    throw new Error(`Wait entry belongs to another session: ${output}`);
  }
  if (!isRecord(entry.turn)) {
    throw new Error(`Wait entry has no turn result: ${output}`);
  }
  const turn = entry.turn;
  if (
    turn.stopReason !== "end_turn" ||
    turn.finalReply !== scenario.finalReply
  ) {
    throw new Error(`Turn did not finish as authored: ${JSON.stringify(turn)}`);
  }
  return {
    turnId: requiredString(turn, "turnId", "wait turn"),
    stopReason: requiredString(turn, "stopReason", "wait turn"),
  };
}

function recordCleanupFailure(
  failures: string[],
  label: string,
  error: unknown,
): void {
  failures.push(`${label} failed: ${String(error)}`);
}

// 收尾：兜底停止本次启动的守护进程，再回收组副本/安装/运行目录与 socket/state；
// 每个清理动作的失败都保留为原始事实并以非零退出报告，不被 finally 吞掉，
// 也不把未执行或中断未完成当作通过。
async function main(): Promise<void> {
  const [groupArgument, adapterArgument, evidenceArgument] =
    process.argv.slice(2);
  if (
    typeof groupArgument !== "string" ||
    typeof adapterArgument !== "string" ||
    typeof evidenceArgument !== "string"
  ) {
    process.stderr.write(
      "usage: check-pnpm-consumer-round.ts <group-dir> <adapter-module> <evidence-dir>\n",
    );
    process.exitCode = 64;
    return;
  }
  const run: ScenarioRun = {
    groupDirectory: resolve(groupArgument),
    adapterModule: resolve(adapterArgument),
    evidenceDirectory: resolve(evidenceArgument),
  };
  mkdirSync(run.evidenceDirectory, { recursive: true });
  const logsDirectory = join(run.evidenceDirectory, "pnpm-round-logs");
  mkdirSync(logsDirectory, { recursive: true });
  const observationPath = join(
    run.evidenceDirectory,
    "adapter-observations.ndjson",
  );
  const factsPath = join(run.evidenceDirectory, "pnpm-round-facts.ndjson");
  rmSync(factsPath, { force: true });
  rmSync(observationPath, { force: true });
  const recorder = createFactRecorder(factsPath);
  const owned: OwnedResources = { temporaryRoot: undefined, daemon: undefined };
  const cleanupFailures: string[] = [];
  let primaryFailure: { readonly message: string } | undefined;
  try {
    const identity = readInputIdentity(run.groupDirectory);
    recorder.record("acceptance_input_identity", {
      groupDirectory: run.groupDirectory,
      pnpmVersion: identity.pnpmVersion,
      candidateFile: identity.candidateFile,
      candidateSha256: identity.candidateDigest,
      packageName: identity.packageName,
      files: identity.files,
    });
    await runWorkerRound(
      run,
      identity,
      recorder,
      owned,
      logsDirectory,
      observationPath,
    );
    recorder.record("acceptance_input_reverified", {
      groupDirectory: run.groupDirectory,
      files: readInputIdentity(run.groupDirectory).files,
    });
  } catch (error) {
    primaryFailure =
      error instanceof Error
        ? { message: error.message }
        : { message: `round threw a non-Error value (typeof ${typeof error})` };
    recorder.record("worker_round", {
      status: "failed",
      message: primaryFailure.message,
    });
  } finally {
    const handle = owned.daemon;
    if (handle !== undefined) {
      try {
        const fact = await stopDaemon(handle, daemonStopGraceMs);
        recorder.record("daemon_fallback_cleanup_stop", fact);
        if (!isCleanStop(fact)) {
          cleanupFailures.push(
            `daemon fallback cleanup left facts: ${JSON.stringify(fact)} (log: ${handle.logPath})`,
          );
        }
      } catch (error) {
        recordCleanupFailure(cleanupFailures, "daemon fallback cleanup", error);
      }
    }
    if (owned.temporaryRoot !== undefined) {
      try {
        const temporaryRoot = owned.temporaryRoot;
        rmSync(temporaryRoot, { recursive: true, force: true });
        recorder.record("runtime_cleanup", {
          temporaryRoot,
          removed: !existsSync(temporaryRoot),
        });
      } catch (error) {
        recordCleanupFailure(cleanupFailures, "temporary root removal", error);
      }
    }
  }
  cleanupFailures.push(...recorder.failures);
  if (primaryFailure !== undefined) {
    process.stderr.write(
      `Pnpm consumer round failed: ${primaryFailure.message}\nEvidence kept: ${run.evidenceDirectory}\n`,
    );
    for (const failure of cleanupFailures) {
      process.stderr.write(`${failure}\n`);
    }
    process.exitCode = 1;
    return;
  }
  if (cleanupFailures.length > 0) {
    for (const failure of cleanupFailures) {
      process.stderr.write(`${failure}\n`);
    }
    process.stderr.write(
      `Pnpm consumer round business checks passed but cleanup failed; not reported as success. Evidence kept: ${run.evidenceDirectory}\n`,
    );
    process.exitCode = 1;
    return;
  }
  // 留证事实：宿主临时安装/socket/state/进程已回收，外部证据仍可读取。
  const retainedEvidence = [factsPath, observationPath].map((path) => ({
    path,
    bytes: statSync(path).size,
  }));
  recorder.record("evidence_retained", {
    evidenceDirectory: run.evidenceDirectory,
    files: retainedEvidence,
    logFiles: readdirSync(logsDirectory).sort((left, right) =>
      left.localeCompare(right),
    ),
  });
  process.stdout.write(
    `Pnpm consumer round passed\nEvidence: ${run.evidenceDirectory}\n`,
  );
}

await main();
