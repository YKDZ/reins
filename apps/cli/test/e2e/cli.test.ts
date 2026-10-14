import { Buffer } from "node:buffer";
import { spawn, type ChildProcess } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  makeDiagnosticId,
  sessionIdSchema,
  turnIdSchema,
  encodeTurnHandle,
} from "@reins/protocol";
import {
  connect as connectSdk,
  ReinsSdkError,
  type AgentFact,
  type PermissionHandle,
  type ReinsConnection,
  type SessionHandle,
  type TurnHandle,
} from "@ykdz/reins-sdk";
import * as v from "valibot";
import { afterEach, describe, expect, test } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const cliBin = join(repoRoot, "apps/cli/dist/reins.js");
const daemonBin = join(repoRoot, "packages/daemon/dist/main.js");
const releaseVersion = v.parse(
  v.object({
    version: v.pipe(
      v.string(),
      v.regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u),
    ),
  }),
  JSON.parse(
    await readFile(join(repoRoot, "apps/cli/package.json"), "utf8"),
  ) as unknown,
).version;
const fixturesModule = join(
  repoRoot,
  "apps/cli/test/e2e/fixtures/fake-adapters.ts",
);
const fixtureDaemonBin = join(
  repoRoot,
  "apps/cli/test/e2e/fixtures/daemon-fixture.mjs",
);
type CliResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  pid: number;
};

function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  options?: { input?: string; timeoutMs?: number },
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, [cliBin, ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout?.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    if (options?.input !== undefined) {
      child.stdin?.write(options.input);
    }
    child.stdin?.end();
    let settled = false;
    let timedOut = false;
    let killWatchdog: NodeJS.Timeout | undefined;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killWatchdog !== undefined) clearTimeout(killWatchdog);
      resolve({
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        exitCode: code,
        pid: child.pid ?? -1,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      // SIGKILL 后仍以 close（含 stdout/stderr 排空）为主完成条件；仅为
      // 异常平台行为保留独立 watchdog，避免测试进程永久挂起。
      killWatchdog = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(-1);
      }, 2_000);
    }, options?.timeoutMs ?? 15_000);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killWatchdog !== undefined) clearTimeout(killWatchdog);
      reject(error);
    });
    child.on("close", (code) => {
      finish(timedOut ? -1 : (code ?? -1));
    });
  });
}

function startCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  input = false,
): {
  child: ChildProcess;
  stdout: string[];
  stderr: string[];
} {
  const child = spawn(process.execPath, [cliBin, ...args], {
    env: { ...process.env, ...env },
    stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout?.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  return { child, stdout, stderr };
}

function waitForExit(child: ChildProcess, timeoutMs = 5_000): Promise<number> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  if (child.signalCode !== null) return Promise.resolve(-1);
  return new Promise((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(timedOut ? -1 : (code ?? -1));
    });
  });
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 5000,
): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("等待条件超时");
    }
    await sleep(50);
  }
}

const cleanupDirs: string[] = [];
const missingSessionId = v.parse(sessionIdSchema, "missing@gfixture");

afterEach(async () => {
  for (const dir of cleanupDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function testEnv(dir: string): NodeJS.ProcessEnv {
  return {
    REINS_SOCKET: join(dir, "reins.sock"),
    REINS_STATE_DIR: join(dir, "state"),
    REINS_DAEMON_BIN: daemonBin,
    REINS_ADAPTERS_MODULE: fixturesModule,
    REINS_IDLE_TIMEOUT_MS: "300",
    REINS_CONSUMER_CONTEXT: "cli-e2e",
  };
}

async function startDaemon(env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const daemon = spawn(
    process.execPath,
    [daemonBin, "--adapters", fixturesModule],
    {
      env: { ...process.env, ...env },
      stdio: "ignore",
    },
  );
  await waitFor(() => pathExists(env.REINS_SOCKET ?? ""));
  return daemon;
}

async function stopDaemon(
  daemon: ChildProcess,
  socketPath: string,
): Promise<void> {
  const exited = new Promise<void>((resolve) =>
    daemon.once("close", () => resolve()),
  );
  daemon.kill("SIGTERM");
  await exited;
  await waitFor(async () => !(await pathExists(socketPath)));
}

async function freshEnv(): Promise<{
  dir: string;
  env: NodeJS.ProcessEnv;
  socketPath: string;
}> {
  // 小型运行状态在 Linux 使用 tmpfs，避免磁盘 fsync 延迟耗尽进程协议的超时。
  const dir = await mkdtemp(
    join(
      process.platform === "linux" ? "/dev/shm" : tmpdir(),
      "reins-cli-e2e-",
    ),
  );
  cleanupDirs.push(dir);
  return {
    dir,
    env: testEnv(dir),
    socketPath: join(dir, "reins.sock"),
  };
}

function fixtureDaemonEnv(
  env: NodeJS.ProcessEnv,
  dir: string,
  mode: string,
): NodeJS.ProcessEnv {
  return {
    ...env,
    REINS_DAEMON_BIN: fixtureDaemonBin,
    REINS_FIXTURE_DAEMON_MODE: mode,
    REINS_FIXTURE_PID_FILE: join(dir, `${mode}.pid`),
    REINS_FIXTURE_EXIT_FILE: join(dir, `${mode}.exit`),
    REINS_FIXTURE_REQUESTS_FILE: join(dir, `${mode}.requests`),
  };
}

async function waitForFixtureExit(
  env: NodeJS.ProcessEnv,
  timeoutMs = 2_000,
): Promise<void> {
  const path = env.REINS_FIXTURE_EXIT_FILE;
  if (path === undefined) throw new Error("fixture exit file is required");
  await waitFor(() => pathExists(path), timeoutMs);
  const pidPath = env.REINS_FIXTURE_PID_FILE;
  if (pidPath === undefined) throw new Error("fixture pid file is required");
  const pid = Number(await readFile(pidPath, "utf8"));
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, timeoutMs);
}

async function waitForFixtureStopped(
  env: NodeJS.ProcessEnv,
  timeoutMs = 2_000,
): Promise<void> {
  const pidPath = env.REINS_FIXTURE_PID_FILE;
  if (pidPath === undefined) throw new Error("fixture pid file is required");
  await waitFor(() => pathExists(pidPath), timeoutMs);
  const pid = Number(await readFile(pidPath, "utf8"));
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, timeoutMs);
}

type OperationData = {
  operation?: string;
  credential?: string;
  sessionHandle?: string;
  turnHandle?: string;
  cwd?: string;
  status?: string;
  permissionHandle?: string;
  sessions?: Array<Record<string, unknown>>;
  record?: Record<string, unknown>;
  records?: Array<Record<string, unknown>>;
  truncated?: boolean;
  capabilities?: Array<{ harness: string; models?: unknown[] }>;
  failures?: unknown[];
  failure?: { code?: string; facts?: Record<string, unknown> };
};

function dataFrom(result: CliResult): OperationData {
  const output = result.stdout.length > 0 ? result.stdout : result.stderr;
  const data = (JSON.parse(output) as { data?: OperationData }).data;
  if (data === undefined) throw new Error("CLI 结构化响应缺少 data");
  return data;
}

async function preparedCredential(
  env: NodeJS.ProcessEnv,
  operation: "spawn" | "send" | "kill" | "resolve-permission",
): Promise<string> {
  const result = await runCli(["prepare-operation", operation], env);
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  const prepared = dataFrom(result);
  expect(prepared.operation).toBe(operation);
  expect(prepared.credential).toEqual(expect.any(String));
  if (typeof prepared.credential !== "string") throw new Error("执行凭据缺失");
  return prepared.credential;
}

async function connectSdkForEnv(
  env: NodeJS.ProcessEnv,
): Promise<ReinsConnection> {
  const socketPath = env.REINS_SOCKET;
  const consumerContext = env.REINS_CONSUMER_CONTEXT;
  if (socketPath === undefined || consumerContext === undefined)
    throw new Error("SDK control tests require a socket and consumer binding");
  return connectSdk({ socketPath, consumerContext });
}

async function permissionRequestFor(
  connection: ReinsConnection,
  turnHandle: string,
): Promise<Extract<AgentFact, { type: "permission.requested" }>> {
  const subscription = await connection.attach(
    { scope: "turn", turnHandle: turnHandle as TurnHandle },
    { mode: "available" },
  );
  try {
    for await (const fact of subscription) {
      if (fact.type === "permission.requested") return fact;
    }
  } finally {
    subscription.close();
    await subscription.done;
  }
  throw new Error("The permission adapter emitted no request fact");
}

async function sdkFailureFor(
  action: () => Promise<unknown>,
): Promise<ReinsSdkError> {
  try {
    await action();
  } catch (error) {
    if (error instanceof ReinsSdkError) return error;
    throw error;
  }
  throw new Error("The SDK operation unexpectedly succeeded");
}

type SpawnCliInput = {
  readonly harness: string;
  readonly message: string;
  readonly name: string;
  readonly cwd?: string;
  readonly agent?: string;
  readonly model?: string;
  readonly reasoning?: string;
  readonly authorizationMode?: "interactive" | "allowAll";
  readonly sandbox?: string;
  readonly captureHarnessStderr?: boolean;
};

async function spawnWithCli(
  env: NodeJS.ProcessEnv,
  input: SpawnCliInput,
): Promise<CliResult> {
  const credential = await preparedCredential(env, "spawn");
  const args = [
    "spawn",
    "--operation",
    credential,
    "--name",
    input.name,
    "--harness",
    input.harness,
    "--message",
    input.message,
    "--cwd",
    input.cwd ?? process.cwd(),
  ];
  for (const [flag, value] of [
    ["--agent", input.agent],
    ["--model", input.model],
    ["--reasoning", input.reasoning],
    ["--authorization-mode", input.authorizationMode],
    ["--sandbox", input.sandbox],
  ] as const) {
    if (value !== undefined) args.push(flag, value);
  }
  if (input.captureHarnessStderr === true)
    args.push("--capture-harness-stderr");
  return runCli(args, env);
}

async function killWithCli(
  env: NodeJS.ProcessEnv,
  sessionHandle: string,
): Promise<CliResult> {
  const credential = await preparedCredential(env, "kill");
  return runCli(
    ["kill", "--session", sessionHandle, "--operation", credential],
    env,
  );
}

function sessionIdFrom(result: CliResult): string {
  return v.parse(sessionIdSchema, dataFrom(result).sessionHandle);
}

function turnHandleFrom(result: CliResult): string {
  const turnHandle = dataFrom(result).turnHandle;
  if (typeof turnHandle !== "string") throw new Error("spawn 结果缺少回合句柄");
  return turnHandle;
}

describe("A 类：帮助（stdout + 退出 0）", () => {
  test("--help 声明正式控制命令", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["--help"], env);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("prepare-operation");
    expect(result.stdout).toContain("capabilities");
    expect(result.stdout).toContain("spawn");
    expect(result.stdout).toContain("list");
    expect(result.stdout).toContain("kill");
  });

  test("spawn help 声明执行前凭据与显式参数", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["spawn", "--help"], env);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("--operation");
    expect(result.stdout).toContain("--harness");
    expect(result.stdout).toContain("--message");
    expect(result.stdout).toContain("--cwd");
    expect(result.stdout).toContain("--authorization-mode");
  });

  test("--version 输出 stdout", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["--version"], env);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`reins ${releaseVersion}\n`);
  });
});

