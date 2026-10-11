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

import { makeDiagnosticId, sessionIdSchema, turnIdSchema, encodeTurnHandle } from "@reins/protocol";
import * as v from "valibot";
import { afterEach, describe, expect, test } from "vitest";

import {
  commandSpecForName,
  commandSpecs,
  flagDisplay,
  fullUsageFor,
  validateCommand,
  valueHint,
  type CommandArg,
  type CommandConstraint,
  type CommandOption,
  type CommandSpec,
  type ValueKind,
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
const fixtureTurnHandle = encodeTurnHandle({sessionId: fixtureSessionId, turnId: v.parse(turnIdSchema,"t1")});
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

function sessionIdFrom(result: CliResult): string {
  return v.parse(
    sessionIdSchema,
    (JSON.parse(result.stdout) as { sessionId: unknown }).sessionId,
  );
}

describe("A 类：帮助（stdout + 退出 0）", () => {
  test("无子命令输出 stdout 帮助", async () => {
    const { env } = await freshEnv();
    const result = await runCli([], env);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: reins [options] <command>");
  });

  test("--help 输出 stdout 帮助", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["--help"], env);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: reins [options] <command>");
    expect(result.stdout).toContain(
      "spawn <harness> <message...> --name <session-name> [options]",
    );
    expect(result.stdout).not.toContain("spawn [options] [harness]");
  });

  test("子命令 --help 输出完整参数表", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["spawn", "--help"], env);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "Usage: reins spawn <harness> <message...> --name <session-name> [options]",
    );
    expect(result.stdout).toContain("--authorization-mode");
  });

  test("interrupt help 不再声明 message", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["interrupt", "--help"], env);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "Usage: reins interrupt <ids...> [options]",
    );
    expect(result.stdout).not.toContain("--message");
  });

  test("diagnostics help exposes finite filters and constraints", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["diagnostics", "--help"], env);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--id <diagnostic-id>");
    expect(result.stdout).toContain("--turn <turn-id>");
    expect(result.stdout).toContain("--limit <n>");
  });

  test("--version 输出 stdout", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["--version"], env);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`${releaseVersion}\n`);
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
      const spawned = await runCli(
        ["spawn", "hang", "wait", "--name", "timeout-close"],
        env,
      );
      sessionId = sessionIdFrom(spawned);
      const result = await runCli(["attach", sessionId], env, {
        timeoutMs: 100,
      });
      expect(result.exitCode).toBe(-1);
      expect(result.stderr).toBe("");
    } finally {
      if (sessionId !== undefined) await runCli(["kill", sessionId], env);
      if (daemon.exitCode === null) await stopDaemon(daemon, socketPath);
    }
  });

  test("a downstream pipe close makes a long attach exit quietly and release its daemon", async () => {
    const { dir, env, socketPath } = await freshEnv();
    const fixtureEnv = fixtureDaemonEnv(env, dir, "attach-long-replay");
    const child = spawn(
      process.execPath,
      [cliBin, "--pretty", "attach", "prompt@g1"],
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
      expect(JSON.parse(first.stdout.join(""))).toMatchObject({
        capabilities: [],
      });
      expect(JSON.parse(second.stdout.join(""))).toMatchObject({
        capabilities: [],
      });
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

  test("spawn validates session name grammar before daemon use", async () => {
    const { env } = await freshEnv();
    const result = await runCli(
      ["spawn", "fake", "hello", "--name", "daemon"],
      env,
    );
    expect(result.exitCode).toBe(64);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "usage_error",
      issues: [{ issue: "invalid_value", field: "--name" }],
    });
  });

  test("explicit stderr capture persists bounded UTF-8 evidence", async () => {
    const { env } = await freshEnv();
    const spawned = await runCli(
      [
        "spawn",
        "capture",
        "hello",
        "--name",
        "capture-session",
        "--capture-harness-stderr",
      ],
      env,
    );
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
    await runCli(["kill", sessionId], env);
  });

  test("unsupported stderr capture rejects before session creation", async () => {
    const { env } = await freshEnv();
    const result = await runCli(
      [
        "spawn",
        "fake",
        "hello",
        "--name",
        "no-capture",
        "--capture-harness-stderr",
      ],
      env,
    );
    expect(result.exitCode).toBe(65);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "unsupported_feature",
    });
    const sessions = await runCli(["list", "--name", "no-capture"], env);
    expect(JSON.parse(sessions.stdout)).toEqual([]);
  });

  test("capabilities 输出能力矩阵（JSON 默认）", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["capabilities"], env);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      capabilities: Array<{ harness: string }>;
      failures: unknown[];
    };
    expect(parsed.failures).toEqual([]);
    expect(parsed.capabilities.map((entry) => entry.harness).sort()).toEqual([
      "cancelled",
      "capture",
      "failed",
      "fake",
      "hang",
      "permission",
    ]);
  });

  test("spawn 成功并以 JSON 输出 sessionId", async () => {
    const { env } = await freshEnv();
    const result = await runCli(
      ["spawn", "fake", "hello", "--name", "test-session"],
      env,
    );
    expect(result.exitCode).toBe(0);
    const sessionId = sessionIdFrom(result);
    expect(sessionId).toMatch(/@g/u);
    await runCli(["kill", sessionId], env);
  });

  test("spawn 接受合法 --authorization-mode", async () => {
    const { env } = await freshEnv();
    const result = await runCli(
      [
        "spawn",
        "fake",
        "hi",
        "--authorization-mode",
        "allow-all",
        "--name",
        "test-session",
      ],
      env,
    );
    expect(result.exitCode).toBe(0);
    const sessionId = sessionIdFrom(result);
    expect(sessionId).toMatch(/@g/u);
    await runCli(["kill", sessionId], env);
  });

  test("attach 仍默认流式回放事件（JSON 诊断视图）", async () => {
    const { env } = await freshEnv();
    const spawned = await runCli(
      ["spawn", "fake", "hello", "--name", "test-session"],
      env,
    );
    expect(spawned.exitCode).toBe(0);
    const sessionId = sessionIdFrom(spawned);
    const attached = await runCli(
      ["attach", sessionId, "--exit-on", "end_turn"],
      env,
    );
    expect(attached.exitCode).toBe(0);
    expect(attached.stdout).toContain('"kind":"notification"');
    expect(attached.stdout).toContain('"method":"event"');
    expect(attached.stdout).toContain('"stopReason":"end_turn"');
    expect(attached.stdout).toContain('"role":"worker"');
    await runCli(["kill", sessionId], env);
  });

  test("attach appends a machine error after streamed JSON when daemon disconnects", async () => {
    const { env, socketPath } = await freshEnv();
    const daemon = await startDaemon(env);
    try {
      const spawned = await runCli(
        ["spawn", "fake", "hello", "--name", "disconnect-session"],
        env,
      );
      const sessionId = sessionIdFrom(spawned);
      const attached = startCli(["attach", sessionId, "--replay", "10"], env);
      await waitFor(() =>
        attached.stdout.join("").includes('"kind":"notification"'),
      );
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
      const spawned = await runCli(
        ["spawn", "fake", "hello", "--name", "pretty-disconnect"],
        env,
      );
      const sessionId = sessionIdFrom(spawned);
      const attached = startCli(
        ["--pretty", "attach", sessionId, "--replay", "10"],
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
    const spawned = await runCli(
      ["spawn", "permission", "do it", "--name", "prompt-kill"],
      env,
    );
    const sessionId = sessionIdFrom(spawned);
    const attached = startCli(
      ["--pretty", "attach", sessionId, "--exit-on", "end_turn"],
      env,
      true,
    );
    await waitFor(() => attached.stdout.join("").includes("Choose (1-2):"));
    const exit = waitForExit(attached.child, 5_000);
    await runCli(["kill", sessionId], env);
    expect(await exit).toBe(0);
    expect(attached.stderr.join("")).toBe("");
  });

  test("pretty permission prompts are resolved once in arrival order", async () => {
    const { dir, env } = await freshEnv();
    const requestsFile = join(dir, "permission-queue.requests");
    const queueEnv = { ...env, REINS_FIXTURE_REQUESTS_FILE: requestsFile };
    const spawned = await runCli(
      ["spawn", "permission", "queue", "--name", "prompt-queue"],
      queueEnv,
    );
    const sessionId = sessionIdFrom(spawned);
    const attached = startCli(
      ["--pretty", "attach", sessionId, "--exit-on", "end_turn"],
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
      await runCli(["kill", sessionId], queueEnv);
    }
  });

  test("kill aborts the active prompt and clears queued permission requests", async () => {
    const { dir, env } = await freshEnv();
    const requestsFile = join(dir, "permission-kill.requests");
    const queueEnv = { ...env, REINS_FIXTURE_REQUESTS_FILE: requestsFile };
    const spawned = await runCli(
      ["spawn", "permission", "queue", "--name", "prompt-kill-queue"],
      queueEnv,
    );
    const sessionId = sessionIdFrom(spawned);
    const attached = startCli(
      ["--pretty", "attach", sessionId, "--exit-on", "end_turn"],
      queueEnv,
      true,
    );
    const exitPromise = waitForExit(attached.child, 2_000);
    await waitFor(() => attached.stdout.join("").includes("Choose (1-2):"));
    await runCli(["kill", sessionId], queueEnv);
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
      ["--pretty", "attach", "prompt@g1", "--exit-on", "end_turn"],
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
    const spawned = await runCli(
      ["spawn", "hang", "wait me", "--name", "test-session"],
      env,
    );
    expect(spawned.exitCode).toBe(0);
    const sessionId = sessionIdFrom(spawned);
    const waited = await runCli(["wait", JSON.parse(spawned.stdout).turnHandle, "--completion", "all", "--timeout", "100"], env);
    expect(waited.exitCode).toBe(4);
    expect(JSON.parse(waited.stdout)).toEqual({
      status: "timeout", completed: [],pending: [{turnHandle: JSON.parse(spawned.stdout).turnHandle}],
    });
    await runCli(["kill", sessionId], env);
  });

  test("--pretty spawn 输出人类可读英文", async () => {
    const { env } = await freshEnv();
    const result = await runCli(
      ["--pretty", "spawn", "fake", "hi", "--name", "test-session"],
      env,
    );
    expect(result.exitCode).toBe(0);
    const sessionId = /^Created session (.+)\n/u.exec(result.stdout)?.[1];
    expect(sessionId).toBeDefined();
    await runCli(["kill", sessionId ?? ""], env);
  });

  test.each([
    ["json", []],
    ["pretty", ["--pretty"]],
  ] as const)(
    "resolve-permission %s 成功返回 typed ack",
    async (mode, prefix) => {
      const { env } = await freshEnv();
      const spawned = await runCli(
        ["spawn", "permission", "do it", "--name", `resolve-${mode}`],
        env,
      );
      const sessionId = sessionIdFrom(spawned);
      const resolved = await runCli(
        [
          ...prefix,
          "resolve-permission",
          sessionId,
          "p1",
          "--outcome",
          "allow",
        ],
        env,
      );
      expect(resolved.exitCode).toBe(0);
      expect(resolved.stderr).toBe("");
      if (mode === "json") {
        expect(JSON.parse(resolved.stdout)).toEqual({
          sessionId,
          permissionId: "p1",
        });
      } else {
        expect(resolved.stdout).toBe(
          `Resolved permission p1 on session ${sessionId}\n`,
        );
      }
      await runCli(["kill", sessionId], env);
    },
  );

  test("--pretty list 对空集合给出显式成功", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["--pretty", "list"], env);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("No sessions found\n");
  });

  test("attach pretty 权限交互并随决议结束", async () => {
    const { env } = await freshEnv();
    const spawned = await runCli(
      ["spawn", "permission", "do it", "--name", "test-session"],
      env,
    );
    expect(spawned.exitCode).toBe(0);
    const sessionId = sessionIdFrom(spawned);
    const attached = startCli(
      ["attach", sessionId, "--pretty", "--exit-on", "end_turn"],
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
      await runCli(["kill", sessionId], env);
    }
  });

  test("attach pretty 显示 caller/worker 角色", async () => {
    const { env } = await freshEnv();
    const spawned = await runCli(
      ["spawn", "fake", "hello", "--name", "test-session"],
      env,
    );
    expect(spawned.exitCode).toBe(0);
    const sessionId = sessionIdFrom(spawned);
    const sent = await runCli(
      ["send", sessionId, "next", "--placement", "new_turn"],
      env,
    );
    expect(sent.exitCode).toBe(0);
    const attached = await runCli(
      ["attach", sessionId, "--pretty", "--exit-on", "end_turn"],
      env,
    );
    expect(attached.exitCode).toBe(0);
    expect(attached.stdout).toContain("worker: interim");
    expect(attached.stdout).toContain("caller: next");
    await runCli(["kill", sessionId], env);
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
      const first = await runCli(
        ["spawn", "fake", "first", "--name", "restart-session"],
        env,
      );
      expect(first.exitCode).toBe(0);
      const oldSessionId = sessionIdFrom(first);

      await stopDaemon(daemonA, socketPath);
      const daemonB = await startDaemon(env);
      try {
        const second = await runCli(
          ["spawn", "fake", "second", "--name", "restart-session"],
          env,
        );
        expect(second.exitCode).toBe(0);
        const newSessionId = sessionIdFrom(second);
        expect(newSessionId).not.toBe(oldSessionId);

        const oldAddress = await runCli(
          ["send", oldSessionId, "stale", "--placement", "new_turn"],
          env,
        );
        expect(oldAddress.exitCode).toBe(65);
        expect(JSON.parse(oldAddress.stdout)).toMatchObject({
          code: "session_not_found",
          sessionId: oldSessionId,
        });
        await runCli(["kill", newSessionId], env);
      } finally {
        await stopDaemon(daemonB, socketPath);
      }
    } catch (error) {
      if (daemonA.exitCode === null) await stopDaemon(daemonA, socketPath);
      throw error;
    }
  });
});

