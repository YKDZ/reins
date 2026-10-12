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
  encodePermissionHandle,
  permissionIdSchema,
} from "@reins/protocol";
import * as v from "valibot";
import { afterEach, describe, expect, test } from "vitest";

import {
  publisherCommandSpecs,
  workspaceCommandSpecs,
} from "../../src/command-spec.ts";

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
const stdoutEioPreload = join(
  repoRoot,
  "apps/cli/test/e2e/fixtures/emit-stdout-eio.cjs",
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

function runPublisher(args: readonly string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(repoRoot, "apps/cli/dist/publisher-cli.js"), ...args],
      { env: { ...process.env, REINS_CONSUMER_CONTEXT: "" }, stdio: "pipe" },
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        exitCode: code ?? -1,
        pid: child.pid ?? -1,
      }),
    );
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

function processExists(pid: number): boolean {
  if (pid < 1) return false;
  try {
    process.kill(pid, 0);
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
const fixtureSessionId = v.parse(sessionIdSchema, "test-session@gfixture");
const fixtureTurnHandle = encodeTurnHandle({
  sessionId: fixtureSessionId,
  turnId: v.parse(turnIdSchema, "t1"),
});
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
  sessions?: Array<Record<string, unknown>>;
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
  operation: "spawn" | "send" | "interrupt" | "kill",
): Promise<string> {
  const result = await runCli(["prepare-operation", operation], env);
  expect(result.exitCode, result.stdout).toBe(0);
  const prepared = dataFrom(result);
  expect(prepared.operation).toBe(operation);
  expect(prepared.credential).toEqual(expect.any(String));
  if (typeof prepared.credential !== "string") throw new Error("执行凭据缺失");
  return prepared.credential;
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

  test("a downstream pipe close makes a long attach exit quietly and release its daemon", async () => {
    const { dir, env, socketPath } = await freshEnv();
    const fixtureEnv = fixtureDaemonEnv(env, dir, "attach-long-replay");
    const child = spawn(
      process.execPath,
      [
        cliBin,
        "--pretty",
        "attach",
        "prompt@g1",
        "--scope",
        "session",
        "--replay",
        "available",
      ],
      {
        env: { ...process.env, ...fixtureEnv },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stderr: string[] = [];
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    let closedPipe = false;
    child.stdout?.once("data", () => {
      closedPipe = true;
      child.stdout?.destroy();
    });

    expect(await waitForExit(child, 8_000)).toBe(0);
    expect(closedPipe).toBe(true);
    expect(stderr.join("")).toBe("");
    expect(child.killed).toBe(false);
    expect(processExists(child.pid ?? -1)).toBe(false);
    await waitForFixtureExit(fixtureEnv, 4_000);
    expect(await pathExists(socketPath)).toBe(false);
    expect(await pathExists(`${socketPath}.lock`)).toBe(false);
  }, 12_000);

  test("a non-EPIPE stdout failure uses the typed stderr grammar and exit 65", async () => {
    const { dir, env, socketPath } = await freshEnv();
    const fixtureEnv = fixtureDaemonEnv(env, dir, "output-error");
    const result = await runCli(["capabilities"], {
      ...fixtureEnv,
      NODE_OPTIONS:
        `${process.env.NODE_OPTIONS ?? ""} --require=${stdoutEioPreload}`.trim(),
    });

    expect(result.exitCode).toBe(65);
    expect(result.stderr).toBe("error: Unable to write CLI output (EIO)\n");
    expect(result.stderr).not.toContain("Error:");
    expect(result.stdout).not.toContain("internal_error");
    expect(result.stdout).not.toContain("output_error");
    expect(processExists(result.pid)).toBe(false);
    await waitForFixtureExit(fixtureEnv, 4_000);
    expect(await pathExists(socketPath)).toBe(false);
    expect(await pathExists(`${socketPath}.lock`)).toBe(false);
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
    expect(JSON.parse(result.stdout)).toMatchObject({
      records: [
        { operation: "diagnostics_store", reason: "initialized" },
        { operation: "daemon", reason: "started" },
      ],
      truncated: false,
    });
  });

  test("真实 malformed transport diagnostic 经正式 CLI 输出 JSON 与 pretty", async () => {
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
      const result = JSON.parse(json.stdout) as {
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
      expect(json.stdout).toBe(`${JSON.stringify(result)}\n`);

      const pretty = await runCli(
        ["--pretty", "diagnostics", "--kind", "transport_failure"],
        env,
      );
      expect(pretty.exitCode).toBe(0);
      expect(pretty.stdout).toBe(
        `${JSON.stringify(result.records, null, 2)}\ntruncated: false\n`,
      );
      expect(
        [json.stdout, json.stderr, pretty.stdout, pretty.stderr].map((text) =>
          text.includes(secretSentinel),
        ),
      ).toEqual([false, false, false, false]);
      expect([json.stderr, pretty.stderr]).toEqual(["", ""]);
    } finally {
      if (daemon.exitCode === null && daemon.signalCode === null) {
        await stopDaemon(daemon, socketPath);
      }
    }
  });

  test("legacy v1 transport TextEvidence 不进入正式 CLI JSON 与 pretty", async () => {
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
      const result = JSON.parse(json.stdout) as {
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
        ["--pretty", "diagnostics", "--id", diagnosticId],
        env,
      );
      expect(pretty.exitCode).toBe(0);
      expect(pretty.stdout).toBe(`${JSON.stringify(safeRecord, null, 2)}\n`);
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
    const { env } = await freshEnv();
    const result = await runCli(
      ["diagnostics", "--id", "d1-098", "--harness", "fake"],
      env,
    );
    expect(result.exitCode).toBe(64);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "usage_error",
      issues: [{ issue: "invalid_combination" }],
    });
  });

  test.each([
    ["turn requires session", ["diagnostics", "--turn", "t1"]],
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
    const { env } = await freshEnv();
    const result = await runCli(args, env);
    expect(result.exitCode).toBe(64);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "usage_error",
    });
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
      return JSON.parse(queried.stdout).records.length === 3;
    });
    const queried = await runCli(
      ["diagnostics", "--session", sessionId, "--kind", "harness_stderr"],
      env,
    );
    const record = (
      JSON.parse(queried.stdout) as {
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
    const all = JSON.parse(queried.stdout) as {
      records: Array<{
        diagnosticId: string;
        recordedAt: string;
        sessionId: string;
        turnId: string;
      }>;
    };
    const first = all.records[0]!;
    const exact = await runCli(
      ["diagnostics", "--id", first.diagnosticId],
      env,
    );
    expect(JSON.parse(exact.stdout)).toMatchObject({
      record: { diagnosticId: first.diagnosticId },
    });
    for (const args of [
      ["--session", sessionId],
      ["--session", sessionId, "--turn", first.turnId],
      ["--session", sessionId, "--harness", "capture", "--source", "harness"],
      ["--harness", "capture"],
      ["--source", "harness", "adapter"],
      ["--kind", "harness_stderr"],
      ["--min-severity", "info"],
      ["--since", first.recordedAt, "--until", first.recordedAt],
    ]) {
      const filtered = await runCli(["diagnostics", ...args], env);
      expect(JSON.parse(filtered.stdout).records.length).toBeGreaterThan(0);
    }
    const excludedByAnd = await runCli(
      ["diagnostics", "--session", sessionId, "--harness", "fake"],
      env,
    );
    expect(JSON.parse(excludedByAnd.stdout)).toEqual({
      records: [],
      truncated: false,
    });
    const latest = await runCli(
      ["diagnostics", "--session", sessionId, "--limit", "1"],
      env,
    );
    expect(JSON.parse(latest.stdout)).toMatchObject({
      records: [
        expect.objectContaining({
          diagnosticId: all.records.at(-1)?.diagnosticId,
        }),
      ],
      truncated: true,
    });
    const empty = await runCli(["diagnostics", "--harness", "none"], env);
    expect(JSON.parse(empty.stdout)).toEqual({ records: [], truncated: false });
    const missing = await runCli(["diagnostics", "--id", "d1-098"], env);
    expect(missing.exitCode).toBe(65);
    expect(JSON.parse(missing.stdout)).toMatchObject({
      code: "diagnostic_not_found",
    });
    const pretty = await runCli(
      ["--pretty", "diagnostics", "--id", first.diagnosticId],
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

  test("attach 仍默认流式回放事件（JSON 诊断视图）", async () => {
    const { env } = await freshEnv();
    const spawned = await spawnWithCli(env, {
      harness: "fake",
      message: "hello",
      name: "test-session",
    });
    expect(spawned.exitCode).toBe(0);
    const sessionId = sessionIdFrom(spawned);
    const attached = await runCli(
      [
        "attach",
        turnHandleFrom(spawned),
        "--scope",
        "turn",
        "--replay",
        "available",
      ],
      env,
    );
    expect(attached.exitCode).toBe(0);
    expect(attached.stdout).toContain('"type":"subscription.established"');
    expect(attached.stdout).toContain('"type":"text"');
    expect(attached.stdout).toContain('"stopReason":"end_turn"');
    expect(attached.stdout).toContain('"role":"worker"');
    await killWithCli(env, sessionId);
  });

  test("attach appends a machine error after streamed JSON when daemon disconnects", async () => {
    const { env, socketPath } = await freshEnv();
    const daemon = await startDaemon(env);
    try {
      const spawned = await spawnWithCli(env, {
        harness: "fake",
        message: "hello",
        name: "disconnect-session",
      });
      const sessionId = sessionIdFrom(spawned);
      const attached = startCli(
        ["attach", sessionId, "--scope", "session", "--replay", "available"],
        env,
      );
      await waitFor(() => attached.stdout.join("").includes('"type":"text"'));
      // SIGTERM 现在是有序清理，会发送 session.killed；SIGKILL 才模拟断线。
      daemon.kill("SIGKILL");
      await waitForExit(daemon);
      expect(await waitForExit(attached.child)).toBe(65);
      expect(attached.stderr.join("")).toBe("");
      const lines = attached.stdout.join("").trim().split("\n");
      expect(lines.length).toBeGreaterThan(1);
      expect(lines.map((line) => JSON.parse(line))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "daemon_disconnected" }),
        ]),
      );
    } finally {
      if (daemon.exitCode === null && daemon.signalCode === null) {
        await stopDaemon(daemon, socketPath);
      }
    }
  });

  test("pretty attach keeps events on stdout and disconnect error on stderr", async () => {
    const { env, socketPath } = await freshEnv();
    const daemon = await startDaemon(env);
    try {
      const spawned = await spawnWithCli(env, {
        harness: "fake",
        message: "hello",
        name: "pretty-disconnect",
      });
      const sessionId = sessionIdFrom(spawned);
      const attached = startCli(
        [
          "--pretty",
          "attach",
          sessionId,
          "--scope",
          "session",
          "--replay",
          "available",
        ],
        env,
      );
      await waitFor(() => attached.stdout.join("").includes("worker: interim"));
      // SIGTERM 现在是有序清理，会发送 session.killed；SIGKILL 才模拟断线。
      daemon.kill("SIGKILL");
      await waitForExit(daemon);
      expect(await waitForExit(attached.child)).toBe(65);
      expect(attached.stdout.join("")).toContain("worker: interim");
      expect(attached.stderr.join("")).toContain("error: Daemon disconnected");
    } finally {
      if (daemon.exitCode === null && daemon.signalCode === null) {
        await stopDaemon(daemon, socketPath);
      }
    }
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
        "--pretty",
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
    expect(await exit).toBe(0);
    expect(attached.stderr.join("")).toBe("");
  });

  test("pretty permission prompts are resolved once in arrival order", async () => {
    const { dir, env } = await freshEnv();
    const requestsFile = join(dir, "permission-queue.requests");
    const queueEnv = { ...env, REINS_FIXTURE_REQUESTS_FILE: requestsFile };
    const spawned = await spawnWithCli(queueEnv, {
      harness: "permission",
      message: "queue",
      name: "prompt-queue",
    });
    const sessionId = sessionIdFrom(spawned);
    const attached = startCli(
      [
        "--pretty",
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
    try {
      await waitFor(() => attached.stdout.join("").includes("Choose (1-2):"));
      attached.child.stdin?.write("1\n");
      await waitFor(
        () =>
          (attached.stdout.join("").match(/Choose \(1-2\):/gu)?.length ?? 0) ===
          2,
      );
      attached.child.stdin?.end("1\n");
      expect(await waitForExit(attached.child, 5_000)).toBe(0);
      expect((await readFile(requestsFile, "utf8")).trim().split("\n")).toEqual(
        ["p1", "p2"],
      );
      expect(
        attached.stdout.join("").match(/Permission requested:/gu),
      ).toHaveLength(2);
    } finally {
      attached.child.stdin?.destroy();
      if (
        attached.child.exitCode === null &&
        attached.child.signalCode === null
      ) {
        attached.child.kill("SIGKILL");
        await waitForExit(attached.child, 2_000);
      }
      await killWithCli(queueEnv, sessionId);
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
        "--pretty",
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
    expect(await exitPromise).toBe(0);
    expect(await pathExists(requestsFile)).toBe(false);
    expect(
      attached.stdout.join("").match(/Permission requested:/gu),
    ).toHaveLength(1);
  });

  test("disconnect aborts an outstanding pretty prompt without a late resolution", async () => {
    const { dir, env } = await freshEnv();
    const fixtureEnv = fixtureDaemonEnv(env, dir, "prompt-disconnect");
    const attached = startCli(
      [
        "--pretty",
        "attach",
        fixtureTurnHandle,
        "--scope",
        "turn",
        "--replay",
        "available",
      ],
      fixtureEnv,
      true,
    );
    const exitPromise = waitForExit(attached.child, 2_000);
    await waitFor(() => attached.stdout.join("").includes("Choose (1-2):"));
    const started = Date.now();
    expect(await exitPromise).toBe(65);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(attached.stdout.join("")).not.toContain("[attach ended]");
    expect(attached.stderr.join("")).toContain("error: Daemon disconnected");
    const requestsPath = fixtureEnv.REINS_FIXTURE_REQUESTS_FILE;
    if (requestsPath === undefined)
      throw new Error("requests file is required");
    expect((await readFile(requestsPath, "utf8")).trim().split("\n")).toEqual([
      "initialize",
      "attach",
    ]);
    await waitForFixtureExit(fixtureEnv);
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
    expect(JSON.parse(waited.stdout).data.result).toEqual({
      status: "timeout",
      completed: [],
      pending: [{ turnHandle: turnHandleFrom(spawned) }],
    });
    await killWithCli(env, sessionId);
  });

  test.each([
    ["json", []],
    ["pretty", ["--pretty"]],
  ] as const)(
    "resolve-permission %s 成功返回 typed ack",
    async (mode, prefix) => {
      const { env } = await freshEnv();
      const spawned = await spawnWithCli(env, {
        harness: "permission",
        message: "do it",
        name: `resolve-${mode}`,
      });
      const sessionId = sessionIdFrom(spawned);
      const resolved = await runCli(
        [
          ...prefix,
          "resolve-permission",
          encodePermissionHandle({
            sessionId: v.parse(sessionIdSchema, sessionId),
            turnId: v.parse(turnIdSchema, "t1"),
            permissionId: v.parse(permissionIdSchema, "p1"),
          }),
          "--outcome",
          "allow",
        ],
        env,
      );
      expect(resolved.exitCode).toBe(0);
      expect(resolved.stderr).toBe("");
      if (mode === "json") {
        expect(JSON.parse(resolved.stdout)).toEqual({
          permissionHandle: encodePermissionHandle({
            sessionId: v.parse(sessionIdSchema, sessionId),
            turnId: v.parse(turnIdSchema, "t1"),
            permissionId: v.parse(permissionIdSchema, "p1"),
          }),
          status: "resolved",
        });
      } else {
        expect(resolved.stdout).toBe("Permission resolved\n");
      }
      await killWithCli(env, sessionId);
    },
  );

  test("attach pretty 权限交互并随决议结束", async () => {
    const { env } = await freshEnv();
    const spawned = await spawnWithCli(env, {
      harness: "permission",
      message: "do it",
      name: "test-session",
    });
    expect(spawned.exitCode).toBe(0);
    const sessionId = sessionIdFrom(spawned);
    const attached = startCli(
      [
        "attach",
        turnHandleFrom(spawned),
        "--pretty",
        "--scope",
        "turn",
        "--replay",
        "available",
      ],
      env,
      true,
    );
    try {
      await waitFor(() => attached.stdout.join("").includes("Choose (1-2):"));
      attached.child.stdin?.end("1\n");
      expect(await waitForExit(attached.child)).toBe(0);
      expect(attached.stdout.join("")).toContain("Permission requested");
      expect(attached.stdout.join("")).toContain("[attach ended]");
      expect(attached.stdout.join("")).toContain("[turn completed] end_turn");
      expect(attached.stdout.join("")).not.toContain("resolved:allow");
    } finally {
      attached.child.stdin?.destroy();
      if (
        attached.child.exitCode === null &&
        attached.child.signalCode === null
      ) {
        attached.child.kill("SIGKILL");
        await waitForExit(attached.child, 2_000);
      }
      await killWithCli(env, sessionId);
    }
  });

  test("attach pretty 显示 caller/worker 角色", async () => {
    const { env } = await freshEnv();
    const spawned = await spawnWithCli(env, {
      harness: "fake",
      message: "hello",
      name: "test-session",
    });
    expect(spawned.exitCode).toBe(0);
    const sessionId = sessionIdFrom(spawned);
    const credential = await preparedCredential(env, "send");
    const sent = await runCli(
      [
        "send",
        sessionId,
        "--placement",
        "new_turn",
        "--message",
        "next",
        "--operation",
        credential,
      ],
      env,
    );
    expect(sent.exitCode).toBe(0);
    await killWithCli(env, sessionId);
    const attached = await runCli(
      [
        "attach",
        sessionId,
        "--output-format",
        "text",
        "--scope",
        "session",
        "--replay",
        "available",
      ],
      env,
    );
    expect(attached.exitCode).toBe(0);
    expect(attached.stdout).toContain("worker: interim");
    expect(attached.stdout).toContain("caller: next");
    await killWithCli(env, sessionId);
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

describe("workspace 与 publisher 声明入口", () => {
  test("handoff 一次返回全部必填问题和子命令 canonical usage", async () => {
    const result = await runCli(["workspace", "handoff"], {
      REINS_CONSUMER_CONTEXT: "",
    });
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "usage_error",
      issues: [
        { issue: "missing_argument", field: "--repository <path>" },
        { issue: "missing_argument", field: "--commit <sha>" },
        { issue: "missing_argument", field: "--subdirectory <path>" },
        { issue: "missing_argument", field: "--binding <refs...>" },
      ],
      usage:
        "reins workspace handoff --repository <path> --commit <sha> --subdirectory <path> --binding <refs...> [options]",
    });
  });

  test("detach 枚举错误在 JSON 与 pretty 中都走声明语法", async () => {
    const json = await runCli(
      ["workspace", "detach", "--session-disposition", "invalid"],
      { REINS_CONSUMER_CONTEXT: "" },
    );
    expect(json.exitCode).toBe(64);
    expect(JSON.parse(json.stdout)).toMatchObject({
      code: "usage_error",
      issues: [
        {
          issue: "invalid_value",
          field: "--session-disposition",
          value: "invalid",
        },
      ],
      usage: "reins workspace detach --session-disposition <value> [options]",
    });

    const pretty = await runCli(
      ["--pretty", "workspace", "detach", "--session-disposition", "invalid"],
      { REINS_CONSUMER_CONTEXT: "" },
    );
    expect(pretty.exitCode).toBe(64);
    expect(pretty.stdout).toBe("");
    expect(pretty.stderr).toContain("suggestion: Allowed: require_none, kill");
    expect(pretty.stderr).toContain("usage: reins workspace detach");
  });

  test("未知 workspace 子命令只列出实际子命令", async () => {
    const result = await runCli(["workspace", "typo"], {
      REINS_CONSUMER_CONTEXT: "",
    });
    expect(result.exitCode).toBe(64);
    expect(JSON.parse(result.stdout)).toMatchObject({
      issues: [
        {
          issue: "unknown_command",
          valid: workspaceCommandSpecs.map((spec) =>
            spec.name.slice("workspace ".length),
          ),
        },
      ],
      usage: "reins workspace [options] <command>",
    });
  });

  test("publisher 缺 file 使用相同完整 issue 与 canonical usage", async () => {
    const result = await runPublisher(["publish"]);
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "usage_error",
      issues: [
        { issue: "missing_argument", target: "argument", field: "file" },
      ],
      usage: `reins ${publisherCommandSpecs[0]!.name} <file> [options]`,
    });
  });

  test("publisher 错误反馈只使用实际声明的 publisher 命令", async () => {
    const unknown = await runPublisher(["workspace"]);
    expect(unknown.exitCode).toBe(64);
    expect(JSON.parse(unknown.stdout)).toMatchObject({
      issues: [
        {
          issue: "unknown_command",
          value: "workspace",
          valid: publisherCommandSpecs.map((spec) => spec.name),
        },
      ],
      usage: "reins [options] <command>",
    });

    const invalidOption = await runPublisher([
      "publish",
      "workspace",
      "--invalid",
    ]);
    expect(invalidOption.exitCode).toBe(64);
    expect(JSON.parse(invalidOption.stdout)).toMatchObject({
      issues: [{ issue: "unknown_option", value: "--invalid" }],
      usage: "reins publish <file> [options]",
    });
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

  test.each([
    "attach-invalid-envelope",
    "attach-invalid-error",
    "attach-invalid-notification",
    "attach-invalid-result",
    "attach-invalid-after-response",
  ])("attach 将 %s 保留为 invalid_daemon_response", async (fixtureMode) => {
    const { dir, env } = await freshEnv();
    const fixtureEnv = fixtureDaemonEnv(env, dir, fixtureMode);
    const result = await runCli(
      ["attach", "prompt@g1", "--scope", "session", "--replay", "available"],
      fixtureEnv,
      {
        timeoutMs: 3_000,
      },
    );
    expect(result.exitCode).toBe(65);
    expect(result.stderr).toBe("");
    const lines = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.at(-1)).toMatchObject({ code: "invalid_daemon_response" });
    await waitForFixtureExit(fixtureEnv);
  });

  test("pretty permission EOF is a typed terminal error on stderr", async () => {
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
        "--pretty",
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
      "error: Permission input closed before a choice was received\n",
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
    const credential = await preparedCredential(beta, "send");

    const foreignSend = await runCli(
      [
        "send",
        sessionId,
        "--placement",
        "new_turn",
        "--message",
        "intrude",
        "--operation",
        credential,
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
