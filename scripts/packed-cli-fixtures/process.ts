// 窄共享进程夹具的执行/观察层：命令执行、就绪等待、超时与停止。
// 只负责进程生命周期与完整输出记录，不含任何场景断言；断言留在调用方入口。
import { spawn, type ChildProcess } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  type WriteStream,
} from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { LoggedCommandResult, ProcessExitFact } from "./types.ts";

export function ensureParentDirectory(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

// 到点期限：不 ref 事件循环。结果已定后落败的计时器不该继续维持调用进程存活，
// 而子进程自身的句柄在运行期间就让循环存活，因此真实超时分类不受影响。
function deadline(ms: number): Promise<false> {
  return delay(ms, undefined, { ref: false }).then(() => false as const);
}

type Observed = {
  readonly completion: Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>;
  readonly startupError: () => Error | undefined;
  readonly stdout: () => Buffer;
  readonly stderr: () => Buffer;
  readonly running: () => boolean;
  readonly stop: (graceMs: number) => Promise<ProcessExitFact>;
};

// 从进程启动起把 stdout/stderr 同时流式写入日志文件并在内存中收集；
// stop() 是唯一施加停止动作的入口：SIGTERM 宽限期耗尽后升级 SIGKILL，
// 并把超时、信号与残留进程作为原始事实返回（不抛错、不掩盖、不自动重试）。
function observeProcess(child: ChildProcess, logPath: string): Observed {
  ensureParentDirectory(logPath);
  const logStream: WriteStream = createWriteStream(logPath);
  let startupError: Error | undefined;
  child.on("error", (error) => {
    startupError ??= error;
    logStream.write(`${String(error)}\n`);
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const pairs = [
    [child.stdout, stdoutChunks],
    [child.stderr, stderrChunks],
  ] as const;
  for (const [stream, sink] of pairs) {
    if (stream === null || stream === undefined) continue;
    stream.on("data", (chunk: Buffer) => {
      logStream.write(chunk);
      sink.push(chunk);
    });
  }
  const closed = new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("close", (exitCode, signal) => {
      // stdio 管道已随进程结束；收尾日志流，让落盘成为可观察事实而非悬空等待。
      logStream.end();
      resolve({ exitCode, signal });
    });
  });
  // 确认收集完成：等待日志流关闭（文件描述符已关闭、内容已刷盘）后再报告结果。
  const completion = closed.then(
    (result) =>
      new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          if (logStream.closed) {
            resolve(result);
            return;
          }
          logStream.once("close", () => resolve(result));
          logStream.once("error", () => resolve(result));
        },
      ),
  );
  const running = (): boolean =>
    child.exitCode === null && child.signalCode === null;
  const fact = (
    reason: ProcessExitFact["reason"],
    timedOut: boolean,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): ProcessExitFact => ({
    reason,
    exitCode,
    signal,
    timedOut,
    stillRunning: running(),
  });
  return {
    completion,
    startupError: () => startupError,
    stdout: () => Buffer.concat(stdoutChunks),
    stderr: () => Buffer.concat(stderrChunks),
    running,
    stop: async (graceMs: number): Promise<ProcessExitFact> => {
      if (startupError !== undefined) {
        const observed = await completion;
        return fact("spawn_error", false, observed.exitCode, observed.signal);
      }
      if (!running()) {
        const observed = await completion;
        return fact("exited", false, observed.exitCode, observed.signal);
      }
      child.kill("SIGTERM");
      const graceful = await Promise.race([
        completion.then(() => true as const),
        deadline(graceMs),
      ]);
      if (graceful) {
        const observed = await completion;
        return fact("terminated", false, observed.exitCode, observed.signal);
      }
      child.kill("SIGKILL");
      const observed = await completion;
      return fact(
        "sigkill_escalated",
        true,
        observed.exitCode,
        observed.signal,
      );
    },
  };
}

// 供 daemon 接缝复用同一观察实现（日志流式落盘 + 停止事实）。
export function observe(child: ChildProcess, logPath: string): Observed {
  return observeProcess(child, logPath);
}

// 短命令：通过同一共享入口执行，完整 stdout/stderr（含失败输出）写入 logPath。
// timeoutMs 是调用方给出的执行上限：到点以 SIGTERM 宽限→SIGKILL 升级停止子进程，
// 并把超时作为原始事实保留在结果里（不抛错、不自动重试、不改写退出事实）。
const commandTimeoutStopGraceMs = 2_000;

export async function runLoggedCommand(options: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly logPath: string;
  readonly timeoutMs?: number;
}): Promise<LoggedCommandResult> {
  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const observed = observeProcess(child, options.logPath);
  const exit = await settleObservedExit(observed, options.timeoutMs);
  const error = observed.startupError();
  if (error !== undefined) {
    throw Object.assign(error, { logPath: options.logPath });
  }
  return {
    exit,
    stdout: observed.stdout().toString("utf8"),
    stderr: observed.stderr().toString("utf8"),
    logPath: options.logPath,
  };
}

async function settleObservedExit(
  observed: Observed,
  timeoutMs: number | undefined,
): Promise<ProcessExitFact> {
  if (timeoutMs === undefined) {
    const result = await observed.completion;
    return {
      reason: "exited",
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: false,
      stillRunning: false,
    };
  }
  const finished = await Promise.race([
    observed.completion.then(() => true as const),
    deadline(timeoutMs),
  ]);
  if (finished) {
    const result = await observed.completion;
    return {
      reason: "exited",
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: false,
      stillRunning: false,
    };
  }
  const stopped = await observed.stop(commandTimeoutStopGraceMs);
  return { ...stopped, timedOut: true };
}

// 轮询等待路径出现；每次轮询先检查 abort，让「进程已退出」等失败事实立即终止等待。
export async function waitForPath(
  path: string,
  timeoutMs: number,
  abort?: () => Error | undefined,
  pollIntervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    const failure = abort?.();
    if (failure !== undefined) throw failure;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for path: ${path}`);
    }
    await delay(pollIntervalMs);
  }
}

export async function waitForPathRemoval(
  path: string,
  timeoutMs: number,
  pollIntervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for removal: ${path}`);
    }
    await delay(pollIntervalMs);
  }
}