type UsageCase = {
  name: string;
  args: readonly string[];
  code?: "usage_error" | "unknown_harness" | "invalid_params";
  issue?:
    | "missing_argument"
    | "unknown_command"
    | "unknown_option"
    | "invalid_value"
    | "invalid_combination";
  target?: "argument" | "option";
  field?: string;
  value?: string;
  valid?: readonly string[];
  hint?: string;
  suggestionContains?: readonly string[];
  specName?: string;
  modes?: readonly ("json" | "pretty")[];
};

function assertNever(value: never): never {
  throw new Error(`Unhandled command-spec variant: ${String(value)}`);
}

function sampleForKind(kind: ValueKind): string {
  switch (kind.type) {
    case "text":
      return "x";
    case "sessionName":
      return "test-session";
    case "sessionId":
      return fixtureSessionId;
    case "turnHandle":
      return fixtureTurnHandle;
    case "turnId":
      return "t1";
    case "permissionId":
      return "p1";
    case "diagnosticId":
      return "d1-098";
    case "time":
      return "2026-01-01T00:00:00.000Z";
    case "boolean":
      return "";
    case "enum":
      return kind.values[0] ?? "x";
    case "number":
      return String(Math.max(kind.min ?? 0, 1));
    case "jsonObject":
      return "{}";
    case "dynamic":
      switch (kind.source) {
        case "harness":
          return "fake";
        case "model":
          return "fake-model";
        case "reasoning":
          return "low";
        default:
          return assertNever(kind.source);
      }
    default:
      return assertNever(kind);
  }
}

