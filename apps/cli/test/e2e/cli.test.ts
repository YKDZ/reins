import { Buffer } from "node:buffer";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sessionIdSchema } from "@reins/protocol";
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
const cliBin = join(repoRoot, "apps/cli/dist/cli.js");
const daemonBin = join(repoRoot, "packages/daemon/dist/main.js");
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
const fixtureSessionId = v.parse(sessionIdSchema, "test-session@gfixture");
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
  const dir = await mkdtemp(join(tmpdir(), "reins-cli-e2e-"));
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
    expect(result.stdout).toBe("0.0.0\n");
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
  test("diagnostics returns one complete finite JSON response", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["diagnostics"], env);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      records: [],
      truncated: false,
    });
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
      issue: "invalid_combination",
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
      issue: "invalid_value",
      field: "--name",
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

  test("JSON interactive run is rejected before spawning", async () => {
    const { env } = await freshEnv();
    const result = await runCli(
      [
        "run",
        "fake",
        "hello",
        "--name",
        "interactive-run",
        "--authorization-mode",
        "interactive",
      ],
      env,
    );
    expect(result.exitCode).toBe(64);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "usage_error",
      issue: "invalid_combination",
    });
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

  test("spawn 接受合法 --authorization-mode 与 --meta", async () => {
    const { env } = await freshEnv();
    const result = await runCli(
      [
        "spawn",
        "fake",
        "hi",
        "--authorization-mode",
        "allow-all",
        "--meta",
        '{"a":1}',
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

  test("run 默认只返回紧凑最终结果，不流式回放事件", async () => {
    const { env } = await freshEnv();
    const result = await runCli(
      ["run", "fake", "hello", "--name", "test-session"],
      env,
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      sessionId: string;
      stopReason: string;
      finalReply: string | null;
    };
    expect(parsed).toMatchObject({ stopReason: "end_turn", finalReply: "ok" });
    expect(parsed.sessionId).toMatch(/@g/u);
    expect(result.stdout).not.toContain('"method":"event"');
    await runCli(["kill", parsed.sessionId], env);
  });

  test.each([
    ["failed", 1],
    ["cancelled", 2],
  ])("run preserves %s stop reason exit code", async (harness, exitCode) => {
    const { env } = await freshEnv();
    const result = await runCli(
      ["run", harness, "hello", "--name", `run-${harness}`],
      env,
    );
    expect(result.exitCode).toBe(exitCode);
    expect(JSON.parse(result.stdout)).toMatchObject({ stopReason: harness });
    expect(result.stdout).not.toContain('"method":"event"');
  });

  test("run observes a real second-connection kill as compact exit 3", async () => {
    const { env } = await freshEnv();
    const running = startCli(
      ["run", "hang", "hello", "--name", "run-killed"],
      env,
    );
    await waitFor(async () => {
      const listed = await runCli(["list", "--name", "run-killed"], env);
      return JSON.parse(listed.stdout).length === 1;
    });
    const listed = await runCli(["list", "--name", "run-killed"], env);
    const sessionId = (
      JSON.parse(listed.stdout) as Array<{ sessionId: string }>
    )[0]!.sessionId;
    const exit = waitForExit(running.child, 10_000);
    try {
      expect((await runCli(["kill", sessionId], env)).exitCode).toBe(0);
      expect(await exit).toBe(3);
    } finally {
      if (running.child.exitCode === null) running.child.kill("SIGKILL");
    }
    const output = JSON.parse(running.stdout.join("")) as {
      stopReason: string;
    };
    expect(output.stopReason).toBe("killed");
    expect(running.stdout.join("")).not.toContain('"method":"event"');
    expect(running.stderr.join("")).toBe("");
  }, 15_000);

  test("--pretty run 输出人类可读最终结果", async () => {
    const { env } = await freshEnv();
    const result = await runCli(
      ["--pretty", "run", "fake", "hello", "--name", "test-session"],
      env,
    );
    expect(result.exitCode).toBe(0);
    const sessionId =
      /^Turn completed: end_turn \((.+@g[a-z0-9]+)\)\nok\n$/u.exec(
        result.stdout,
      )?.[1];
    expect(sessionId).toBeDefined();
    await runCli(["kill", sessionId ?? ""], env);
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
      daemon.kill("SIGTERM");
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
      if (daemon.exitCode === null) await stopDaemon(daemon, socketPath);
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
      daemon.kill("SIGTERM");
      expect(await waitForExit(attached.child)).toBe(65);
      expect(attached.stdout.join("")).toContain("worker: interim");
      expect(attached.stderr.join("")).toContain("error: Daemon disconnected");
    } finally {
      if (daemon.exitCode === null) await stopDaemon(daemon, socketPath);
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
    const attached = await runCli(
      ["--pretty", "attach", sessionId, "--exit-on", "end_turn"],
      queueEnv,
      { input: "1\n1\n", timeoutMs: 5_000 },
    );
    expect(attached.exitCode).toBe(0);
    expect((await readFile(requestsFile, "utf8")).trim().split("\n")).toEqual([
      "p1",
      "p2",
    ]);
    expect(attached.stdout.match(/Permission requested:/gu)).toHaveLength(2);
    await runCli(["kill", sessionId], queueEnv);
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
    const waited = await runCli(["wait", sessionId, "--timeout", "100"], env);
    expect(waited.exitCode).toBe(4);
    expect(JSON.parse(waited.stdout)).toEqual({
      status: "timeout",
      results: [],
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
    const sessionId = /^Created session (.+)\n$/u.exec(result.stdout)?.[1];
    expect(sessionId).toBeDefined();
    await runCli(["kill", sessionId ?? ""], env);
  });

  test("attach pretty 权限交互并随决议结束", async () => {
    const { env } = await freshEnv();
    const spawned = await runCli(
      ["spawn", "permission", "do it", "--name", "test-session"],
      env,
    );
    expect(spawned.exitCode).toBe(0);
    const sessionId = sessionIdFrom(spawned);
    const attached = await runCli(
      ["attach", sessionId, "--pretty", "--exit-on", "end_turn"],
      env,
      { input: "1\n" },
    );
    expect(attached.exitCode).toBe(0);
    expect(attached.stdout).toContain("Permission requested");
    expect(attached.stdout).toContain("[attach ended]");
    expect(attached.stdout).toContain("resolved:allow");
    await runCli(["kill", sessionId], env);
  });

  test("attach pretty 显示 caller/worker 角色", async () => {
    const { env } = await freshEnv();
    const spawned = await runCli(
      ["spawn", "fake", "hello", "--name", "test-session"],
      env,
    );
    expect(spawned.exitCode).toBe(0);
    const sessionId = sessionIdFrom(spawned);
    const sent = await runCli(["send", sessionId, "next"], env);
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

        const oldAddress = await runCli(["send", oldSessionId, "stale"], env);
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
  let modes: readonly ("json" | "pretty")[] | undefined;
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
    case "forbiddenModeValue":
      add(constraint.field, constraint.value);
      field = flagDisplay(option(constraint.field).flags);
      modes = [constraint.mode];
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
    ...(modes === undefined ? {} : { modes }),
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
          issue?: string;
          target?: string;
          field?: string;
          value?: string;
          valid?: string[];
          hint?: string;
        };
        expect(parsed.code).toBe(usageCase.code ?? "usage_error");
        if (usageCase.issue !== undefined) {
          expect(parsed.issue).toBe(usageCase.issue);
        }
        if (usageCase.target !== undefined) {
          expect(parsed.target).toBe(usageCase.target);
        }
        if (usageCase.field !== undefined) {
          expect(parsed.field).toBe(usageCase.field);
        }
        if (usageCase.value !== undefined) {
          expect(parsed.value).toBe(usageCase.value);
        }
        if (usageCase.valid !== undefined) {
          expect(parsed.valid).toEqual([...usageCase.valid]);
        }
        if (usageCase.hint !== undefined) {
          expect(parsed.hint).toBe(usageCase.hint);
        }
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
        issue: "missing_argument",
        target: "argument",
        field: "harness",
        message:
          "Missing required argument 'harness'. Run 'reins capabilities' to list valid harnesses",
      })}\n`,
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
        "suggestion: Allowed: spawn, send, wait, interrupt, kill, list, attach, run, diagnostics, capabilities, resolve-permission\n" +
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
    const result = await runCli(
      ["--pretty", "run", "permission", "do it", "--name", "prompt-eof"],
      env,
      { timeoutMs: 3_000 },
    );
    expect(result.exitCode).toBe(65);
    expect(result.stdout).toContain("Permission requested:");
    expect(result.stderr).toBe(
      "error: Permission input closed before a choice was received\n",
    );
    expect(result.stderr).not.toContain("usage:");
    const listed = await runCli(["list", "--name", "prompt-eof"], env);
    const sessionId = (
      JSON.parse(listed.stdout) as Array<{ sessionId: string }>
    )[0]?.sessionId;
    if (sessionId !== undefined) await runCli(["kill", sessionId], env);
  });

  test("完整进程将无响应 daemon 区分为 daemon_timeout 并清理子进程", async () => {
    const { dir, env } = await freshEnv();
    const fixtureEnv = fixtureDaemonEnv(env, dir, "timeout");
    const started = Date.now();
    const result = await runCli(
      ["wait", fixtureSessionId, "--timeout", "1"],
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
      timeoutMs: 3_000,
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
  });

  test("daemon 被 signal 终止视为已经退出并及时返回", async () => {
    const { dir, env } = await freshEnv();
    const fixtureEnv = fixtureDaemonEnv(env, dir, "startup-signal");
    const started = Date.now();
    const result = await runCli(["capabilities"], fixtureEnv, {
      timeoutMs: 3_000,
    });
    expect(result.exitCode).toBe(65);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "daemon_start_failed",
      cause: {
        kind: "upstream",
        message: expect.stringContaining("SIGTERM"),
      },
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    await waitForFixtureStopped(fixtureEnv);
  });

  test("daemon 退出后仍排空 fd3 启动报告再解析 cause", async () => {
    const { dir, env } = await freshEnv();
    const fixtureEnv = fixtureDaemonEnv(env, dir, "startup-report-drain");
    const result = await runCli(["capabilities"], fixtureEnv, {
      timeoutMs: 3_000,
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
  });

  test("daemon 运行超过一秒后写入的完整启动报告仍保留 cause", async () => {
    const { dir, env } = await freshEnv();
    const fixtureEnv = fixtureDaemonEnv(env, dir, "startup-report-late");
    const result = await runCli(["capabilities"], fixtureEnv, {
      timeoutMs: 4_000,
    });
    expect(result.exitCode).toBe(65);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "daemon_start_failed",
      cause: { kind: "upstream", message: "late complete startup report" },
    });
    await waitForFixtureExit(fixtureEnv);
  });

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
    expect(Date.now() - started).toBeLessThan(2_000);
  });

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
    const result = await runCli(["send", missingSessionId, "hi"], env);
    expect(result.exitCode).toBe(65);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "session_not_found",
    });
  });

  test("wait 未知会话返回 session_not_found", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["wait", missingSessionId], env);
    expect(result.exitCode).toBe(65);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "session_not_found",
    });
  });

  test("kill 未知会话返回 not_found 而非报错", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["kill", missingSessionId], env);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { sessionId: missingSessionId, status: "not_found" },
    ]);
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
  });

  test("pretty 域错误不输出 suggestion 与 usage", async () => {
    const { env } = await freshEnv();
    const result = await runCli(
      ["--pretty", "send", missingSessionId, "hi"],
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
