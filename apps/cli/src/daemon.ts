import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import type { ErrorCause, ProtocolMessage } from "@reins/protocol";
import { makeErrorCause } from "@reins/protocol";
import {
  createUnixSocketClient,
  resolveReinsSocketPath,
  type TransportConnection,
} from "@reins/transport";
import lockfile from "proper-lockfile";

import { machineError } from "./errors.ts";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const STARTUP_REPORT_FD = 3;
const STARTUP_REPORT_MAX_BYTES = 8 * 1024;
const STARTUP_REPORT_DRAIN_TIMEOUT_MS = 1_000;

async function tryConnect(
  socketPath: string,
): Promise<TransportConnection<ProtocolMessage> | null> {
  try {
    return await createUnixSocketClient<ProtocolMessage>(socketPath);
  } catch {
    return null;
  }
}

// 开发模式默认指向 monorepo 内 daemon 构建产物；发布形态回退到同名 bin。
export function resolveDaemonCommand(env: NodeJS.ProcessEnv): string[] {
  const explicit = env.REINS_DAEMON_BIN;
  if (explicit !== undefined && explicit !== "") return [explicit];
  const devPath = fileURLToPath(
    new URL("../../../packages/daemon/dist/main.js", import.meta.url),
  );
  if (existsSync(devPath)) return [process.execPath, devPath];
  return ["reins-daemon"];
}

export type EnsureDaemonResult = {
  connection: TransportConnection<ProtocolMessage>;
  child: ChildProcess | null;
};

// 自动拉起：先探测既有 daemon，不存在则子进程拉起并轮询 socket。
export async function ensureDaemon(
  env: NodeJS.ProcessEnv,
  options?: { timeoutMs?: number; onSpawn?: (child: ChildProcess) => void },
): Promise<EnsureDaemonResult> {
  const socketPath = resolveReinsSocketPath(env);
  const existing = await tryConnect(socketPath);
  if (existing !== null) return { connection: existing, child: null };
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  let spawnError: Error | undefined;
  let launchError: Error | undefined;
  let child: ChildProcess | undefined;
  let startup: ReturnType<typeof collectStartupReport> | undefined;
  let releaseLaunch: (() => Promise<void>) | undefined;
  const timeoutMs = options?.timeoutMs ?? 5000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await tryConnect(socketPath);
    if (connected !== null) {
      startup?.close();
      await releaseLaunch?.();
      // 让 CLI 进程不被 daemon 子进程句柄拖住，daemon 自行空闲退出。
      child?.unref();
      return { connection: connected, child: child ?? null };
    }
    if (releaseLaunch === undefined && child === undefined) {
      try {
        releaseLaunch = await lockfile.lock(socketPath, {
          realpath: false,
          retries: 0,
          stale: 2_000,
          update: 1_000,
        });
      } catch (error) {
        if (!isLaunchLockContention(error)) {
          launchError =
            error instanceof Error ? error : new Error(String(error));
        }
      }
      if (releaseLaunch !== undefined) {
        launchError = undefined;
        // 获得 launcher 所有权后复查：前一赢家可能刚在探测与加锁之间上线。
        const winner = await tryConnect(socketPath);
        if (winner !== null) {
          await releaseLaunch();
          return { connection: winner, child: null };
        }
        const args = resolveDaemonCommand(env);
        const adaptersModule = env.REINS_ADAPTERS_MODULE;
        if (adaptersModule !== undefined && adaptersModule !== "") {
          args.push("--adapters", adaptersModule);
        }
        child = spawn(args[0] ?? "reins-daemon", args.slice(1), {
          // fd 3 只承载启动窗口的有界机器报告；正常后台 stdout/stderr 仍不进入 CLI。
          stdio: ["ignore", "ignore", "ignore", "pipe"],
          env: {
            ...env,
            REINS_SOCKET: socketPath,
            REINS_STARTUP_FD: String(STARTUP_REPORT_FD),
          },
        });
        options?.onSpawn?.(child);
        startup = collectStartupReport(
          child.stdio[STARTUP_REPORT_FD] as Readable | null | undefined,
        );
        child.once("error", (error) => {
          spawnError = error;
        });
      }
    }
    // 自己拉起的 child 可能输掉同 socket 的外部竞争；其退出不代表赢家
    // 不会在总 deadline 内上线，因此继续连接同一 socket。
    await sleep(50);
  }
  if (child !== undefined) await terminateChild(child);
  // 启动报告的排空窗口从失败已确定时开始；daemon 正常运行多久都不会
  // 提前耗尽这个窗口。stream 终态仍是完整报告的唯一完成信号。
  if (startup !== undefined) {
    await Promise.race([startup.done, sleep(STARTUP_REPORT_DRAIN_TIMEOUT_MS)]);
  }
  const reportedCause = startup?.cause();
  startup?.close();
  await releaseLaunch?.();
  const cause =
    reportedCause ??
    (spawnError === undefined && launchError === undefined
      ? child === undefined || !hasExited(child)
        ? makeErrorCause(
            "timeout",
            `daemon failed to start within ${timeoutMs}ms`,
          )
        : child.signalCode !== null
          ? makeErrorCause(
              "upstream",
              `daemon exited before startup completed (signal ${child.signalCode})`,
            )
          : makeErrorCause(
              "upstream",
              `daemon exited before startup completed (code ${child.exitCode})`,
            )
      : makeErrorCause(
          "io",
          (spawnError ?? launchError)?.message ?? "unknown",
        ));
  throw machineError({
    code: "daemon_start_failed",
    cause,
  });
}

function isLaunchLockContention(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ELOCKED"
  );
}

function collectStartupReport(stream: Readable | null | undefined): {
  done: Promise<void>;
  cause(): ErrorCause | undefined;
  close(): void;
} {
  let text = "";
  let settled = false;
  let settleDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    settleDone = resolve;
  });
  const settle = (): void => {
    if (settled) return;
    settled = true;
    settleDone();
  };
  if (stream !== null && stream !== undefined) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      if (Buffer.byteLength(text, "utf8") >= STARTUP_REPORT_MAX_BYTES) return;
      text = appendUtf8Bounded(text, chunk, STARTUP_REPORT_MAX_BYTES);
    });
    stream.once("end", settle);
    stream.once("close", settle);
    stream.once("error", settle);
  } else {
    settle();
  }
  return {
    done,
    cause() {
      for (const line of text.trim().split("\n").reverse()) {
        try {
          const parsed = JSON.parse(line) as {
            v?: unknown;
            cause?: { kind?: unknown; message?: unknown };
          };
          const kind = parsed.cause?.kind;
          const message = parsed.cause?.message;
          if (
            parsed.v === 1 &&
            typeof message === "string" &&
            (kind === "exception" ||
              kind === "upstream" ||
              kind === "io" ||
              kind === "timeout" ||
              kind === "closed")
          ) {
            return makeErrorCause(kind, message);
          }
        } catch {
          // 启动报告不是完整 JSON 时继续查找；最终回退到进程状态。
        }
      }
      return undefined;
    },
    close() {
      stream?.destroy();
      settle();
    },
  };
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function appendUtf8Bounded(
  current: string,
  addition: string,
  maxBytes: number,
): string {
  let result = current;
  let bytes = Buffer.byteLength(current, "utf8");
  for (const character of addition) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (
    child.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  )
    return;
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
  child.kill("SIGTERM");
  const exited = await Promise.race([
    closed.then(() => true),
    sleep(1_000).then(() => false),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([closed, sleep(1_000)]);
  }
}