function sampleForArg(arg: CommandArg): string {
  if (arg.name === "message") return "hi";
  if (arg.name === "permissionId") return "p1";
  if (arg.name === "ids") return fixtureSessionId;
  return sampleForKind(arg.kind);
}

function sampleForOption(option: { kind: ValueKind }): string {
  return sampleForKind(option.kind);
}

function suggestionForMissing(
  arg: CommandArg | { flags: string; description: string; kind: ValueKind },
): string {
  return valueHint(arg.kind) ?? arg.description;
}

function allMissingIssues(spec: CommandSpec): unknown[] {
  return [
    ...spec.args.map((arg) => ({
      target: "argument" as const,
      field: arg.name,
      declaration: arg,
    })),
    ...spec.options
      .filter((option) => option.required === true)
      .map((option) => ({
        target: "option" as const,
        field: option.flags,
        declaration: option,
      })),
  ].map(({ target, field, declaration }) => ({
    issue: "missing_argument",
    target,
    field,
    ...(declaration.kind.type === "enum"
      ? { valid: [...declaration.kind.values] }
      : { hint: suggestionForMissing(declaration) }),
  }));
}

function missingArgumentCases(): UsageCase[] {
  return commandSpecs.flatMap((spec) =>
    spec.args.map((arg, index) => {
      const prefix = [
        ...spec.args.slice(0, index).map(sampleForArg),
        ...spec.options
          .filter((option) => option.required === true)
          .flatMap((option) => [
            flagDisplay(option.flags),
            sampleForOption(option),
          ]),
      ];
      return {
        name: `${spec.name} missing ${arg.name}`,
        args: [spec.name, ...prefix],
        issue: "missing_argument" as const,
        target: "argument" as const,
        field: arg.name,
        specName: spec.name,
        suggestionContains: [suggestionForMissing(arg)],
      };
    }),
  );
}

function missingOptionCases(): UsageCase[] {
  return commandSpecs.flatMap((spec) =>
    spec.options
      .filter((option) => option.required === true)
      .map((option) => ({
        name: `${spec.name} missing option ${option.name}`,
        args: [spec.name, ...spec.args.map(sampleForArg)],
        issue: "missing_argument" as const,
        target: "option" as const,
        field: option.flags,
        specName: spec.name,
        suggestionContains: [suggestionForMissing(option)],
      })),
  );
}

type InvalidKindCategory =
  | "number"
  | "sessionName"
  | "sessionId"
  | "turnId"
  | "turnHandle"
  | "permissionId"
  | "diagnosticId"
  | "time"
  | "boolean"
  | "enum"
  | "multiEnum"
  | "jsonObject"
  | "dynamicHarness"
  | "dynamicModel"
  | "dynamicReasoning";

type FieldOccurrence =
  | { readonly location: "argument"; readonly field: CommandArg }
  | { readonly location: "option"; readonly field: CommandOption };

function invalidCategory(
  kind: ValueKind,
  variadic: boolean,
): InvalidKindCategory | null {
  switch (kind.type) {
    case "text":
      return null;
    case "number":
    case "sessionName":
    case "sessionId":
    case "turnId":
    case "turnHandle":
    case "permissionId":
    case "diagnosticId":
    case "time":
    case "boolean":
    case "jsonObject":
      return kind.type;
    case "enum":
      return variadic ? "multiEnum" : "enum";
    case "dynamic":
      switch (kind.source) {
        case "harness":
          return "dynamicHarness";
        case "model":
          return "dynamicModel";
        case "reasoning":
          return "dynamicReasoning";
        default:
          return assertNever(kind.source);
      }
    default:
      return assertNever(kind);
  }
}

function invalidValueFor(kind: ValueKind): string {
  switch (kind.type) {
    case "text":
      return "";
    case "sessionName":
      return "daemon";
    case "sessionId":
      return "not-a-session-id";
    case "turnHandle":
      return "bad-handle";
    case "turnId":
      return "T1";
    case "permissionId":
      return "P1";
    case "diagnosticId":
      return "d1-000";
    case "time":
      return "2026-01-01T00:00:00Z";
    case "boolean":
      return "false";
    case "enum":
      return "bogus";
    case "number":
      if (kind.max !== undefined) return String(kind.max + 1);
      if (kind.min !== undefined) return String(kind.min - 1);
      return "not-a-number";
    case "jsonObject":
      return "[]";
    case "dynamic":
      return `unknown-${kind.source}`;
    default:
      return assertNever(kind);
  }
}