describe("CLI 进程边界（缝 D）", () => {
  test("waitForExit handles an already-exited child", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    expect(await waitForExit(child, 100)).toBe(0);
  });

  test("runCli timeout waits for killed child close before returning", async () => {
    const { env, socketPath } = await freshEnv();
    const daemon = await startDaemon(env);
    let sessionId: string | undefined;
    try {
      const spawned = await spawnWithCli(env, {
        harness: "hang",
        message: "wait",
        name: "timeout-close",
      });
      sessionId = sessionIdFrom(spawned);
      const result = await runCli(
        ["attach", sessionId, "--scope", "session", "--replay", "none"],
        env,
        {
          timeoutMs: 100,
        },
      );
      expect(result.exitCode).toBe(-1);
      expect(result.stderr).toBe("");
    } finally {
      if (sessionId !== undefined) await killWithCli(env, sessionId);
      if (daemon.exitCode === null) await stopDaemon(daemon, socketPath);
    }
  });

  test("two cold CLI launchers coordinate one daemon and both connect", async () => {
    for (let round = 0; round < 10; round += 1) {
      const { dir, env } = await freshEnv();
      const fixtureEnv = fixtureDaemonEnv(env, dir, "cold-launch-barrier");
      const first = startCli(["capabilities"], fixtureEnv);
      const second = startCli(["capabilities"], fixtureEnv);
      const firstExit = waitForExit(first.child, 7_000);
      const secondExit = waitForExit(second.child, 7_000);
      expect(await Promise.all([firstExit, secondExit])).toEqual([0, 0]);
      for (const stdout of [first.stdout.join(""), second.stdout.join("")]) {
        expect(JSON.parse(stdout)).toMatchObject({
          schemaVersion: "1",
          command: "capabilities",
          kind: "data",
          variant: "result",
          data: { capabilities: [], failures: [] },
        });
      }
      const pidPath = fixtureEnv.REINS_FIXTURE_PID_FILE;
      if (pidPath === undefined)
        throw new Error("fixture pid file is required");
      const pids = (await readFile(pidPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(Number);
      expect(pids).toHaveLength(1);
      await waitForFixtureExit(fixtureEnv);
      expect(await pathExists(`${fixtureEnv.REINS_SOCKET}.lock`)).toBe(false);
    }
  }, 70_000);
  test("diagnostics returns one complete finite JSON response", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["diagnostics"], env);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(dataFrom(result)).toMatchObject({
      records: [
        { operation: "diagnostics_store", reason: "initialized" },
        { operation: "daemon", reason: "started" },
      ],
      truncated: false,
    });
  });

  test("真实 malformed transport diagnostic 经正式 CLI 输出结构化与文本", async () => {
    const { env: baseEnv, socketPath } = await freshEnv();
    const env = { ...baseEnv, REINS_IDLE_TIMEOUT_MS: "5000" };
    const daemon = await startDaemon(env);
    const secretSentinel = ["cli", "transport", "sentinel"].join("-");
    const frame = Buffer.from(
      `{"ordinary":"body","tool_result":{"content":"${secretSentinel}"}\n`,
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const raw = connect(socketPath);
        raw.once("connect", () => raw.end(frame));
        raw.once("close", () => resolve());
        raw.once("error", reject);
      });

      const json = await runCli(
        ["diagnostics", "--kind", "transport_failure"],
        env,
      );
      expect(json.exitCode).toBe(0);
      const result = dataFrom(json) as {
        records: Array<Record<string, unknown>>;
        truncated: boolean;
      };
      expect(result).toMatchObject({
        records: [
          {
            source: "daemon",
            kind: "transport_failure",
            operation: "read",
            reason: "invalid_frame",
            inputBytes: frame.length - 1,
            severity: "error",
            v: 1,
          },
        ],
        truncated: false,
      });
      expect(result.records).toHaveLength(1);
      expect(Object.keys(result.records[0] ?? {}).sort()).toEqual([
        "diagnosticId",
        "inputBytes",
        "kind",
        "operation",
        "reason",
        "recordedAt",
        "severity",
        "source",
        "v",
      ]);
      expect(json.stdout.trim().split("\n")).toHaveLength(1);

      const textOutput = await runCli(
        [
          "--output-format",
          "text",
          "diagnostics",
          "--kind",
          "transport_failure",
        ],
        env,
      );
      expect(textOutput.exitCode).toBe(0);
      expect(JSON.parse(textOutput.stdout)).toEqual(result);
      expect(
        [json.stdout, json.stderr, textOutput.stdout, textOutput.stderr].map(
          (output) => output.includes(secretSentinel),
        ),
      ).toEqual([false, false, false, false]);
      expect([json.stderr, textOutput.stderr]).toEqual(["", ""]);
    } finally {
      if (daemon.exitCode === null && daemon.signalCode === null) {
        await stopDaemon(daemon, socketPath);
      }
    }
  });

  test("legacy v1 transport TextEvidence 不进入正式 CLI 结构化与文本输出", async () => {
    const { env, socketPath } = await freshEnv();
    const stateDirectory = env.REINS_STATE_DIR;
    if (stateDirectory === undefined)
      throw new Error("state directory is required");
    const diagnosticsDirectory = join(stateDirectory, "diagnostics");
    await mkdir(diagnosticsDirectory, { recursive: true, mode: 0o700 });
    const secretSentinel = ["legacy", "cli", "sentinel"].join("-");
    const diagnosticId = makeDiagnosticId("legacy", "cli");
    const legacy = {
      source: "daemon",
      kind: "transport_failure",
      operation: "write",
      reason: "io_error",
      message: {
        text: secretSentinel,
        truncated: false,
        originalBytes: Buffer.byteLength(secretSentinel),
      },
      v: 1,
      diagnosticId,
      // 固定历史时刻会随真实时钟超出默认 7 天保留窗口，令本用例变成日期敏感；
      // 归属反例与时间无关。
      recordedAt: new Date().toISOString(),
      severity: "error",
    } as const;
    const activePath = join(diagnosticsDirectory, "active.ndjson");
    await writeFile(activePath, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
    const daemon = await startDaemon(env);
    try {
      const json = await runCli(["diagnostics", "--id", diagnosticId], env);
      expect(json.exitCode).toBe(0);
      const result = dataFrom(json) as {
        record: Record<string, unknown>;
      };
      const safeRecord = {
        source: "daemon",
        v: 1,
        diagnosticId,
        recordedAt: legacy.recordedAt,
        severity: "error",
        kind: "transport_failure",
        operation: "write",
        reason: "io_error",
      };
      expect(result).toEqual({ record: safeRecord });
      const pretty = await runCli(
        ["--output-format", "text", "diagnostics", "--id", diagnosticId],
        env,
      );
      expect(pretty.exitCode).toBe(0);
      expect(JSON.parse(pretty.stdout)).toEqual({ record: safeRecord });
      expect(
        [json.stdout, json.stderr, pretty.stdout, pretty.stderr].map((text) =>
          text.includes(secretSentinel),
        ),
      ).toEqual([false, false, false, false]);
      const canonicalFiles = (await readdir(diagnosticsDirectory)).filter(
        (name) =>
          name === "active.ndjson" || /^segment-\d{12}\.ndjson$/u.test(name),
      );
      const canonicalText = await Promise.all(
        canonicalFiles.map(
          async (name) =>
            await readFile(join(diagnosticsDirectory, name), "utf8"),
        ),
      );
      expect(canonicalText.some((text) => text.includes(secretSentinel))).toBe(
        false,
      );
    } finally {
      if (daemon.exitCode === null && daemon.signalCode === null) {
        await stopDaemon(daemon, socketPath);
      }
    }
  });

  test("diagnostics rejects exact id combined with filters before daemon use", async () => {
    const { dir, env } = await freshEnv();
    const fixtureEnv = fixtureDaemonEnv(
      env,
      dir,
      "diagnostics-invalid-combination",
    );
    const result = await runCli(
      ["diagnostics", "--id", "d1-098", "--harness", "fake"],
      fixtureEnv,
    );
    expect(result.exitCode).toBe(64);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      schemaVersion: "1",
      command: "diagnostics",
      kind: "usageFailure",
      issues: [{ code: "inputRejected" }],
    });
    expect(await pathExists(fixtureEnv.REINS_FIXTURE_PID_FILE ?? "")).toBe(
      false,
    );
  });

  test.each([
    [
      "since must not follow until",
      [
        "diagnostics",
        "--since",
        "2026-01-02T00:00:00.000Z",
        "--until",
        "2026-01-01T00:00:00.000Z",
      ],
    ],
    ["limit has an inclusive lower bound", ["diagnostics", "--limit", "0"]],
    ["limit has an inclusive upper bound", ["diagnostics", "--limit", "1001"]],
    ["limit is an integer", ["diagnostics", "--limit", "1.5"]],
  ])("diagnostics validates $0 locally", async (_name, args) => {
    const { dir, env } = await freshEnv();
    const fixtureEnv = fixtureDaemonEnv(env, dir, "diagnostics-invalid-input");
    const result = await runCli(args, fixtureEnv);
    expect(result.exitCode).toBe(64);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      schemaVersion: "1",
      command: "diagnostics",
      kind: "usageFailure",
      issues: [{ code: "inputRejected" }],
    });
    expect(await pathExists(fixtureEnv.REINS_FIXTURE_PID_FILE ?? "")).toBe(
      false,
    );
  });

  test("拒绝保留会话名且不创建会话", async () => {
    const { env } = await freshEnv();
    const result = await spawnWithCli(env, {
      harness: "fake",
      message: "hello",
      name: "daemon",
    });
    expect(result.exitCode).toBe(70);
    expect(dataFrom(result).failure).toMatchObject({
      code: "invalid_params",
      facts: { issues: [{ issue: "invalid_value", path: "sessionName" }] },
    });
    const listed = await runCli(["list"], env);
    expect(listed.exitCode).toBe(0);
    expect(dataFrom(listed).sessions).toEqual([]);
  });

  test("explicit stderr capture persists bounded UTF-8 evidence", async () => {
    const { env } = await freshEnv();
    const spawned = await spawnWithCli(env, {
      harness: "capture",
      message: "hello",
      name: "capture-session",
      captureHarnessStderr: true,
    });
    expect(spawned.exitCode).toBe(0);
    const sessionId = sessionIdFrom(spawned);
    await waitFor(async () => {
      const queried = await runCli(
        ["diagnostics", "--session", sessionId, "--kind", "harness_stderr"],
        env,
      );
      return dataFrom(queried).records?.length === 3;
    });
    const queried = await runCli(
      ["diagnostics", "--session", sessionId, "--kind", "harness_stderr"],
      env,
    );
    const record = (
      dataFrom(queried) as {
        records: Array<{
          text: { text: string; truncated: boolean; originalBytes: number };
        }>;
      }
    ).records[0];
    expect(record?.text).toMatchObject({
      truncated: true,
      originalBytes: 20_000,
    });
    expect(Buffer.byteLength(record?.text.text ?? "", "utf8")).toBe(16 * 1024);
    const all = dataFrom(queried) as {
      records: Array<{
        diagnosticId: string;
        recordedAt: string;
        sessionHandle: string;
        turnHandle: string;
      }>;
    };
    const first = all.records[0]!;
    const exact = await runCli(
      ["diagnostics", "--id", first.diagnosticId],
      env,
    );
    expect(dataFrom(exact)).toMatchObject({
      record: { diagnosticId: first.diagnosticId },
    });
    const turnOnly = await runCli(
      ["diagnostics", "--turn", first.turnHandle],
      env,
    );
    expect(turnOnly.exitCode).toBe(0);
    expect(dataFrom(turnOnly).records?.length).toBeGreaterThan(0);
    const connection = await connectSdkForEnv(env);
    try {
      const turnRecords = await connection.diagnostics({
        turnHandle: first.turnHandle as TurnHandle,
      });
      expect(
        "records" in turnRecords ? turnRecords.records.length : 0,
      ).toBeGreaterThan(0);
      const malformedHandle = await sdkFailureFor(() =>
        connection.diagnostics({ turnHandle: "invalid" as TurnHandle }),
      );
      expect(malformedHandle.stage).toBe("query");
      expect(malformedHandle.failure).toMatchObject({
        code: "invalid_params",
        facts: { issues: [{ issue: "invalid_value", path: "turnHandle" }] },
      });
      const mismatchedSession = await sdkFailureFor(() =>
        connection.diagnostics({
          sessionHandle: missingSessionId as unknown as SessionHandle,
          turnHandle: first.turnHandle as TurnHandle,
        }),
      );
      expect(mismatchedSession.failure).toMatchObject({
        code: "invalid_params",
        facts: {
          issues: [
            {
              issue: "invalid_combination",
              paths: ["sessionHandle", "turnHandle"],
            },
          ],
        },
      });
    } finally {
      connection.close();
    }
    const malformedCli = await runCli(
      ["diagnostics", "--session", sessionId, "--turn", "invalid"],
      env,
    );
    expect(malformedCli.exitCode).toBe(70);
    expect(`${malformedCli.stdout}\n${malformedCli.stderr}`).not.toMatch(
      /ValiError|projectDiagnosticsParams|at .*\.js:/u,
    );
    expect(dataFrom(malformedCli).failure).toMatchObject({
      code: "invalid_params",
      facts: { issues: [{ issue: "invalid_value", path: "turnHandle" }] },
    });
    const mismatchedCli = await runCli(
      [
        "diagnostics",
        "--session",
        missingSessionId,
        "--turn",
        first.turnHandle,
      ],
      env,
    );
    expect(mismatchedCli.exitCode).toBe(70);
    expect(dataFrom(mismatchedCli).failure).toMatchObject({
      code: "invalid_params",
      facts: {
        issues: [
          {
            issue: "invalid_combination",
            paths: ["sessionHandle", "turnHandle"],
          },
        ],
      },
    });
    for (const args of [
      ["--session", sessionId],
      ["--session", sessionId, "--turn", first.turnHandle],
      ["--session", sessionId, "--harness", "capture", "--source", "harness"],
      ["--harness", "capture"],
      ["--source", "harness", "--source", "adapter"],
      ["--kind", "harness_stderr"],
      ["--min-severity", "info"],
      ["--since", first.recordedAt, "--until", first.recordedAt],
    ]) {
      const filtered = await runCli(["diagnostics", ...args], env);
      expect(
        filtered.exitCode,
        `${JSON.stringify(args)}\n${filtered.stdout}\n${filtered.stderr}`,
      ).toBe(0);
      expect(dataFrom(filtered).records?.length).toBeGreaterThan(0);
    }
    const excludedByAnd = await runCli(
      ["diagnostics", "--session", sessionId, "--harness", "fake"],
      env,
    );
    expect(dataFrom(excludedByAnd)).toEqual({
      records: [],
      truncated: false,
    });
    const latest = await runCli(
      ["diagnostics", "--session", sessionId, "--limit", "1"],
      env,
    );
    expect(dataFrom(latest)).toMatchObject({
      records: [
        expect.objectContaining({
          diagnosticId: all.records.at(-1)?.diagnosticId,
        }),
      ],
      truncated: true,
    });
    const empty = await runCli(["diagnostics", "--harness", "none"], env);
    expect(dataFrom(empty)).toEqual({ records: [], truncated: false });
    const missing = await runCli(["diagnostics", "--id", "d1-098"], env);
    expect(missing.exitCode).toBe(65);
    expect(dataFrom(missing).failure).toMatchObject({
      code: "diagnostic_not_found",
    });
    const pretty = await runCli(
      ["--output-format", "text", "diagnostics", "--id", first.diagnosticId],
      env,
    );
    expect(pretty.stdout).toContain("harness_stderr");
    await killWithCli(env, sessionId);
  });

  test("unsupported stderr capture rejects before session creation", async () => {
    const { env } = await freshEnv();
    const result = await spawnWithCli(env, {
      harness: "fake",
      message: "hello",
      name: "no-capture",
      captureHarnessStderr: true,
    });
    expect(result.exitCode).toBe(70);
    expect(dataFrom(result).failure).toMatchObject({
      code: "unsupported_feature",
      facts: { feature: "capture_harness_stderr" },
    });
    const sessions = await runCli(["list", "--name", "no-capture"], env);
    expect(dataFrom(sessions).sessions).toEqual([]);
  });

  test("capabilities 输出能力矩阵（JSON 默认）", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["capabilities"], env);
    expect(result.exitCode).toBe(0);
    const parsed = dataFrom(result);
    expect(parsed.failures).toEqual([]);
    expect(parsed.capabilities?.map((entry) => entry.harness).sort()).toEqual([
      "cancelled",
      "capture",
      "failed",
      "fake",
      "hang",
      "permission",
    ]);
  });

  test("spawn 返回本代会话与回合句柄", async () => {
    const { env } = await freshEnv();
    const result = await spawnWithCli(env, {
      harness: "fake",
      message: "hello",
      name: "test-session",
    });
    expect(result.exitCode).toBe(0);
    const sessionId = sessionIdFrom(result);
    expect(sessionId).toMatch(/@g/u);
    expect(turnHandleFrom(result).startsWith(`${sessionId}/`)).toBe(true);
    expect(dataFrom(result).cwd).toBe(process.cwd());
    await killWithCli(env, sessionId);
  });

  test("spawn 接受合法 --authorization-mode", async () => {
    const { env } = await freshEnv();
    const result = await spawnWithCli(env, {
      harness: "fake",
      message: "hi",
      name: "test-session",
      authorizationMode: "allowAll",
    });
    expect(result.exitCode).toBe(0);
    const sessionId = sessionIdFrom(result);
    expect(sessionId).toMatch(/@g/u);
    await killWithCli(env, sessionId);
  });

  test("killing a session aborts an outstanding pretty permission prompt", async () => {
    const { env } = await freshEnv();
    const spawned = await spawnWithCli(env, {
      harness: "permission",
      message: "do it",
      name: "prompt-kill",
    });
    const sessionId = sessionIdFrom(spawned);
    const attached = startCli(
      [
        "--output-format",
        "text",
        "attach",
        turnHandleFrom(spawned),
        "--scope",
        "turn",
        "--replay",
        "available",
      ],
      env,
      true,
    );
    await waitFor(() => attached.stdout.join("").includes("Choose (1-2):"));
    const exit = waitForExit(attached.child, 5_000);
    await killWithCli(env, sessionId);
    expect(
      await exit,
      `${attached.stdout.join("")}\n${attached.stderr.join("")}`,
    ).toBe(0);
    expect(attached.stderr.join("")).toBe("");
  });

  test("交互权限选择先返回可恢复意图，显式执行前不改变原生响应", async () => {
    const { dir, env } = await freshEnv();
    const requestsFile = join(dir, "permission-choice.requests");
    const permissionEnv = { ...env, REINS_FIXTURE_REQUESTS_FILE: requestsFile };
    const spawned = await spawnWithCli(permissionEnv, {
      harness: "permission",
      message: "do it",
      name: "prompt-choice",
    });
    const sessionId = sessionIdFrom(spawned);
    const attached = startCli(
      [
        "--output-format",
        "text",
        "attach",
        turnHandleFrom(spawned),
        "--scope",
        "turn",
        "--replay",
        "available",
      ],
      permissionEnv,
      true,
    );
    try {
      await waitFor(() => attached.stdout.join("").includes("Choose (1-2):"));
      attached.child.stdin?.end("1\n");
      expect(await waitForExit(attached.child, 5_000)).toBe(0);
      expect(attached.stderr.join("")).toBe("");
      const prefix = "Permission response prepared (not executed): ";
      const preparedOutput = attached.stdout.join("");
      const prefixIndex = preparedOutput.indexOf(prefix);
      const preparedLine =
        prefixIndex === -1
          ? undefined
          : preparedOutput.slice(prefixIndex + prefix.length).split(/\r?\n/u)[0];
      if (preparedLine === undefined)
        throw new Error("permission intent was not returned");
      const prepared: unknown = JSON.parse(preparedLine);
      if (
        prepared === null ||
        typeof prepared !== "object" ||
        !("permissionHandle" in prepared) ||
        typeof prepared.permissionHandle !== "string" ||
        !("credential" in prepared) ||
        typeof prepared.credential !== "string"
      )
        throw new Error("permission intent was incomplete");
      expect(prepared).toMatchObject({
        resolution: { outcome: "allow", scope: "once" },
      });
      expect(await pathExists(requestsFile)).toBe(false);

      const resolved = await runCli(
        [
          "resolve-permission",
          prepared.permissionHandle,
          "--outcome",
          "allow",
          "--scope",
          "once",
          "--operation",
          prepared.credential,
        ],
        permissionEnv,
      );
      expect(resolved.exitCode).toBe(0);
      expect(dataFrom(resolved)).toMatchObject({
        permissionHandle: prepared.permissionHandle,
        status: "resolved",
      });
      expect(await readFile(requestsFile, "utf8")).toBe("p1\n");
    } finally {
      attached.child.stdin?.destroy();
      if (
        attached.child.exitCode === null &&
        attached.child.signalCode === null
      ) {
        attached.child.kill("SIGKILL");
        await waitForExit(attached.child, 2_000);
      }
      await killWithCli(permissionEnv, sessionId);
    }
  });

  test("未提供的权限选项在原生响应前拒绝", async () => {
    const { dir, env: baseEnv } = await freshEnv();
    const requestsFile = join(dir, "permission-choice-invalid.requests");
    const permissionEnv = {
      ...baseEnv,
      REINS_FIXTURE_REQUESTS_FILE: requestsFile,
    };
    const spawned = await spawnWithCli(permissionEnv, {
      harness: "permission",
      message: "do it",
      name: "invalid-prompt-choice",
    });
    const sessionId = sessionIdFrom(spawned);
    const attached = startCli(
      [
        "--output-format",
        "text",
        "attach",
        turnHandleFrom(spawned),
        "--scope",
        "turn",
        "--replay",
        "available",
      ],
      permissionEnv,
      true,
    );
    try {
      await waitFor(() => attached.stdout.join("").includes("Choose (1-2):"));
      attached.child.stdin?.end("3\n");
      expect(await waitForExit(attached.child, 5_000)).toBe(64);
      const output = `${attached.stdout.join("")}\n${attached.stderr.join("")}`;
      expect(output).toContain("Choose one of the offered permission options");
      expect(output).not.toContain("Permission response prepared");
      expect(output).not.toContain("[turn completed]");
      expect(await pathExists(requestsFile)).toBe(false);

      const listed = await runCli(
        ["list", "--session", sessionId],
        permissionEnv,
      );
      expect(dataFrom(listed).sessions?.[0]).toMatchObject({ state: "busy" });
    } finally {
      attached.child.stdin?.destroy();
      if (
        attached.child.exitCode === null &&
        attached.child.signalCode === null
      ) {
        attached.child.kill("SIGKILL");
        await waitForExit(attached.child, 2_000);
      }
      await killWithCli(permissionEnv, sessionId);
    }
  });

  test("kill aborts the active prompt and clears queued permission requests", async () => {
    const { dir, env } = await freshEnv();
    const requestsFile = join(dir, "permission-kill.requests");
    const queueEnv = { ...env, REINS_FIXTURE_REQUESTS_FILE: requestsFile };
    const spawned = await spawnWithCli(queueEnv, {
      harness: "permission",
      message: "queue",
      name: "prompt-kill-queue",
    });
    const sessionId = sessionIdFrom(spawned);
    const attached = startCli(
      [
        "--output-format",
        "text",
        "attach",
        turnHandleFrom(spawned),
        "--scope",
        "turn",
        "--replay",
        "available",
      ],
      queueEnv,
      true,
    );
    const exitPromise = waitForExit(attached.child, 2_000);
    await waitFor(() => attached.stdout.join("").includes("Choose (1-2):"));
    await killWithCli(queueEnv, sessionId);
    expect(
      await exitPromise,
      `${attached.stdout.join("")}\n${attached.stderr.join("")}`,
    ).toBe(0);
    expect(await pathExists(requestsFile)).toBe(false);
    expect(
      attached.stdout.join("").match(/Permission requested:/gu),
    ).toHaveLength(1);
  });

  test("SIGINT cancels an outstanding permission prompt without deciding it", async () => {
    const { dir, env: baseEnv, socketPath } = await freshEnv();
    const requestsFile = join(dir, "prompt-interrupt.requests");
    const env = { ...baseEnv, REINS_FIXTURE_REQUESTS_FILE: requestsFile };
    const daemon = await startDaemon(env);
    let attached: ReturnType<typeof startCli> | undefined;
    let sessionHandle: string | undefined;
    try {
      const spawned = await spawnWithCli(env, {
        harness: "permission",
        message: "interrupt while prompting",
        name: "prompt-interrupt",
      });
      sessionHandle = sessionIdFrom(spawned);
      const turnHandle = turnHandleFrom(spawned);
      attached = startCli(
        [
          "--output-format",
          "text",
          "attach",
          turnHandle,
          "--scope",
          "turn",
          "--replay",
          "available",
        ],
        env,
        true,
      );
      const exitPromise = waitForExit(attached.child, 2_000);
      await waitFor(() => attached!.stdout.join("").includes("Choose (1-2):"));
      const started = Date.now();
      expect(attached.child.kill("SIGINT")).toBe(true);
      expect(
        await exitPromise,
        `${attached.stdout.join("")}\n${attached.stderr.join("")}`,
      ).toBe(0);
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(attached.stdout.join("")).toContain("[attach ended] closed");
      expect(attached.stdout.join("")).not.toContain("[turn completed]");
      expect(await pathExists(requestsFile)).toBe(false);
      const listed = await runCli(["list", "--session", sessionHandle], env);
      expect(dataFrom(listed).sessions?.[0]).toMatchObject({ state: "busy" });
    } finally {
      attached?.child.stdin?.destroy();
      if (
        attached !== undefined &&
        attached.child.exitCode === null &&
        attached.child.signalCode === null
      ) {
        attached.child.kill("SIGKILL");
        await waitForExit(attached.child, 2_000);
      }
      if (sessionHandle !== undefined && daemon.exitCode === null)
        await killWithCli(env, sessionHandle);
      if (daemon.exitCode === null && daemon.signalCode === null)
        await stopDaemon(daemon, socketPath);
    }
  });

  test("wait 超时退出码 4", async () => {
    const { env } = await freshEnv();
    const spawned = await spawnWithCli(env, {
      harness: "hang",
      message: "wait me",
      name: "test-session",
    });
    expect(spawned.exitCode).toBe(0);
    const sessionId = sessionIdFrom(spawned);
    const waited = await runCli(
      [
        "wait",
        turnHandleFrom(spawned),
        "--completion",
        "all",
        "--timeout",
        "100",
      ],
      env,
    );
    expect(waited.exitCode).toBe(4);
    expect(JSON.parse(waited.stdout)).toMatchObject({
      schemaVersion: "1",
      command: "wait",
      kind: "data",
      variant: "timeout",
      data: {
        result: {
          status: "timeout",
          completed: [],
          pending: [{ turnHandle: turnHandleFrom(spawned) }],
        },
      },
    });
    await killWithCli(env, sessionId);
  });

  test.each([
    ["structured", []],
    ["text", ["--output-format", "text"]],
  ] as const)(
    "resolve-permission %s 通过预先凭据返回 typed ack",
    async (mode, prefix) => {
      const { dir, env: baseEnv } = await freshEnv();
      const requestsFile = join(dir, `resolve-${mode}.requests`);
      const env = { ...baseEnv, REINS_FIXTURE_REQUESTS_FILE: requestsFile };
      const spawned = await spawnWithCli(env, {
        harness: "permission",
        message: "do it",
        name: `resolve-${mode}`,
      });
      const sessionId = sessionIdFrom(spawned);
      const connection = await connectSdkForEnv(env);
      let request: Extract<AgentFact, { type: "permission.requested" }>;
      try {
        request = await permissionRequestFor(
          connection,
          turnHandleFrom(spawned),
        );
      } finally {
        connection.close();
      }
      expect(request.options).toEqual([
        { outcome: "allow", scope: "once" },
        { outcome: "deny", feedback: false },
      ]);
      expect("permissionId" in request).toBe(false);
      const credential = await preparedCredential(env, "resolve-permission");
      const resolved = await runCli(
        [
          ...prefix,
          "resolve-permission",
          request.permissionHandle,
          "--outcome",
          "allow",
          "--scope",
          "once",
          "--operation",
          credential,
        ],
        env,
      );
      expect(resolved.exitCode).toBe(0);
      expect(resolved.stderr).toBe("");
      if (mode === "structured") {
        expect(dataFrom(resolved)).toEqual({
          permissionHandle: request.permissionHandle,
          status: "resolved",
        });
      } else {
        expect(resolved.stdout).toBe("Permission resolved\n");
      }
      expect(await readFile(requestsFile, "utf8")).toBe("p1\n");
      await killWithCli(env, sessionId);
    },
  );

  test("SDK 用不透明句柄与单次凭据拒绝未提供决议", async () => {
    const { dir, env: baseEnv } = await freshEnv();
    const requestsFile = join(dir, "sdk-permission.requests");
    const env = { ...baseEnv, REINS_FIXTURE_REQUESTS_FILE: requestsFile };
    const spawned = await spawnWithCli(env, {
      harness: "permission",
      message: "do it",
      name: "sdk-permission-validation",
    });
    expect(spawned.exitCode).toBe(0);
    const sessionHandle = sessionIdFrom(spawned);
    const connection = await connectSdkForEnv(env);
    try {
      const request = await permissionRequestFor(
        connection,
        turnHandleFrom(spawned),
      );
      const malformed = await sdkFailureFor(() =>
        connection.resolvePermission(
          "not-a-permission-handle" as PermissionHandle,
          { outcome: "allow", scope: "once" },
          connection.prepareOperation("resolvePermission"),
        ),
      );
      expect(malformed.failure).toEqual({
        code: "invalid_params",
        facts: {
          issues: [{ issue: "invalid_value", path: "permissionHandle" }],
        },
      });
      expect(await pathExists(requestsFile)).toBe(false);

      const rejectedCredential =
        connection.prepareOperation("resolvePermission");
      const invalidOption = { outcome: "allow", scope: "session" } as const;
      const rejected = await sdkFailureFor(() =>
        connection.resolvePermission(
          request.permissionHandle,
          invalidOption,
          rejectedCredential,
        ),
      );
      expect(rejected.failure).toEqual({
        code: "permission_resolution_mismatch",
        facts: { permissionHandle: request.permissionHandle },
      });
      const replayedFailure = await sdkFailureFor(() =>
        connection.resolvePermission(
          request.permissionHandle,
          invalidOption,
          rejectedCredential,
        ),
      );
      expect(replayedFailure.failure).toEqual(rejected.failure);
      const conflict = await sdkFailureFor(() =>
        connection.resolvePermission(
          request.permissionHandle,
          { outcome: "deny" },
          rejectedCredential,
        ),
      );
      expect(conflict.failure.code).toBe("command_id_conflict");
      expect(await pathExists(requestsFile)).toBe(false);

      const resolved = await connection.resolvePermission(
        request.permissionHandle,
        { outcome: "allow", scope: "once" },
        connection.prepareOperation("resolvePermission"),
      );
      expect(resolved).toEqual({
        permissionHandle: request.permissionHandle,
        status: "resolved",
      });
      expect(await readFile(requestsFile, "utf8")).toBe("p1\n");
      const duplicate = await sdkFailureFor(() =>
        connection.resolvePermission(
          request.permissionHandle,
          { outcome: "allow", scope: "once" },
          connection.prepareOperation("resolvePermission"),
        ),
      );
      expect(duplicate.failure).toEqual({
        code: "permission_not_pending",
        facts: { permissionHandle: request.permissionHandle },
      });
      expect(await readFile(requestsFile, "utf8")).toBe("p1\n");
    } finally {
      connection.close();
      await killWithCli(env, sessionHandle);
    }
  });

  test("自动拉起 daemon，空闲后清理 socket", async () => {
    const { env, socketPath } = await freshEnv();
    expect(await pathExists(socketPath)).toBe(false);
    const result = await runCli(["capabilities"], env);
    expect(result.exitCode).toBe(0);
    await waitFor(async () => pathExists(socketPath));
    await waitFor(async () => !(await pathExists(socketPath)), 5000);
  });

  test("daemon restart gives a new SessionId and rejects the old address", async () => {
    const { env, socketPath } = await freshEnv();
    const daemonA = await startDaemon(env);
    try {
      const first = await spawnWithCli(env, {
        harness: "fake",
        message: "first",
        name: "restart-session",
      });
      expect(first.exitCode).toBe(0);
      const oldSessionId = sessionIdFrom(first);

      await stopDaemon(daemonA, socketPath);
      const daemonB = await startDaemon(env);
      try {
        const second = await spawnWithCli(env, {
          harness: "fake",
          message: "second",
          name: "restart-session",
        });
        expect(second.exitCode).toBe(0);
        const newSessionId = sessionIdFrom(second);
        expect(newSessionId).not.toBe(oldSessionId);

        const oldAddress = await killWithCli(env, oldSessionId);
        expect(oldAddress.exitCode).toBe(0);
        expect(dataFrom(oldAddress)).toMatchObject({
          sessionHandle: oldSessionId,
          status: "not_found",
        });
        await killWithCli(env, newSessionId);
      } finally {
        await stopDaemon(daemonB, socketPath);
      }
    } catch (error) {
      if (daemonA.exitCode === null) await stopDaemon(daemonA, socketPath);
      throw error;
    }
  });
});
describe("CLI 域错误（不夹带 usage）", () => {
  test.each([
    "invalid-envelope",
    "invalid-error",
    "invalid-notification",
    "invalid-result",
  ])("完整进程拒绝 fixture daemon 的 %s", async (mode) => {
    const { dir, env } = await freshEnv();
    const fixtureEnv = fixtureDaemonEnv(env, dir, mode);
    const started = Date.now();
    const result = await runCli(["capabilities"], fixtureEnv, {
      timeoutMs: 3_000,
    });
    expect(result.exitCode).toBe(70);
    expect(result.stdout).toBe("");
    expect(dataFrom(result).failure).toMatchObject({
      code: "invalid_daemon_response",
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    await waitForFixtureExit(fixtureEnv);
  });

  test("text permission EOF is a typed terminal error on stderr", async () => {
    const { env } = await freshEnv();
    const spawned = await spawnWithCli(env, {
      harness: "permission",
      message: "do it",
      name: "prompt-eof",
    });
    expect(spawned.exitCode).toBe(0);
    const sessionId = sessionIdFrom(spawned);
    const result = await runCli(
      [
        "--output-format",
        "text",
        "attach",
        turnHandleFrom(spawned),
        "--scope",
        "turn",
        "--replay",
        "available",
      ],
      env,
      {
        timeoutMs: 3_000,
      },
    );
    expect(result.exitCode).toBe(65);
    expect(result.stdout).toContain("Permission requested:");
    expect(result.stderr).toBe(
      "error: Permission input ended before the response was prepared\n",
    );
    expect(result.stderr).not.toContain("usage:");
    await killWithCli(env, sessionId);
  });

  test("完整进程将无响应 daemon 区分为 daemon_timeout 并清理子进程", async () => {
    const { dir, env } = await freshEnv();
    const fixtureEnv = fixtureDaemonEnv(env, dir, "timeout");
    const started = Date.now();
    const result = await runCli(["capabilities"], fixtureEnv, {
      timeoutMs: 7_000,
    });
    expect(result.exitCode).toBe(70);
    expect(result.stdout).toBe("");
    expect(dataFrom(result).failure).toMatchObject({ code: "daemon_timeout" });
    expect(Date.now() - started).toBeLessThan(6_500);
    await waitForFixtureStopped(fixtureEnv);
  }, 10_000);

  test("daemon 启动失败返回 UTF-8 有界 cause 并清理子进程", async () => {
    const { dir, env } = await freshEnv();
    const fixtureEnv = fixtureDaemonEnv(env, dir, "startup-failure");
    const result = await runCli(["capabilities"], fixtureEnv, {
      timeoutMs: 7_000,
    });
    expect(result.exitCode).toBe(70);
    expect(result.stdout).toBe("");
    const failure = dataFrom(result).failure;
    expect(failure?.code).toBe("daemon_start_failed");
    const cause = failure?.facts?.cause as
      | { kind: string; message: string }
      | undefined;
    expect(cause?.kind).toBe("upstream");
    expect(cause?.message).toContain("é");
    expect(Buffer.byteLength(cause?.message ?? "", "utf8")).toBeLessThanOrEqual(
      4 * 1024,
    );
    await waitForFixtureExit(fixtureEnv);
  }, 10_000);

  test("启动报告的 transport 前缀按原始 cause 保留", async () => {
    const { dir, env } = await freshEnv();
    const fixtureEnv = fixtureDaemonEnv(
      env,
      dir,
      "startup-transport-lookalike",
    );
    const result = await runCli(["capabilities"], fixtureEnv, {
      timeoutMs: 7_000,
    });
    expect(result.exitCode).toBe(70);
    expect(dataFrom(result).failure).toMatchObject({
      code: "daemon_start_failed",
      facts: { cause: { kind: "io", message: "transport:address_in_use" } },
    });
    await waitForFixtureExit(fixtureEnv);
  }, 10_000);

  test("daemon 被 signal 终止后仍观察同 socket 到总 deadline", async () => {
    const { dir, env } = await freshEnv();
    const fixtureEnv = fixtureDaemonEnv(env, dir, "startup-signal");
    const started = Date.now();
    const result = await runCli(["capabilities"], fixtureEnv, {
      timeoutMs: 7_000,
    });
    expect(result.exitCode).toBe(70);
    expect(dataFrom(result).failure).toMatchObject({
      code: "daemon_start_failed",
      facts: {
        cause: {
          kind: "upstream",
          message: expect.stringContaining("SIGTERM"),
        },
      },
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
    expect(Date.now() - started).toBeLessThan(6_500);
    await waitForFixtureStopped(fixtureEnv);
  }, 10_000);

  test("存活但未监听的进程超时后按原始 timeout 失败并清理", async () => {
    const { dir, env } = await freshEnv();
    const fixtureEnv = fixtureDaemonEnv(env, dir, "startup-never-listens");
    const started = Date.now();
    const result = await runCli(["capabilities"], fixtureEnv, {
      timeoutMs: 7_000,
    });
    expect(result.exitCode).toBe(70);
    expect(dataFrom(result).failure).toMatchObject({
      code: "daemon_start_failed",
      facts: {
        cause: {
          kind: "timeout",
          message: "daemon failed to start within 5000ms",
        },
      },
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
    expect(Date.now() - started).toBeLessThan(6_500);
    await waitForFixtureStopped(fixtureEnv);
  }, 10_000);

  test("daemon 退出后仍排空 fd3 启动报告再解析 cause", async () => {
    const { dir, env } = await freshEnv();
    const fixtureEnv = fixtureDaemonEnv(env, dir, "startup-report-drain");
    const result = await runCli(["capabilities"], fixtureEnv, {
      timeoutMs: 7_000,
    });
    expect(result.exitCode).toBe(70);
    const cause = dataFrom(result).failure?.facts?.cause as
      | { kind: string; message: string }
      | undefined;
    expect(cause?.kind).toBe("upstream");
    expect(cause?.message).toContain("report-before-exit:界");
    expect(Buffer.byteLength(cause?.message ?? "", "utf8")).toBeLessThanOrEqual(
      4 * 1024,
    );
    await waitForFixtureExit(fixtureEnv);
  }, 10_000);

  test("daemon 运行超过一秒后写入的完整启动报告仍保留 cause", async () => {
    const { dir, env } = await freshEnv();
    const fixtureEnv = fixtureDaemonEnv(env, dir, "startup-report-late");
    const result = await runCli(["capabilities"], fixtureEnv, {
      timeoutMs: 7_000,
    });
    expect(result.exitCode).toBe(70);
    expect(dataFrom(result).failure).toMatchObject({
      code: "daemon_start_failed",
      facts: {
        cause: { kind: "upstream", message: "late complete startup report" },
      },
    });
    await waitForFixtureExit(fixtureEnv);
  }, 10_000);

  test("真实 daemon 的 fail-fast cause 经启动报告通道返回", async () => {
    const { env } = await freshEnv();
    const started = Date.now();
    const result = await runCli(["capabilities"], {
      ...env,
      REINS_DIAGNOSTICS_MAX_BYTES: "0",
    });
    expect(result.exitCode).toBe(70);
    expect(result.stdout).toBe("");
    expect(dataFrom(result).failure).toMatchObject({
      code: "daemon_start_failed",
      facts: {
        cause: {
          kind: "exception",
          message: expect.stringContaining("REINS_DIAGNOSTICS_MAX_BYTES"),
        },
      },
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
    expect(Date.now() - started).toBeLessThan(6_500);
  }, 10_000);

  test("address-in-use 通过 capabilities 返回类型化启动失败且不泄露路径", async () => {
    const { dir, env: baseEnv } = await freshEnv();
    const secretSentinel = ["socket", "path", "sentinel"].join("-");
    const occupiedPath = join(dir, `${secretSentinel}.sock`);
    await writeFile(occupiedPath, "occupied", { mode: 0o600 });
    const result = await runCli(
      ["capabilities"],
      { ...baseEnv, REINS_SOCKET: occupiedPath },
      { timeoutMs: 7_000 },
    );
    expect(result.exitCode).toBe(70);
    expect(dataFrom(result).failure).toMatchObject({
      code: "daemon_start_failed",
      facts: { transportCode: "address_in_use" },
    });
    expect(
      [result.stdout, result.stderr].map((text) =>
        text.includes(secretSentinel),
      ),
    ).toEqual([false, false]);
  }, 15_000);

  test("诊断 append 失败时 unexpected error 不产生悬空 diagnosticId", async () => {
    const { dir, env } = await freshEnv();
    const fixtureEnv = fixtureDaemonEnv(env, dir, "append-failure");
    const result = await spawnWithCli(fixtureEnv, {
      harness: "explode",
      message: "hello",
      name: "append-failure",
    });
    expect(result.exitCode).toBe(70);
    expect(dataFrom(result).failure).toMatchObject({
      code: "internal_error",
      facts: { cause: { kind: "exception", message: "worker start exploded" } },
    });
    await waitForFixtureExit(fixtureEnv);
  });

  test("send 未知会话返回 session_not_found", async () => {
    const { env } = await freshEnv();
    const credential = await preparedCredential(env, "send");
    const result = await runCli(
      [
        "send",
        missingSessionId,
        "--placement",
        "new_turn",
        "--message",
        "hi",
        "--operation",
        credential,
      ],
      env,
    );
    expect(result.exitCode).toBe(70);
    expect(dataFrom(result).failure).toMatchObject({
      code: "session_not_found",
      facts: { sessionHandle: missingSessionId },
    });
  });

  test("wait 未知会话返回 session_not_found", async () => {
    const { env } = await freshEnv();
    const result = await runCli(
      [
        "wait",
        encodeTurnHandle({
          sessionId: missingSessionId,
          turnId: v.parse(turnIdSchema, "t1"),
        }),
        "--completion",
        "all",
      ],
      env,
    );
    expect(result.exitCode).toBe(70);
    expect(dataFrom(result).failure).toMatchObject({
      code: "session_not_found",
      facts: { sessionHandle: missingSessionId },
    });
  });

  test("kill 未知会话返回 not_found 而非报错", async () => {
    const { env } = await freshEnv();
    const credential = await preparedCredential(env, "kill");
    const result = await runCli(
      ["kill", "--session", missingSessionId, "--operation", credential],
      env,
    );
    expect(result.exitCode).toBe(0);
    expect(dataFrom(result)).toEqual({
      sessionHandle: missingSessionId,
      status: "not_found",
    });
  });

  test("daemon 不可达返回 daemon_start_failed", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["capabilities"], {
      ...env,
      REINS_DAEMON_BIN: "/bin/false",
    });
    expect(result.exitCode).toBe(70);
    expect(dataFrom(result).failure).toMatchObject({
      code: "daemon_start_failed",
    });
  }, 10_000);
});

describe("CLI 消费者绑定握手（01 票）", () => {
  test("缺少消费者绑定的 CLI 在触达 daemon 前拒绝且不创建 socket", async () => {
    const { env, socketPath } = await freshEnv();
    const unboundEnv: NodeJS.ProcessEnv = { ...env };
    delete unboundEnv.REINS_CONSUMER_CONTEXT;
    const result = await runCli(["list"], unboundEnv);
    expect(result.exitCode).toBe(70);
    expect(result.stdout).toBe("");
    expect(dataFrom(result).failure).toMatchObject({
      code: "consumer_context_required",
    });
    expect(await pathExists(socketPath)).toBe(false);
  });

  test("带绑定的真实 CLI 经 daemon 完成创建与查询", async () => {
    const { env } = await freshEnv();
    const spawned = await spawnWithCli(env, {
      harness: "fake",
      message: "hello",
      name: "bound-session",
    });
    expect(spawned.exitCode).toBe(0);
    const sessionId = sessionIdFrom(spawned);
    expect(sessionId).toMatch(/@g/u);

    const listed = await runCli(["list"], env);
    expect(listed.exitCode).toBe(0);
    expect(dataFrom(listed).sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionHandle: sessionId }),
      ]),
    );
    await killWithCli(env, sessionId);
  });

  test("同一 daemon 世代内显式会话名不可复用", async () => {
    const { env } = await freshEnv();
    const first = await spawnWithCli(env, {
      harness: "fake",
      message: "hello",
      name: "reused-name",
    });
    expect(first.exitCode).toBe(0);
    const firstSessionId = sessionIdFrom(first);
    expect(firstSessionId).toMatch(/@g/u);

    const duplicate = await spawnWithCli(env, {
      harness: "fake",
      message: "again",
      name: "reused-name",
    });
    expect(duplicate.exitCode).toBe(70);
    expect(dataFrom(duplicate).failure).toMatchObject({
      code: "session_name_conflict",
      facts: { sessionName: "reused-name" },
    });

    const killed = await killWithCli(env, firstSessionId);
    expect(dataFrom(killed)).toEqual({
      sessionHandle: firstSessionId,
      status: "killed",
    });
    const afterKill = await spawnWithCli(env, {
      harness: "fake",
      message: "third",
      name: "reused-name",
    });
    expect(afterKill.exitCode).toBe(70);
    expect(dataFrom(afterKill).failure).toMatchObject({
      code: "session_name_conflict",
      facts: { sessionName: "reused-name" },
    });
    const listed = await runCli(["list", "--name", "reused-name"], env);
    expect(listed.exitCode).toBe(0);
    expect(
      dataFrom(listed).sessions?.map((session) => session.sessionHandle),
    ).toEqual([firstSessionId]);
  });

  test("消费者绑定不作为领域动作参数暴露", async () => {
    const { env, socketPath } = await freshEnv();
    const withFlag = await runCli(
      ["spawn", "--consumer-context", "explicit"],
      env,
    );
    expect(withFlag.exitCode).toBe(64);
    expect(withFlag.stdout).not.toContain("consumerContext");
    expect(await pathExists(socketPath)).toBe(false);

    const binding = env.REINS_CONSUMER_CONTEXT ?? "";
    const spawned = await spawnWithCli(env, {
      harness: "fake",
      message: "hello",
      name: "opaque-binding",
    });
    expect(spawned.exitCode).toBe(0);
    expect(spawned.stdout).not.toContain(binding);
    const sessionId = sessionIdFrom(spawned);
    const listed = await runCli(["list"], env);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).not.toContain(binding);
    await killWithCli(env, sessionId);
  });

  test("另一消费者的公开 list 与 kill 按不存在呈现会话", async () => {
    const { env } = await freshEnv();
    const alpha = { ...env, REINS_CONSUMER_CONTEXT: "cli-alpha" };
    const beta = { ...env, REINS_CONSUMER_CONTEXT: "cli-beta" };

    const spawned = await spawnWithCli(alpha, {
      harness: "fake",
      message: "hello",
      name: "owned-session",
    });
    expect(spawned.exitCode).toBe(0);
    const sessionId = sessionIdFrom(spawned);

    const foreignList = await runCli(["list"], beta);
    expect(foreignList.exitCode).toBe(0);
    expect(dataFrom(foreignList).sessions).toEqual([]);

    const foreignKill = await killWithCli(beta, sessionId);
    expect(dataFrom(foreignKill)).toEqual({
      sessionHandle: sessionId,
      status: "not_found",
    });

    const ownerList = await runCli(["list"], alpha);
    expect(ownerList.exitCode).toBe(0);
    expect(dataFrom(ownerList).sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionHandle: sessionId }),
      ]),
    );

    const killed = await killWithCli(alpha, sessionId);
    expect(dataFrom(killed)).toEqual({
      sessionHandle: sessionId,
      status: "killed",
    });
  });

  test("另一消费者的 send 与 wait 不得访问他人会话", async () => {
    const { env } = await freshEnv();
    const alpha = { ...env, REINS_CONSUMER_CONTEXT: "cli-alpha" };
    const beta = { ...env, REINS_CONSUMER_CONTEXT: "cli-beta" };

    const spawned = await spawnWithCli(alpha, {
      harness: "fake",
      message: "hello",
      name: "owned-send-wait-session",
    });
    expect(spawned.exitCode).toBe(0);
    const sessionId = sessionIdFrom(spawned);

    const betaSendCredential = await preparedCredential(beta, "send");
    const foreignSend = await runCli(
      [
        "send",
        sessionId,
        "--message",
        "intrude",
        "--placement",
        "new_turn",
        "--operation",
        betaSendCredential,
      ],
      beta,
    );
    expect(foreignSend.exitCode).toBe(70);
    expect(dataFrom(foreignSend).failure).toMatchObject({
      code: "session_not_found",
      facts: { sessionHandle: sessionId },
    });

    const foreignWait = await runCli(
      [
        "wait",
        turnHandleFrom(spawned),
        "--completion",
        "all",
        "--timeout",
        "50",
      ],
      beta,
    );
    expect(foreignWait.exitCode).toBe(70);
    expect(dataFrom(foreignWait).failure).toMatchObject({
      code: "session_not_found",
      facts: { sessionHandle: sessionId },
    });

    await killWithCli(alpha, sessionId);
  });
});
