// 正式发行包的 npm 干净安装 smoke：安装兼容性与既有业务场景断言留在本入口，
// 环境准备之外的一切进程生命周期（启动、就绪、超时、停止、完整日志）走
// scripts/packed-cli-fixtures 的窄共享接缝，供后续 Docker 正式包 smoke 复用。
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
import {
  assertReleaseVersionAuthority,
  readJsonObject,
  releaseTarballName,
  resolveReleaseRuntimeDependencies,
} from "./release-package.ts";

type CommandResult = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
};

// 本次行动拥有的资源：调用方指定的证据目录之外的临时安装/runtime 与本次启动的进程。
type OwnedResources = {
  temporaryRoot: string | undefined;
  runtimeRoot: string | undefined;
  directDaemon: DaemonHandle | undefined;
};

const adapterFixtureSource = fileURLToPath(
  new URL("./packed-cli-fixtures/adapter-fixture.ts", import.meta.url),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readManifest(directory: string): Record<string, unknown> {
  return readJsonObject(join(directory, "package.json"));
}

// 兼容原入口的断言形状：命令结果 + 从进程启动即完整落盘的日志。
function toCommandResult(result: LoggedCommandResult): CommandResult {
  return {
    status: result.exit.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function assertOutput(
  label: string,
  result: CommandResult,
  expected: { status: number; stderr: string },
  logPath: string,
): void {
  if (result.status !== expected.status || result.stderr !== expected.stderr) {
    throw new Error(
      `${label} returned exit ${result.status}\n${result.stdout}${result.stderr}\nFull log: ${logPath}`,
    );
  }
}

function requireSuccess(
  label: string,
  result: CommandResult,
  logPath: string,
): void {
  if (result.status !== 0) {
    throw new Error(
      `${label} failed with exit ${result.status}\n${result.stdout}${result.stderr}\nFull log: ${logPath}`,
    );
  }
}

function filesRecursively(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesRecursively(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

// 停止事实判定与业务断言：干净停止的分类走共享模块，本入口只保留场景断言。
async function smokePackedCli(
  evidenceDirectory: string,
  recorder: FactRecorder,
  owned: OwnedResources,
): Promise<void> {
  const repository = process.cwd();
  const releaseIdentity = assertReleaseVersionAuthority(repository);
  const expectedRuntimeDependencies =
    resolveReleaseRuntimeDependencies(repository);

  // 环境准备：临时安装/runtime 目录归本入口所有；日志写入调用方证据目录。
  owned.temporaryRoot = mkdtempSync(join(tmpdir(), "reins-packed-cli-"));
  const temporaryRoot = owned.temporaryRoot;
  const installDirectory = join(temporaryRoot, "install");
  // Linux 宿主磁盘的 fsync 延迟会耗尽自动启动窗口；小型运行状态使用独立 tmpfs。
  owned.runtimeRoot = mkdtempSync(
    join(
      process.platform === "linux" ? "/dev/shm" : tmpdir(),
      "reins-packed-runtime-",
    ),
  );
  const runtimeDirectory = owned.runtimeRoot;
  const logsDirectory = join(evidenceDirectory, "npm-smoke-logs");
  const artifactDirectory = join(repository, ".artifacts", "release");
  const tarballName = releaseTarballName(
    releaseIdentity.name,
    releaseIdentity.version,
  );
  const tarball = join(artifactDirectory, tarballName);

  mkdirSync(installDirectory);
  // 证据目录由调用方指定且可能被复用：日志目录按幂等方式准备。
  mkdirSync(logsDirectory, { recursive: true });

  const artifacts = readdirSync(artifactDirectory).sort();
  if (
    artifacts.length !== 2 ||
    artifacts[0] !== "SHA256SUMS" ||
    artifacts[1] !== tarballName
  ) {
    throw new Error(`Unexpected release artifact set: ${artifacts.join(", ")}`);
  }
  const actualDigest = createHash("sha256")
    .update(readFileSync(tarball))
    .digest("hex");
  const expectedDigest = `${actualDigest}  ${tarballName}\n`;
  if (
    readFileSync(join(artifactDirectory, "SHA256SUMS"), "utf8") !==
    expectedDigest
  )
    throw new Error("SHA256SUMS does not match the release tarball");

  writeFileSync(
    join(installDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "reins-packed-cli-smoke",
        version: "0.0.0",
        private: true,
      },
      null,
      2,
    )}\n`,
  );
  // npm 专属的干净安装留在原入口；进程观察走共享接缝，完整日志（含安装脚本输出）留证。
  const installLog = join(logsDirectory, "npm-install.log");
  const install = toCommandResult(
    await runLoggedCommand({
      command: "npm",
      args: [
        "install",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        tarball,
      ],
      cwd: installDirectory,
      logPath: installLog,
    }),
  );
  requireSuccess("clean install", install, installLog);
  recorder.record("npm_install", {
    exitCode: install.status,
    logPath: installLog,
  });

  const binDirectory = join(installDirectory, "node_modules", ".bin");
  const installedPackage = join(
    installDirectory,
    "node_modules",
    releaseIdentity.name,
  );
  const cli = join(binDirectory, "reins");
  const daemon = join(binDirectory, "reins-daemon");
  if (!existsSync(cli) || !existsSync(daemon))
    throw new Error("Packed install did not expose both runtime executables");

  const installedManifest = readManifest(installedPackage);
  if (
    installedManifest.name !== releaseIdentity.name ||
    installedManifest.version !== releaseIdentity.version ||
    installedManifest.license !== "MIT" ||
    JSON.stringify(installedManifest.dependencies) !==
      JSON.stringify(expectedRuntimeDependencies) ||
    JSON.stringify(installedManifest.os) !== JSON.stringify(["linux"]) ||
    JSON.stringify(installedManifest.cpu) !== JSON.stringify(["x64"]) ||
    "private" in installedManifest ||
    "exports" in installedManifest ||
    "imports" in installedManifest
  ) {
    throw new Error("Installed manifest diverged from the release authority");
  }
  if (
    readFileSync(join(installedPackage, "README.md"), "utf8") !==
    readFileSync("README.md", "utf8")
  ) {
    throw new Error("Packed README did not come from the repository authority");
  }
  if (
    readFileSync(join(installedPackage, "LICENSE"), "utf8") !==
    readFileSync("LICENSE", "utf8")
  ) {
    throw new Error(
      "Packed LICENSE did not come from the repository authority",
    );
  }
  for (const name of ["reins.js", "reins-daemon.js"] as const) {
    const path = join(installedPackage, "dist", name);
    if ((statSync(path).mode & 0o777) !== 0o755)
      throw new Error(`Packed executable mode is not 0755: ${name}`);
  }

  // SDK 与额外厂商运行时：从已安装发行包上下文按正常模块解析定位，不假设 npm
  // 扁平布局；记录实际版本与运行时文件摘要（该下载不在包锁冻结范围）。
  const sdk = locateInstalledSdk(installedPackage);
  if (sdk.runtimeEntrypointBytes < 10 * 1024 * 1024) {
    throw new Error("Qoder postinstall did not provision its worker runtime");
  }
  recorder.record("installed_sdk_identity", sdk);

  const maps = filesRecursively(join(installedPackage, "dist")).filter((path) =>
    path.endsWith(".js.map"),
  );
  if (maps.length === 0)
    throw new Error("Packed distribution omitted source maps");
  for (const path of maps) {
    const sourceMap: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(sourceMap)) throw new Error(`Invalid source map: ${path}`);
    const sources = sourceMap.sources;
    const sourcesContent = sourceMap.sourcesContent;
    if (
      !Array.isArray(sources) ||
      !Array.isArray(sourcesContent) ||
      sources.length === 0 ||
      sourcesContent.length !== sources.length ||
      !sourcesContent.every((content) => typeof content === "string")
    ) {
      throw new Error(`Packed source map omitted sourcesContent: ${path}`);
    }
  }

  const helpLog = join(logsDirectory, "cli-help.log");
  const help = toCommandResult(
    await runLoggedCommand({
      command: cli,
      args: ["--help"],
      logPath: helpLog,
    }),
  );
  assertOutput("packed help", help, { status: 0, stderr: "" }, helpLog);
  if (
    !help.stdout.includes("Usage: reins [options] <command>") ||
    !help.stdout.includes(
      "spawn <harness> <message...> --name <session-name> [options]",
    )
  )
    throw new Error("Packed help omitted canonical command usage");

  const versionLog = join(logsDirectory, "cli-version.log");
  const version = toCommandResult(
    await runLoggedCommand({
      command: cli,
      args: ["--version"],
      logPath: versionLog,
    }),
  );
  assertOutput(
    "packed version",
    version,
    { status: 0, stderr: "" },
    versionLog,
  );
  if (version.stdout !== `${releaseIdentity.version}\n`) {
    throw new Error(`Packed version diverged: ${version.stdout}`);
  }

  const usageLog = join(logsDirectory, "cli-usage-error.log");
  const usage = toCommandResult(
    await runLoggedCommand({
      command: cli,
      args: ["resolve-permission", "test@g2"],
      logPath: usageLog,
    }),
  );
  assertOutput(
    "packed usage error",
    usage,
    { status: 64, stderr: "" },
    usageLog,
  );
  const usageError: unknown = JSON.parse(usage.stdout);
  if (
    !isRecord(usageError) ||
    usageError.code !== "usage_error" ||
    !Array.isArray(usageError.issues) ||
    usageError.issues.length !== 2 ||
    usageError.usage !==
      "reins resolve-permission <sessionId> <permissionId> --outcome <allow|deny> [options]"
  )
    throw new Error(`Packed usage error was incomplete: ${usage.stdout}`);

  // adapter 素材：受正式接口类型约束的注册表模块，复制给 daemon 的现有注册表接缝；
  // 只有 type-only 输入，type import 由 Node 24 类型擦除，运行期不解析 workspace 包。
  const adaptersModule = join(runtimeDirectory, "adapter-fixture.ts");
  copyFileSync(adapterFixtureSource, adaptersModule);

  const directDirectory = join(runtimeDirectory, "direct");
  mkdirSync(directDirectory);
  const directSocket = join(directDirectory, "reins.sock");
  const directEnv: NodeJS.ProcessEnv = {
    ...process.env,
    REINS_SOCKET: directSocket,
    REINS_STATE_DIR: join(directDirectory, "state"),
    REINS_ADAPTERS_MODULE: adaptersModule,
    REINS_CONSUMER_CONTEXT: "packed-cli-check",
    REINS_IDLE_TIMEOUT_MS: "10000",
  };
  owned.directDaemon = await startDaemon({
    label: "direct packed daemon",
    executable: daemon,
    args: [],
    env: directEnv,
    socketPath: directSocket,
    logPath: join(logsDirectory, "direct-daemon.log"),
    readyTimeoutMs: 5_000,
  });

  const directListLog = join(logsDirectory, "direct-list.log");
  const directList = toCommandResult(
    await runLoggedCommand({
      command: cli,
      args: ["list"],
      env: directEnv,
      logPath: directListLog,
    }),
  );
  assertOutput(
    "direct packed daemon list",
    directList,
    { status: 0, stderr: "" },
    directListLog,
  );
  if (directList.stdout !== "[]\n")
    throw new Error(
      `Packed daemon returned unexpected output: ${directList.stdout}`,
    );

  const capabilitiesLog = join(logsDirectory, "direct-capabilities.log");
  const capabilities = toCommandResult(
    await runLoggedCommand({
      command: cli,
      args: ["capabilities"],
      env: directEnv,
      logPath: capabilitiesLog,
    }),
  );
  assertOutput(
    "direct packed daemon capabilities",
    capabilities,
    { status: 0, stderr: "" },
    capabilitiesLog,
  );
  // 本入口的能力目录由场景作者明确创作（完整 worker 回合归 S2b2）。
  const expectedCapabilities = {
    capabilities: [
      {
        harness: "fixture",
        models: [
          {
            id: "fixture-model",
            displayName: "Fixture model",
            reasoningEfforts: ["low", "high"],
          },
        ],
      },
    ],
    failures: [],
  };
  if (
    JSON.stringify(JSON.parse(capabilities.stdout) as unknown) !==
    JSON.stringify(expectedCapabilities)
  ) {
    throw new Error(
      `Packed capabilities were unexpected: ${capabilities.stdout}`,
    );
  }
  recorder.record("registry_capabilities", {
    stdout: JSON.parse(capabilities.stdout) as unknown,
  });

  const directHandle = owned.directDaemon;
  const directStop = await stopDaemon(directHandle, 5_000);
  owned.directDaemon = undefined;
  recorder.record("direct_daemon_stop", directStop);
  if (!isCleanStop(directStop)) {
    throw new Error(
      `Direct daemon did not stop cleanly: ${JSON.stringify(directStop)} (log: ${directHandle.logPath})`,
    );
  }
  await waitForPathRemoval(directSocket, 5_000);
  await waitForPathRemoval(`${directSocket}.lock`, 5_000);

  const automaticDirectory = join(runtimeDirectory, "automatic");
  mkdirSync(automaticDirectory);
  const automaticSocket = join(automaticDirectory, "reins.sock");
  const automaticEnv: NodeJS.ProcessEnv = {
    ...process.env,
    REINS_SOCKET: automaticSocket,
    REINS_STATE_DIR: join(automaticDirectory, "state"),
    REINS_ADAPTERS_MODULE: adaptersModule,
    REINS_CONSUMER_CONTEXT: "packed-cli-check",
    REINS_IDLE_TIMEOUT_MS: "50",
  };
  delete automaticEnv.REINS_DAEMON_BIN;
  const automaticListLog = join(logsDirectory, "automatic-list.log");
  const automaticList = toCommandResult(
    await runLoggedCommand({
      command: cli,
      args: ["list"],
      env: automaticEnv,
      logPath: automaticListLog,
    }),
  );
  assertOutput(
    "sibling packed daemon list",
    automaticList,
    { status: 0, stderr: "" },
    automaticListLog,
  );
  if (automaticList.stdout !== "[]\n") {
    throw new Error(
      `Sibling daemon returned unexpected output: ${automaticList.stdout}`,
    );
  }
  await waitForPathRemoval(automaticSocket, 5_000);
  await waitForPathRemoval(`${automaticSocket}.lock`, 5_000);
  recorder.record("automatic_daemon_exit", {
    socketRemoved: true,
    logPath: automaticListLog,
  });

  const invalidAdaptersModule = join(temporaryRoot, "invalid-adapters.mjs");
  writeFileSync(invalidAdaptersModule, "export default null;\n");
  const mappedFailureLog = join(logsDirectory, "daemon-mapped-failure.log");
  const mappedFailure = toCommandResult(
    await runLoggedCommand({
      command: daemon,
      args: ["--adapters", invalidAdaptersModule],
      env: {
        ...process.env,
        NODE_OPTIONS:
          `${process.env.NODE_OPTIONS ?? ""} --enable-source-maps`.trim(),
        REINS_SOCKET: join(runtimeDirectory, "mapped-error.sock"),
        REINS_STATE_DIR: join(runtimeDirectory, "mapped-error-state"),
      },
      logPath: mappedFailureLog,
    }),
  );
  if (
    mappedFailure.status === 0 ||
    !mappedFailure.stderr.includes("packages/daemon/src/main.ts:")
  ) {
    throw new Error(
      `Packed source map did not map the daemon stack\n${mappedFailure.stdout}${mappedFailure.stderr}\nFull log: ${mappedFailureLog}`,
    );
  }
  recorder.record("mapped_failure_exit", {
    status: mappedFailure.status,
    logPath: mappedFailureLog,
  });

  recorder.record("smoke_result", { status: "passed" });
}

function recordCleanupFailure(
  failures: string[],
  label: string,
  error: unknown,
): void {
  failures.push(`${label} failed: ${String(error)}`);
}

// 收尾：先兜底停止本次启动的进程，再回收临时安装/runtime；每个清理动作的失败都
// 保留为原始事实并以非零退出报告，不由 finally 吞掉，也不把失败改成通过。
async function main(): Promise<void> {
  const evidenceDirectory =
    process.env.REINS_SMOKE_EVIDENCE_DIR ??
    join(process.cwd(), ".artifacts", "packed-cli-smoke");
  mkdirSync(evidenceDirectory, { recursive: true });
  const recorder = createFactRecorder(
    join(evidenceDirectory, "npm-smoke-facts.ndjson"),
  );
  const owned: OwnedResources = {
    temporaryRoot: undefined,
    runtimeRoot: undefined,
    directDaemon: undefined,
  };
  const cleanupFailures: string[] = [];
  let primaryFailure: { readonly message: string } | undefined;
  try {
    await smokePackedCli(evidenceDirectory, recorder, owned);
  } catch (error) {
    primaryFailure =
      error instanceof Error
        ? { message: error.message }
        : { message: `smoke threw a non-Error value (typeof ${typeof error})` };
  } finally {
    const handle = owned.directDaemon;
    if (handle !== undefined) {
      try {
        const fact = await stopDaemon(handle, 5_000);
        // 无条件保存原始停止事实：无论主失败是否已发生、判定干净与否，真实
        // exit/信号/超时都是必须留证的产品生命周期事实，不能被 finally 丢弃。
        recorder.record("daemon_fallback_cleanup_stop", fact);
        if (!isCleanStop(fact)) {
          cleanupFailures.push(
            `daemon fallback cleanup left facts: ${JSON.stringify(fact)} (log: ${handle.logPath})`,
          );
        }
      } catch (error) {
        cleanupFailures.push(
          `daemon fallback cleanup failed: ${String(error)} (log: ${handle.logPath})`,
        );
      }
    }
    for (const directory of [owned.runtimeRoot, owned.temporaryRoot]) {
      if (directory === undefined) continue;
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch (error) {
        recordCleanupFailure(
          cleanupFailures,
          "temporary directory removal",
          error,
        );
      }
    }
  }
  // 留证写入失败同样是独立事实，不能被业务通过掩盖。
  cleanupFailures.push(...recorder.failures);
  if (primaryFailure !== undefined) {
    process.stderr.write(
      `Packed CLI smoke failed: ${primaryFailure.message}\nEvidence kept: ${evidenceDirectory}\n`,
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
      `Packed CLI smoke business checks passed but cleanup failed; not reported as success. Evidence kept: ${evidenceDirectory}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write("Packed CLI smoke passed\n");
}

await main();