function baseArgs(spec: CommandSpec, omittedOption?: string): string[] {
  return [
    spec.name,
    ...spec.args.map(sampleForArg),
    ...spec.options
      .filter(
        (option) => option.required === true && option.name !== omittedOption,
      )
      .flatMap((option) => [
        flagDisplay(option.flags),
        sampleForOption(option),
      ]),
  ];
}

function invalidCaseFor(
  spec: CommandSpec,
  occurrence: FieldOccurrence,
): UsageCase {
  const { field } = occurrence;
  const invalid = invalidValueFor(field.kind);
  const args = baseArgs(
    spec,
    occurrence.location === "option" ? field.name : undefined,
  );
  let fieldName = field.name;
  if (occurrence.location === "argument") {
    const index = spec.args.indexOf(occurrence.field);
    if (field.variadic === true) {
      args.push(invalid);
    } else {
      args[1 + index] = invalid;
    }
  } else {
    fieldName = flagDisplay(occurrence.field.flags);
    args.push(
      field.kind.type === "boolean" ? `${fieldName}=${invalid}` : fieldName,
    );
    if (field.kind.type !== "boolean") {
      if (field.variadic === true) args.push(sampleForOption(field));
      args.push(invalid);
    }
  }
  if (field.kind.type === "dynamic" && field.kind.source === "reasoning") {
    const model = spec.options.find(
      (candidate) =>
        candidate.kind.type === "dynamic" && candidate.kind.source === "model",
    );
    if (model !== undefined) {
      args.push(flagDisplay(model.flags), sampleForOption(model));
    }
  }
  const hint = valueHint(field.kind);
  const dynamicCode =
    field.kind.type !== "dynamic"
      ? undefined
      : field.kind.source === "harness"
        ? "unknown_harness"
        : "invalid_params";
  return {
    name: `${spec.name} rejects invalid ${field.name} (${invalidCategory(field.kind, field.variadic === true) ?? "text"})`,
    args,
    ...(dynamicCode === undefined ? {} : { code: dynamicCode }),
    ...(dynamicCode !== undefined
      ? {}
      : {
          issue:
            field.kind.type === "boolean"
              ? ("unknown_option" as const)
              : ("invalid_value" as const),
          ...(field.kind.type === "boolean" ? {} : { field: fieldName }),
          value:
            field.kind.type === "boolean" ? `${fieldName}=${invalid}` : invalid,
        }),
    ...(field.kind.type === "enum"
      ? { valid: [...field.kind.values] }
      : field.kind.type === "boolean"
        ? {
            valid: [
              ...spec.options.map((option) => flagDisplay(option.flags)),
              "--pretty",
            ],
          }
        : {}),
    ...(dynamicCode === undefined &&
    field.kind.type !== "enum" &&
    hint !== undefined
      ? { hint }
      : {}),
    ...(dynamicCode === undefined
      ? {
          suggestionContains:
            hint === undefined
              ? [flagDisplay((field as CommandOption).flags)]
              : [hint],
        }
      : {}),
    specName: spec.name,
  };
}

const fixtureValueKinds = {
  number: {
    type: "number",
    integer: true,
    min: 1,
    max: 2,
    hint: "Expected fixture integer",
  },
  sessionName: { type: "sessionName", hint: "Expected fixture SessionName" },
  sessionId: { type: "sessionId", hint: "Expected fixture SessionId" },
  turnId: { type: "turnId", hint: "Expected fixture TurnId" },
  turnHandle: {type:"turnHandle",hint:"Expected fixture TurnHandle"},
  permissionId: {
    type: "permissionId",
    hint: "Expected fixture PermissionId",
  },
  diagnosticId: {
    type: "diagnosticId",
    hint: "Expected fixture DiagnosticId",
  },
  time: { type: "time", hint: "Expected fixture UTC time" },
  boolean: { type: "boolean" },
  enum: { type: "enum", values: ["one", "two"] },
  multiEnum: { type: "enum", values: ["one", "two"] },
  jsonObject: { type: "jsonObject", hint: "Expected fixture object" },
  dynamicHarness: {
    type: "dynamic",
    source: "harness",
    hint: "Expected fixture harness",
  },
  dynamicModel: {
    type: "dynamic",
    source: "model",
    hint: "Expected fixture model",
  },
  dynamicReasoning: {
    type: "dynamic",
    source: "reasoning",
    hint: "Expected fixture reasoning",
  },
} as const satisfies Record<InvalidKindCategory, ValueKind>;

function derivedInvalidValueCases(): {
  e2e: UsageCase[];
  fixture: Array<{ category: InvalidKindCategory; spec: CommandSpec }>;
} {
  const found = new Set<InvalidKindCategory>();
  const e2e: UsageCase[] = [];
  for (const spec of commandSpecs) {
    for (const field of spec.args) {
      const category = invalidCategory(field.kind, field.variadic === true);
      if (category === null) continue;
      found.add(category);
      e2e.push(invalidCaseFor(spec, { location: "argument", field }));
    }
    for (const field of spec.options) {
      const category = invalidCategory(field.kind, field.variadic === true);
      if (category === null) continue;
      found.add(category);
      e2e.push(invalidCaseFor(spec, { location: "option", field }));
    }
  }
  const fixture: Array<{ category: InvalidKindCategory; spec: CommandSpec }> =
    [];
  for (const [category, kind] of Object.entries(fixtureValueKinds) as Array<
    [InvalidKindCategory, ValueKind]
  >) {
    if (found.has(category)) continue;
    fixture.push({
      category,
      spec: {
        name: `fixture-${category}`,
        description: "test-only value-kind fixture",
        args: [],
        options: [
          {
            name: "value",
            flags: "--value <value>",
            description: "fixture value",
            variadic: category === "multiEnum",
            kind,
          },
        ],
      },
    });
  }
  return {
    e2e,
    fixture,
  };
}

