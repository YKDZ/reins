import { spawn, type ChildProcess } from "node:child_process";
import { access, cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { daemonGenerationSchema, sessionIdSchema } from "@reins/protocol";
import * as v from "valibot";
import { afterEach, describe, expect, test } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const cliBin = join(repoRoot, "apps/cli/dist/reins.js");
const daemonBin = join(repoRoot, "packages/daemon/dist/main.js");
const fixturesModule = join(
  repoRoot,
  "apps/cli/test/e2e/fixtures/fake-adapters.ts",
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
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliBin, ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout?.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    child.stdin?.end();
    let settled = false;
    let timedOut = false;
    let watchdog: NodeJS.Timeout | undefined;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (watchdog !== undefined) clearTimeout(watchdog);
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
      watchdog = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(-1);
      }, 2_000);
    }, 15_000);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (watchdog !== undefined) clearTimeout(watchdog);
      reject(error);
    });
    child.on("close", (code) => {
      finish(timedOut ? -1 : (code ?? -1));
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

function processAlive(pid: number): boolean {
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
  timeoutMs = 8_000,
): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("wait condition timed out");
    }
    await sleep(50);
  }
}

const ownedDaemons: ChildProcess[] = [];
const cleanupDirs: string[] = [];

afterEach(async () => {
  for (const daemon of ownedDaemons.splice(0)) {
    if (daemon.exitCode === null && daemon.signalCode === null) {
      daemon.kill("SIGKILL");
    }
  }
  for (const dir of cleanupDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

// 每次 startDaemon 都真实 fork packages/daemon/dist/main.js：generation 由
// 真实 state 分配（openDiagnosticsRuntime 在 socket 打开前 allocate 一次）。
// 显式 stopDaemon 保证每一代是独立进程，且留下 owned PID／退出证据。
async function startDaemon(env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const daemon = spawn(
    process.execPath,
    [daemonBin, "--adapters", fixturesModule],
    { env: { ...process.env, ...env }, stdio: "ignore" },
  );
  ownedDaemons.push(daemon);
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

function generationOf(sessionId: string): string {
  return sessionId.slice(sessionId.lastIndexOf("@g") + 2);
}

function sessionIdFrom(result: CliResult): string {
  return v.parse(
    sessionIdSchema,
    (JSON.parse(result.stdout) as { sessionId: unknown }).sessionId,
  );
}

describe("世代身份谱系：真实 CLI + 真实 daemon + 真实 state", () => {
  // acceptance 反例：把耐久 generation 计数器回滚到旧值后，重新分配的世代
  // token 仍须与旧标识不同，令旧 SessionId 引用失效，而非冒充原命名空间连续。
  test("状态回滚后同名会话不重用旧世代，旧引用按不存在拒绝", async () => {
    const dir = await mkdtemp(
      join(
        process.platform === "linux" ? "/dev/shm" : tmpdir(),
        "reins-wrr01-lineage-",
      ),
    );
    cleanupDirs.push(dir);
    const stateDir = join(dir, "state");
    const snapshotDir = join(dir, "snapshot");
    const socketPath = join(dir, "reins.sock");
    // 大 idleTimeout 让 daemon 在测试显式启停期间保持存活，避免空闲自毁
    // 触发 CLI 冷启动而额外分配世代、破坏逐代计数账目。
    const env: NodeJS.ProcessEnv = {
      REINS_SOCKET: socketPath,
      REINS_STATE_DIR: stateDir,
      REINS_DAEMON_BIN: daemonBin,
      REINS_ADAPTERS_MODULE: fixturesModule,
      REINS_IDLE_TIMEOUT_MS: "120000",
      REINS_CONSUMER_CONTEXT: "cli-e2e",
    };

    // 第一代：真实启动分配计数器 1，干净停止后保存其 state 快照。
    // 快照必须在停止后采集：运行中的 diagnostics store 持有 writer lock，
    // 热拷贝会把陈旧锁带回、令下一代启动失败；而持久 state 回滚本就针对
    // 静止的落盘状态。
    const first = await startDaemon(env);
    const firstPid = first.pid ?? -1;
    await stopDaemon(first, socketPath);
    await cp(stateDir, snapshotDir, { recursive: true });

    // 第二代：真实新进程，同名 foo 取得“旧引用”。
    const second = await startDaemon(env);
    const secondPid = second.pid ?? -1;
    const spawned2 = await runCli(
      ["spawn", "fake", "hello", "--name", "foo"],
      env,
    );
    expect(spawned2.exitCode).toBe(0);
    const staleHandle = sessionIdFrom(spawned2);
    const staleGeneration = generationOf(staleHandle);
    const counterAfterSecond = (
      await readFile(join(stateDir, "generation"), "utf8")
    ).trim();
    await stopDaemon(second, socketPath);

    // 回滚：删除并恢复第一代 state，把 generation 计数器还原到第二代读取前的旧值。
    await rm(stateDir, { recursive: true, force: true });
    await cp(snapshotDir, stateDir, { recursive: true });

    // 第三代：真实新进程，同名 foo 重新分配。
    const third = await startDaemon(env);
    const thirdPid = third.pid ?? -1;
    const spawned3 = await runCli(
      ["spawn", "fake", "hello", "--name", "foo"],
      env,
    );
    expect(spawned3.exitCode).toBe(0);
    const currentHandle = sessionIdFrom(spawned3);
    const currentGeneration = generationOf(currentHandle);
    const counterAfterThird = (
      await readFile(join(stateDir, "generation"), "utf8")
    ).trim();

    // 计数器被回滚到第二代所用的同一值，因而身份 token 只能靠启动 epoch 区分；
    // 这正是与“普通重启仅计数器递增”不同的机制证据。
    expect(counterAfterThird).toBe(counterAfterSecond);
    expect(currentGeneration).not.toBe(staleGeneration);
    expect(currentHandle).not.toBe(staleHandle);
    expect(v.safeParse(daemonGenerationSchema, currentGeneration).success).toBe(
      true,
    );

    // 操作旧引用：按不存在拒绝（退出 65）。
    const stale = await runCli(["send", staleHandle, "stale"], env);
    expect(stale.exitCode).toBe(65);
    expect(JSON.parse(stale.stdout)).toMatchObject({
      code: "session_not_found",
      sessionId: staleHandle,
    });

    // 当前会话仍可查。
    const listed = await runCli(["list", "--name", "foo"], env);
    const sessions = JSON.parse(listed.stdout) as Array<{ sessionId: string }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe(currentHandle);

    await runCli(["kill", currentHandle], env);

    // 每次重启确实是独立进程，且逐一退出。
    expect(new Set([firstPid, secondPid, thirdPid]).size).toBe(3);
    await stopDaemon(third, socketPath);
    for (const daemon of [first, second, third]) {
      expect(daemon.exitCode !== null || daemon.signalCode !== null).toBe(true);
    }
    expect(processAlive(thirdPid)).toBe(false);
  }, 30_000);
});
