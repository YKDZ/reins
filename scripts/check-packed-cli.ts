// 正式发行包的 npm 干净安装 smoke：安装兼容性与既有业务场景断言留在本入口，
// 环境准备之外的一切进程生命周期（启动、就绪、超时、停止、完整日志）走
// scripts/packed-cli-fixtures 的窄共享接缝，供后续 Docker 正式包 smoke 复用。
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  startUnixAcknowledgementProxy,
  startUnixConnectionProxy,
  type UnixAcknowledgementProxy,
  type UnixConnectionProxy,
} from "./packed-cli-fixtures/ack-proxy.ts";
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
  observe,
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
  resolveReleaseSdkDependencies,
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
  acknowledgementProxy: UnixAcknowledgementProxy | undefined;
  connectionProxy: UnixConnectionProxy | undefined;
  releaseGates: string[];
};

const adapterFixtureSource = fileURLToPath(
  new URL("./packed-cli-fixtures/adapter-fixture.ts", import.meta.url),
);
const adapterWorkerSource = fileURLToPath(
  new URL("./packed-cli-fixtures/adapter-worker.ts", import.meta.url),
);
const sdkQuerySource = fileURLToPath(
  new URL("./packed-cli-fixtures/sdk-query.ts", import.meta.url),
);
const sdkRecoverableControlSource = fileURLToPath(
  new URL("./packed-cli-fixtures/sdk-recoverable-control.ts", import.meta.url),
);
const applicationQuerySource = fileURLToPath(
  new URL("./packed-cli-fixtures/application-query.ts", import.meta.url),
);
const simulatedAdapterSource = fileURLToPath(
  new URL("./packed-cli-fixtures/simulated-adapter.ts", import.meta.url),
);
const seedKilledSessionSource = fileURLToPath(
  new URL(
    "../apps/cli/test/e2e/fixtures/seed-killed-session.ts",
    import.meta.url,
  ),
);
const sdkKilledListSource = fileURLToPath(
  new URL("./packed-cli-fixtures/sdk-killed-list.ts", import.meta.url),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readManifest(directory: string): Record<string, unknown> {
  return readJsonObject(join(directory, "package.json"));
}

function readDataEnvelope(
  label: string,
  stdout: string,
  command: string,
): Record<string, unknown> {
  const envelope: unknown = JSON.parse(stdout);
  if (
    !isRecord(envelope) ||
    envelope.kind !== "data" ||
    envelope.command !== command ||
    envelope.variant !== "result" ||
    !isRecord(envelope.data)
  ) {
    throw new Error(
      `${label} did not return the cli-contract data envelope: ${stdout}`,
    );
  }
  return envelope.data;
}

function readJsonRecord(
  label: string,
  stdout: string,
): Record<string, unknown> {
  const value: unknown = JSON.parse(stdout);
  if (!isRecord(value))
    throw new Error(`${label} did not return a JSON object`);
  return value;
}

function readJsonLineRecords(
  label: string,
  stdout: string,
): Record<string, unknown>[] {
  const lines = stdout.trim().split("\n").filter(Boolean);
  if (lines.length === 0)
    throw new Error(`${label} returned no stream records`);
  return lines.map((line) => {
    const value: unknown = JSON.parse(line);
    if (!isRecord(value))
      throw new Error(`${label} returned a non-object record`);
    return value;
  });
}

function canonicalJson(value: unknown): string {
  const normalize = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(normalize);
    if (!isRecord(current)) return current;
    return Object.fromEntries(
      Object.keys(current)
        .sort()
        .map((key) => [key, normalize(current[key])]),
    );
  };
  return JSON.stringify(normalize(value));
}

function readJsonLines(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value)) throw new Error(`Invalid JSON record in ${path}`);
      return value;
    });
}

function assertProcessStopped(label: string, pid: number): void {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (isRecord(error) && error.code === "ESRCH") return;
    throw error;
  }
  throw new Error(`${label} is still running: ${pid}`);
}

function assertProcessRunning(label: string, pid: number): void {
  try {
    process.kill(pid, 0);
  } catch (error) {
    throw new Error(`${label} is not running: ${pid} (${String(error)})`);
  }
}