function constraintCase(
  spec: CommandSpec,
  constraint: CommandConstraint,
): UsageCase {
  const args = baseArgs(spec);
  const option = (name: string): CommandOption => {
    const found = spec.options.find((candidate) => candidate.name === name);
    if (found === undefined)
      throw new Error(`Missing constraint field ${name}`);
    return found;
  };
  const add = (name: string, value?: string): void => {
    const target = option(name);
    args.push(flagDisplay(target.flags));
    if (target.kind.type !== "boolean") {
      args.push(value ?? sampleForOption(target));
    }
  };
  let field: string;
  switch (constraint.type) {
    case "exclusive":
      add(constraint.field);
      add(constraint.with[0] ?? assertNever(constraint.with[0] as never));
      field = flagDisplay(option(constraint.field).flags);
      break;
    case "requires":
      add(constraint.field);
      field = flagDisplay(option(constraint.field).flags);
      break;
    case "orderedTime":
      add(constraint.since, "2026-01-02T00:00:00.000Z");
      add(constraint.until, "2026-01-01T00:00:00.000Z");
      field = `${flagDisplay(option(constraint.since).flags)}, ${flagDisplay(option(constraint.until).flags)}`;
      break;
    default:
      return assertNever(constraint);
  }
  return {
    name: `${spec.name} rejects ${constraint.type} constraint`,
    args,
    issue: "invalid_combination",
    field,
    hint: constraint.hint,
    suggestionContains: [constraint.hint],
    specName: spec.name,
  };
}

const derivedValues = derivedInvalidValueCases();
const derivedConstraintCases = commandSpecs.flatMap((spec) =>
  (spec.constraints ?? []).map((constraint) =>
    constraintCase(spec, constraint),
  ),
);

const specialValueCases: UsageCase[] = [
  {
    name: "capabilities excess arguments",
    args: ["capabilities", "x"],
    issue: "invalid_value",
    field: "arguments",
    hint: "Remove the extra arguments",
    suggestionContains: ["Remove the extra arguments"],
    specName: "capabilities",
  },
];

const unknownCommandCase: UsageCase = {
  name: "unknown command",
  args: ["bogus"],
  issue: "unknown_command",
  value: "bogus",
  valid: commandSpecs.map((spec) => spec.name),
  suggestionContains: ["Allowed: spawn"],
};

const unknownOptionSpec = commandSpecForName("spawn");
const unknownOptionCase: UsageCase = {
  name: "unknown option",
  args: ["spawn", "fake", "hi", "--name", "test-session", "--nope"],
  issue: "unknown_option",
  value: "--nope",
  valid: [
    ...(unknownOptionSpec?.options.map((option) => flagDisplay(option.flags)) ??
      []),
    "--pretty",
  ],
  suggestionContains: ["Allowed: --agent"],
  specName: "spawn",
};

const removedInterruptMessageOptionCase: UsageCase = {
  name: "interrupt removed message option",
  args: ["interrupt", fixtureSessionId, "--message", "legacy explanation"],
  issue: "unknown_option",
  value: "--message",
  valid: ["--pretty"],
  suggestionContains: ["Allowed: --pretty"],
  specName: "interrupt",
};

const usageCases: UsageCase[] = [
  ...missingArgumentCases(),
  ...missingOptionCases(),
  ...derivedValues.e2e,
  ...derivedConstraintCases,
  ...specialValueCases,
  unknownCommandCase,
  unknownOptionCase,
  removedInterruptMessageOptionCase,
];

describe("CLI 错误矩阵（缝 D，从命令规范派生）", () => {
  test("每个公开值类型都由真实命令或同一派生器的专用 fixture 覆盖", () => {
    const covered = new Set<InvalidKindCategory>();
    let occurrences = 0;
    for (const spec of commandSpecs) {
      for (const field of [...spec.args, ...spec.options]) {
        const category = invalidCategory(field.kind, field.variadic === true);
        if (category === null) continue;
        covered.add(category);
        occurrences += 1;
      }
    }
    expect(derivedValues.e2e).toHaveLength(occurrences);
    for (const { category, spec } of derivedValues.fixture) {
      const field = spec.options[0]!;
      expect(() =>
        validateCommand(spec, [], { value: invalidValueFor(field.kind) }),
      ).toThrow();
      covered.add(category);
    }
    expect(covered).toEqual(new Set(Object.keys(fixtureValueKinds)));
  });

  for (const spec of commandSpecs) {
    test(`${spec.name} help 从规范显示全部值提示与约束`, async () => {
      const { env } = await freshEnv();
      const result = await runCli([spec.name, "--help"], env);
      const normalized = result.stdout.replace(/\s+/gu, " ");
      const hints = [
        ...spec.args.map((field) => valueHint(field.kind)),
        ...spec.options.map((field) => valueHint(field.kind)),
        ...(spec.constraints ?? []).map((constraint) => constraint.hint),
      ].filter((hint): hint is string => hint !== undefined);
      for (const hint of hints) {
        expect(normalized, `${spec.name}: ${hint}`).toContain(
          hint.replace(/\s+/gu, " "),
        );
      }
    });
  }

  for (const spec of commandSpecs) {
    const expectedIssues = allMissingIssues(spec);
    if (expectedIssues.length === 0) continue;
    test(`${spec.name} 一次返回全部声明必填项`, async () => {
      const { env } = await freshEnv();
      const result = await runCli([spec.name], env);
      expect(result.exitCode).toBe(64);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        code: "usage_error",
        issues: expectedIssues,
        usage: `reins ${fullUsageFor(spec)}`,
      });
    });
  }

  for (const usageCase of usageCases) {
    const spec =
      usageCase.specName === undefined
        ? undefined
        : commandSpecForName(usageCase.specName);
    for (const mode of usageCase.modes ?? ["json", "pretty"]) {
      const pretty = mode === "pretty";
      test(`${usageCase.name}（${pretty ? "pretty" : "json"}）`, async () => {
        const { env } = await freshEnv();
        const args = pretty ? ["--pretty", ...usageCase.args] : usageCase.args;
        const result = await runCli(args, env);
        expect(result.exitCode, usageCase.name).toBe(64);
        if (pretty) {
          expect(result.stdout).toBe("");
          expect(result.stderr).not.toContain("error: error:");
          expect(result.stderr.startsWith("error: ")).toBe(true);
          if ((usageCase.suggestionContains?.length ?? 0) > 0) {
            expect(result.stderr).toContain("suggestion: ");
          }
          expect(result.stderr).toContain(`usage: reins ${fullUsageFor(spec)}`);
          for (const fragment of usageCase.suggestionContains ?? []) {
            expect(result.stderr, usageCase.name).toContain(fragment);
          }
          return;
        }
        expect(result.stderr).toBe("");
        const parsed = JSON.parse(result.stdout) as {
          code: string;
          message: string;
          issues?: Array<{
            issue: string;
            target?: string;
            field?: string;
            value?: string;
            valid?: string[];
            hint?: string;
          }>;
          usage?: string;
        };
        const primaryIssue = parsed.issues?.[0];
        expect(parsed.code).toBe(usageCase.code ?? "usage_error");
        if (usageCase.issue !== undefined) {
          expect(primaryIssue?.issue).toBe(usageCase.issue);
        }
        if (usageCase.target !== undefined) {
          expect(primaryIssue?.target).toBe(usageCase.target);
        }
        if (usageCase.field !== undefined) {
          expect(primaryIssue?.field).toBe(usageCase.field);
        }
        if (usageCase.value !== undefined) {
          expect(primaryIssue?.value).toBe(usageCase.value);
        }
        if (usageCase.valid !== undefined) {
          expect(primaryIssue?.valid).toEqual([...usageCase.valid]);
        }
        if (usageCase.hint !== undefined) {
          expect(primaryIssue?.hint).toBe(usageCase.hint);
        }
        expect(parsed.usage).toBe(`reins ${fullUsageFor(spec)}`);
        for (const fragment of usageCase.suggestionContains ?? []) {
          expect(parsed.message, usageCase.name).toContain(fragment);
        }
      });
    }
  }
});

describe("CLI 输出金样（逐字节）", () => {
  test("缺 harness 的 pretty 错误块", async () => {
    const { env } = await freshEnv();
    const result = await runCli(
      ["--pretty", "spawn", "--name", "test-session"],
      env,
    );
    expect(result.exitCode).toBe(64);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "error: Missing required argument 'harness'\n" +
        "suggestion: Run 'reins capabilities' to list valid harnesses\n" +
        "error: Missing required argument 'message'\n" +
        "suggestion: initial message\n" +
        "usage: reins spawn <harness> <message...> --name <session-name> [options]\n",
    );
  });

  test("缺 harness 的 JSON 机器错误", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["spawn", "--name", "test-session"], env);
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      `${JSON.stringify({
        code: "usage_error",
        issues: [
          {
            issue: "missing_argument",
            target: "argument",
            field: "harness",
            hint: "Run 'reins capabilities' to list valid harnesses",
          },
          {
            issue: "missing_argument",
            target: "argument",
            field: "message",
            hint: "initial message",
          },
        ],
        message:
          "Missing required argument 'harness'. Run 'reins capabilities' to list valid harnesses. " +
          "Missing required argument 'message'. initial message",
        usage:
          "reins spawn <harness> <message...> --name <session-name> [options]",
      })}\n`,
    );
  });

  test("JSON 一次列全声明中可确定的缺失必填项", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["resolve-permission", "test@g2"], env);
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      code: "usage_error",
      issues: [
        {
          issue: "missing_argument",
          target: "argument",
          field: "permissionId",
          hint: "Expected a valid PermissionId",
        },
        {
          issue: "missing_argument",
          target: "option",
          field: "--outcome <allow|deny>",
          valid: ["allow", "deny"],
        },
      ],
      message:
        "Missing required argument 'permissionId'. Expected a valid PermissionId. " +
        "Missing required option '--outcome <allow|deny>'. Allowed: allow, deny",
      usage:
        "reins resolve-permission <sessionId> <permissionId> --outcome <allow|deny> [options]",
    });
  });

  test("pretty 按声明顺序列出同一组缺失必填项", async () => {
    const { env } = await freshEnv();
    const result = await runCli(
      ["--pretty", "resolve-permission", "test@g2"],
      env,
    );
    expect(result.exitCode).toBe(64);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "error: Missing required argument 'permissionId'\n" +
        "suggestion: Expected a valid PermissionId\n" +
        "error: Missing required option '--outcome <allow|deny>'\n" +
        "suggestion: Allowed: allow, deny\n" +
        "usage: reins resolve-permission <sessionId> <permissionId> --outcome <allow|deny> [options]\n",
    );
  });

  test("非法 state 的 pretty 错误块", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["--pretty", "list", "--state", "bogus"], env);
    expect(result.exitCode).toBe(64);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "error: Invalid value 'bogus' for '--state'\n" +
        "suggestion: Allowed: busy, idle, killed\n" +
        "usage: reins list [options]\n",
    );
  });

  test("拼错命令保留 Did you mean", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["--pretty", "spwan"], env);
    expect(result.exitCode).toBe(64);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "error: Unknown command 'spwan'. Did you mean 'spawn'?\n" +
        "suggestion: Allowed: spawn, send, wait, interrupt, kill, list, attach, diagnostics, capabilities, resolve-permission, retry\n" +
        "usage: reins [options] <command>\n",
    );
  });

  test("未知 harness 的 pretty 错误块（能力矩阵内联）", async () => {
    const { env } = await freshEnv();
    const result = await runCli(
      ["--pretty", "spawn", "nope", "x", "--name", "test-session"],
      env,
    );
    expect(result.exitCode).toBe(64);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "error: Unknown harness 'nope'\n" +
        "suggestion: Allowed: fake, capture, hang, permission, failed, cancelled\n" +
        "usage: reins spawn <harness> <message...> --name <session-name> [options]\n",
    );
  });
});