async function waitForFact(
  label: string,
  read: () => Record<string, unknown>[],
  matches: (fact: Record<string, unknown>) => boolean,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const fact = read().find(matches);
    if (fact !== undefined) return fact;
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForObservedExit(
  label: string,
  observed: ReturnType<typeof observe>,
  timeoutMs: number,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      observed.completion,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function readFailureEnvelope(
  label: string,
  result: CommandResult,
  command: string,
  variant: string,
): Record<string, unknown> {
  const lines = `${result.stdout}${result.stderr}`.split("\n").filter(Boolean);
  if (lines.length !== 1) {
    throw new Error(`${label} did not return one failure envelope`);
  }
  const envelope: unknown = JSON.parse(lines[0]!);
  if (
    !isRecord(envelope) ||
    envelope.kind !== "failure" ||
    envelope.command !== command ||
    envelope.variant !== variant ||
    !isRecord(envelope.data)
  ) {
    throw new Error(`${label} did not return a typed cli-contract failure`);
  }
  return envelope.data;
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
  const expectedSdkDependencies = resolveReleaseSdkDependencies(repository);

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
  const sdkTarballName = releaseTarballName(
    "@ykdz/reins-sdk",
    releaseIdentity.version,
  );
  const sdkTarball = join(artifactDirectory, sdkTarballName);

  mkdirSync(installDirectory);
  // 证据目录由调用方指定且可能被复用：日志目录按幂等方式准备。
  mkdirSync(logsDirectory, { recursive: true });

  const artifacts = readdirSync(artifactDirectory).sort();
  const expectedArtifacts = ["SHA256SUMS", sdkTarballName, tarballName].sort();
  if (JSON.stringify(artifacts) !== JSON.stringify(expectedArtifacts)) {
    throw new Error(`Unexpected release artifact set: ${artifacts.join(", ")}`);
  }
  const runtimeDigest = createHash("sha256")
    .update(readFileSync(tarball))
    .digest("hex");
  const sdkDigest = createHash("sha256")
    .update(readFileSync(sdkTarball))
    .digest("hex");
  const expectedDigest =
    [`${runtimeDigest}  ${tarballName}`, `${sdkDigest}  ${sdkTarballName}`]
      .sort()
      .join("\n") + "\n";
  if (
    readFileSync(join(artifactDirectory, "SHA256SUMS"), "utf8") !==
    expectedDigest
  )
    throw new Error("SHA256SUMS does not match the release tarball");

  // npm 会预取 runtime 声明的 SDK registry 版本；引用命令中的直接 SDK spec，使验收 consumer 复用本地候选。
  writeFileSync(
    join(installDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "reins-packed-cli-smoke",
        version: "0.0.0",
        private: true,
        allowScripts: { "@qodercn-ai/qodercn-agent-sdk": true },
        overrides: { "@ykdz/reins-sdk": "$@ykdz/reins-sdk" },
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
        sdkTarball,
      ],
      cwd: installDirectory,
      logPath: installLog,
      timeoutMs: 300_000,
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
  const runtimeExports = installedManifest.exports;
  const applicationExport = isRecord(runtimeExports)
    ? runtimeExports["./application"]
    : undefined;
  if (
    installedManifest.name !== releaseIdentity.name ||
    installedManifest.version !== releaseIdentity.version ||
    installedManifest.license !== "MIT" ||
    JSON.stringify(installedManifest.dependencies) !==
      JSON.stringify(expectedRuntimeDependencies) ||
    JSON.stringify(installedManifest.os) !== JSON.stringify(["linux"]) ||
    JSON.stringify(installedManifest.cpu) !== JSON.stringify(["x64"]) ||
    !isRecord(applicationExport) ||
    applicationExport.types !== "./dist/application.d.ts" ||
    applicationExport.default !== "./dist/application.js" ||
    Object.keys(runtimeExports as Record<string, unknown>).length !== 1 ||
    "private" in installedManifest ||
    "imports" in installedManifest
  ) {
    throw new Error("Installed manifest diverged from the release authority");
  }
  const installedSdkPackage = join(
    installDirectory,
    "node_modules",
    "@ykdz",
    "reins-sdk",
  );
  const installedSdkManifest = readManifest(installedSdkPackage);
  const sdkExports = installedSdkManifest.exports;
  const sdkEntry = isRecord(sdkExports) ? sdkExports["."] : undefined;
  if (
    installedSdkManifest.name !== "@ykdz/reins-sdk" ||
    installedSdkManifest.version !== releaseIdentity.version ||
    installedSdkManifest.types !== "./dist/index.d.ts" ||
    !isRecord(installedSdkManifest.dependencies) ||
    JSON.stringify(installedSdkManifest.dependencies) !==
      JSON.stringify(expectedSdkDependencies) ||
    !isRecord(sdkEntry) ||
    sdkEntry.types !== "./dist/index.d.ts" ||
    sdkEntry.default !== "./dist/index.js" ||
    Object.keys(sdkExports as Record<string, unknown>).length !== 1 ||
    "private" in installedSdkManifest ||
    "imports" in installedSdkManifest ||
    "os" in installedSdkManifest ||
    "cpu" in installedSdkManifest ||
    "@ykdz/reins" in
      (installedSdkManifest.dependencies as Record<string, unknown>) ||
    Object.keys(installedSdkManifest.dependencies).some((name) =>
      name.startsWith("@reins/"),
    )
  ) {
    throw new Error(
      "Installed SDK manifest diverged from its public release contract",
    );
  }
  const sdkDistribution = join(installedSdkPackage, "dist");
  const sdkFiles = filesRecursively(sdkDistribution);
  const declarations = sdkFiles.filter((path) => path.endsWith(".d.ts"));
  const javascript = sdkFiles.filter((path) => path.endsWith(".js"));
  if (
    declarations.length === 0 ||
    javascript.length === 0 ||
    declarations.some((path) =>
      /from ["'](?:@reins\/|@ykdz\/reins(?:\/|["']))/u.test(
        readFileSync(path, "utf8"),
      ),
    ) ||
    javascript.some((path) =>
      /from ["'](?:@reins\/|@ykdz\/reins(?:\/|["']))/u.test(
        readFileSync(path, "utf8"),
      ),
    )
  ) {
    throw new Error(
      "SDK distribution exposed a private import or omitted its API",
    );
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
  if (
    !isRecord(installedManifest.bin) ||
    JSON.stringify(Object.keys(installedManifest.bin).sort()) !==
      JSON.stringify(["reins", "reins-daemon"])
  ) {
    throw new Error("Packed runtime CLI bins do not match the public contract");
  }
  const applicationDistribution = join(installedPackage, "dist");
  for (const name of ["application.js", "application.d.ts"] as const) {
    if (!existsSync(join(applicationDistribution, name))) {
      throw new Error(`Packed application export omitted ${name}`);
    }
  }
  const applicationFiles = [
    "application.js",
    "application.d.ts",
    "application-contracts.d.ts",
  ];
  for (const name of applicationFiles) {
    const path = join(applicationDistribution, name);
    if (!existsSync(path)) {
      throw new Error(`Packed application export omitted ${name}`);
    }
    const source = readFileSync(path, "utf8");
    if (/from ["']@reins\//u.test(source)) {
      throw new Error(`Application export leaked a private import: ${name}`);
    }
    if (name.endsWith(".d.ts") && source.includes("application-runtime")) {
      throw new Error(`Application declaration leaked private runtime types`);
    }
  }

  // SDK 与额外厂商运行时：从已安装发行包上下文按正常模块解析定位，不假设 npm
  // 扁平布局；记录实际版本与运行时文件摘要（该下载不在包锁冻结范围）。
  const sdkConsumerDirectory = join(temporaryRoot, "sdk-only-consumer");
  const sdkCandidateDirectory = join(sdkConsumerDirectory, "candidate");
  mkdirSync(sdkCandidateDirectory, { recursive: true });
  const sdkCandidate = join(sdkCandidateDirectory, sdkTarballName);
  copyFileSync(sdkTarball, sdkCandidate);
  if (
    createHash("sha256").update(readFileSync(sdkCandidate)).digest("hex") !==
    sdkDigest
  ) {
    throw new Error(
      "SDK-only consumer candidate differs from the release tarball",
    );
  }
  writeFileSync(
    join(sdkConsumerDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "reins-sdk-only-consumer",
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies: {
          "@ykdz/reins-sdk": `file:candidate/${sdkTarballName}`,
        },
      },
      null,
      2,
    )}\n`,
  );
  const sdkQueryFixture = join(sdkConsumerDirectory, "sdk-query.ts");
  copyFileSync(sdkQuerySource, sdkQueryFixture);
  const sdkRecoverableControlFixture = join(
    sdkConsumerDirectory,
    "sdk-recoverable-control.ts",
  );
  copyFileSync(sdkRecoverableControlSource, sdkRecoverableControlFixture);

  const sdkLockGenerationLog = join(
    logsDirectory,
    "sdk-only-lock-generation.log",
  );
  const sdkLockGeneration = toCommandResult(
    await runLoggedCommand({
      command: "pnpm",
      args: ["install", "--lockfile-only"],
      cwd: sdkConsumerDirectory,
      logPath: sdkLockGenerationLog,
      timeoutMs: 120_000,
    }),
  );
  requireSuccess(
    "SDK-only consumer lock generation",
    sdkLockGeneration,
    sdkLockGenerationLog,
  );
  const sdkLockPath = join(sdkConsumerDirectory, "pnpm-lock.yaml");
  const sdkLockDigest = createHash("sha256")
    .update(readFileSync(sdkLockPath))
    .digest("hex");
  recorder.record("sdk_only_consumer_lock", {
    digest: sdkLockDigest,
    package: "@ykdz/reins-sdk",
    version: releaseIdentity.version,
    tarballSha256: sdkDigest,
  });

  const sdkInstallLog = join(logsDirectory, "sdk-only-frozen-install.log");
  const sdkInstall = toCommandResult(
    await runLoggedCommand({
      command: "pnpm",
      args: ["install", "--frozen-lockfile"],
      cwd: sdkConsumerDirectory,
      logPath: sdkInstallLog,
      timeoutMs: 120_000,
    }),
  );
  requireSuccess("SDK-only frozen install", sdkInstall, sdkInstallLog);
  if (
    createHash("sha256").update(readFileSync(sdkLockPath)).digest("hex") !==
    sdkLockDigest
  ) {
    throw new Error("Frozen SDK-only install rewrote its consumer lock");
  }
  const consumerEvidenceDirectory = join(evidenceDirectory, "consumers");
  mkdirSync(consumerEvidenceDirectory, { recursive: true });
  copyFileSync(
    join(sdkConsumerDirectory, "package.json"),
    join(consumerEvidenceDirectory, "sdk-only-package.json"),
  );
  copyFileSync(
    sdkLockPath,
    join(consumerEvidenceDirectory, "sdk-only-pnpm-lock.yaml"),
  );
  recorder.record("sdk_only_frozen_install", {
    exitCode: sdkInstall.status,
    logPath: sdkInstallLog,
  });

  const typecheckLog = join(logsDirectory, "sdk-only-types.log");
  const typecheck = toCommandResult(
    await runLoggedCommand({
      command: join(repository, "node_modules", ".bin", "tsc"),
      args: [
        "--ignoreConfig",
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
        sdkQueryFixture,
        sdkRecoverableControlFixture,
      ],
      cwd: sdkConsumerDirectory,
      logPath: typecheckLog,
      timeoutMs: 120_000,
    }),
  );
  requireSuccess("SDK-only installed type check", typecheck, typecheckLog);
  recorder.record("sdk_only_public_types", {
    exitCode: typecheck.status,
    logPath: typecheckLog,
    declaration: "compiled from installed SDK package",
  });

  const applicationConsumerDirectory = join(
    temporaryRoot,
    "runtime-sdk-consumer",
  );
  const applicationCandidateDirectory = join(
    applicationConsumerDirectory,
    "candidate",
  );
  mkdirSync(applicationCandidateDirectory, { recursive: true });
  const applicationRuntimeCandidate = join(
    applicationCandidateDirectory,
    tarballName,
  );
  const applicationSdkCandidate = join(
    applicationCandidateDirectory,
    sdkTarballName,
  );
  copyFileSync(tarball, applicationRuntimeCandidate);
  copyFileSync(sdkTarball, applicationSdkCandidate);
  if (
    createHash("sha256")
      .update(readFileSync(applicationRuntimeCandidate))
      .digest("hex") !== runtimeDigest ||
    createHash("sha256")
      .update(readFileSync(applicationSdkCandidate))
      .digest("hex") !== sdkDigest
  ) {
    throw new Error("Dual-package consumer candidates changed release bytes");
  }
  writeFileSync(
    join(applicationConsumerDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "reins-runtime-sdk-consumer",
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies: {
          "@ykdz/reins": `file:candidate/${tarballName}`,
          "@ykdz/reins-sdk": `file:candidate/${sdkTarballName}`,
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(applicationConsumerDirectory, "pnpm-workspace.yaml"),
    `packages: []\nallowBuilds:\n  "@qodercn-ai/qodercn-agent-sdk": true\noverrides:\n  "@ykdz/reins-sdk": "file:candidate/${sdkTarballName}"\n`,
  );
  const applicationQueryFixture = join(
    applicationConsumerDirectory,
    "application-query.ts",
  );
  copyFileSync(applicationQuerySource, applicationQueryFixture);
  const sdkKilledListFixture = join(
    applicationConsumerDirectory,
    "sdk-killed-list.ts",
  );
  copyFileSync(sdkKilledListSource, sdkKilledListFixture);

  const applicationLockGenerationLog = join(
    logsDirectory,
    "runtime-sdk-lock-generation.log",
  );
  const applicationLockGeneration = toCommandResult(
    await runLoggedCommand({
      command: "pnpm",
      args: ["install", "--lockfile-only"],
      cwd: applicationConsumerDirectory,
      logPath: applicationLockGenerationLog,
      timeoutMs: 120_000,
    }),
  );
  requireSuccess(
    "runtime and SDK consumer lock generation",
    applicationLockGeneration,
    applicationLockGenerationLog,
  );
  const applicationLockPath = join(
    applicationConsumerDirectory,
    "pnpm-lock.yaml",
  );
  const applicationLockDigest = createHash("sha256")
    .update(readFileSync(applicationLockPath))
    .digest("hex");
  recorder.record("runtime_sdk_consumer_lock", {
    digest: applicationLockDigest,
    packages: ["@ykdz/reins", "@ykdz/reins-sdk"],
    version: releaseIdentity.version,
    runtimeTarballSha256: runtimeDigest,
    sdkTarballSha256: sdkDigest,
  });

  const applicationInstallLog = join(
    logsDirectory,
    "runtime-sdk-frozen-install.log",
  );
  const applicationInstall = toCommandResult(
    await runLoggedCommand({
      command: "pnpm",
      args: ["install", "--frozen-lockfile"],
      cwd: applicationConsumerDirectory,
      logPath: applicationInstallLog,
      timeoutMs: 300_000,
    }),
  );
  requireSuccess(
    "runtime and SDK frozen install",
    applicationInstall,
    applicationInstallLog,
  );
  if (
    createHash("sha256")
      .update(readFileSync(applicationLockPath))
      .digest("hex") !== applicationLockDigest
  ) {
    throw new Error("Frozen runtime and SDK install rewrote its consumer lock");
  }
  copyFileSync(
    join(applicationConsumerDirectory, "package.json"),
    join(consumerEvidenceDirectory, "runtime-sdk-package.json"),
  );
  copyFileSync(
    join(applicationConsumerDirectory, "pnpm-workspace.yaml"),
    join(consumerEvidenceDirectory, "runtime-sdk-pnpm-workspace.yaml"),
  );
  copyFileSync(
    applicationLockPath,
    join(consumerEvidenceDirectory, "runtime-sdk-pnpm-lock.yaml"),
  );
  const consumerRuntimeManifest = readManifest(
    join(applicationConsumerDirectory, "node_modules", "@ykdz", "reins"),
  );
  const consumerSdkManifest = readManifest(
    join(applicationConsumerDirectory, "node_modules", "@ykdz", "reins-sdk"),
  );
  if (
    consumerRuntimeManifest.version !== releaseIdentity.version ||
    consumerSdkManifest.version !== releaseIdentity.version
  ) {
    throw new Error("Frozen consumer installed mismatched package versions");
  }
  recorder.record("runtime_sdk_frozen_install", {
    exitCode: applicationInstall.status,
    logPath: applicationInstallLog,
    lockDigest: applicationLockDigest,
    runtimePackage: consumerRuntimeManifest.name,
    sdkPackage: consumerSdkManifest.name,
    version: releaseIdentity.version,
  });

  const applicationTypecheckLog = join(
    logsDirectory,
    "runtime-sdk-application-types.log",
  );
  const applicationTypecheck = toCommandResult(
    await runLoggedCommand({
      command: join(repository, "node_modules", ".bin", "tsc"),
      args: [
        "--ignoreConfig",
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
        applicationQueryFixture,
        sdkKilledListFixture,
      ],
      cwd: applicationConsumerDirectory,
      logPath: applicationTypecheckLog,
      timeoutMs: 120_000,
    }),
  );
  requireSuccess(
    "installed runtime application type check",
    applicationTypecheck,
    applicationTypecheckLog,
  );
  recorder.record("runtime_application_public_types", {
    exitCode: applicationTypecheck.status,
    logPath: applicationTypecheckLog,
    import: "@ykdz/reins/application",
  });

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
    !help.stdout.includes("Usage\n  reins <command>") ||
    !help.stdout.includes("  capabilities\n") ||
    !help.stdout.includes("  prepare-operation\n") ||
    !help.stdout.includes("  spawn\n") ||
    !help.stdout.includes("  kill\n") ||
    !help.stdout.includes("  list\n") ||
    !help.stdout.includes("  attach\n")
  )
    throw new Error("Packed help omitted the control command contract");

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
  if (version.stdout !== `reins ${releaseIdentity.version}\n`) {
    throw new Error(`Packed version diverged: ${version.stdout}`);
  }

  // adapter 素材：受正式接口类型约束的注册表模块，复制给 daemon 的现有注册表接缝；
  // 只有 type-only 输入，type import 由 Node 24 类型擦除，运行期不解析 workspace 包。
  const adaptersModule = join(runtimeDirectory, "adapter-fixture.ts");
  copyFileSync(adapterFixtureSource, adaptersModule);
  copyFileSync(
    adapterWorkerSource,
    join(runtimeDirectory, "adapter-worker.ts"),
  );

  const directDirectory = join(runtimeDirectory, "direct");
  mkdirSync(directDirectory);
  const workerDirectory = join(directDirectory, "workspace");
  mkdirSync(workerDirectory);
  const directSocket = join(directDirectory, "reins.sock");
  const adapterObservations = join(
    directDirectory,
    "adapter-observations.ndjson",
  );
  const workerActivity = join(directDirectory, "worker-activity.ndjson");
  const capabilityMode = join(directDirectory, "capability-mode.txt");
  const terminateGate = join(directDirectory, "terminate.release");
  writeFileSync(capabilityMode, "with-model", "utf8");
  writeFileSync(terminateGate, "released", "utf8");
  owned.releaseGates.push(terminateGate);
  const directEnv: NodeJS.ProcessEnv = {
    ...process.env,
    REINS_SOCKET: directSocket,
    REINS_STATE_DIR: join(directDirectory, "state"),
    REINS_ADAPTERS_MODULE: adaptersModule,
    REINS_CONSUMER_CONTEXT: "packed-cli-check",
    REINS_IDLE_TIMEOUT_MS: "10000",
    REINS_PACKED_FIXTURE_OBSERVATIONS: adapterObservations,
    REINS_PACKED_FIXTURE_ACTIVITY: workerActivity,
    REINS_PACKED_FIXTURE_CAPABILITY_MODE: capabilityMode,
    REINS_PACKED_FIXTURE_TERMINATE_GATE: terminateGate,
    REINS_PACKED_FIXTURE_FAIL_FIRST_TERMINATE: "1",
    REINS_WORKER_CWD: workerDirectory,
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
  const listData = readDataEnvelope("packed list", directList.stdout, "list");
  if (JSON.stringify(listData) !== JSON.stringify({ sessions: [] }))
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
  const capabilitiesData = readDataEnvelope(
    "packed capabilities",
    capabilities.stdout,
    "capabilities",
  );
  if (
    JSON.stringify(capabilitiesData) !== JSON.stringify(expectedCapabilities)
  ) {
    throw new Error(
      `Packed capabilities were unexpected: ${capabilities.stdout}`,
    );
  }
  recorder.record("registry_capabilities", {
    stdout: capabilitiesData,
  });

  const sdkQueryLog = join(logsDirectory, "sdk-only-query.log");
  const sdkQuery = toCommandResult(
    await runLoggedCommand({
      command: process.execPath,
      args: ["--experimental-strip-types", sdkQueryFixture],
      cwd: sdkConsumerDirectory,
      env: directEnv,
      logPath: sdkQueryLog,
    }),
  );
  requireSuccess(
    "installed SDK query against the packed daemon",
    sdkQuery,
    sdkQueryLog,
  );
  recorder.record("sdk_only_query", {
    exitCode: sdkQuery.status,
    logPath: sdkQueryLog,
    socketPath: directSocket,
  });

  const runSdkControl = async (
    mode: string,
    label: string,
    extraEnv: NodeJS.ProcessEnv = {},
  ): Promise<Record<string, unknown>> => {
    const logPath = join(logsDirectory, `${label}.log`);
    const result = toCommandResult(
      await runLoggedCommand({
        command: process.execPath,
        args: [
          "--experimental-strip-types",
          sdkRecoverableControlFixture,
          mode,
        ],
        cwd: sdkConsumerDirectory,
        env: { ...directEnv, ...extraEnv },
        logPath,
        timeoutMs: 30_000,
      }),
    );
    requireSuccess(label, result, logPath);
    return readJsonRecord(label, result.stdout);
  };

  const spawnIntentPath = join(directDirectory, "accepted-spawn.json");
  const preparedSpawn = await runSdkControl(
    "prepare-spawn",
    "sdk-prepare-spawn",
  );
  if (
    preparedSpawn.prepared !== true ||
    preparedSpawn.serialized !== true ||
    preparedSpawn.sessionCount !== 0 ||
    typeof preparedSpawn.daemonGeneration !== "string" ||
    typeof preparedSpawn.intent !== "string"
  )
    throw new Error(
      "The installed SDK did not expose a serializable pre-spawn intent",
    );
  writeFileSync(spawnIntentPath, preparedSpawn.intent, "utf8");
  const persistedSpawnIntent = readFileSync(spawnIntentPath, "utf8");
  const spawnValidation = await runSdkControl(
    "spawn-validation",
    "sdk-spawn-validation",
  );
  if (
    JSON.stringify(spawnValidation.codes) !==
    JSON.stringify([
      "invalid_params",
      "invalid_params",
      "unsupported_feature",
      "unknown_harness",
    ])
  )
    throw new Error("The SDK and daemon did not reject invalid spawn inputs");
  if (
    readJsonLines(adapterObservations).some(
      ({ type }) => type === "worker_started",
    )
  )
    throw new Error("Rejected SDK spawn inputs started a native worker");

  const spawnProxyPath = join(directDirectory, "spawn-ack-proxy.sock");
  owned.acknowledgementProxy = await startUnixAcknowledgementProxy({
    socketPath: spawnProxyPath,
    targetPath: directSocket,
    method: "spawn",
  });
  const spawnUnknown = await runSdkControl("spawn-drop", "sdk-spawn-drop-ack", {
    REINS_SOCKET: owned.acknowledgementProxy.socketPath,
    REINS_OPERATION_INTENT_JSON: persistedSpawnIntent,
  });
  const spawnAcknowledgement =
    await owned.acknowledgementProxy.waitForDroppedAcknowledgement();
  await owned.acknowledgementProxy.close();
  owned.acknowledgementProxy = undefined;
  if (
    spawnUnknown.code !== "command_outcome_unknown" ||
    spawnUnknown.stage !== "operation" ||
    spawnAcknowledgement.method !== "spawn" ||
    !isRecord(spawnAcknowledgement.result) ||
    typeof spawnAcknowledgement.result.sessionId !== "string" ||
    typeof spawnAcknowledgement.result.turnId !== "string"
  )
    throw new Error("The SDK spawn response-loss scenario missed its real ACK");

  const capabilityQueriesBeforeRecovery = readJsonLines(
    adapterObservations,
  ).filter(({ type }) => type === "capabilities_queried").length;
  writeFileSync(capabilityMode, "without-model", "utf8");
  const recoveredSpawn = await runSdkControl(
    "spawn-recover",
    "sdk-spawn-recover",
    { REINS_OPERATION_INTENT_JSON: persistedSpawnIntent },
  );
  const recoveredSpawnResult = recoveredSpawn.result;
  if (
    !isRecord(recoveredSpawnResult) ||
    recoveredSpawnResult.sessionHandle !==
      spawnAcknowledgement.result.sessionId ||
    recoveredSpawnResult.cwd !== workerDirectory ||
    typeof recoveredSpawnResult.turnHandle !== "string" ||
    !recoveredSpawnResult.turnHandle.startsWith(
      `${spawnAcknowledgement.result.sessionId}/${spawnAcknowledgement.result.turnId}.`,
    )
  )
    throw new Error("The SDK did not project the exact daemon spawn ACK");
  const capabilityQueriesAfterRecovery = readJsonLines(
    adapterObservations,
  ).filter(({ type }) => type === "capabilities_queried").length;
  if (capabilityQueriesAfterRecovery !== capabilityQueriesBeforeRecovery)
    throw new Error(
      "Recovering an accepted spawn rechecked dynamic capabilities",
    );
  const newCredentialSpawn = await runSdkControl(
    "spawn-new-credential",
    "sdk-spawn-new-credential-capability-check",
    { REINS_OPERATION_INTENT_JSON: persistedSpawnIntent },
  );
  if (
    newCredentialSpawn.code !== "invalid_params" ||
    newCredentialSpawn.path !== "model"
  )
    throw new Error(
      "A new spawn credential did not revalidate changed capabilities",
    );
  const capabilityQueriesAfterNewCredential = readJsonLines(
    adapterObservations,
  ).filter(({ type }) => type === "capabilities_queried").length;
  if (
    capabilityQueriesAfterNewCredential !==
    capabilityQueriesAfterRecovery + 1
  )
    throw new Error("A new spawn credential skipped capability validation");
  const workerStarted = await waitForFact(
    "the real fixture worker",
    () => readJsonLines(adapterObservations),
    (fact) => fact.type === "worker_started",
  );
  const workerReady = await waitForFact(
    "the real fixture descendant",
    () => readJsonLines(adapterObservations),
    (fact) => fact.type === "worker_ready",
  );
  if (
    !isRecord(workerStarted.spec) ||
    typeof workerReady.workerPid !== "number" ||
    typeof workerReady.descendantPid !== "number" ||
    workerReady.workerCwd !== workerDirectory
  )
    throw new Error("The real worker fixture omitted its process observations");
  const actualSpec = workerStarted.spec;
  const expectedSpecKeys = [
    "agent",
    "authorizationMode",
    "cwd",
    "harness",
    "message",
    "model",
    "reasoning",
    "sandbox",
    "sessionName",
    "sessionId",
    "turnId",
  ].sort();
  const expectedSpec = {
    agent: "fixture-agent",
    authorizationMode: "interactive",
    cwd: workerDirectory,
    harness: "fixture",
    message: "  exact task\nkeep spacing  ",
    model: "fixture-model",
    reasoning: "high",
    sandbox: "workspace-write",
    sessionName: "packed-recover",
    sessionId: spawnAcknowledgement.result.sessionId,
    turnId: spawnAcknowledgement.result.turnId,
  };
  if (
    JSON.stringify(Object.keys(actualSpec).sort()) !==
      JSON.stringify(expectedSpecKeys) ||
    Object.entries(expectedSpec).some(
      ([key, value]) => actualSpec[key] !== value,
    )
  )
    throw new Error(
      "The SDK did not preserve the original spawn input and omitted fields",
    );
  if (
    readJsonLines(adapterObservations).filter(
      ({ type }) => type === "worker_started",
    ).length !== 1
  )
    throw new Error("Recovering spawn started more than one worker");
  const spawnConflict = await runSdkControl(
    "spawn-conflict",
    "sdk-spawn-conflict",
    { REINS_OPERATION_INTENT_JSON: persistedSpawnIntent },
  );
  if (spawnConflict.code !== "command_id_conflict")
    throw new Error(
      "The SDK did not expose the daemon's changed-parameter conflict",
    );

  const sendIntentPath = join(directDirectory, "accepted-send.json");
  const deliveredBeforePrepare = readJsonLines(adapterObservations).filter(
    ({ type }) => type === "message_delivered",
  ).length;
  const preparedSend = await runSdkControl("prepare-send", "sdk-prepare-send", {
    REINS_TARGET_TURN: recoveredSpawnResult.turnHandle as string,
  });
  if (preparedSend.prepared !== true || typeof preparedSend.intent !== "string")
    throw new Error("The installed SDK did not prepare a send credential");
  writeFileSync(sendIntentPath, preparedSend.intent, "utf8");
  const persistedSendIntent = readFileSync(sendIntentPath, "utf8");
  if (
    readJsonLines(adapterObservations).filter(
      ({ type }) => type === "message_delivered",
    ).length !== deliveredBeforePrepare
  )
    throw new Error("Preparing the SDK send operation delivered a message");
  const sendProxyPath = join(directDirectory, "send-ack-proxy.sock");
  owned.acknowledgementProxy = await startUnixAcknowledgementProxy({
    socketPath: sendProxyPath,
    targetPath: directSocket,
    method: "send",
  });
  const sendUnknown = await runSdkControl("send-drop", "sdk-send-drop-ack", {
    REINS_SOCKET: owned.acknowledgementProxy.socketPath,
    REINS_OPERATION_INTENT_JSON: persistedSendIntent,
  });
  const sendAcknowledgement =
    await owned.acknowledgementProxy.waitForDroppedAcknowledgement();
  await owned.acknowledgementProxy.close();
  owned.acknowledgementProxy = undefined;
  if (
    sendUnknown.code !== "command_outcome_unknown" ||
    sendUnknown.stage !== "operation" ||
    sendAcknowledgement.method !== "send" ||
    !isRecord(sendAcknowledgement.result) ||
    sendAcknowledgement.result.sessionId !==
      spawnAcknowledgement.result.sessionId ||
    sendAcknowledgement.result.turnId !== spawnAcknowledgement.result.turnId
  )
    throw new Error("The SDK send response-loss scenario missed its real ACK");
  const recoveredSend = await runSdkControl(
    "send-recover",
    "sdk-send-recover",
    { REINS_OPERATION_INTENT_JSON: persistedSendIntent },
  );
  if (
    !isRecord(recoveredSend.result) ||
    recoveredSend.result.sessionHandle !== recoveredSpawnResult.sessionHandle ||
    recoveredSend.result.turnHandle !== recoveredSpawnResult.turnHandle ||
    recoveredSend.result.deliveryPoint !== "active_turn"
  )
    throw new Error("The SDK did not recover the exact active-turn send");
  const sendConflict = await runSdkControl(
    "send-conflict",
    "sdk-send-conflict",
    { REINS_OPERATION_INTENT_JSON: persistedSendIntent },
  );
  if (sendConflict.code !== "command_id_conflict")
    throw new Error("The SDK did not expose the changed send conflict");
  const deliveredMessages = readJsonLines(adapterObservations).filter(
    ({ type }) => type === "message_delivered",
  );
  if (
    deliveredMessages.length !== deliveredBeforePrepare + 1 ||
    deliveredMessages[0]?.sessionId !== spawnAcknowledgement.result.sessionId ||
    deliveredMessages[0]?.turnId !== spawnAcknowledgement.result.turnId ||
    deliveredMessages[0]?.message !== "  exact delivered note\nkeep spacing  "
  )
    throw new Error("Recovering the send duplicated or changed its delivery");

  const interruptIntentPath = join(directDirectory, "accepted-interrupt.json");
  const interruptedBeforePrepare = readJsonLines(adapterObservations).filter(
    ({ type }) => type === "interrupt_requested",
  ).length;
  const preparedInterrupt = await runSdkControl(
    "prepare-interrupt",
    "sdk-prepare-interrupt",
    { REINS_TARGET_TURN: recoveredSpawnResult.turnHandle as string },
  );
  if (
    preparedInterrupt.prepared !== true ||
    typeof preparedInterrupt.intent !== "string"
  )
    throw new Error(
      "The installed SDK did not prepare an interrupt credential",
    );
  writeFileSync(interruptIntentPath, preparedInterrupt.intent, "utf8");
  const persistedInterruptIntent = readFileSync(interruptIntentPath, "utf8");
  if (
    readJsonLines(adapterObservations).filter(
      ({ type }) => type === "interrupt_requested",
    ).length !== interruptedBeforePrepare
  )
    throw new Error("Preparing the SDK interrupt operation stopped the worker");
  const interruptProxyPath = join(directDirectory, "interrupt-ack-proxy.sock");
  owned.acknowledgementProxy = await startUnixAcknowledgementProxy({
    socketPath: interruptProxyPath,
    targetPath: directSocket,
    method: "interrupt",
  });
  const interruptUnknown = await runSdkControl(
    "interrupt-drop",
    "sdk-interrupt-drop-ack",
    {
      REINS_SOCKET: owned.acknowledgementProxy.socketPath,
      REINS_OPERATION_INTENT_JSON: persistedInterruptIntent,
    },
  );
  const interruptAcknowledgement =
    await owned.acknowledgementProxy.waitForDroppedAcknowledgement();
  await owned.acknowledgementProxy.close();
  owned.acknowledgementProxy = undefined;
  if (
    interruptUnknown.code !== "command_outcome_unknown" ||
    interruptUnknown.stage !== "operation" ||
    interruptAcknowledgement.method !== "interrupt" ||
    !isRecord(interruptAcknowledgement.result) ||
    interruptAcknowledgement.result.sessionId !==
      spawnAcknowledgement.result.sessionId ||
    interruptAcknowledgement.result.turnId !==
      spawnAcknowledgement.result.turnId
  )
    throw new Error(
      "The SDK interrupt response-loss scenario missed its real ACK",
    );
  const recoveredInterrupt = await runSdkControl(
    "interrupt-recover",
    "sdk-interrupt-recover",
    { REINS_OPERATION_INTENT_JSON: persistedInterruptIntent },
  );
  if (
    !isRecord(recoveredInterrupt.result) ||
    recoveredInterrupt.result.turnHandle !== recoveredSpawnResult.turnHandle ||
    recoveredInterrupt.result.status !== "accepted" ||
    !isRecord(recoveredInterrupt.observed) ||
    recoveredInterrupt.observed.status !== "timeout" ||
    !Array.isArray(recoveredInterrupt.observed.pending) ||
    recoveredInterrupt.observed.pending[0] !== recoveredSpawnResult.turnHandle
  )
    throw new Error("The SDK confused interrupt acceptance with completion");
  const interruptRequests = readJsonLines(adapterObservations).filter(
    ({ type }) => type === "interrupt_requested",
  );
  if (
    interruptRequests.length !== interruptedBeforePrepare + 1 ||
    interruptRequests[0]?.sessionId !== spawnAcknowledgement.result.sessionId ||
    interruptRequests[0]?.turnId !== spawnAcknowledgement.result.turnId
  )
    throw new Error("Recovering the interrupt repeated or changed its target");

  const killIntentPath = join(directDirectory, "accepted-kill.json");
  const preparedKill = await runSdkControl("prepare-kill", "sdk-prepare-kill", {
    REINS_TARGET_SESSION: recoveredSpawnResult.sessionHandle as string,
  });
  if (preparedKill.prepared !== true || typeof preparedKill.intent !== "string")
    throw new Error("The installed SDK did not prepare a kill credential");
  writeFileSync(killIntentPath, preparedKill.intent, "utf8");
  const persistedKillIntent = readFileSync(killIntentPath, "utf8");
  if (
    readJsonLines(adapterObservations).some(
      ({ type }) => type === "terminate_called",
    )
  )
    throw new Error("Preparing the SDK kill operation performed cleanup");
  const failedKill = await runSdkControl(
    "kill-failure-replay",
    "sdk-kill-failure-replay",
    { REINS_OPERATION_INTENT_JSON: persistedKillIntent },
  );
  if (
    !isRecord(failedKill.failure) ||
    failedKill.failure.code !== "internal_error"
  )
    throw new Error("The SDK did not retain the original cleanup failure");
  await waitForFact(
    "the failed cleanup observation",
    () => readJsonLines(adapterObservations),
    (fact) => fact.type === "terminate_rejected" && fact.attempt === 1,
  );
  const activeBeforeWait = readJsonLines(workerActivity);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const activeAfterWait = readJsonLines(workerActivity);
  if (
    activeAfterWait.filter(({ type }) => type === "heartbeat").length <=
    activeBeforeWait.filter(({ type }) => type === "heartbeat").length
  )
    throw new Error(
      "The failed cleanup did not leave its real worker tree running",
    );
  assertProcessRunning("The failed worker process", workerReady.workerPid);
  assertProcessRunning(
    "The failed descendant process",
    workerReady.descendantPid,
  );

  const preparedKillRetry = await runSdkControl(
    "prepare-kill-retry",
    "sdk-prepare-kill-retry",
    { REINS_OPERATION_INTENT_JSON: persistedKillIntent },
  );
  if (
    preparedKillRetry.prepared !== true ||
    typeof preparedKillRetry.intent !== "string"
  )
    throw new Error("A new explicit kill retry credential was not prepared");
  if (
    readJsonLines(adapterObservations).filter(
      ({ type }) => type === "terminate_called",
    ).length !== 1
  )
    throw new Error("Preparing a new kill credential repeated cleanup");
  writeFileSync(killIntentPath, preparedKillRetry.intent, "utf8");
  const persistedKillRetry = readFileSync(killIntentPath, "utf8");
  rmSync(terminateGate, { force: true });
  const killConnectionProxyPath = join(
    directDirectory,
    "kill-pending-proxy.sock",
  );
  owned.connectionProxy = await startUnixConnectionProxy({
    socketPath: killConnectionProxyPath,
    targetPath: directSocket,
  });
  const killDisconnectChild = spawn(
    process.execPath,
    ["--experimental-strip-types", sdkRecoverableControlFixture, "kill-drop"],
    {
      cwd: sdkConsumerDirectory,
      env: {
        ...directEnv,
        REINS_SOCKET: owned.connectionProxy.socketPath,
        REINS_OPERATION_INTENT_JSON: persistedKillRetry,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const killDisconnectObserved = observe(
    killDisconnectChild,
    join(logsDirectory, "sdk-kill-pending-disconnect.log"),
  );
  let killRecoveryObserved: ReturnType<typeof observe> | undefined;
  let killUnknown: Record<string, unknown> | undefined;
  try {
    await waitForFact(
      "the in-flight SDK kill cleanup",
      () => readJsonLines(adapterObservations),
      (fact) =>
        fact.type === "terminate_waiting" &&
        fact.sessionId === recoveredSpawnResult.sessionHandle &&
        fact.attempt === 2,
    );
    await owned.connectionProxy.close();
    owned.connectionProxy = undefined;
    const lostExit = await waitForObservedExit(
      "the disconnected SDK kill caller",
      killDisconnectObserved,
      10_000,
    );
    if (lostExit.exitCode !== 0)
      throw new Error(
        `The disconnected SDK kill caller exited ${lostExit.exitCode}`,
      );
    killUnknown = readJsonRecord(
      "sdk-kill-pending-disconnect",
      killDisconnectObserved.stdout().toString("utf8"),
    );
    if (
      killUnknown.code !== "command_outcome_unknown" ||
      killUnknown.operation !== "kill" ||
      killUnknown.stage !== "operation"
    )
      throw new Error("The installed SDK omitted the pending kill outcome");

    const killRecoveryChild = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        sdkRecoverableControlFixture,
        "kill-recover",
      ],
      {
        cwd: sdkConsumerDirectory,
        env: {
          ...directEnv,
          REINS_OPERATION_INTENT_JSON: persistedKillRetry,
          REINS_EXPECTED_TURN_HANDLE: recoveredSpawnResult.turnHandle as string,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    killRecoveryObserved = observe(
      killRecoveryChild,
      join(logsDirectory, "sdk-kill-join-inflight.log"),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (!killRecoveryObserved.running())
      throw new Error("The recovering SDK did not join the pending kill");
    const pendingTerminateCalls = readJsonLines(adapterObservations).filter(
      ({ sessionId, type }) =>
        sessionId === recoveredSpawnResult.sessionHandle &&
        type === "terminate_called",
    );
    if (pendingTerminateCalls.length !== 2)
      throw new Error("Joining the pending kill repeated worker cleanup");

    writeFileSync(terminateGate, "released", "utf8");
    const recoveryExit = await waitForObservedExit(
      "the SDK caller joined to the pending kill",
      killRecoveryObserved,
      10_000,
    );
    if (recoveryExit.exitCode !== 0)
      throw new Error(`The SDK kill recovery exited ${recoveryExit.exitCode}`);
  } finally {
    writeFileSync(terminateGate, "released", "utf8");
    const connectionProxy = owned.connectionProxy;
    if (connectionProxy !== undefined) {
      await connectionProxy.close();
      owned.connectionProxy = undefined;
    }
    if (killDisconnectObserved.running())
      await killDisconnectObserved.stop(2_000);
    if (killRecoveryObserved?.running()) await killRecoveryObserved.stop(2_000);
  }
  if (killRecoveryObserved === undefined)
    throw new Error("The in-flight kill recovery process did not start");
  if (killUnknown === undefined)
    throw new Error("The disconnected SDK kill result was not observed");
  const recoveredKill = readJsonRecord(
    "sdk-kill-join-inflight",
    killRecoveryObserved.stdout().toString("utf8"),
  );
  if (
    !isRecord(recoveredKill.result) ||
    recoveredKill.result.sessionHandle !== recoveredSpawnResult.sessionHandle ||
    recoveredKill.result.status !== "killed" ||
    !isRecord(recoveredKill.session) ||
    recoveredKill.session.state !== "killed" ||
    !isRecord(recoveredKill.session.lastCompletedTurn) ||
    recoveredKill.session.lastCompletedTurn.stopReason !== "killed" ||
    recoveredKill.session.lastCompletedTurn.turnHandle !==
      recoveredSpawnResult.turnHandle
  )
    throw new Error("The SDK did not recover the in-flight kill result");
  const completedKillReplay = await runSdkControl(
    "kill-recover",
    "sdk-kill-completed-replay",
    {
      REINS_OPERATION_INTENT_JSON: persistedKillRetry,
      REINS_EXPECTED_TURN_HANDLE: recoveredSpawnResult.turnHandle as string,
    },
  );
  if (
    !isRecord(completedKillReplay.result) ||
    canonicalJson(completedKillReplay.result) !==
      canonicalJson(recoveredKill.result)
  )
    throw new Error("The SDK did not replay the completed kill result");
  const cleanupFactsAtRecovery = readJsonLines(adapterObservations);
  if (
    !cleanupFactsAtRecovery.some(
      (fact) =>
        fact.type === "terminate_finished" &&
        fact.sessionId === recoveredSpawnResult.sessionHandle &&
        fact.attempt === 2,
    )
  )
    throw new Error("The joined kill returned before real cleanup finished");
  const activityAtAcknowledgement = readJsonLines(workerActivity);
  const descriptorCounts = Object.fromEntries(
    ["worker", "descendant"].map((role) => [
      role,
      {
        opened: activityAtAcknowledgement.filter(
          (fact) => fact.type === "opened" && fact.role === role,
        ).length,
        closed: activityAtAcknowledgement.filter(
          (fact) => fact.type === "closed" && fact.role === role,
        ).length,
        pids: [
          ...new Set(
            activityAtAcknowledgement
              .filter((fact) => fact.role === role)
              .map((fact) => fact.pid)
              .filter((pid): pid is number => typeof pid === "number"),
          ),
        ],
      },
    ]),
  );
  const isPidRunning = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return !(isRecord(error) && error.code === "ESRCH");
    }
  };
  recorder.record("worker_cleanup_at_kill_acknowledgement", {
    descriptorCounts,
    workerPid: workerReady.workerPid,
    workerRunning: isPidRunning(workerReady.workerPid),
    descendantPid: workerReady.descendantPid,
    descendantRunning: isPidRunning(workerReady.descendantPid),
    terminateFinished: cleanupFactsAtRecovery.filter(
      (fact) =>
        fact.type === "terminate_finished" &&
        fact.sessionId === recoveredSpawnResult.sessionHandle,
    ),
  });
  for (const role of ["worker", "descendant"]) {
    if (
      activityAtAcknowledgement.filter(
        (fact) => fact.type === "closed" && fact.role === role,
      ).length !== 1
    ) {
      throw new Error(
        `The ${role} descriptor was not closed exactly once at kill recovery: ${JSON.stringify(descriptorCounts)}`,
      );
    }
  }
  assertProcessStopped("The recovered worker process", workerReady.workerPid);
  assertProcessStopped(
    "The recovered descendant process",
    workerReady.descendantPid,
  );
  const finalActivity = readJsonLines(workerActivity);
  for (const role of ["worker", "descendant"]) {
    if (
      finalActivity.filter(
        (fact) => fact.type === "opened" && fact.role === role,
      ).length !== 1 ||
      finalActivity.filter(
        (fact) => fact.type === "closed" && fact.role === role,
      ).length !== 1
    )
      throw new Error(`The ${role} file descriptor did not close exactly once`);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (readJsonLines(workerActivity).length !== finalActivity.length)
    throw new Error("The killed worker tree continued writing after cleanup");
  assertProcessStopped("The worker process", workerReady.workerPid);
  assertProcessStopped("The descendant process", workerReady.descendantPid);

  const generationBeforeRestart = preparedSpawn.daemonGeneration;
  const previousDaemon = owned.directDaemon;
  const previousStop = await stopDaemon(previousDaemon, 5_000);
  owned.directDaemon = undefined;
  recorder.record("recoverable_control_daemon_restart_stop", previousStop);
  if (!isCleanStop(previousStop))
    throw new Error(
      `The recoverable-control daemon did not stop cleanly: ${JSON.stringify(previousStop)}`,
    );
  await waitForPathRemoval(directSocket, 5_000);
  await waitForPathRemoval(`${directSocket}.lock`, 5_000);
  owned.directDaemon = await startDaemon({
    label: "restarted packed daemon",
    executable: daemon,
    args: [],
    env: directEnv,
    socketPath: directSocket,
    logPath: join(logsDirectory, "restarted-daemon.log"),
    readyTimeoutMs: 5_000,
  });
  const staleSpawn = await runSdkControl(
    "spawn-stale",
    "sdk-stale-generation",
    {
      REINS_OPERATION_INTENT_JSON: persistedSpawnIntent,
    },
  );
  const staleSend = await runSdkControl(
    "send-stale",
    "sdk-send-stale-generation",
    { REINS_OPERATION_INTENT_JSON: persistedSendIntent },
  );
  const staleInterrupt = await runSdkControl(
    "interrupt-stale",
    "sdk-interrupt-stale-generation",
    { REINS_OPERATION_INTENT_JSON: persistedInterruptIntent },
  );
  const staleHandle = await runSdkControl(
    "handle-stale",
    "sdk-stale-session-handle",
    { REINS_TARGET_SESSION: recoveredSpawnResult.sessionHandle as string },
  );
  if (
    staleSpawn.code !== "stale_command_id" ||
    staleSend.code !== "stale_command_id" ||
    staleInterrupt.code !== "stale_command_id" ||
    staleSpawn.daemonGeneration === generationBeforeRestart ||
    staleHandle.status !== "not_found" ||
    staleHandle.sessionHandle !== recoveredSpawnResult.sessionHandle ||
    readJsonLines(adapterObservations).filter(
      ({ type }) => type === "worker_started",
    ).length !== 1
  )
    throw new Error(
      "The SDK replayed a stale credential in a new daemon generation",
    );
  recorder.record("sdk_recoverable_session_control", {
    generationBeforeRestart,
    generationAfterRestart: staleSpawn.daemonGeneration,
    spawnAcknowledgement: spawnAcknowledgement.result,
    spawnResult: recoveredSpawnResult,
    spawnConflict: spawnConflict.code,
    sendAcknowledgement,
    sendResult: recoveredSend.result,
    sendConflict: sendConflict.code,
    sendDeliveryCount: deliveredMessages.length,
    interruptAcknowledgement,
    interruptResult: recoveredInterrupt.result,
    interruptPending: recoveredInterrupt.observed,
    interruptRequestCount: interruptRequests.length,
    capabilityQueriesBeforeRecovery,
    capabilityQueriesAfterRecovery,
    capabilityQueriesAfterNewCredential,
    newCredentialSpawn: newCredentialSpawn.code,
    spawnValidation: spawnValidation.codes,
    killFailure: failedKill.failure,
    killDisconnect: killUnknown,
    killResult: recoveredKill.result,
    workerStartedCount: 1,
    workerPids: [workerReady.workerPid, workerReady.descendantPid],
    descriptorsClosed: ["worker", "descendant"],
    staleCredential: staleSpawn.code,
    staleSend: staleSend.code,
    staleInterrupt: staleInterrupt.code,
    staleHandle: staleHandle.status,
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

  // 通过已冻结安装的正式 application export 启动 sibling daemon 并查询。
  const applicationDirectory = join(runtimeDirectory, "application");
  mkdirSync(applicationDirectory);
  const applicationSocket = join(applicationDirectory, "reins.sock");
  const applicationEnv: NodeJS.ProcessEnv = {
    ...process.env,
    REINS_SOCKET: applicationSocket,
    REINS_STATE_DIR: join(applicationDirectory, "state"),
    REINS_ADAPTERS_MODULE: adaptersModule,
    REINS_CONSUMER_CONTEXT: "packed-application-check",
    REINS_IDLE_TIMEOUT_MS: "100",
    REINS_DAEMON_BIN: daemon,
  };
  const applicationQueryLog = join(
    logsDirectory,
    "runtime-sdk-application-query.log",
  );
  const applicationQuery = toCommandResult(
    await runLoggedCommand({
      command: process.execPath,
      args: ["--experimental-strip-types", applicationQueryFixture],
      cwd: applicationConsumerDirectory,
      env: applicationEnv,
      logPath: applicationQueryLog,
      timeoutMs: 20_000,
    }),
  );
  requireSuccess(
    "installed application start and query",
    applicationQuery,
    applicationQueryLog,
  );
  const applicationResult: unknown = JSON.parse(applicationQuery.stdout);
  if (
    !isRecord(applicationResult) ||
    applicationResult.status !== "queried" ||
    applicationResult.capabilityHarness !== "fixture" ||
    applicationResult.sessionCount !== 0 ||
    applicationResult.failureCode !== "invalid_params" ||
    applicationResult.failureStage !== "query"
  ) {
    throw new Error(
      `Installed application returned unexpected output: ${applicationQuery.stdout}`,
    );
  }
  await waitForPathRemoval(applicationSocket, 5_000);
  await waitForPathRemoval(`${applicationSocket}.lock`, 5_000);
  recorder.record("runtime_application_start_query", {
    exitCode: applicationQuery.status,
    logPath: applicationQueryLog,
    result: applicationResult,
    socketRemoved: true,
    daemonExecutable: daemon,
  });

  // 用现有 simulated adapter 与生产 control client 创建并清理真实 daemon 会话；
  // 该 helper 只播种状态，查询由冻结安装 consumer 内的公开 SDK 执行。
  const simulatedAdaptersModule = join(
    runtimeDirectory,
    "simulated-adapter.ts",
  );
  copyFileSync(simulatedAdapterSource, simulatedAdaptersModule);
  const killedListDirectory = join(runtimeDirectory, "killed-list");
  mkdirSync(killedListDirectory);
  const killedListSocket = join(killedListDirectory, "reins.sock");
  const killedListEnv: NodeJS.ProcessEnv = {
    ...process.env,
    REINS_SOCKET: killedListSocket,
    REINS_STATE_DIR: join(killedListDirectory, "state"),
    REINS_ADAPTERS_MODULE: simulatedAdaptersModule,
    REINS_CONSUMER_CONTEXT: "packed-killed-list-check",
    REINS_IDLE_TIMEOUT_MS: "120000",
    REINS_SIMULATED_OBSERVATION_LOG: join(
      killedListDirectory,
      "adapter-observations.ndjson",
    ),
  };
  owned.directDaemon = await startDaemon({
    label: "killed-list packed daemon",
    executable: daemon,
    args: [],
    env: killedListEnv,
    socketPath: killedListSocket,
    logPath: join(logsDirectory, "killed-list-daemon.log"),
    readyTimeoutMs: 5_000,
  });
  const seedSessionLog = join(logsDirectory, "killed-list-seed-session.log");
  const seedSession = toCommandResult(
    await runLoggedCommand({
      command: process.execPath,
      args: [
        "--conditions=source",
        "--experimental-strip-types",
        seedKilledSessionSource,
      ],
      cwd: repository,
      env: killedListEnv,
      logPath: seedSessionLog,
      timeoutMs: 30_000,
    }),
  );
  requireSuccess(
    "create and kill packed fixture session",
    seedSession,
    seedSessionLog,
  );
  const killedSession: unknown = JSON.parse(seedSession.stdout);
  if (
    !isRecord(killedSession) ||
    typeof killedSession.sessionHandle !== "string" ||
    killedSession.stopReason !== "end_turn"
  ) {
    throw new Error(
      `Session fixture returned unexpected output: ${seedSession.stdout}`,
    );
  }
  const historyWorkspace = join(killedListDirectory, "history-workspace");
  mkdirSync(historyWorkspace);
  const historyWindowLog = join(
    logsDirectory,
    "sdk-fact-window-and-expired-cursor.log",
  );
  const historyWindow = await runSdkControl(
    "replay-window",
    "sdk-fact-window-and-expired-cursor",
    {
      ...killedListEnv,
      REINS_WORKER_CWD: historyWorkspace,
      REINS_HISTORY_GATE: join(killedListDirectory, "release-history"),
    },
  );
  if (
    typeof historyWindow.sessionHandle !== "string" ||
    typeof historyWindow.turnHandle !== "string" ||
    typeof historyWindow.staleCursor !== "string" ||
    historyWindow.retainedMessages !== 999 ||
    historyWindow.factCount !== 1000 ||
    !isRecord(historyWindow.window) ||
    historyWindow.window.truncated !== true ||
    typeof historyWindow.window.oldest !== "number" ||
    historyWindow.window.oldest <= 1 ||
    typeof historyWindow.window.head !== "number" ||
    !isRecord(historyWindow.expired) ||
    historyWindow.expired.code !== "event_cursor_expired" ||
    !isRecord(historyWindow.expired.facts) ||
    historyWindow.expired.facts.oldest !== historyWindow.window.oldest ||
    historyWindow.expired.facts.head !== historyWindow.window.head
  )
    throw new Error(
      "The installed SDK omitted its truncated event window or expired cursor facts",
    );
  const installedCli = join(
    applicationConsumerDirectory,
    "node_modules",
    ".bin",
    "reins",
  );
  const availableAttachLog = join(
    logsDirectory,
    "installed-cli-truncated-attach.log",
  );
  const availableAttach = toCommandResult(
    await runLoggedCommand({
      command: installedCli,
      args: [
        "attach",
        historyWindow.turnHandle as string,
        "--scope",
        "turn",
        "--replay",
        "available",
      ],
      cwd: applicationConsumerDirectory,
      env: killedListEnv,
      logPath: availableAttachLog,
      timeoutMs: 30_000,
    }),
  );
  requireSuccess(
    "installed CLI attach to a truncated history window",
    availableAttach,
    availableAttachLog,
  );
  const availableFrames = readJsonLineRecords(
    "installed CLI truncated attach",
    availableAttach.stdout,
  );
  const availableEstablishment = availableFrames.find(
    (frame) => frame.kind === "record" && frame.variant === "established",
  );
  const availableCliFacts = availableFrames
    .filter((frame) => frame.kind === "record" && frame.variant === "fact")
    .map((frame) => {
      if (!isRecord(frame.data) || !isRecord(frame.data.fact))
        throw new Error("The installed CLI emitted a malformed replay fact");
      return frame.data.fact;
    });
  if (
    !isRecord(availableEstablishment?.data) ||
    !isRecord(availableEstablishment.data.establishment) ||
    !isRecord(availableEstablishment.data.establishment.window) ||
    availableEstablishment.data.establishment.window.truncated !== true ||
    availableEstablishment.data.establishment.window.oldest !==
      historyWindow.window.oldest ||
    availableEstablishment.data.establishment.window.head !==
      historyWindow.window.head ||
    availableEstablishment.data.establishment.replayed !== 1000 ||
    availableCliFacts.length !== 1000 ||
    availableCliFacts.at(-1)?.type !== "turn.completed"
  )
    throw new Error(
      "The installed CLI did not expose the bounded replay window",
    );

  const expiredAttachLog = join(
    logsDirectory,
    "installed-cli-expired-cursor.log",
  );
  const expiredAttach = toCommandResult(
    await runLoggedCommand({
      command: installedCli,
      args: [
        "attach",
        historyWindow.turnHandle as string,
        "--scope",
        "turn",
        "--replay",
        "after",
        "--cursor",
        historyWindow.staleCursor as string,
      ],
      cwd: applicationConsumerDirectory,
      env: killedListEnv,
      logPath: expiredAttachLog,
      timeoutMs: 30_000,
    }),
  );
  if (expiredAttach.status !== 70)
    throw new Error(
      `The installed CLI accepted an expired cursor with exit ${expiredAttach.status}`,
    );
  const expiredFrames = readJsonLineRecords(
    "installed CLI expired cursor",
    `${expiredAttach.stdout}${expiredAttach.stderr}`,
  );
  const expiredStream = expiredFrames[0];
  const expiredFailure = expiredFrames[1];
  if (
    expiredFrames.length !== 2 ||
    expiredStream?.kind !== "stream" ||
    expiredStream.command !== "attach" ||
    expiredFailure?.kind !== "failure" ||
    expiredFailure.command !== "attach" ||
    expiredFailure.variant !== "attachFailed" ||
    !isRecord(expiredFailure.data)
  )
    throw new Error(
      "The installed CLI expired cursor did not return its stream header and typed failure",
    );
  const expiredData = expiredFailure.data;
  if (
    !isRecord(expiredData.failure) ||
    expiredData.failure.code !== "event_cursor_expired" ||
    !isRecord(expiredData.failure.facts) ||
    expiredData.failure.facts.oldest !== historyWindow.window.oldest ||
    expiredData.failure.facts.head !== historyWindow.window.head
  )
    throw new Error("The installed CLI omitted typed expired cursor facts");
  recorder.record("installed_sdk_cli_fact_window_and_expiry", {
    sdk: historyWindow,
    cliWindow: availableEstablishment.data.establishment.window,
    cliReplayedFacts: availableCliFacts.length,
    cliExpiredCursor: expiredData.failure,
    sdkLogPath: historyWindowLog,
    cliAvailableLogPath: availableAttachLog,
    cliExpiredLogPath: expiredAttachLog,
  });
  const killedListQueryLog = join(logsDirectory, "sdk-killed-list-query.log");
  const killedListQuery = toCommandResult(
    await runLoggedCommand({
      command: process.execPath,
      args: ["--experimental-strip-types", sdkKilledListFixture],
      cwd: applicationConsumerDirectory,
      env: {
        ...killedListEnv,
        REINS_TARGET_SESSION: killedSession.sessionHandle,
      },
      logPath: killedListQueryLog,
      timeoutMs: 20_000,
    }),
  );
  requireSuccess(
    "installed SDK query for a killed session",
    killedListQuery,
    killedListQueryLog,
  );
  const killedListResult: unknown = JSON.parse(killedListQuery.stdout);
  if (
    !isRecord(killedListResult) ||
    killedListResult.state !== "killed" ||
    killedListResult.sessionHandle !== killedSession.sessionHandle ||
    !isRecord(killedListResult.lastCompletedTurn) ||
    killedListResult.lastCompletedTurn.stopReason !== "end_turn" ||
    typeof killedListResult.lastCompletedTurn.turnHandle !== "string" ||
    killedListResult.lastCompletedTurn.turnHandle === ""
  ) {
    throw new Error(
      `Installed SDK omitted the killed turn summary: ${killedListQuery.stdout}`,
    );
  }

  const interruptedAttachGate = join(
    killedListDirectory,
    "release-interrupted-attach-events",
  );
  const interruptedAttachCompletionGate = join(
    killedListDirectory,
    "complete-interrupted-attach-turn",
  );
  const interruptedAttachMessages = 5_000;
  const interruptedAttachCredentialLog = join(
    logsDirectory,
    "installed-cli-backpressure-prepare-spawn.log",
  );
  const interruptedAttachCredentialResult = toCommandResult(
    await runLoggedCommand({
      command: installedCli,
      args: ["prepare-operation", "spawn"],
      cwd: applicationConsumerDirectory,
      env: killedListEnv,
      logPath: interruptedAttachCredentialLog,
      timeoutMs: 30_000,
    }),
  );
  requireSuccess(
    "installed CLI prepare spawn for backpressure observation",
    interruptedAttachCredentialResult,
    interruptedAttachCredentialLog,
  );
  const interruptedAttachCredential = readDataEnvelope(
    "installed CLI backpressure spawn credential",
    interruptedAttachCredentialResult.stdout,
    "prepareOperation",
  );
  if (typeof interruptedAttachCredential.credential !== "string")
    throw new Error("The installed CLI omitted its spawn credential");
  const interruptedAttachSpawnLog = join(
    logsDirectory,
    "installed-cli-backpressure-spawn.log",
  );
  const interruptedAttachSpawnResult = toCommandResult(
    await runLoggedCommand({
      command: installedCli,
      args: [
        "spawn",
        "--operation",
        interruptedAttachCredential.credential,
        "--name",
        "sigint-backpressure-session",
        "--harness",
        "simulated",
        "--message",
        JSON.stringify({
          gate: interruptedAttachGate,
          completionGate: interruptedAttachCompletionGate,
          messages: interruptedAttachMessages,
          reply: "completed after observer cancellation",
        }),
        "--cwd",
        historyWorkspace,
      ],
      cwd: applicationConsumerDirectory,
      env: killedListEnv,
      logPath: interruptedAttachSpawnLog,
      timeoutMs: 30_000,
    }),
  );
  requireSuccess(
    "installed CLI spawn for backpressure observation",
    interruptedAttachSpawnResult,
    interruptedAttachSpawnLog,
  );
  const interruptedAttachSpawn = readDataEnvelope(
    "installed CLI backpressure spawn",
    interruptedAttachSpawnResult.stdout,
    "spawn",
  );
  if (
    typeof interruptedAttachSpawn.sessionHandle !== "string" ||
    typeof interruptedAttachSpawn.turnHandle !== "string"
  )
    throw new Error("The installed CLI omitted backpressure session handles");
  const interruptedSessionHandle = interruptedAttachSpawn.sessionHandle;
  const interruptedTurnHandle = interruptedAttachSpawn.turnHandle;

  const interruptedAttachLog = join(
    logsDirectory,
    "installed-cli-sigint-backpressure.log",
  );
  const interruptedAttachChild: ChildProcess = spawn(
    installedCli,
    ["attach", interruptedTurnHandle, "--scope", "turn", "--replay", "none"],
    {
      cwd: applicationConsumerDirectory,
      env: killedListEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const interruptedAttachStdout: string[] = [];
  const interruptedAttachStderr: string[] = [];
  let startupOutput = "";
  let established = false;
  let resolveEstablished!: () => void;
  let rejectEstablished!: (error: Error) => void;
  const establishedPromise = new Promise<void>((resolve, reject) => {
    resolveEstablished = resolve;
    rejectEstablished = reject;
  });
  let resolveInterruptedAttachClose!: () => void;
  const interruptedAttachClosed = new Promise<void>((resolve) => {
    resolveInterruptedAttachClose = resolve;
  });
  interruptedAttachChild.once("close", resolveInterruptedAttachClose);
  interruptedAttachChild.stdout?.setEncoding("utf8");
  interruptedAttachChild.stdout?.on("data", (chunk: string) => {
    interruptedAttachStdout.push(chunk);
    if (established) return;
    startupOutput += chunk;
    for (const line of startupOutput.split("\n")) {
      if (line === "") continue;
      const frame: unknown = JSON.parse(line);
      if (
        isRecord(frame) &&
        frame.kind === "record" &&
        frame.variant === "established"
      ) {
        established = true;
        interruptedAttachChild.stdout?.pause();
        resolveEstablished();
        return;
      }
    }
  });
  interruptedAttachChild.stderr?.setEncoding("utf8");
  interruptedAttachChild.stderr?.on("data", (chunk: string) =>
    interruptedAttachStderr.push(chunk),
  );
  interruptedAttachChild.once("error", (error) => {
    if (!established) rejectEstablished(error);
  });
  interruptedAttachChild.once("exit", (code, signal) => {
    if (!established)
      rejectEstablished(
        new Error(
          `Installed CLI exited before attach establishment: code=${code} signal=${signal}`,
        ),
      );
  });
  const establishedTimeout = setTimeout(
    () =>
      rejectEstablished(new Error("Installed CLI attach did not establish")),
    10_000,
  );
  try {
    await establishedPromise;
    clearTimeout(establishedTimeout);
    writeFileSync(interruptedAttachGate, "release", "utf8");
    const emitted = await waitForFact(
      "the packed adapter's backpressure facts",
      () => readJsonLines(killedListEnv.REINS_SIMULATED_OBSERVATION_LOG!),
      (fact) =>
        fact.type === "events_emitted" &&
        fact.sessionId === interruptedSessionHandle &&
        fact.messages === interruptedAttachMessages,
      30_000,
    );
    if (emitted.messages !== interruptedAttachMessages)
      throw new Error("The packed adapter emitted an incomplete fact batch");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    if (
      interruptedAttachChild.exitCode !== null ||
      interruptedAttachChild.signalCode !== null
    )
      throw new Error("Installed CLI exited before the SIGINT cancellation");
    if (!interruptedAttachChild.kill("SIGINT"))
      throw new Error("Could not send SIGINT to the installed CLI process");
    const exitDeadline = Date.now() + 10_000;
    while (
      interruptedAttachChild.exitCode === null &&
      interruptedAttachChild.signalCode === null
    ) {
      if (Date.now() >= exitDeadline)
        throw new Error(
          "Installed CLI stayed open after SIGINT while its output pipe was unread",
        );
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    if (
      interruptedAttachChild.exitCode !== 0 ||
      interruptedAttachChild.signalCode !== null
    )
      throw new Error(
        `Installed CLI did not exit cleanly after SIGINT: code=${interruptedAttachChild.exitCode} signal=${interruptedAttachChild.signalCode}`,
      );
    interruptedAttachChild.stdout?.resume();
    await interruptedAttachClosed;
    const interruptedAttachErrors = interruptedAttachStderr.join("");
    if (interruptedAttachErrors !== "")
      throw new Error(
        `Installed CLI reported an error while handling SIGINT: ${interruptedAttachErrors}`,
      );

    const queryInterruptedSession = async (
      label: string,
    ): Promise<Record<string, unknown>> => {
      const logPath = join(logsDirectory, `${label}.log`);
      const result = toCommandResult(
        await runLoggedCommand({
          command: installedCli,
          args: ["list", "--session", interruptedSessionHandle],
          cwd: applicationConsumerDirectory,
          env: killedListEnv,
          logPath,
          timeoutMs: 30_000,
        }),
      );
      requireSuccess(label, result, logPath);
      const data = readDataEnvelope(label, result.stdout, "list");
      if (!Array.isArray(data.sessions) || !isRecord(data.sessions[0]))
        throw new Error(`${label} omitted the observed session`);
      return data.sessions[0];
    };
    const liveAfterInterrupt = await queryInterruptedSession(
      "installed-cli-list-after-sigint",
    );
    if (
      liveAfterInterrupt.sessionHandle !== interruptedSessionHandle ||
      liveAfterInterrupt.state !== "busy" ||
      liveAfterInterrupt.activeTurn !== interruptedTurnHandle
    )
      throw new Error("Cancelling installed CLI attach stopped the live turn");
    writeFileSync(interruptedAttachCompletionGate, "release", "utf8");
    let completedAfterInterrupt = false;
    const completionDeadline = Date.now() + 15_000;
    while (!completedAfterInterrupt) {
      const session = await queryInterruptedSession(
        `installed-cli-list-after-completion-${Date.now()}`,
      );
      completedAfterInterrupt = session.state === "idle";
      if (completedAfterInterrupt) break;
      if (Date.now() >= completionDeadline)
        throw new Error(
          "The session did not complete after releasing its fixture gate",
        );
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    recorder.record("installed_cli_sigint_during_backpressure", {
      attachLogPath: interruptedAttachLog,
      exitCode: interruptedAttachChild.exitCode,
      signal: interruptedAttachChild.signalCode,
      eventsEmitted: emitted.messages,
      busyAfterInterrupt: liveAfterInterrupt.state === "busy",
      completedAfterFixtureRelease: completedAfterInterrupt,
      stderr: interruptedAttachErrors,
    });
  } finally {
    clearTimeout(establishedTimeout);
    if (
      interruptedAttachChild.exitCode === null &&
      interruptedAttachChild.signalCode === null
    )
      interruptedAttachChild.kill("SIGKILL");
    interruptedAttachChild.stdout?.resume();
    await interruptedAttachClosed;
    writeFileSync(
      interruptedAttachLog,
      `stdout:\n${interruptedAttachStdout.join("")}\nstderr:\n${interruptedAttachStderr.join("")}`,
      "utf8",
    );
  }
  const replacementCredentialLog = join(
    logsDirectory,
    "installed-cli-replacement-prepare-spawn.log",
  );
  const replacementCredentialResult = toCommandResult(
    await runLoggedCommand({
      command: installedCli,
      args: ["prepare-operation", "spawn"],
      cwd: applicationConsumerDirectory,
      env: killedListEnv,
      logPath: replacementCredentialLog,
      timeoutMs: 30_000,
    }),
  );
  requireSuccess(
    "installed CLI prepare spawn for replacement presentation",
    replacementCredentialResult,
    replacementCredentialLog,
  );
  const replacementCredential = readDataEnvelope(
    "installed CLI replacement spawn credential",
    replacementCredentialResult.stdout,
    "prepareOperation",
  );
  if (typeof replacementCredential.credential !== "string")
    throw new Error(
      "The installed CLI omitted the replacement spawn credential",
    );
  const replacementSpawnLog = join(
    logsDirectory,
    "installed-cli-replacement-spawn.log",
  );
  const replacementSpawnResult = toCommandResult(
    await runLoggedCommand({
      command: installedCli,
      args: [
        "spawn",
        "--operation",
        replacementCredential.credential,
        "--name",
        "replacement-presentation-session",
        "--harness",
        "simulated",
        "--message",
        JSON.stringify({
          replacement: { draft: "draft", corrected: "corrected" },
          reply: "corrected",
        }),
        "--cwd",
        historyWorkspace,
      ],
      cwd: applicationConsumerDirectory,
      env: killedListEnv,
      logPath: replacementSpawnLog,
      timeoutMs: 30_000,
    }),
  );
  requireSuccess(
    "installed CLI spawn for replacement presentation",
    replacementSpawnResult,
    replacementSpawnLog,
  );
  const replacementSpawn = readDataEnvelope(
    "installed CLI replacement spawn",
    replacementSpawnResult.stdout,
    "spawn",
  );
  if (typeof replacementSpawn.turnHandle !== "string")
    throw new Error("The installed CLI omitted the replacement turn handle");
  const replacementTextLog = join(
    logsDirectory,
    "installed-cli-replacement-attach-text.log",
  );
  const replacementTextResult = toCommandResult(
    await runLoggedCommand({
      command: installedCli,
      args: [
        "attach",
        replacementSpawn.turnHandle,
        "--scope",
        "turn",
        "--replay",
        "available",
        "--output-format",
        "text",
      ],
      cwd: applicationConsumerDirectory,
      env: killedListEnv,
      logPath: replacementTextLog,
      timeoutMs: 30_000,
    }),
  );
  requireSuccess(
    "installed CLI text attach for a corrected message",
    replacementTextResult,
    replacementTextLog,
  );
  if (
    !replacementTextResult.stdout.includes("worker: draft") ||
    !replacementTextResult.stdout.includes(
      "[message updated] worker: corrected",
    ) ||
    replacementTextResult.stdout.includes("draftcorrected")
  )
    throw new Error(
      "The installed CLI appended a corrected snapshot instead of replacing its draft",
    );
  recorder.record("installed_cli_replacement_presentation", {
    turnHandle: replacementSpawn.turnHandle,
    draftVisible: replacementTextResult.stdout.includes("worker: draft"),
    replacementVisible: replacementTextResult.stdout.includes(
      "[message updated] worker: corrected",
    ),
    appendedDraft: replacementTextResult.stdout.includes("draftcorrected"),
    logPath: replacementTextLog,
  });
  const killedListDaemon = owned.directDaemon;
  const killedListStop = await stopDaemon(killedListDaemon, 5_000);
  owned.directDaemon = undefined;
  recorder.record("killed_list_daemon_stop", killedListStop);
  if (!isCleanStop(killedListStop)) {
    throw new Error(
      `Killed-list daemon did not stop cleanly: ${JSON.stringify(killedListStop)} (log: ${killedListDaemon.logPath})`,
    );
  }
  await waitForPathRemoval(killedListSocket, 5_000);
  await waitForPathRemoval(`${killedListSocket}.lock`, 5_000);
  recorder.record("sdk_killed_session_list", {
    exitCode: killedListQuery.status,
    logPath: killedListQueryLog,
    seedLogPath: seedSessionLog,
    result: killedListResult,
  });

  const controlCliDirectory = join(runtimeDirectory, "control-cli");
  mkdirSync(controlCliDirectory);
  const controlCliSocket = join(controlCliDirectory, "reins.sock");
  const controlCliWorkspace = join(controlCliDirectory, "workspace");
  mkdirSync(controlCliWorkspace);
  const controlCliObservations = join(
    controlCliDirectory,
    "adapter-observations.ndjson",
  );
  const controlCliActivity = join(
    controlCliDirectory,
    "worker-activity.ndjson",
  );
  const controlCliEnv: NodeJS.ProcessEnv = {
    ...process.env,
    REINS_SOCKET: controlCliSocket,
    REINS_STATE_DIR: join(controlCliDirectory, "state"),
    REINS_ADAPTERS_MODULE: adaptersModule,
    REINS_CONSUMER_CONTEXT: "packed-installed-cli-control",
    REINS_IDLE_TIMEOUT_MS: "10000",
    REINS_DAEMON_BIN: daemon,
    REINS_PACKED_FIXTURE_OBSERVATIONS: controlCliObservations,
    REINS_PACKED_FIXTURE_ACTIVITY: controlCliActivity,
  };
  const frozenCli = join(
    applicationConsumerDirectory,
    "node_modules",
    ".bin",
    "reins",
  );
  const runInstalledCliResult = async (
    args: string[],
    label: string,
    env: NodeJS.ProcessEnv = controlCliEnv,
  ): Promise<CommandResult> => {
    const logPath = join(logsDirectory, `${label}.log`);
    const result = toCommandResult(
      await runLoggedCommand({
        command: frozenCli,
        args,
        cwd: applicationConsumerDirectory,
        env,
        logPath,
        timeoutMs: 30_000,
      }),
    );
    return result;
  };
  const runInstalledCli = async (
    args: string[],
    label: string,
    env: NodeJS.ProcessEnv = controlCliEnv,
  ): Promise<CommandResult> => {
    const result = await runInstalledCliResult(args, label, env);
    requireSuccess(label, result, join(logsDirectory, `${label}.log`));
    return result;
  };

  // 冻结安装的 SDK 与 CLI 分别创建新回合；两个新回合由可控门闩反向完成，
  // 再验证 any/all 保留调用者给出的句柄顺序，timeout=0 也不会取消工作。
  const orderedTurnsDirectory = join(killedListDirectory, "ordered-turns");
  mkdirSync(orderedTurnsDirectory);
  const sdkTurnGate = join(orderedTurnsDirectory, "release-sdk-turn");
  const cliTurnGate = join(orderedTurnsDirectory, "release-cli-turn");
  owned.releaseGates.push(sdkTurnGate, cliTurnGate);
  const spawnAndComplete = async (
    sessionName: string,
  ): Promise<{ sessionHandle: string; turnHandle: string }> => {
    const credentialOutput = await runInstalledCli(
      ["prepare-operation", "spawn"],
      `ordered-${sessionName}-prepare-spawn`,
      killedListEnv,
    );
    const credentialData = readDataEnvelope(
      `ordered ${sessionName} spawn credential`,
      credentialOutput.stdout,
      "prepareOperation",
    );
    if (typeof credentialData.credential !== "string")
      throw new Error(`The installed CLI omitted ${sessionName} spawn intent`);
    const intentPath = join(orderedTurnsDirectory, `${sessionName}-spawn.json`);
    const input = {
      name: sessionName,
      harness: "simulated",
      message: JSON.stringify({ reply: `${sessionName} initial turn` }),
      cwd: historyWorkspace,
    };
    writeFileSync(
      intentPath,
      JSON.stringify({
        operation: "spawn",
        credential: credentialData.credential,
        input,
      }),
      "utf8",
    );
    const persisted = readJsonRecord(
      `persisted ${sessionName} spawn intent`,
      readFileSync(intentPath, "utf8"),
    );
    if (!isRecord(persisted.input))
      throw new Error(`The ${sessionName} spawn intent was not persisted`);
    const spawned = await runInstalledCli(
      [
        "spawn",
        "--operation",
        persisted.credential as string,
        "--name",
        persisted.input.name as string,
        "--harness",
        persisted.input.harness as string,
        "--message",
        persisted.input.message as string,
        "--cwd",
        persisted.input.cwd as string,
      ],
      `ordered-${sessionName}-spawn`,
      killedListEnv,
    );
    const spawnData = readDataEnvelope(
      `ordered ${sessionName} spawn`,
      spawned.stdout,
      "spawn",
    );
    if (
      typeof spawnData.sessionHandle !== "string" ||
      typeof spawnData.turnHandle !== "string"
    )
      throw new Error(`The installed CLI omitted ${sessionName} exact handles`);
    const initialWait = await runInstalledCli(
      [
        "wait",
        spawnData.turnHandle,
        "--completion",
        "all",
        "--timeout",
        "5000",
      ],
      `ordered-${sessionName}-initial-wait`,
      killedListEnv,
    );
    const waitEnvelope = readJsonRecord(
      `ordered ${sessionName} initial wait`,
      initialWait.stdout,
    );
    if (
      !isRecord(waitEnvelope.data) ||
      !isRecord(waitEnvelope.data.result) ||
      waitEnvelope.data.result.status !== "satisfied"
    )
      throw new Error(`The ${sessionName} initial turn did not complete`);
    return {
      sessionHandle: spawnData.sessionHandle,
      turnHandle: spawnData.turnHandle,
    };
  };
  const sdkBaseTurn = await spawnAndComplete("packed-sdk-ordered");
  const cliBaseTurn = await spawnAndComplete("packed-cli-ordered");
  const sdkNewTurnMessage = JSON.stringify({
    completionGate: sdkTurnGate,
    reply: "SDK new turn completed last",
  });
  const sdkPreparedNewTurn = await runSdkControl(
    "prepare-new-turn",
    "installed-sdk-prepare-new-turn",
    {
      ...killedListEnv,
      REINS_TARGET_SESSION: sdkBaseTurn.sessionHandle,
      REINS_NEW_TURN_MESSAGE: sdkNewTurnMessage,
    },
  );
  if (
    sdkPreparedNewTurn.prepared !== true ||
    typeof sdkPreparedNewTurn.intent !== "string"
  )
    throw new Error("The installed SDK did not prepare a new-turn intent");
  const sdkNewTurnIntentPath = join(orderedTurnsDirectory, "sdk-send.json");
  writeFileSync(sdkNewTurnIntentPath, sdkPreparedNewTurn.intent, "utf8");
  const sdkNewTurnIntent = readFileSync(sdkNewTurnIntentPath, "utf8");
  const sdkNewTurnOutput = await runSdkControl(
    "send-new-turn",
    "installed-sdk-send-new-turn",
    { ...killedListEnv, REINS_OPERATION_INTENT_JSON: sdkNewTurnIntent },
  );
  if (
    !isRecord(sdkNewTurnOutput.result) ||
    sdkNewTurnOutput.result.sessionHandle !== sdkBaseTurn.sessionHandle ||
    sdkNewTurnOutput.result.deliveryPoint !== "new_turn" ||
    typeof sdkNewTurnOutput.result.turnHandle !== "string"
  )
    throw new Error("The installed SDK did not return the exact new turn");
  const sdkTurnHandle = sdkNewTurnOutput.result.turnHandle;

  const cliNewTurnMessage = JSON.stringify({
    completionGate: cliTurnGate,
    reply: "CLI new turn completed first",
  });
  const cliNewTurnCredentialOutput = await runInstalledCli(
    ["prepare-operation", "send"],
    "installed-cli-prepare-new-turn",
    killedListEnv,
  );
  const cliNewTurnCredential = readDataEnvelope(
    "installed CLI new-turn credential",
    cliNewTurnCredentialOutput.stdout,
    "prepareOperation",
  );
  if (typeof cliNewTurnCredential.credential !== "string")
    throw new Error("The installed CLI did not prepare a new-turn credential");
  const cliNewTurnIntentPath = join(orderedTurnsDirectory, "cli-send.json");
  writeFileSync(
    cliNewTurnIntentPath,
    JSON.stringify({
      operation: "send",
      credential: cliNewTurnCredential.credential,
      sessionHandle: cliBaseTurn.sessionHandle,
      placement: "new_turn",
      message: cliNewTurnMessage,
    }),
    "utf8",
  );
  const cliNewTurnIntent = readJsonRecord(
    "persisted CLI new-turn intent",
    readFileSync(cliNewTurnIntentPath, "utf8"),
  );
  const cliNewTurnOutput = await runInstalledCli(
    [
      "send",
      cliNewTurnIntent.sessionHandle as string,
      "--placement",
      cliNewTurnIntent.placement as string,
      "--message",
      cliNewTurnIntent.message as string,
      "--operation",
      cliNewTurnIntent.credential as string,
    ],
    "installed-cli-send-new-turn",
    killedListEnv,
  );
  const cliNewTurnData = readDataEnvelope(
    "installed CLI new-turn result",
    cliNewTurnOutput.stdout,
    "send",
  );
  if (
    cliNewTurnData.sessionHandle !== cliBaseTurn.sessionHandle ||
    typeof cliNewTurnData.turnHandle !== "string" ||
    JSON.stringify(Object.keys(cliNewTurnData).sort()) !==
      JSON.stringify(["sessionHandle", "turnHandle"])
  )
    throw new Error(
      "The installed CLI did not return only its exact new-turn handles",
    );
  const cliTurnHandle = cliNewTurnData.turnHandle;
  const orderedTurnHandles = [sdkTurnHandle, cliTurnHandle];

  const assertSdkOrderedWait = (
    label: string,
    value: Record<string, unknown>,
    status: "timeout" | "satisfied",
    completed: string[],
    pending: string[],
  ): void => {
    const result = value.result;
    if (
      !isRecord(result) ||
      result.status !== status ||
      !Array.isArray(result.completed) ||
      !Array.isArray(result.pending) ||
      JSON.stringify(
        result.completed.map((item) =>
          isRecord(item) && typeof item.turnHandle === "string"
            ? item.turnHandle
            : "",
        ),
      ) !== JSON.stringify(completed) ||
      JSON.stringify(result.pending) !== JSON.stringify(pending)
    )
      throw new Error(`The installed SDK ${label} wait changed target order`);
  };
  const assertCliOrderedWait = (
    label: string,
    result: CommandResult,
    expectedExit: number,
    status: "timeout" | "satisfied",
    completed: string[],
    pending: string[],
  ): void => {
    const envelope = readJsonRecord(label, result.stdout);
    const waitResult = envelope.data;
    if (
      result.status !== expectedExit ||
      !isRecord(waitResult) ||
      !isRecord(waitResult.result) ||
      waitResult.result.status !== status ||
      !Array.isArray(waitResult.result.completed) ||
      !Array.isArray(waitResult.result.pending) ||
      JSON.stringify(
        waitResult.result.completed.map((item) =>
          isRecord(item) && typeof item.turnHandle === "string"
            ? item.turnHandle
            : "",
        ),
      ) !== JSON.stringify(completed) ||
      JSON.stringify(
        waitResult.result.pending.map((item) =>
          isRecord(item) && typeof item.turnHandle === "string"
            ? item.turnHandle
            : "",
        ),
      ) !== JSON.stringify(pending)
    )
      throw new Error(`The installed CLI ${label} wait changed target order`);
  };

  const sdkWaitTargetsEnv = {
    ...killedListEnv,
    REINS_TARGET_TURNS: JSON.stringify(orderedTurnHandles),
  };
  const sdkTimedOutWait = await runSdkControl(
    "wait-ordered",
    "installed-sdk-ordered-any-timeout",
    {
      ...sdkWaitTargetsEnv,
      REINS_WAIT_COMPLETION: "any",
      REINS_WAIT_TIMEOUT_MS: "0",
    },
  );
  assertSdkOrderedWait(
    "timed-out any",
    sdkTimedOutWait,
    "timeout",
    [],
    orderedTurnHandles,
  );
  const cliTimedOutWait = await runInstalledCliResult(
    ["wait", ...orderedTurnHandles, "--completion", "any", "--timeout", "0"],
    "installed-cli-ordered-any-timeout",
    killedListEnv,
  );
  assertCliOrderedWait(
    "timed-out any",
    cliTimedOutWait,
    4,
    "timeout",
    [],
    orderedTurnHandles,
  );

  writeFileSync(cliTurnGate, "release CLI turn first", "utf8");
  owned.releaseGates = owned.releaseGates.filter(
    (gate) => gate !== cliTurnGate,
  );
  const sdkAnyWait = await runSdkControl(
    "wait-ordered",
    "installed-sdk-ordered-any-completed",
    {
      ...sdkWaitTargetsEnv,
      REINS_WAIT_COMPLETION: "any",
      REINS_WAIT_TIMEOUT_MS: "5000",
    },
  );
  assertSdkOrderedWait(
    "any",
    sdkAnyWait,
    "satisfied",
    [cliTurnHandle],
    [sdkTurnHandle],
  );
  const cliAnyWait = await runInstalledCliResult(
    ["wait", ...orderedTurnHandles, "--completion", "any", "--timeout", "5000"],
    "installed-cli-ordered-any-completed",
    killedListEnv,
  );
  assertCliOrderedWait(
    "any",
    cliAnyWait,
    0,
    "satisfied",
    [cliTurnHandle],
    [sdkTurnHandle],
  );

  writeFileSync(sdkTurnGate, "release SDK turn second", "utf8");
  owned.releaseGates = owned.releaseGates.filter(
    (gate) => gate !== sdkTurnGate,
  );
  const sdkAllWait = await runSdkControl(
    "wait-ordered",
    "installed-sdk-ordered-all",
    {
      ...sdkWaitTargetsEnv,
      REINS_WAIT_COMPLETION: "all",
      REINS_WAIT_TIMEOUT_MS: "5000",
    },
  );
  assertSdkOrderedWait("all", sdkAllWait, "satisfied", orderedTurnHandles, []);
  const cliAllWait = await runInstalledCli(
    ["wait", ...orderedTurnHandles, "--completion", "all", "--timeout", "5000"],
    "installed-cli-ordered-all",
    killedListEnv,
  );
  assertCliOrderedWait(
    "all",
    cliAllWait,
    0,
    "satisfied",
    orderedTurnHandles,
    [],
  );
  recorder.record("installed_sdk_cli_new_turn_and_ordered_wait", {
    sdkNewTurn: sdkNewTurnOutput.result,
    cliNewTurn: cliNewTurnData,
    timedOutPending: orderedTurnHandles,
    anyCompletedFirst: cliTurnHandle,
    allCompletedInRequestedOrder: orderedTurnHandles,
    persistedIntentPaths: [sdkNewTurnIntentPath, cliNewTurnIntentPath],
  });

  const cliPreparedSpawnOutput = await runInstalledCli(
    ["prepare-operation", "spawn"],
    "installed-cli-prepare-spawn",
  );
  const cliPreparedSpawnData = readDataEnvelope(
    "installed CLI prepare spawn",
    cliPreparedSpawnOutput.stdout,
    "prepareOperation",
  );
  if (
    cliPreparedSpawnData.operation !== "spawn" ||
    typeof cliPreparedSpawnData.credential !== "string"
  )
    throw new Error("The installed CLI did not expose its prepared credential");
  if (
    readJsonLines(controlCliObservations).some(
      ({ type }) => type === "worker_started",
    )
  )
    throw new Error("The installed CLI started a worker while preparing spawn");
  const cliIntentPath = join(controlCliDirectory, "accepted-operation.json");
  writeFileSync(
    cliIntentPath,
    JSON.stringify({
      operation: "spawn",
      credential: cliPreparedSpawnData.credential,
      input: {
        name: "packed-cli-session",
        harness: "fixture",
        message: "CLI private response-loss task",
        cwd: controlCliWorkspace,
      },
    }),
    "utf8",
  );
  const cliIntent = readJsonRecord(
    "persisted CLI operation",
    readFileSync(cliIntentPath, "utf8"),
  );
  if (!isRecord(cliIntent.input))
    throw new Error("The CLI operation intent was not persisted before spawn");
  const cliSpawnArgs = [
    "spawn",
    "--operation",
    cliIntent.credential as string,
    "--name",
    cliIntent.input.name as string,
    "--harness",
    cliIntent.input.harness as string,
    "--message",
    cliIntent.input.message as string,
    "--cwd",
    cliIntent.input.cwd as string,
  ];
  const cliSpawnProxyPath = join(controlCliDirectory, "spawn-ack-proxy.sock");
  owned.acknowledgementProxy = await startUnixAcknowledgementProxy({
    socketPath: cliSpawnProxyPath,
    targetPath: controlCliSocket,
    method: "spawn",
  });
  const lostCliSpawn = await runInstalledCliResult(
    cliSpawnArgs,
    "installed-cli-spawn-drop-ack",
    { ...controlCliEnv, REINS_SOCKET: owned.acknowledgementProxy.socketPath },
  );
  const cliSpawnAcknowledgement =
    await owned.acknowledgementProxy.waitForDroppedAcknowledgement();
  await owned.acknowledgementProxy.close();
  owned.acknowledgementProxy = undefined;
  const lostCliSpawnData = readFailureEnvelope(
    "installed CLI spawn response loss",
    lostCliSpawn,
    "spawn",
    "operationFailed",
  );
  const cliSpawnAckResult = cliSpawnAcknowledgement.result;
  if (
    lostCliSpawn.status !== 70 ||
    !isRecord(lostCliSpawnData.failure) ||
    lostCliSpawnData.failure.code !== "command_outcome_unknown" ||
    !isRecord(lostCliSpawnData.failure.facts) ||
    lostCliSpawnData.failure.facts.operation !== "spawn" ||
    !isRecord(cliSpawnAckResult) ||
    typeof cliSpawnAckResult.sessionId !== "string" ||
    typeof cliSpawnAckResult.turnId !== "string" ||
    `${lostCliSpawn.stdout}${lostCliSpawn.stderr}`.includes(
      "CLI private response-loss task",
    )
  )
    throw new Error(
      "The installed CLI did not report its lost spawn response without exposing the task",
    );
  const cliSpawnOutput = await runInstalledCli(
    cliSpawnArgs,
    "installed-cli-spawn-recover",
  );
  const cliSpawnData = readDataEnvelope(
    "installed CLI spawn recovery",
    cliSpawnOutput.stdout,
    "spawn",
  );
  if (
    typeof cliSpawnData.sessionHandle !== "string" ||
    typeof cliSpawnData.turnHandle !== "string" ||
    cliSpawnData.cwd !== controlCliWorkspace ||
    cliSpawnData.sessionHandle !== cliSpawnAckResult.sessionId ||
    !cliSpawnData.turnHandle.startsWith(
      `${cliSpawnAckResult.sessionId}/${cliSpawnAckResult.turnId}.`,
    )
  )
    throw new Error(
      "The installed CLI did not recover the exact spawn handles",
    );
  const cliWorkerStarted = await waitForFact(
    "the installed CLI worker input",
    () => readJsonLines(controlCliObservations),
    (fact) => fact.type === "worker_started",
  );
  if (!isRecord(cliWorkerStarted.spec))
    throw new Error("The installed CLI worker omitted its input facts");
  const expectedCliSpecKeys = [
    "cwd",
    "harness",
    "message",
    "sessionId",
    "sessionName",
    "turnId",
  ].sort();
  if (
    JSON.stringify(Object.keys(cliWorkerStarted.spec).sort()) !==
      JSON.stringify(expectedCliSpecKeys) ||
    cliWorkerStarted.spec.cwd !== controlCliWorkspace ||
    cliWorkerStarted.spec.harness !== "fixture" ||
    cliWorkerStarted.spec.message !== "CLI private response-loss task" ||
    cliWorkerStarted.spec.sessionId !== cliSpawnData.sessionHandle ||
    cliWorkerStarted.spec.sessionName !== "packed-cli-session" ||
    typeof cliWorkerStarted.spec.turnId !== "string"
  )
    throw new Error(
      "The installed CLI changed input text or materialized omitted options",
    );
  if (
    readJsonLines(controlCliObservations).filter(
      ({ type }) => type === "worker_started",
    ).length !== 1
  )
    throw new Error("Recovering the CLI spawn started a duplicate worker");
  const cliWorkerReady = await waitForFact(
    "the installed CLI worker process tree",
    () => readJsonLines(controlCliObservations),
    (fact) =>
      fact.type === "worker_ready" &&
      fact.sessionId === cliSpawnData.sessionHandle,
  );
  if (
    typeof cliWorkerReady.workerPid !== "number" ||
    typeof cliWorkerReady.descendantPid !== "number" ||
    cliWorkerReady.workerCwd !== controlCliWorkspace
  )
    throw new Error("The installed CLI worker omitted process ids");
  const cliListOutput = await runInstalledCli(
    ["list", "--session", cliSpawnData.sessionHandle],
    "installed-cli-list",
  );
  const cliListData = readDataEnvelope(
    "installed CLI list",
    cliListOutput.stdout,
    "list",
  );
  if (
    !Array.isArray(cliListData.sessions) ||
    cliListData.sessions.length !== 1 ||
    !isRecord(cliListData.sessions[0]) ||
    cliListData.sessions[0].state !== "busy" ||
    cliListData.sessions[0].activeTurn !== cliSpawnData.turnHandle
  )
    throw new Error("The installed CLI did not list its exact active turn");

  const cliPreparedSendOutput = await runInstalledCli(
    ["prepare-operation", "send"],
    "installed-cli-prepare-send",
  );
  const cliPreparedSendData = readDataEnvelope(
    "installed CLI prepare send",
    cliPreparedSendOutput.stdout,
    "prepareOperation",
  );
  if (
    cliPreparedSendData.operation !== "send" ||
    typeof cliPreparedSendData.credential !== "string"
  )
    throw new Error("The installed CLI did not prepare a send credential");
  const cliSendMessage = "  installed CLI send\nkeep spacing  ";
  const cliSendIntentPath = join(controlCliDirectory, "accepted-send.json");
  writeFileSync(
    cliSendIntentPath,
    JSON.stringify({
      operation: "send",
      credential: cliPreparedSendData.credential,
      turnHandle: cliSpawnData.turnHandle,
      message: cliSendMessage,
    }),
    "utf8",
  );
  const cliSendIntent = readJsonRecord(
    "persisted CLI send operation",
    readFileSync(cliSendIntentPath, "utf8"),
  );
  const cliSendArgs = [
    "send",
    cliSendIntent.turnHandle as string,
    "--placement",
    "active_turn",
    "--message",
    cliSendIntent.message as string,
    "--operation",
    cliSendIntent.credential as string,
  ];
  const cliSendProxyPath = join(controlCliDirectory, "send-ack-proxy.sock");
  owned.acknowledgementProxy = await startUnixAcknowledgementProxy({
    socketPath: cliSendProxyPath,
    targetPath: controlCliSocket,
    method: "send",
  });
  const lostCliSend = await runInstalledCliResult(
    cliSendArgs,
    "installed-cli-send-drop-ack",
    { ...controlCliEnv, REINS_SOCKET: owned.acknowledgementProxy.socketPath },
  );
  const cliSendAcknowledgement =
    await owned.acknowledgementProxy.waitForDroppedAcknowledgement();
  await owned.acknowledgementProxy.close();
  owned.acknowledgementProxy = undefined;
  const lostCliSendData = readFailureEnvelope(
    "installed CLI send response loss",
    lostCliSend,
    "send",
    "operationFailed",
  );
  if (
    lostCliSend.status !== 70 ||
    !isRecord(lostCliSendData.failure) ||
    lostCliSendData.failure.code !== "command_outcome_unknown" ||
    !isRecord(lostCliSendData.failure.facts) ||
    lostCliSendData.failure.facts.operation !== "send" ||
    cliSendAcknowledgement.method !== "send" ||
    !isRecord(cliSendAcknowledgement.result) ||
    cliSendAcknowledgement.result.sessionId !== cliSpawnData.sessionHandle ||
    cliSendAcknowledgement.result.turnId !==
      (cliSpawnData.turnHandle as string).split("/")[1]?.split(".")[0] ||
    `${lostCliSend.stdout}${lostCliSend.stderr}`.includes(cliSendMessage)
  )
    throw new Error(
      "The installed CLI did not report send response loss without exposing its input",
    );
  const recoveredCliSendOutput = await runInstalledCli(
    cliSendArgs,
    "installed-cli-send-recover",
  );
  const recoveredCliSend = readDataEnvelope(
    "installed CLI send recovery",
    recoveredCliSendOutput.stdout,
    "send",
  );
  if (
    recoveredCliSend.sessionHandle !== cliSpawnData.sessionHandle ||
    recoveredCliSend.turnHandle !== cliSpawnData.turnHandle ||
    JSON.stringify(Object.keys(recoveredCliSend).sort()) !==
      JSON.stringify(["sessionHandle", "turnHandle"]) ||
    typeof cliSendAcknowledgement.result.messageId !== "string"
  )
    throw new Error(
      "The installed CLI did not recover only the exact send handles",
    );
  const conflictingCliSend = await runInstalledCliResult(
    [
      ...cliSendArgs.slice(0, 5),
      `${cliSendMessage} changed`,
      ...cliSendArgs.slice(6),
    ],
    "installed-cli-send-conflict",
  );
  const conflictingCliSendData = readFailureEnvelope(
    "installed CLI send conflict",
    conflictingCliSend,
    "send",
    "operationFailed",
  );
  if (
    conflictingCliSend.status !== 70 ||
    !isRecord(conflictingCliSendData.failure) ||
    conflictingCliSendData.failure.code !== "command_id_conflict"
  )
    throw new Error("The installed CLI did not preserve the send conflict");
  const cliDeliveredMessages = readJsonLines(controlCliObservations).filter(
    ({ type }) => type === "message_delivered",
  );
  if (
    cliDeliveredMessages.length !== 1 ||
    cliDeliveredMessages[0]?.sessionId !== cliSpawnData.sessionHandle ||
    cliDeliveredMessages[0]?.message !== cliSendMessage
  )
    throw new Error(
      "The installed CLI replayed or changed the delivered message",
    );

  const cliPreparedInterruptOutput = await runInstalledCli(
    ["prepare-operation", "interrupt"],
    "installed-cli-prepare-interrupt",
  );
  const cliPreparedInterruptData = readDataEnvelope(
    "installed CLI prepare interrupt",
    cliPreparedInterruptOutput.stdout,
    "prepareOperation",
  );
  if (
    cliPreparedInterruptData.operation !== "interrupt" ||
    typeof cliPreparedInterruptData.credential !== "string"
  )
    throw new Error(
      "The installed CLI did not prepare an interrupt credential",
    );
  const cliInterruptIntentPath = join(
    controlCliDirectory,
    "accepted-interrupt.json",
  );
  writeFileSync(
    cliInterruptIntentPath,
    JSON.stringify({
      operation: "interrupt",
      credential: cliPreparedInterruptData.credential,
      turnHandle: cliSpawnData.turnHandle,
    }),
    "utf8",
  );
  const cliInterruptIntent = readJsonRecord(
    "persisted CLI interrupt operation",
    readFileSync(cliInterruptIntentPath, "utf8"),
  );
  const cliInterruptArgs = [
    "interrupt",
    cliInterruptIntent.turnHandle as string,
    "--operation",
    cliInterruptIntent.credential as string,
  ];
  const cliInterruptProxyPath = join(
    controlCliDirectory,
    "interrupt-ack-proxy.sock",
  );
  owned.acknowledgementProxy = await startUnixAcknowledgementProxy({
    socketPath: cliInterruptProxyPath,
    targetPath: controlCliSocket,
    method: "interrupt",
  });
  const lostCliInterrupt = await runInstalledCliResult(
    cliInterruptArgs,
    "installed-cli-interrupt-drop-ack",
    {
      ...controlCliEnv,
      REINS_SOCKET: owned.acknowledgementProxy.socketPath,
    },
  );
  const cliInterruptAcknowledgement =
    await owned.acknowledgementProxy.waitForDroppedAcknowledgement();
  await owned.acknowledgementProxy.close();
  owned.acknowledgementProxy = undefined;
  const lostCliInterruptData = readFailureEnvelope(
    "installed CLI interrupt response loss",
    lostCliInterrupt,
    "interrupt",
    "operationFailed",
  );
  if (
    lostCliInterrupt.status !== 70 ||
    !isRecord(lostCliInterruptData.failure) ||
    lostCliInterruptData.failure.code !== "command_outcome_unknown" ||
    !isRecord(lostCliInterruptData.failure.facts) ||
    lostCliInterruptData.failure.facts.operation !== "interrupt" ||
    cliInterruptAcknowledgement.method !== "interrupt" ||
    !isRecord(cliInterruptAcknowledgement.result) ||
    cliInterruptAcknowledgement.result.sessionId !== cliSpawnData.sessionHandle
  )
    throw new Error(
      "The installed CLI did not preserve typed interrupt response loss",
    );
  const recoveredCliInterruptOutput = await runInstalledCli(
    cliInterruptArgs,
    "installed-cli-interrupt-recover",
  );
  const recoveredCliInterrupt = readDataEnvelope(
    "installed CLI interrupt recovery",
    recoveredCliInterruptOutput.stdout,
    "interrupt",
  );
  if (
    recoveredCliInterrupt.turnHandle !== cliSpawnData.turnHandle ||
    recoveredCliInterrupt.status !== "accepted"
  )
    throw new Error("The installed CLI did not recover interrupt acceptance");
  const cliInterruptWait = await runInstalledCliResult(
    [
      "wait",
      cliSpawnData.turnHandle as string,
      "--completion",
      "all",
      "--timeout",
      "0",
    ],
    "installed-cli-interrupt-remains-pending",
  );
  const cliInterruptWaitEnvelope = readJsonRecord(
    "installed CLI wait after accepted interrupt",
    cliInterruptWait.stdout,
  );
  if (
    cliInterruptWait.status !== 4 ||
    !isRecord(cliInterruptWaitEnvelope.data) ||
    !isRecord(cliInterruptWaitEnvelope.data.result) ||
    cliInterruptWaitEnvelope.data.result.status !== "timeout" ||
    !Array.isArray(cliInterruptWaitEnvelope.data.result.pending) ||
    !isRecord(cliInterruptWaitEnvelope.data.result.pending[0]) ||
    cliInterruptWaitEnvelope.data.result.pending[0].turnHandle !==
      cliSpawnData.turnHandle
  )
    throw new Error("The installed CLI treated interrupt ACK as completion");
  const cliInterruptRequests = readJsonLines(controlCliObservations).filter(
    ({ type }) => type === "interrupt_requested",
  );
  if (
    cliInterruptRequests.length !== 1 ||
    cliInterruptRequests[0]?.sessionId !== cliSpawnData.sessionHandle ||
    cliInterruptRequests[0]?.turnId !==
      (cliSpawnData.turnHandle as string).split("/")[1]?.split(".")[0]
  )
    throw new Error("The installed CLI replayed or retargeted the interrupt");

  const disconnectedSdk = await runSdkControl(
    "disconnect-first-fact",
    "installed-sdk-disconnect-first-fact",
    {
      ...controlCliEnv,
      REINS_TARGET_SESSION: cliSpawnData.sessionHandle as string,
    },
  );
  const deliveredFactCount = disconnectedSdk.deliveredFactCount;
  const queuedFactCount = disconnectedSdk.queuedFactCount;
  const deliveredFactIds = disconnectedSdk.deliveredFactIds;
  if (
    typeof disconnectedSdk.checkpoint !== "string" ||
    disconnectedSdk.code !== "daemon_disconnected" ||
    disconnectedSdk.cursorMatchesDeliveredFact !== true ||
    typeof queuedFactCount !== "number" ||
    !Number.isInteger(queuedFactCount) ||
    queuedFactCount < 1 ||
    typeof deliveredFactCount !== "number" ||
    !Number.isInteger(deliveredFactCount) ||
    deliveredFactCount < 2 ||
    !Array.isArray(deliveredFactIds) ||
    !deliveredFactIds.every((factId) => typeof factId === "string") ||
    deliveredFactIds.length !== deliveredFactCount
  )
    throw new Error(
      "The installed SDK did not preserve the last queued-and-delivered fact cursor on disconnect",
    );
  const sdkDeliveredFactIds = deliveredFactIds as string[];
  const cliDisconnectSocket = join(controlCliDirectory, "attach-proxy.sock");
  const cliDisconnectProxy = await startUnixConnectionProxy({
    socketPath: cliDisconnectSocket,
    targetPath: controlCliSocket,
  });
  const cliDisconnectChild = spawn(
    frozenCli,
    [
      "attach",
      cliSpawnData.sessionHandle as string,
      "--scope",
      "session",
      "--replay",
      "available",
    ],
    {
      cwd: applicationConsumerDirectory,
      env: { ...controlCliEnv, REINS_SOCKET: cliDisconnectSocket },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const cliDisconnectLog = join(
    logsDirectory,
    "installed-cli-queued-disconnect.log",
  );
  const cliDisconnectObserved = observe(cliDisconnectChild, cliDisconnectLog);
  try {
    const readyDeadline = Date.now() + 10_000;
    let observedFactCount = 0;
    while (observedFactCount < deliveredFactCount) {
      const partialFrames = cliDisconnectObserved
        .stdout()
        .toString("utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      observedFactCount = partialFrames.filter(
        (frame) => frame.kind === "record" && frame.variant === "fact",
      ).length;
      if (observedFactCount >= deliveredFactCount) break;
      if (!cliDisconnectObserved.running())
        throw new Error("The installed CLI exited before replaying its facts");
      if (Date.now() >= readyDeadline)
        throw new Error(
          "The installed CLI did not replay queued facts in time",
        );
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    await cliDisconnectProxy.close();
    const disconnectedCliExit = await cliDisconnectObserved.completion;
    const cliDisconnectStdout = cliDisconnectObserved.stdout().toString("utf8");
    const cliDisconnectStderr = cliDisconnectObserved.stderr().toString("utf8");
    if (disconnectedCliExit.exitCode !== 70)
      throw new Error(
        `The installed CLI did not report a typed disconnect: exit=${disconnectedCliExit.exitCode}\n${cliDisconnectStderr}`,
      );
    const cliDisconnectFrames = readJsonLineRecords(
      "installed CLI queued disconnect",
      cliDisconnectStdout,
    );
    const cliDisconnectFacts = cliDisconnectFrames
      .filter((frame) => frame.kind === "record" && frame.variant === "fact")
      .map((frame) => {
        if (!isRecord(frame.data) || !isRecord(frame.data.fact))
          throw new Error("The installed CLI emitted a malformed fact record");
        return frame.data.fact;
      });
    const cliDisconnectFailures = readJsonLineRecords(
      "installed CLI queued disconnect failure",
      cliDisconnectStderr,
    );
    const cliDisconnectFailure = cliDisconnectFailures.at(-1);
    if (
      JSON.stringify(cliDisconnectFacts.map((fact) => fact.factId)) !==
        JSON.stringify(sdkDeliveredFactIds) ||
      !isRecord(cliDisconnectFailure?.data) ||
      !isRecord(cliDisconnectFailure.data.failure) ||
      !isRecord(cliDisconnectFailure.data.failure.facts) ||
      cliDisconnectFailure.data.failure.code !== "daemon_disconnected" ||
      cliDisconnectFailure.data.failure.facts.resumeCursor !==
        disconnectedSdk.checkpoint
    )
      throw new Error(
        "The installed CLI failure cursor did not match its last queued-and-delivered fact",
      );
    recorder.record("installed_cli_queued_disconnect", {
      exitCode: disconnectedCliExit.exitCode,
      logPath: cliDisconnectLog,
      deliveredFactCount: cliDisconnectFacts.length,
      deliveredFactIds: cliDisconnectFacts.map((fact) => fact.factId),
      checkpoint: disconnectedSdk.checkpoint,
      failure: cliDisconnectFailure.data.failure,
    });
  } finally {
    await cliDisconnectProxy.close();
    if (cliDisconnectObserved.running())
      await cliDisconnectObserved.stop(2_000);
  }
  await waitForPathRemoval(cliDisconnectSocket, 5_000);
  assertProcessRunning("The disconnected SDK worker", cliWorkerReady.workerPid);
  assertProcessRunning(
    "The disconnected SDK descendant",
    cliWorkerReady.descendantPid,
  );
  if (
    readJsonLines(controlCliObservations).some(
      ({ type }) => type === "terminate_called",
    )
  )
    throw new Error("Closing the installed SDK observer killed its session");
  const cliPreparedKillOutput = await runInstalledCli(
    ["prepare-operation", "kill"],
    "installed-cli-prepare-kill",
  );
  const cliPreparedKillData = readDataEnvelope(
    "installed CLI prepare kill",
    cliPreparedKillOutput.stdout,
    "prepareOperation",
  );
  if (
    cliPreparedKillData.operation !== "kill" ||
    typeof cliPreparedKillData.credential !== "string"
  )
    throw new Error("The installed CLI did not prepare a kill credential");
  assertProcessRunning("The prepared CLI worker", cliWorkerReady.workerPid);
  assertProcessRunning(
    "The prepared CLI descendant",
    cliWorkerReady.descendantPid,
  );
  if (
    readJsonLines(controlCliObservations).some(
      ({ type }) => type === "terminate_called",
    )
  )
    throw new Error("The installed CLI performed cleanup while preparing kill");
  const cliKillOutput = await runInstalledCli(
    [
      "kill",
      "--session",
      cliSpawnData.sessionHandle,
      "--operation",
      cliPreparedKillData.credential,
    ],
    "installed-cli-kill",
  );
  const cliKillData = readDataEnvelope(
    "installed CLI kill",
    cliKillOutput.stdout,
    "kill",
  );
  if (
    cliKillData.sessionHandle !== cliSpawnData.sessionHandle ||
    cliKillData.status !== "killed"
  )
    throw new Error("The installed CLI did not confirm real session cleanup");
  if (
    !readJsonLines(controlCliObservations).some(
      ({ attempt, type }) => type === "terminate_finished" && attempt === 1,
    )
  )
    throw new Error(
      "The installed CLI acknowledged kill before cleanup finished",
    );
  assertProcessStopped("The installed CLI worker", cliWorkerReady.workerPid);
  assertProcessStopped(
    "The installed CLI descendant",
    cliWorkerReady.descendantPid,
  );
  const cliActivityAtKill = readJsonLines(controlCliActivity);
  for (const role of ["worker", "descendant"]) {
    if (
      cliActivityAtKill.filter(
        (fact) =>
          fact.type === "closed" &&
          fact.role === role &&
          (fact.pid === cliWorkerReady.workerPid ||
            fact.pid === cliWorkerReady.descendantPid),
      ).length !== 1
    )
      throw new Error(
        `The installed CLI did not close the ${role} descriptor before kill success`,
      );
  }
  const sdkFactReplay = await runSdkControl(
    "replay-facts",
    "installed-sdk-fact-replay",
    {
      ...controlCliEnv,
      REINS_TARGET_SESSION: cliSpawnData.sessionHandle as string,
      REINS_RESUME_CURSOR: disconnectedSdk.checkpoint,
      REINS_RESUME_FACT_COUNT: String(deliveredFactCount),
    },
  );
  if (
    !Array.isArray(sdkFactReplay.facts) ||
    !Array.isArray(sdkFactReplay.resumedFacts) ||
    sdkFactReplay.facts.length < 2 ||
    sdkFactReplay.replayed !==
      sdkFactReplay.facts.length - deliveredFactCount ||
    sdkFactReplay.checkpointWasDelivered !== true ||
    sdkFactReplay.resumedAfterDisconnect !== true ||
    typeof sdkFactReplay.endReason !== "string"
  )
    throw new Error("The installed SDK did not establish exact fact replay");
  const cliAttachOutput = await runInstalledCli(
    [
      "attach",
      cliSpawnData.sessionHandle as string,
      "--scope",
      "session",
      "--replay",
      "available",
    ],
    "installed-cli-attach-available",
  );
  const cliAttachFrames = readJsonLineRecords(
    "installed CLI attach",
    cliAttachOutput.stdout,
  );
  const cliFacts = cliAttachFrames
    .filter((frame) => frame.kind === "record" && frame.variant === "fact")
    .map((frame) => {
      if (!isRecord(frame.data) || !isRecord(frame.data.fact))
        throw new Error("The installed CLI emitted a malformed fact record");
      return frame.data.fact;
    });
  const cliEstablished = cliAttachFrames.find(
    (frame) => frame.kind === "record" && frame.variant === "established",
  );
  const cliEnded = cliAttachFrames.find(
    (frame) => frame.kind === "record" && frame.variant === "ended",
  );
  if (
    canonicalJson(cliFacts) !== canonicalJson(sdkFactReplay.facts) ||
    !isRecord(cliEstablished?.data) ||
    !isRecord(cliEstablished.data.establishment) ||
    !isRecord(cliEstablished.data.establishment.window) ||
    cliEstablished.data.establishment.replayed !== cliFacts.length ||
    !isRecord(cliEnded?.data) ||
    !isRecord(cliEnded.data.end) ||
    cliEnded.data.end.reason !== sdkFactReplay.endReason ||
    cliFacts.some((fact) =>
      ["sessionId", "turnId", "eventId", "messageId", "toolCallId"].some(
        (key) => key in fact,
      ),
    )
  )
    throw new Error(
      "The installed CLI did not expose the same stable domain facts as the SDK",
    );
  const cliTextAttach = await runInstalledCli(
    [
      "attach",
      cliSpawnData.sessionHandle as string,
      "--scope",
      "session",
      "--replay",
      "available",
      "--output-format",
      "text",
    ],
    "installed-cli-attach-text",
  );
  if (
    !cliTextAttach.stdout.includes("Created session ") ||
    !cliTextAttach.stdout.includes("[turn started] ") ||
    !cliTextAttach.stdout.includes("[session killed] ") ||
    cliTextAttach.stdout.includes('"factId"')
  )
    throw new Error(
      "The installed CLI did not render replayed facts through its text projection",
    );
  await waitForPathRemoval(controlCliSocket, 15_000);
  await waitForPathRemoval(`${controlCliSocket}.lock`, 5_000);
  const staleCliSpawn = await runInstalledCliResult(
    cliSpawnArgs,
    "installed-cli-stale-spawn-credential",
  );
  const staleCliSpawnData = readFailureEnvelope(
    "installed CLI stale spawn credential",
    staleCliSpawn,
    "spawn",
    "operationFailed",
  );
  const staleCliSend = await runInstalledCliResult(
    cliSendArgs,
    "installed-cli-stale-send-credential",
  );
  const staleCliSendData = readFailureEnvelope(
    "installed CLI stale send credential",
    staleCliSend,
    "send",
    "operationFailed",
  );
  const staleCliInterrupt = await runInstalledCliResult(
    cliInterruptArgs,
    "installed-cli-stale-interrupt-credential",
  );
  const staleCliInterruptData = readFailureEnvelope(
    "installed CLI stale interrupt credential",
    staleCliInterrupt,
    "interrupt",
    "operationFailed",
  );
  if (
    staleCliSpawn.status !== 70 ||
    !isRecord(staleCliSpawnData.failure) ||
    staleCliSpawnData.failure.code !== "stale_command_id" ||
    staleCliSend.status !== 70 ||
    !isRecord(staleCliSendData.failure) ||
    staleCliSendData.failure.code !== "stale_command_id" ||
    staleCliInterrupt.status !== 70 ||
    !isRecord(staleCliInterruptData.failure) ||
    staleCliInterruptData.failure.code !== "stale_command_id" ||
    readJsonLines(controlCliObservations).filter(
      ({ type }) => type === "worker_started",
    ).length !== 1
  )
    throw new Error(
      "The installed CLI did not reject its previous-generation credential without starting a worker",
    );
  await waitForPathRemoval(controlCliSocket, 15_000);
  await waitForPathRemoval(`${controlCliSocket}.lock`, 5_000);
  recorder.record("installed_cli_operation_recovery", {
    responseLoss: lostCliSpawnData.failure,
    droppedAcknowledgement: cliSpawnAcknowledgement,
    recovered: cliSpawnData,
    staleGeneration: staleCliSpawnData.failure,
    sendResponseLoss: lostCliSendData.failure,
    sendAcknowledgement: cliSendAcknowledgement,
    sendRecovered: recoveredCliSend,
    sendConflict: conflictingCliSendData.failure,
    sendDeliveryCount: cliDeliveredMessages.length,
    interruptResponseLoss: lostCliInterruptData.failure,
    interruptAcknowledgement: cliInterruptAcknowledgement,
    interruptRecovered: recoveredCliInterrupt,
    interruptPending: cliInterruptWaitEnvelope.data.result,
    interruptRequestCount: cliInterruptRequests.length,
    staleSend: staleCliSendData.failure,
    staleInterrupt: staleCliInterruptData.failure,
    workerStartCount: 1,
  });
  recorder.record("frozen_consumer_cli_session_control", {
    spawn: cliSpawnData,
    list: cliListData,
    kill: cliKillData,
    factCount: cliFacts.length,
    factIds: cliFacts.map((fact) => fact.factId),
    replayedAfterCheckpoint: sdkFactReplay.replayed,
    disconnectedCheckpoint: disconnectedSdk.checkpoint,
    disconnectCode: disconnectedSdk.code,
    endReason: sdkFactReplay.endReason,
    structuredAttachRecords: cliAttachFrames.length,
    textAttachBytes: Buffer.byteLength(cliTextAttach.stdout),
    workerSpec: cliWorkerStarted.spec,
    workerPids: [cliWorkerReady.workerPid, cliWorkerReady.descendantPid],
    descriptorsClosed: ["worker", "descendant"],
    daemonSocketRemoved: true,
  });

  // 使用正式冻结安装的 SDK-only 与 runtime+SDK consumers，通过生产 daemon、Unix
  // socket、已有注册 adapter 和真实 worker 覆盖权限与诊断闭环。
  const permissionDirectory = join(runtimeDirectory, "permission-diagnostics");
  mkdirSync(permissionDirectory);
  const permissionSocket = join(permissionDirectory, "reins.sock");
  const permissionWorkspace = join(permissionDirectory, "workspace");
  mkdirSync(permissionWorkspace);
  const permissionObservations = join(
    permissionDirectory,
    "adapter-observations.ndjson",
  );
  const permissionActivity = join(
    permissionDirectory,
    "worker-activity.ndjson",
  );
  const permissionEnv: NodeJS.ProcessEnv = {
    ...process.env,
    REINS_SOCKET: permissionSocket,
    REINS_STATE_DIR: join(permissionDirectory, "state"),
    REINS_ADAPTERS_MODULE: adaptersModule,
    REINS_CONSUMER_CONTEXT: "packed-permission-diagnostics",
    REINS_IDLE_TIMEOUT_MS: "10000",
    REINS_PACKED_FIXTURE_OBSERVATIONS: permissionObservations,
    REINS_PACKED_FIXTURE_ACTIVITY: permissionActivity,
    REINS_PACKED_FIXTURE_REJECT_PERMISSION_FILE: join(
      permissionDirectory,
      "reject-permission",
    ),
    REINS_WORKER_CWD: permissionWorkspace,
  };
  owned.directDaemon = await startDaemon({
    label: "packed permission and diagnostics daemon",
    executable: daemon,
    args: [],
    env: permissionEnv,
    socketPath: permissionSocket,
    logPath: join(logsDirectory, "permission-diagnostics-daemon.log"),
    readyTimeoutMs: 5_000,
  });
  const runPermissionCli = (
    args: string[],
    label: string,
    env: NodeJS.ProcessEnv = permissionEnv,
  ): Promise<CommandResult> => runInstalledCli(args, label, env);
  const runPermissionCliResult = (
    args: string[],
    label: string,
    env: NodeJS.ProcessEnv = permissionEnv,
  ): Promise<CommandResult> => runInstalledCliResult(args, label, env);
  const runPermissionSdk = (
    mode: string,
    label: string,
    extraEnv: NodeJS.ProcessEnv = {},
  ): Promise<Record<string, unknown>> =>
    runSdkControl(mode, label, { ...permissionEnv, ...extraEnv });
  const spawnPermissionSession = async (
    sessionName: string,
    label: string,
    message = "packed-permission",
  ): Promise<{ sessionHandle: string; turnHandle: string }> => {
    const prepared = await runPermissionCli(
      ["prepare-operation", "spawn"],
      `${label}-prepare-spawn`,
    );
    const preparedData = readDataEnvelope(
      `${label} spawn credential`,
      prepared.stdout,
      "prepareOperation",
    );
    if (typeof preparedData.credential !== "string")
      throw new Error(`${label} omitted its spawn credential`);
    const spawned = await runPermissionCli(
      [
        "spawn",
        "--operation",
        preparedData.credential,
        "--name",
        sessionName,
        "--harness",
        "fixture",
        "--message",
        message,
        "--cwd",
        permissionWorkspace,
      ],
      `${label}-spawn`,
    );
    const data = readDataEnvelope(`${label} spawn`, spawned.stdout, "spawn");
    if (
      typeof data.sessionHandle !== "string" ||
      typeof data.turnHandle !== "string"
    )
      throw new Error(`${label} omitted its public session handles`);
    return {
      sessionHandle: data.sessionHandle,
      turnHandle: data.turnHandle,
    };
  };
  const observePermission = async (
    sessionHandle: string,
    label: string,
    feedback = false,
  ): Promise<Record<string, unknown>> => {
    const observed = await runPermissionSdk("observe-permission", label, {
      REINS_TARGET_SESSION: sessionHandle,
    });
    if (
      observed.sessionHandle !== sessionHandle ||
      typeof observed.permissionHandle !== "string" ||
      !Array.isArray(observed.options) ||
      canonicalJson(observed.options) !==
        canonicalJson([
          { outcome: "allow", scope: "once" },
          { outcome: "deny", feedback },
        ])
    )
      throw new Error(
        `${label} did not expose the exact observed permission menu`,
      );
    return observed;
  };
  const preparePermissionIntent = async (
    permissionHandle: string,
    label: string,
  ): Promise<{ intent: string; path: string }> => {
    const prepared = await runPermissionSdk("prepare-permission", label, {
      REINS_PERMISSION_HANDLE: permissionHandle,
    });
    if (prepared.prepared !== true || typeof prepared.intent !== "string")
      throw new Error(`${label} did not prepare a serializable decision`);
    const path = join(permissionDirectory, `${label}.json`);
    writeFileSync(path, prepared.intent, "utf8");
    const persisted = readFileSync(path, "utf8");
    if (persisted !== prepared.intent)
      throw new Error(`${label} did not survive persistence`);
    return { intent: persisted, path };
  };
  const permissionSessions: string[] = [];
  const killPermissionSession = async (
    sessionHandle: string,
    label: string,
  ): Promise<void> => {
    const prepared = await runPermissionCli(
      ["prepare-operation", "kill"],
      `${label}-prepare-kill`,
    );
    const preparedData = readDataEnvelope(
      `${label} kill credential`,
      prepared.stdout,
      "prepareOperation",
    );
    if (typeof preparedData.credential !== "string")
      throw new Error(`${label} omitted its kill credential`);
    const killed = await runPermissionCli(
      [
        "kill",
        "--session",
        sessionHandle,
        "--operation",
        preparedData.credential,
      ],
      `${label}-kill`,
    );
    const data = readDataEnvelope(`${label} kill`, killed.stdout, "kill");
    if (data.status !== "killed" || data.sessionHandle !== sessionHandle)
      throw new Error(`${label} did not clean up its actual worker`);
  };
  const readPermissionSession = async (
    sessionHandle: string,
    label: string,
  ): Promise<Record<string, unknown>> => {
    const listed = await runPermissionCli(
      ["list", "--session", sessionHandle],
      label,
    );
    const data = readDataEnvelope(label, listed.stdout, "list");
    if (!Array.isArray(data.sessions) || !isRecord(data.sessions[0]))
      throw new Error(`${label} omitted the exact session`);
    return data.sessions[0];
  };
  const waitForPermissionPrompt = async (
    session: { sessionHandle: string; turnHandle: string },
    label: string,
    action:
      | "prepare-allow"
      | "eof"
      | "interrupt"
      | "prepare-deny-feedback"
      | "feedback-interrupt"
      | "kill-during-feedback",
  ): Promise<{
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stdout: string;
    readonly stderr: string;
  }> => {
    const child = spawn(
      frozenCli,
      [
        "--output-format",
        "text",
        "attach",
        session.turnHandle,
        "--scope",
        "turn",
        "--replay",
        "available",
      ],
      {
        cwd: applicationConsumerDirectory,
        env: permissionEnv,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const observed = observe(child, join(logsDirectory, `${label}.log`));
    try {
      const promptDeadline = Date.now() + 10_000;
      while (!observed.stdout().toString("utf8").includes("Choose (1-2):")) {
        if (!observed.running())
          throw new Error(
            `${label} exited before asking for a permission choice`,
          );
        if (Date.now() >= promptDeadline)
          throw new Error(`${label} did not show the observed permission menu`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (action === "prepare-allow") child.stdin?.end("1\n");
      else if (action === "eof") child.stdin?.end();
      else if (action === "interrupt") {
        if (!child.kill("SIGINT"))
          throw new Error(`${label} could not receive SIGINT`);
      } else {
        child.stdin?.write("2\n");
        const feedbackDeadline = Date.now() + 10_000;
        while (
          !observed.stdout().toString("utf8").includes("Feedback (optional):")
        ) {
          if (!observed.running())
            throw new Error(`${label} exited before requesting feedback`);
          if (Date.now() >= feedbackDeadline)
            throw new Error(`${label} did not request the selected feedback`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (action === "prepare-deny-feedback")
          child.stdin?.end("The selected reason\n");
        else if (action === "feedback-interrupt") {
          if (!child.kill("SIGINT"))
            throw new Error(`${label} could not receive SIGINT at feedback`);
        } else
          await killPermissionSession(session.sessionHandle, `${label}-kill`);
      }
      const exit = await waitForObservedExit(label, observed, 10_000);
      return {
        ...exit,
        stdout: observed.stdout().toString("utf8"),
        stderr: observed.stderr().toString("utf8"),
      };
    } finally {
      child.stdin?.destroy();
      if (observed.running()) await observed.stop(2_000);
    }
  };

  const menuSession = await spawnPermissionSession(
    "permission-menu",
    "installed-cli-permission-menu",
  );
  permissionSessions.push(menuSession.sessionHandle);
  const menuFact = await observePermission(
    menuSession.sessionHandle,
    "installed-sdk-observe-permission-menu",
  );
  const mismatchIntent = await preparePermissionIntent(
    menuFact.permissionHandle as string,
    "installed-sdk-permission-mismatch-intent",
  );
  const beforeMismatchAttempts = readJsonLines(permissionObservations).filter(
    ({ sessionId, type }) =>
      sessionId === menuSession.sessionHandle && type === "permission_resolved",
  ).length;
  const mismatch = await runPermissionSdk(
    "permission-mismatch-replay",
    "installed-sdk-permission-mismatch-replay",
    { REINS_OPERATION_INTENT_JSON: mismatchIntent.intent },
  );
  if (
    !isRecord(mismatch.mismatch) ||
    mismatch.mismatch.code !== "permission_resolution_mismatch" ||
    !isRecord(mismatch.replay) ||
    canonicalJson(mismatch.mismatch) !== canonicalJson(mismatch.replay) ||
    !isRecord(mismatch.conflict) ||
    mismatch.conflict.code !== "command_id_conflict" ||
    readJsonLines(permissionObservations).filter(
      ({ sessionId, type }) =>
        sessionId === menuSession.sessionHandle &&
        type === "permission_resolved",
    ).length !== beforeMismatchAttempts
  )
    throw new Error(
      "The installed SDK did not ledger menu mismatch before adapter execution",
    );
  const cliPermissionCredential = await runPermissionCli(
    ["prepare-operation", "resolve-permission"],
    "installed-cli-prepare-permission-resolution",
  );
  const cliPermissionCredentialData = readDataEnvelope(
    "installed CLI permission credential",
    cliPermissionCredential.stdout,
    "prepareOperation",
  );
  if (typeof cliPermissionCredentialData.credential !== "string")
    throw new Error(
      "The installed CLI omitted its prepared permission credential",
    );
  const cliPermissionResolution = await runPermissionCli(
    [
      "resolve-permission",
      menuFact.permissionHandle as string,
      "--outcome",
      "allow",
      "--scope",
      "once",
      "--operation",
      cliPermissionCredentialData.credential,
    ],
    "installed-cli-permission-resolution",
  );
  const cliPermissionResolutionData = readDataEnvelope(
    "installed CLI permission resolution",
    cliPermissionResolution.stdout,
    "resolvePermission",
  );
  const menuResolutionCalls = readJsonLines(permissionObservations).filter(
    ({ sessionId, type }) =>
      sessionId === menuSession.sessionHandle && type === "permission_resolved",
  );
  if (
    cliPermissionResolutionData.status !== "resolved" ||
    cliPermissionResolutionData.permissionHandle !==
      menuFact.permissionHandle ||
    menuResolutionCalls.length !== 1 ||
    canonicalJson(menuResolutionCalls[0]?.resolution) !==
      canonicalJson({ outcome: "allow", scope: "once" })
  )
    throw new Error(
      "The installed CLI did not resolve the exact SDK-observed option",
    );

  const lostAckSession = await spawnPermissionSession(
    "permission-lost-ack",
    "installed-sdk-permission-lost-ack",
  );
  permissionSessions.push(lostAckSession.sessionHandle);
  const lostAckFact = await observePermission(
    lostAckSession.sessionHandle,
    "installed-sdk-observe-permission-for-recovery",
  );
  const lostAckIntent = await preparePermissionIntent(
    lostAckFact.permissionHandle as string,
    "installed-sdk-permission-recovery-intent",
  );
  const permissionAckProxyPath = join(
    permissionDirectory,
    "resolve-permission-ack-proxy.sock",
  );
  owned.acknowledgementProxy = await startUnixAcknowledgementProxy({
    socketPath: permissionAckProxyPath,
    targetPath: permissionSocket,
    method: "resolvePermission",
  });
  let lostPermissionAck: Record<string, unknown> | undefined;
  let recoveredPermissionDecision: Record<string, unknown> | undefined;
  try {
    const unknown = await runPermissionSdk(
      "resolve-permission-drop",
      "installed-sdk-permission-drop-ack",
      {
        REINS_SOCKET: owned.acknowledgementProxy.socketPath,
        REINS_OPERATION_INTENT_JSON: lostAckIntent.intent,
      },
    );
    lostPermissionAck =
      await owned.acknowledgementProxy.waitForDroppedAcknowledgement();
    if (
      unknown.code !== "command_outcome_unknown" ||
      unknown.stage !== "operation" ||
      lostPermissionAck.method !== "resolvePermission" ||
      !isRecord(lostPermissionAck.result) ||
      lostPermissionAck.result.sessionId !== lostAckSession.sessionHandle
    )
      throw new Error(
        "The installed SDK did not classify the real permission ACK loss",
      );
  } finally {
    await owned.acknowledgementProxy.close();
    owned.acknowledgementProxy = undefined;
  }
  recoveredPermissionDecision = await runPermissionSdk(
    "resolve-permission",
    "installed-sdk-permission-recover-ack",
    { REINS_OPERATION_INTENT_JSON: lostAckIntent.intent },
  );
  const lostAckResolutionCalls = readJsonLines(permissionObservations).filter(
    ({ sessionId, type }) =>
      sessionId === lostAckSession.sessionHandle &&
      type === "permission_resolved",
  );
  if (
    !isRecord(recoveredPermissionDecision.result) ||
    recoveredPermissionDecision.result.status !== "resolved" ||
    recoveredPermissionDecision.result.permissionHandle !==
      lostAckFact.permissionHandle ||
    lostAckResolutionCalls.length !== 1
  )
    throw new Error(
      "The installed SDK recovery duplicated or changed permission delivery",
    );

  const promptSession = await spawnPermissionSession(
    "permission-prompt",
    "installed-cli-permission-prompt",
  );
  permissionSessions.push(promptSession.sessionHandle);
  const chosen = await waitForPermissionPrompt(
    promptSession,
    "installed-cli-permission-prompt-choice",
    "prepare-allow",
  );
  if (
    chosen.exitCode !== 0 ||
    chosen.signal !== null ||
    chosen.stderr !== "" ||
    !chosen.stdout.includes("Permission requested: file_access") ||
    !chosen.stdout.includes("1) Allow once") ||
    !chosen.stdout.includes("2) Deny") ||
    !chosen.stdout.includes("Permission response prepared (not executed):") ||
    chosen.stdout.includes("[turn completed]") ||
    chosen.stdout.includes("[attach ended]")
  )
    throw new Error(
      "The installed CLI did not return the selected permission intent",
    );
  const preparedPrefix = "Permission response prepared (not executed): ";
  const preparedLine = chosen.stdout
    .split(/\r?\n/u)
    .find((line) => line.includes(preparedPrefix));
  const preparedOffset =
    preparedLine === undefined ? -1 : preparedLine.indexOf(preparedPrefix);
  const preparedResponse: unknown =
    preparedLine === undefined || preparedOffset === -1
      ? undefined
      : JSON.parse(preparedLine.slice(preparedOffset + preparedPrefix.length));
  if (
    !isRecord(preparedResponse) ||
    typeof preparedResponse.permissionHandle !== "string" ||
    typeof preparedResponse.credential !== "string" ||
    canonicalJson(preparedResponse.resolution) !==
      canonicalJson({ outcome: "allow", scope: "once" }) ||
    preparedResponse.permissionHandle === "" ||
    preparedResponse.credential === ""
  )
    throw new Error(
      "The installed CLI omitted the exact pre-execution permission intent",
    );
  const interactivePermissionIntentPath = join(
    permissionDirectory,
    "interactive-permission-intent.json",
  );
  writeFileSync(
    interactivePermissionIntentPath,
    canonicalJson(preparedResponse),
    { mode: 0o600 },
  );
  const persistedPreparedResponse: unknown = JSON.parse(
    readFileSync(interactivePermissionIntentPath, "utf8"),
  );
  if (
    !isRecord(persistedPreparedResponse) ||
    canonicalJson(persistedPreparedResponse) !== canonicalJson(preparedResponse)
  )
    throw new Error(
      "The installed CLI permission intent did not survive caller persistence",
    );
  const promptResolutionCallsBeforeExecute = readJsonLines(
    permissionObservations,
  ).filter(
    ({ sessionId, type }) =>
      sessionId === promptSession.sessionHandle &&
      type === "permission_resolved",
  );
  if (promptResolutionCallsBeforeExecute.length !== 0)
    throw new Error(
      "The installed CLI executed a permission response before returning its credential",
    );

  const preparedResolutionArgs = [
    "resolve-permission",
    persistedPreparedResponse.permissionHandle as string,
    "--outcome",
    "allow",
    "--scope",
    "once",
    "--operation",
    persistedPreparedResponse.credential as string,
  ];
  const interactivePermissionProxyPath = join(
    permissionDirectory,
    "interactive-permission-ack-proxy.sock",
  );
  owned.acknowledgementProxy = await startUnixAcknowledgementProxy({
    socketPath: interactivePermissionProxyPath,
    targetPath: permissionSocket,
    method: "resolvePermission",
  });
  try {
    const unknownPermissionResponse = await runPermissionCliResult(
      preparedResolutionArgs,
      "installed-cli-interactive-permission-drop-ack",
      {
        ...permissionEnv,
        REINS_SOCKET: owned.acknowledgementProxy.socketPath,
      },
    );
    const permissionAcknowledgement =
      await owned.acknowledgementProxy.waitForDroppedAcknowledgement();
    const unknownPermissionData = readFailureEnvelope(
      "installed CLI interactive permission response loss",
      unknownPermissionResponse,
      "resolvePermission",
      "operationFailed",
    );
    const resolvedPermissionCalls = readJsonLines(
      permissionObservations,
    ).filter(
      ({ sessionId, type }) =>
        sessionId === promptSession.sessionHandle &&
        type === "permission_resolved",
    );
    if (
      unknownPermissionResponse.status !== 70 ||
      !isRecord(unknownPermissionData.failure) ||
      unknownPermissionData.failure.code !== "command_outcome_unknown" ||
      !isRecord(unknownPermissionData.failure.facts) ||
      unknownPermissionData.failure.facts.operation !== "resolvePermission" ||
      permissionAcknowledgement.method !== "resolvePermission" ||
      !isRecord(permissionAcknowledgement.result) ||
      permissionAcknowledgement.result.sessionId !==
        promptSession.sessionHandle ||
      resolvedPermissionCalls.length !== 1 ||
      canonicalJson(resolvedPermissionCalls[0]?.resolution) !==
        canonicalJson({ outcome: "allow", scope: "once" })
    )
      throw new Error(
        "The installed CLI did not retain the selected permission operation after ACK loss",
      );
  } finally {
    await owned.acknowledgementProxy.close();
    owned.acknowledgementProxy = undefined;
  }
  const recoveredInteractivePermission = await runPermissionCli(
    preparedResolutionArgs,
    "installed-cli-interactive-permission-recover-ack",
  );
  const recoveredInteractivePermissionData = readDataEnvelope(
    "installed CLI interactive permission recovery",
    recoveredInteractivePermission.stdout,
    "resolvePermission",
  );
  const recoveredPermissionCalls = readJsonLines(permissionObservations).filter(
    ({ sessionId, type }) =>
      sessionId === promptSession.sessionHandle &&
      type === "permission_resolved",
  );
  if (
    recoveredInteractivePermissionData.permissionHandle !==
      preparedResponse.permissionHandle ||
    recoveredInteractivePermissionData.status !== "resolved" ||
    recoveredPermissionCalls.length !== 1
  )
    throw new Error(
      "The installed CLI could not recover the exact prepared permission operation",
    );
  const interactivePermissionConflict = await runPermissionCliResult(
    [
      "resolve-permission",
      preparedResponse.permissionHandle,
      "--outcome",
      "deny",
      "--operation",
      preparedResponse.credential,
    ],
    "installed-cli-interactive-permission-conflict",
  );
  const interactivePermissionConflictData = readFailureEnvelope(
    "installed CLI interactive permission conflict",
    interactivePermissionConflict,
    "resolvePermission",
    "operationFailed",
  );
  const permissionCallsAfterConflict = readJsonLines(
    permissionObservations,
  ).filter(
    ({ sessionId, type }) =>
      sessionId === promptSession.sessionHandle &&
      type === "permission_resolved",
  );
  if (
    interactivePermissionConflict.status !== 70 ||
    !isRecord(interactivePermissionConflictData.failure) ||
    interactivePermissionConflictData.failure.code !== "command_id_conflict" ||
    permissionCallsAfterConflict.length !== 1
  )
    throw new Error(
      "The installed CLI accepted changed permission parameters for the saved credential",
    );

  const feedbackSession = await spawnPermissionSession(
    "permission-feedback",
    "installed-cli-permission-feedback",
    "packed-permission-feedback",
  );
  permissionSessions.push(feedbackSession.sessionHandle);
  await observePermission(
    feedbackSession.sessionHandle,
    "installed-sdk-observe-permission-feedback-menu",
    true,
  );
  const feedbackResult = await waitForPermissionPrompt(
    feedbackSession,
    "installed-cli-permission-feedback-result",
    "prepare-deny-feedback",
  );
  const feedbackResolutionCalls = readJsonLines(permissionObservations).filter(
    ({ sessionId, type }) =>
      sessionId === feedbackSession.sessionHandle &&
      type === "permission_resolved",
  );
  if (
    feedbackResult.exitCode !== 0 ||
    feedbackResult.signal !== null ||
    feedbackResult.stderr !== "" ||
    !feedbackResult.stdout.includes("Feedback (optional):") ||
    !feedbackResult.stdout.includes(
      "Permission response prepared (not executed):",
    ) ||
    feedbackResult.stdout.includes("[turn completed]") ||
    feedbackResolutionCalls.length !== 0
  )
    throw new Error(
      "The installed CLI did not prepare the selected denial response before execution",
    );
  const feedbackPreparedLine = feedbackResult.stdout
    .split(/\r?\n/u)
    .find((line) => line.includes(preparedPrefix));
  const feedbackPreparedOffset =
    feedbackPreparedLine === undefined
      ? -1
      : feedbackPreparedLine.indexOf(preparedPrefix);
  const feedbackPreparedResponse: unknown =
    feedbackPreparedLine === undefined || feedbackPreparedOffset === -1
      ? undefined
      : JSON.parse(
          feedbackPreparedLine.slice(
            feedbackPreparedOffset + preparedPrefix.length,
          ),
        );
  if (
    !isRecord(feedbackPreparedResponse) ||
    typeof feedbackPreparedResponse.permissionHandle !== "string" ||
    typeof feedbackPreparedResponse.credential !== "string" ||
    canonicalJson(feedbackPreparedResponse.resolution) !==
      canonicalJson({ outcome: "deny", feedback: "The selected reason" })
  )
    throw new Error(
      "The installed CLI changed or omitted the selected permission feedback",
    );

  const feedbackInterruptedSession = await spawnPermissionSession(
    "permission-feedback-interrupted",
    "installed-cli-permission-feedback-interrupted",
    "packed-permission-feedback",
  );
  permissionSessions.push(feedbackInterruptedSession.sessionHandle);
  const feedbackInterrupted = await waitForPermissionPrompt(
    feedbackInterruptedSession,
    "installed-cli-permission-feedback-sigint",
    "feedback-interrupt",
  );
  const feedbackInterruptedSessionState = await readPermissionSession(
    feedbackInterruptedSession.sessionHandle,
    "installed-cli-permission-feedback-sigint-session-state",
  );
  const feedbackInterruptedCalls = readJsonLines(permissionObservations).filter(
    ({ sessionId, type }) =>
      sessionId === feedbackInterruptedSession.sessionHandle &&
      type === "permission_resolved",
  );
  if (
    feedbackInterrupted.exitCode !== 0 ||
    feedbackInterrupted.signal !== null ||
    feedbackInterrupted.stderr !== "" ||
    !feedbackInterrupted.stdout.includes("Feedback (optional):") ||
    feedbackInterrupted.stdout.includes(
      "Permission response prepared (not executed):",
    ) ||
    !feedbackInterrupted.stdout.includes("[attach ended] closed") ||
    feedbackInterrupted.stdout.includes("[turn completed]") ||
    feedbackInterruptedSessionState.state !== "busy" ||
    feedbackInterruptedCalls.length !== 0
  )
    throw new Error(
      "The installed CLI left denial feedback open after SIGINT or resolved it",
    );

  const feedbackEndedSession = await spawnPermissionSession(
    "permission-feedback-ended",
    "installed-cli-permission-feedback-ended",
    "packed-permission-feedback",
  );
  permissionSessions.push(feedbackEndedSession.sessionHandle);
  const feedbackEnded = await waitForPermissionPrompt(
    feedbackEndedSession,
    "installed-cli-permission-feedback-session-ended",
    "kill-during-feedback",
  );
  const feedbackEndedSessionState = await readPermissionSession(
    feedbackEndedSession.sessionHandle,
    "installed-cli-permission-feedback-ended-session-state",
  );
  const feedbackEndedCalls = readJsonLines(permissionObservations).filter(
    ({ sessionId, type }) =>
      sessionId === feedbackEndedSession.sessionHandle &&
      type === "permission_resolved",
  );
  if (
    feedbackEnded.exitCode !== 0 ||
    feedbackEnded.signal !== null ||
    feedbackEnded.stderr !== "" ||
    !feedbackEnded.stdout.includes("Feedback (optional):") ||
    feedbackEnded.stdout.includes(
      "Permission response prepared (not executed):",
    ) ||
    !/\[attach ended\] (?:killed|session_killed)\b/u.test(
      feedbackEnded.stdout,
    ) ||
    feedbackEnded.stdout.includes("[turn completed]") ||
    feedbackEndedSessionState.state !== "killed" ||
    feedbackEndedCalls.length !== 0
  )
    throw new Error(
      "The installed CLI left denial feedback open after the subscription ended",
    );
  permissionSessions.splice(
    permissionSessions.indexOf(feedbackEndedSession.sessionHandle),
    1,
  );

  const eofSession = await spawnPermissionSession(
    "permission-eof",
    "installed-cli-permission-eof",
  );
  permissionSessions.push(eofSession.sessionHandle);
  const eof = await waitForPermissionPrompt(
    eofSession,
    "installed-cli-permission-eof-prompt",
    "eof",
  );
  const eofSessionState = await readPermissionSession(
    eofSession.sessionHandle,
    "installed-cli-permission-eof-session-state",
  );
  const eofResolutionCalls = readJsonLines(permissionObservations).filter(
    ({ sessionId, type }) =>
      sessionId === eofSession.sessionHandle && type === "permission_resolved",
  );
  if (
    eof.exitCode !== 65 ||
    eof.signal !== null ||
    !eof.stdout.includes("Permission requested: file_access") ||
    eof.stderr !==
      "error: Permission input ended before the response was prepared\n" ||
    eofSessionState.state !== "busy" ||
    eofResolutionCalls.length !== 0
  )
    throw new Error(
      "The installed CLI treated permission input EOF as an allow or completion",
    );

  const interruptedSession = await spawnPermissionSession(
    "permission-interrupted",
    "installed-cli-permission-interrupted",
  );
  permissionSessions.push(interruptedSession.sessionHandle);
  const interrupted = await waitForPermissionPrompt(
    interruptedSession,
    "installed-cli-permission-sigint-prompt",
    "interrupt",
  );
  const interruptedSessionState = await readPermissionSession(
    interruptedSession.sessionHandle,
    "installed-cli-permission-sigint-session-state",
  );
  const interruptedResolutionCalls = readJsonLines(
    permissionObservations,
  ).filter(
    ({ sessionId, type }) =>
      sessionId === interruptedSession.sessionHandle &&
      type === "permission_resolved",
  );
  if (
    interrupted.exitCode !== 0 ||
    interrupted.signal !== null ||
    interrupted.stderr !== "" ||
    !interrupted.stdout.includes("Permission requested: file_access") ||
    !interrupted.stdout.includes("[attach ended] closed") ||
    interrupted.stdout.includes("[turn completed]") ||
    interruptedSessionState.state !== "busy" ||
    interruptedResolutionCalls.length !== 0
  )
    throw new Error(
      "The installed CLI reported SIGINT as a permission decision or turn completion",
    );

  for (const [index, sessionHandle] of permissionSessions.entries())
    await killPermissionSession(
      sessionHandle,
      `permission-session-cleanup-${index + 1}`,
    );
  const permissionDaemon = owned.directDaemon;
  const permissionDaemonStop = await stopDaemon(permissionDaemon, 5_000);
  owned.directDaemon = undefined;
  if (!isCleanStop(permissionDaemonStop))
    throw new Error(
      `Permission daemon did not stop cleanly: ${JSON.stringify(permissionDaemonStop)}`,
    );
  await waitForPathRemoval(permissionSocket, 5_000);
  await waitForPathRemoval(`${permissionSocket}.lock`, 5_000);
  owned.directDaemon = await startDaemon({
    label: "restarted packed permission daemon",
    executable: daemon,
    args: [],
    env: permissionEnv,
    socketPath: permissionSocket,
    logPath: join(logsDirectory, "restarted-permission-daemon.log"),
    readyTimeoutMs: 5_000,
  });
  const beforeStalePermissionAttempts = readJsonLines(
    permissionObservations,
  ).filter(({ type }) => type === "permission_resolved").length;
  const stalePermission = await runPermissionSdk(
    "permission-stale",
    "installed-sdk-stale-permission-credential",
    { REINS_OPERATION_INTENT_JSON: mismatchIntent.intent },
  );
  if (
    stalePermission.code !== "stale_command_id" ||
    readJsonLines(permissionObservations).filter(
      ({ type }) => type === "permission_resolved",
    ).length !== beforeStalePermissionAttempts
  )
    throw new Error(
      "The installed SDK replayed an old permission credential in a new daemon generation",
    );

  const harnessFailure = await runPermissionSdk(
    "harness-failure-diagnostics",
    "installed-sdk-typed-harness-failure",
  );
  const completedFailure = harnessFailure.completed;
  const harnessDiagnostic = harnessFailure.diagnostic;
  if (
    !isRecord(completedFailure) ||
    completedFailure.stopReason !== "failed" ||
    !isRecord(completedFailure.failure) ||
    completedFailure.failure.failureCategory !== "rate_limited" ||
    completedFailure.failure.retryDisposition !== "wait" ||
    typeof completedFailure.diagnosticId !== "string" ||
    !isRecord(harnessDiagnostic) ||
    harnessDiagnostic.diagnosticId !== completedFailure.diagnosticId ||
    harnessDiagnostic.source !== "adapter" ||
    harnessDiagnostic.kind !== "turn_failure" ||
    typeof harnessFailure.sessionHandle !== "string" ||
    typeof harnessFailure.turnHandle !== "string" ||
    harnessDiagnostic.sessionHandle !== harnessFailure.sessionHandle ||
    harnessDiagnostic.turnHandle !== harnessFailure.turnHandle ||
    "sessionId" in harnessDiagnostic ||
    "turnId" in harnessDiagnostic
  )
    throw new Error(
      "The installed SDK did not expose queryable typed Harness failure evidence",
    );
  const cliHarnessDiagnostic = await runPermissionCli(
    ["diagnostics", "--id", completedFailure.diagnosticId],
    "installed-cli-query-harness-diagnostic",
  );
  const cliHarnessDiagnosticData = readDataEnvelope(
    "installed CLI Harness diagnostic query",
    cliHarnessDiagnostic.stdout,
    "diagnostics",
  );
  if (
    !isRecord(cliHarnessDiagnosticData.record) ||
    canonicalJson(cliHarnessDiagnosticData.record) !==
      canonicalJson(harnessDiagnostic)
  )
    throw new Error(
      "The installed CLI did not query the SDK's exact diagnostic record",
    );
  const harnessSessionHandle = String(harnessFailure.sessionHandle);
  const harnessTurnHandle = String(harnessFailure.turnHandle);
  const cliTurnDiagnostic = await runPermissionCli(
    ["diagnostics", "--turn", harnessTurnHandle],
    "installed-cli-query-diagnostic-by-turn",
  );
  const cliTurnDiagnosticData = readDataEnvelope(
    "installed CLI diagnostic query by turn",
    cliTurnDiagnostic.stdout,
    "diagnostics",
  );
  if (
    !Array.isArray(cliTurnDiagnosticData.records) ||
    !cliTurnDiagnosticData.records.some(
      (record) =>
        isRecord(record) &&
        record.diagnosticId === completedFailure.diagnosticId,
    )
  )
    throw new Error(
      "The installed CLI did not query diagnostics with only a turn handle",
    );
  const invalidTurnCli = await runPermissionCliResult(
    ["diagnostics", "--session", harnessSessionHandle, "--turn", "invalid"],
    "installed-cli-invalid-diagnostic-turn",
  );
  const invalidTurnCliData = readFailureEnvelope(
    "installed CLI invalid diagnostic turn",
    invalidTurnCli,
    "diagnostics",
    "queryFailed",
  );
  const invalidTurnFailure = invalidTurnCliData.failure;
  if (
    invalidTurnCli.status !== 70 ||
    `${invalidTurnCli.stdout}\n${invalidTurnCli.stderr}`.match(
      /ValiError|projectDiagnosticsParams|at .*\.js:/u,
    ) !== null ||
    !isRecord(invalidTurnFailure) ||
    invalidTurnFailure.code !== "invalid_params" ||
    !isRecord(invalidTurnFailure.facts) ||
    !Array.isArray(invalidTurnFailure.facts.issues) ||
    !invalidTurnFailure.facts.issues.some(
      (issue) =>
        isRecord(issue) &&
        issue.issue === "invalid_value" &&
        issue.path === "turnHandle",
    )
  )
    throw new Error(
      "The installed CLI did not type an invalid diagnostic turn handle",
    );
  const mismatchedTurnCli = await runPermissionCliResult(
    ["diagnostics", "--session", "different@g1", "--turn", harnessTurnHandle],
    "installed-cli-mismatched-diagnostic-session",
  );
  const mismatchedTurnCliData = readFailureEnvelope(
    "installed CLI mismatched diagnostic session",
    mismatchedTurnCli,
    "diagnostics",
    "queryFailed",
  );
  const mismatchedTurnFailure = mismatchedTurnCliData.failure;
  if (
    mismatchedTurnCli.status !== 70 ||
    !isRecord(mismatchedTurnFailure) ||
    mismatchedTurnFailure.code !== "invalid_params" ||
    !isRecord(mismatchedTurnFailure.facts) ||
    !Array.isArray(mismatchedTurnFailure.facts.issues) ||
    !mismatchedTurnFailure.facts.issues.some(
      (issue) =>
        isRecord(issue) &&
        issue.issue === "invalid_combination" &&
        Array.isArray(issue.paths) &&
        issue.paths.includes("sessionHandle") &&
        issue.paths.includes("turnHandle"),
    )
  )
    throw new Error(
      "The installed CLI accepted a mismatched diagnostic session handle",
    );

  const rejectedPermissionSession = await spawnPermissionSession(
    "permission-diagnostic-failure",
    "installed-cli-permission-diagnostic-failure",
  );
  const rejectedPermissionFact = await observePermission(
    rejectedPermissionSession.sessionHandle,
    "installed-sdk-observe-permission-before-diagnostic-failure",
  );
  const rejectedPermissionIntent = await preparePermissionIntent(
    rejectedPermissionFact.permissionHandle as string,
    "installed-sdk-permission-diagnostic-failure-intent",
  );
  const rejectPermissionPath =
    permissionEnv.REINS_PACKED_FIXTURE_REJECT_PERMISSION_FILE;
  if (rejectPermissionPath === undefined)
    throw new Error("The permission failure fixture path was not configured");
  writeFileSync(rejectPermissionPath, "reject", "utf8");
  const activeDiagnosticsPath = join(
    permissionEnv.REINS_STATE_DIR as string,
    "diagnostics",
    "active.ndjson",
  );
  const savedDiagnosticsPath = `${activeDiagnosticsPath}.saved`;
  if (!existsSync(activeDiagnosticsPath))
    throw new Error(
      "The production diagnostics store did not create its active file",
    );
  renameSync(activeDiagnosticsPath, savedDiagnosticsPath);
  mkdirSync(activeDiagnosticsPath);
  const rejectedPermission = await runPermissionSdk(
    "permission-failure-replay",
    "installed-sdk-permission-diagnostic-write-failure",
    { REINS_OPERATION_INTENT_JSON: rejectedPermissionIntent.intent },
  );
  if (
    !isRecord(rejectedPermission.failure) ||
    rejectedPermission.failure.code !== "internal_error" ||
    !isRecord(rejectedPermission.failure.facts) ||
    !isRecord(rejectedPermission.failure.facts.cause) ||
    rejectedPermission.failure.facts.cause.kind !== "exception" ||
    typeof rejectedPermission.failure.facts.cause.message !== "string" ||
    !rejectedPermission.failure.facts.cause.message.includes(
      "Fixture rejected permission delivery",
    ) ||
    rejectedPermission.failure.facts.diagnosticId !== undefined ||
    !isRecord(rejectedPermission.query) ||
    rejectedPermission.query.code !== "diagnostics_unavailable"
  )
    throw new Error(
      "A diagnostic file failure obscured the original permission cause",
    );
  const cliUnavailableDiagnostics = await runPermissionCliResult(
    ["diagnostics", "--id", completedFailure.diagnosticId],
    "installed-cli-diagnostics-unavailable",
  );
  const cliUnavailableDiagnosticsData = readFailureEnvelope(
    "installed CLI diagnostics unavailable",
    cliUnavailableDiagnostics,
    "diagnostics",
    "queryFailed",
  );
  if (
    cliUnavailableDiagnostics.status !== 70 ||
    !isRecord(cliUnavailableDiagnosticsData.failure) ||
    cliUnavailableDiagnosticsData.failure.code !== "diagnostics_unavailable"
  )
    throw new Error(
      "The installed CLI did not expose unavailable diagnostic storage",
    );
  rmSync(activeDiagnosticsPath, { recursive: true });
  renameSync(savedDiagnosticsPath, activeDiagnosticsPath);
  await killPermissionSession(
    rejectedPermissionSession.sessionHandle,
    "permission-diagnostic-failure-cleanup",
  );
  const finalPermissionDaemon = owned.directDaemon;
  const finalPermissionDaemonStop = await stopDaemon(
    finalPermissionDaemon,
    5_000,
  );
  owned.directDaemon = undefined;
  if (!isCleanStop(finalPermissionDaemonStop))
    throw new Error(
      `Permission diagnostics daemon did not stop cleanly: ${JSON.stringify(finalPermissionDaemonStop)}`,
    );
  await waitForPathRemoval(permissionSocket, 5_000);
  await waitForPathRemoval(`${permissionSocket}.lock`, 5_000);
  recorder.record("frozen_consumer_permission_and_diagnostics", {
    serializedPermissionIntentPath: mismatchIntent.path,
    menuOptions: menuFact.options,
    mismatch: mismatch.mismatch,
    sameCredentialReplay: mismatch.replay,
    changedParameters: mismatch.conflict,
    explicitCliResolution: cliPermissionResolutionData,
    sdkDroppedAcknowledgement: lostPermissionAck,
    sdkRecoveredResolution: recoveredPermissionDecision.result,
    interactiveChoice: chosen.stdout,
    eof: {
      exitCode: eof.exitCode,
      sessionState: eofSessionState.state,
      adapterResolutions: eofResolutionCalls.length,
    },
    sigint: {
      exitCode: interrupted.exitCode,
      sessionState: interruptedSessionState.state,
      adapterResolutions: interruptedResolutionCalls.length,
    },
    staleCredential: stalePermission.code,
    harnessFailure: completedFailure,
    sdkDiagnostic: harnessDiagnostic,
    cliDiagnostic: cliHarnessDiagnosticData.record,
    cliTurnDiagnosticCount: Array.isArray(cliTurnDiagnosticData.records)
      ? cliTurnDiagnosticData.records.length
      : 0,
    invalidDiagnosticTurn: invalidTurnFailure,
    mismatchedDiagnosticSession: mismatchedTurnFailure,
    diagnosticWriteFailure: rejectedPermission.failure,
    diagnosticReplay: rejectedPermission.replay,
    sdkQueryFailure: rejectedPermission.query,
    cliQueryFailure: cliUnavailableDiagnosticsData.failure,
    originalCauseRetained: true,
    workerCleanup: "all permission and failure sessions were terminated",
    daemonStop: finalPermissionDaemonStop,
  });

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
  const automaticListData = readDataEnvelope(
    "automatic packed list",
    automaticList.stdout,
    "list",
  );
  if (JSON.stringify(automaticListData) !== JSON.stringify({ sessions: [] })) {
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

  const startupIoDirectory = join(runtimeDirectory, "startup-io");
  mkdirSync(startupIoDirectory);
  const blockedSocketParent = join(startupIoDirectory, "socket-parent");
  writeFileSync(blockedSocketParent, "ordinary file");
  const startupIoSocket = join(blockedSocketParent, "reins.sock");
  const startupIoEnv: NodeJS.ProcessEnv = {
    ...process.env,
    REINS_SOCKET: startupIoSocket,
    REINS_STATE_DIR: join(startupIoDirectory, "state"),
    REINS_ADAPTERS_MODULE: adaptersModule,
    REINS_CONSUMER_CONTEXT: "packed-startup-io-check",
    REINS_IDLE_TIMEOUT_MS: "50",
    REINS_DAEMON_BIN: daemon,
  };
  const startupIoFailureLog = join(logsDirectory, "startup-io-failure.log");
  const startupIoFailure = toCommandResult(
    await runLoggedCommand({
      command: cli,
      args: ["list"],
      env: startupIoEnv,
      logPath: startupIoFailureLog,
    }),
  );
  if (startupIoFailure.status !== 70) {
    throw new Error(
      `Packed CLI startup IO failure returned exit ${startupIoFailure.status}\n${startupIoFailure.stdout}${startupIoFailure.stderr}\nFull log: ${startupIoFailureLog}`,
    );
  }
  const startupIoFailureData = readFailureEnvelope(
    "packed CLI startup IO failure",
    startupIoFailure,
    "list",
    "queryFailed",
  );
  if (
    !isRecord(startupIoFailureData.failure) ||
    startupIoFailureData.failure.code !== "daemon_start_failed" ||
    !isRecord(startupIoFailureData.failure.facts) ||
    startupIoFailureData.failure.facts.systemCode !== "EEXIST" ||
    !isRecord(startupIoFailureData.failure.facts.cause) ||
    startupIoFailureData.failure.facts.cause.kind !== "io"
  ) {
    throw new Error(
      `Packed CLI omitted typed startup IO facts: ${JSON.stringify(startupIoFailureData)}`,
    );
  }

  rmSync(blockedSocketParent);
  mkdirSync(blockedSocketParent);
  const startupIoRetryLog = join(logsDirectory, "startup-io-retry.log");
  const startupIoRetry = toCommandResult(
    await runLoggedCommand({
      command: cli,
      args: ["list"],
      env: startupIoEnv,
      logPath: startupIoRetryLog,
    }),
  );
  requireSuccess(
    "packed CLI retry after startup IO repair",
    startupIoRetry,
    startupIoRetryLog,
  );
  const startupIoRetryData = readDataEnvelope(
    "packed CLI retry after startup IO repair",
    startupIoRetry.stdout,
    "list",
  );
  if (JSON.stringify(startupIoRetryData) !== JSON.stringify({ sessions: [] })) {
    throw new Error(
      `Packed CLI retry returned unexpected output: ${startupIoRetry.stdout}`,
    );
  }
  await waitForPathRemoval(startupIoSocket, 5_000);
  await waitForPathRemoval(`${startupIoSocket}.lock`, 5_000);
  recorder.record("typed_startup_io_failure_and_retry", {
    failureExitCode: startupIoFailure.status,
    failure: startupIoFailureData,
    retryExitCode: startupIoRetry.status,
    retry: startupIoRetryData,
    failureLogPath: startupIoFailureLog,
    retryLogPath: startupIoRetryLog,
    socketRemoved: true,
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
    acknowledgementProxy: undefined,
    connectionProxy: undefined,
    releaseGates: [],
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
    for (const gate of owned.releaseGates) {
      try {
        writeFileSync(gate, "released", "utf8");
      } catch (error) {
        cleanupFailures.push(
          `cleanup gate release failed: ${String(error)} (${gate})`,
        );
      }
    }
    const connectionProxy = owned.connectionProxy;
    if (connectionProxy !== undefined) {
      try {
        await connectionProxy.close();
      } catch (error) {
        cleanupFailures.push(
          `connection proxy cleanup failed: ${String(error)}`,
        );
      }
      owned.connectionProxy = undefined;
    }
    const proxy = owned.acknowledgementProxy;
    if (proxy !== undefined) {
      try {
        await proxy.close();
      } catch (error) {
        cleanupFailures.push(
          `acknowledgement proxy cleanup failed: ${String(error)}`,
        );
      }
      owned.acknowledgementProxy = undefined;
    }
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