describe("CLI 动态值错误（能力矩阵一次往返）", () => {
  test("unknown harness JSON 内联合法列表", async () => {
    const { env } = await freshEnv();
    const result = await runCli(
      ["spawn", "nope", "x", "--name", "test-session"],
      env,
    );
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      code: string;
      message: string;
      harness?: string;
      availableHarnesses?: string[];
    };
    expect(parsed.code).toBe("unknown_harness");
    expect(parsed.harness).toBe("nope");
    expect(parsed.availableHarnesses).toContain("fake");
    expect(parsed.message).toContain("Unknown harness 'nope'");
    expect(parsed.message).toContain("Allowed: fake");
  });

  test("invalid model JSON 内联合法模型", async () => {
    const { env } = await freshEnv();
    const result = await runCli(
      ["spawn", "fake", "x", "--model", "nope", "--name", "test-session"],
      env,
    );
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      code: string;
      message: string;
      issues?: Array<{ path: string; reason: string }>;
    };
    expect(parsed.code).toBe("invalid_params");
    expect(parsed.issues?.[0]?.path).toBe("model");
    expect(parsed.message).toBe("Invalid parameter value: model");
  });

  test("invalid reasoning JSON 内联合法强度", async () => {
    const { env } = await freshEnv();
    const result = await runCli(
      [
        "spawn",
        "fake",
        "x",
        "--model",
        "fake-model",
        "--reasoning",
        "bogus",
        "--name",
        "test-session",
      ],
      env,
    );
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      code: string;
      message: string;
    };
    expect(parsed.code).toBe("invalid_params");
    expect(parsed.message).toBe("Invalid parameter value: reasoning");
  });

  test("pretty invalid model 内联合法模型与 usage", async () => {
    const { env } = await freshEnv();
    const result = await runCli(
      [
        "--pretty",
        "spawn",
        "fake",
        "x",
        "--model",
        "nope",
        "--name",
        "test-session",
      ],
      env,
    );
    expect(result.exitCode).toBe(64);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error: Invalid parameter value: model");
    expect(result.stderr).not.toContain("suggestion:");
    expect(result.stderr).toContain(
      "usage: reins spawn <harness> <message...> --name <session-name> [options]",
    );
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
    expect(result.exitCode).toBe(65);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
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
    const result = await runCli(["attach", "prompt@g1"], fixtureEnv, {
      timeoutMs: 3_000,
    });
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
    const spawned = await runCli(
      ["spawn", "permission", "do it", "--name", "prompt-eof"],
      env,
    );
    expect(spawned.exitCode).toBe(0);
    const sessionId = sessionIdFrom(spawned);
    const result = await runCli(["--pretty", "attach", sessionId], env, {
      timeoutMs: 3_000,
    });
    expect(result.exitCode).toBe(65);
    expect(result.stdout).toContain("Permission requested:");
    expect(result.stderr).toBe(
      "error: Permission input closed before a choice was received\n",
    );
    expect(result.stderr).not.toContain("usage:");
    await runCli(["kill", sessionId], env);
  });

  test("完整进程将无响应 daemon 区分为 daemon_timeout 并清理子进程", async () => {
    const { dir, env } = await freshEnv();
    const fixtureEnv = fixtureDaemonEnv(env, dir, "timeout");
    const started = Date.now();
    const result = await runCli(
      ["wait", fixtureTurnHandle, "--completion", "all", "--timeout", "1"],
      fixtureEnv,
      { timeoutMs: 7_000 },
    );
    expect(result.exitCode).toBe(65);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ code: "daemon_timeout" });
    expect(Date.now() - started).toBeLessThan(6_500);
    await waitForFixtureExit(fixtureEnv);
  }, 10_000);

  test("daemon 启动失败返回 UTF-8 有界 cause 并清理子进程", async () => {
    const { dir, env } = await freshEnv();
    const fixtureEnv = fixtureDaemonEnv(env, dir, "startup-failure");
    const result = await runCli(["capabilities"], fixtureEnv, {
      timeoutMs: 7_000,
    });
    expect(result.exitCode).toBe(65);
    expect(result.stderr).toBe("");
    const error = JSON.parse(result.stdout) as {
      code: string;
      cause: { kind: string; message: string };
    };
    expect(error.code).toBe("daemon_start_failed");
    expect(error.cause.kind).toBe("upstream");
    expect(error.cause.message).toContain("é");
    expect(Buffer.byteLength(error.cause.message, "utf8")).toBeLessThanOrEqual(
      4 * 1024,
    );
    await waitForFixtureExit(fixtureEnv);
  }, 10_000);

  test("daemon 被 signal 终止后仍观察同 socket 到总 deadline", async () => {
    const { dir, env } = await freshEnv();
    const fixtureEnv = fixtureDaemonEnv(env, dir, "startup-signal");
    const started = Date.now();
    const result = await runCli(["capabilities"], fixtureEnv, {
      timeoutMs: 7_000,
    });
    expect(result.exitCode).toBe(65);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "daemon_start_failed",
      cause: {
        kind: "upstream",
        message: expect.stringContaining("SIGTERM"),
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
    expect(result.exitCode).toBe(65);
    const error = JSON.parse(result.stdout) as {
      cause: { kind: string; message: string };
    };
    expect(error.cause.kind).toBe("upstream");
    expect(error.cause.message).toContain("report-before-exit:界");
    expect(Buffer.byteLength(error.cause.message, "utf8")).toBeLessThanOrEqual(
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
    expect(result.exitCode).toBe(65);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "daemon_start_failed",
      cause: { kind: "upstream", message: "late complete startup report" },
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
    expect(result.exitCode).toBe(65);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "daemon_start_failed",
      cause: {
        kind: "exception",
        message: expect.stringContaining("REINS_DIAGNOSTICS_MAX_BYTES"),
      },
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
    expect(Date.now() - started).toBeLessThan(6_500);
  }, 10_000);

  test("真实 address-in-use 启动失败只由 CLI 集中 grammar 造句", async () => {
    const { dir, env: baseEnv } = await freshEnv();
    const secretSentinel = ["socket", "path", "sentinel"].join("-");
    const occupiedPath = join(dir, `${secretSentinel}.sock`);
    await writeFile(occupiedPath, "occupied", { mode: 0o600 });
    const result = await runCli(
      ["capabilities"],
      { ...baseEnv, REINS_SOCKET: occupiedPath },
      { timeoutMs: 7_000 },
    );
    expect(result.exitCode).toBe(65);
    expect(JSON.parse(result.stdout)).toEqual({
      code: "daemon_start_failed",
      cause: {
        kind: "io",
        message: "Daemon socket address is already in use",
      },
      message: "Daemon socket address is already in use",
    });
    const pretty = await runCli(
      ["--pretty", "capabilities"],
      { ...baseEnv, REINS_SOCKET: occupiedPath },
      { timeoutMs: 7_000 },
    );
    expect(pretty.exitCode).toBe(65);
    expect(pretty.stdout).toBe("");
    expect(pretty.stderr).toBe(
      "error: Daemon socket address is already in use\n",
    );
    expect(
      [result.stdout, result.stderr, pretty.stdout, pretty.stderr].map((text) =>
        text.includes(secretSentinel),
      ),
    ).toEqual([false, false, false, false]);
  }, 15_000);

  test("诊断 append 失败时 unexpected error 不产生悬空 diagnosticId", async () => {
    const { dir, env } = await freshEnv();
    const fixtureEnv = fixtureDaemonEnv(env, dir, "append-failure");
    const result = await runCli(
      ["spawn", "explode", "hello", "--name", "append-failure"],
      fixtureEnv,
      { timeoutMs: 3_000 },
    );
    expect(result.exitCode).toBe(65);
    expect(result.stderr).toBe("");
    const error = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(error).toMatchObject({
      code: "internal_error",
      cause: { kind: "exception", message: "worker start exploded" },
    });
    expect(error).not.toHaveProperty("diagnosticId");
    expect(error.message).not.toContain("reins diagnostics --id");
    await waitForFixtureExit(fixtureEnv);
  });

  test("send 未知会话返回 session_not_found", async () => {
    const { env } = await freshEnv();
    const result = await runCli(
      ["send", missingSessionId, "hi", "--placement", "new_turn"],
      env,
    );
    expect(result.exitCode).toBe(65);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "session_not_found",
    });
  });

  test("wait 未知会话返回 session_not_found", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["wait", encodeTurnHandle({sessionId: missingSessionId,turnId:v.parse(turnIdSchema,"t1")}), "--completion", "all"], env);
    expect(result.exitCode).toBe(65);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "session_not_found",
    });
  });

  test("kill 未知会话返回 not_found 而非报错", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["kill", missingSessionId], env);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      sessionId: missingSessionId,
      status: "not_found",
    });
  });

  test("daemon 不可达返回 daemon_start_failed", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["capabilities"], {
      ...env,
      REINS_DAEMON_BIN: "/bin/false",
    });
    expect(result.exitCode).toBe(65);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "daemon_start_failed",
    });
  }, 10_000);

  test("pretty 域错误不输出 suggestion 与 usage", async () => {
    const { env } = await freshEnv();
    const result = await runCli(
      ["--pretty", "send", missingSessionId, "hi", "--placement", "new_turn"],
      env,
    );
    expect(result.exitCode).toBe(65);
    expect(result.stderr).toBe(
      `error: Session not found: ${missingSessionId}\n`,
    );
    expect(result.stderr).not.toContain("suggestion:");
    expect(result.stderr).not.toContain("usage:");
  });
});

describe("CLI 消费者绑定握手（01 票）", () => {
  test("缺少消费者绑定的 CLI 在触达 daemon 前拒绝且不创建 socket", async () => {
    const { env, socketPath } = await freshEnv();
    const unboundEnv: NodeJS.ProcessEnv = { ...env };
    delete unboundEnv.REINS_CONSUMER_CONTEXT;
    const result = await runCli(["list"], unboundEnv);
    expect(result.exitCode).toBe(64);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "consumer_context_required",
    });
    expect(await pathExists(socketPath)).toBe(false);
  });

  test("带绑定的真实 CLI 经 daemon 完成创建与查询", async () => {
    const { env } = await freshEnv();
    const spawned = await runCli(
      ["spawn", "fake", "hello", "--name", "bound-session"],
      env,
    );
    expect(spawned.exitCode).toBe(0);
    const sessionId = sessionIdFrom(spawned);
    expect(sessionId).toMatch(/@g/u);

    const listed = await runCli(["list"], env);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain(sessionId);
    await runCli(["kill", sessionId], env);
  });

  test("同一 daemon 世代内显式会话名不可复用", async () => {
    const { env } = await freshEnv();
    const first = await runCli(
      ["spawn", "fake", "hello", "--name", "reused-name"],
      env,
    );
    expect(first.exitCode).toBe(0);
    const firstSessionId = sessionIdFrom(first);
    expect(firstSessionId).toMatch(/@g/u);

    const duplicate = await runCli(
      ["spawn", "fake", "again", "--name", "reused-name"],
      env,
    );
    expect(duplicate.exitCode).toBe(65);
    expect(JSON.parse(duplicate.stdout)).toMatchObject({
      code: "session_name_conflict",
      sessionName: "reused-name",
    });

    const killed = await runCli(["kill", firstSessionId], env);
    expect(JSON.parse(killed.stdout)).toEqual({
      sessionId: firstSessionId,
      status: "killed",
    });
    const afterKill = await runCli(
      ["spawn", "fake", "third", "--name", "reused-name"],
      env,
    );
    expect(afterKill.exitCode, afterKill.stdout).toBe(65);
    expect(JSON.parse(afterKill.stdout)).toMatchObject({
      code: "session_name_conflict",
      sessionName: "reused-name",
    });
    const listed = await runCli(["list", "--name", "reused-name"], env);
    expect(listed.exitCode).toBe(0);
    expect(
      (JSON.parse(listed.stdout) as Array<{ sessionId: string }>).map(
        (session) => session.sessionId,
      ),
    ).toEqual([firstSessionId]);
  });

  test("消费者绑定不作为领域动作参数暴露", async () => {
    const { env, socketPath } = await freshEnv();
    const withFlag = await runCli(
      ["spawn", "fake", "hello", "--consumer-context", "explicit"],
      env,
    );
    expect(withFlag.exitCode).toBe(64);
    expect(withFlag.stdout).not.toContain("consumerContext");
    expect(await pathExists(socketPath)).toBe(false);

    const binding = env.REINS_CONSUMER_CONTEXT ?? "";
    const spawned = await runCli(
      ["spawn", "fake", "hello", "--name", "opaque-binding"],
      env,
    );
    expect(spawned.exitCode).toBe(0);
    expect(spawned.stdout).not.toContain(binding);
    const sessionId = sessionIdFrom(spawned);
    const listed = await runCli(["list"], env);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).not.toContain(binding);
    await runCli(["kill", sessionId], env);
  });

  test("另一消费者绑定的真实 CLI 把他人会话按不存在呈现", async () => {
    const { env } = await freshEnv();
    const alpha = { ...env, REINS_CONSUMER_CONTEXT: "cli-alpha" };
    const beta = { ...env, REINS_CONSUMER_CONTEXT: "cli-beta" };

    const spawned = await runCli(
      ["spawn", "fake", "hello", "--name", "owned-session"],
      alpha,
    );
    expect(spawned.exitCode).toBe(0);
    const sessionId = sessionIdFrom(spawned);

    const foreignList = await runCli(["list"], beta);
    expect(foreignList.exitCode).toBe(0);
    expect(JSON.parse(foreignList.stdout)).toEqual([]);

    const foreignSend = await runCli(
      ["send", sessionId, "intrude", "--placement", "new_turn"],
      beta,
    );
    expect(foreignSend.exitCode).toBe(65);
    expect(JSON.parse(foreignSend.stdout)).toMatchObject({
      code: "session_not_found",
      sessionId,
    });

    const foreignKill = await runCli(["kill", sessionId], beta);
    expect(JSON.parse(foreignKill.stdout)).toEqual({
      sessionId,
      status: "not_found",
    });

    const foreignWait = await runCli(
      ["wait", JSON.parse(spawned.stdout).turnHandle, "--completion", "all", "--timeout", "50"],
      beta,
    );
    expect(foreignWait.exitCode).toBe(65);
    expect(JSON.parse(foreignWait.stdout)).toMatchObject({
      code: "session_not_found",
    });

    const ownerList = await runCli(["list"], alpha);
    expect(ownerList.exitCode).toBe(0);
    expect(ownerList.stdout).toContain(sessionId);

    const killed = await runCli(["kill", sessionId], alpha);
    expect(JSON.parse(killed.stdout)).toEqual({ sessionId, status: "killed" });
  });
});
