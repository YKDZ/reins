// 直接启动 daemon 长驻进程的生命周期接缝：真实 spawn、就绪等待（含启动失败/超时
// 事实）、停止（SIGTERM 宽限→SIGKILL 升级）。日志自 spawn 起完整落盘。
// 产品 CLI 自动拉起 sibling daemon 的路径不由本夹具启动，夹具只提供观察与兜底停止。
import { spawn } from "node:child_process";

import { observe, waitForPath } from "./process.ts";
import type {
  DaemonHandle,
  ProcessExitFact,
  StartDaemonOptions,
} from "./types.ts";

// 就绪判定：socket 文件出现即 transport 已绑定监听；启动失败与提前退出在轮询中
// 立即失败并把日志路径带进错误信息；就绪等待超时不抛错，而是记录 startupTimedOut
// 事实，交由调用方决定停止与报告，绝不自动重试掩盖失败。
export async function startDaemon(
  options: StartDaemonOptions,
): Promise<DaemonHandle> {
  const child = spawn(options.executable, [...options.args], {
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const observed = observe(child, options.logPath);
  let startupTimedOut = false;
  await waitForPath(
    options.socketPath,
    options.readyTimeoutMs,
    () => {
      const startupError = observed.startupError();
      if (startupError !== undefined) {
        return new Error(
          `${options.label} failed to start: ${String(startupError)} (log: ${options.logPath})`,
        );
      }
      if (!observed.running()) {
        return new Error(
          `${options.label} exited before becoming ready: exit=${String(child.exitCode)} signal=${String(child.signalCode)} (log: ${options.logPath})`,
        );
      }
      return undefined;
    },
    options.pollIntervalMs,
  ).catch((error: unknown) => {
    if (error instanceof Error && error.message.startsWith("Timed out")) {
      startupTimedOut = true;
      return;
    }
    throw error;
  });
  return {
    label: options.label,
    logPath: options.logPath,
    socketPath: options.socketPath,
    get startupTimedOut() {
      return startupTimedOut;
    },
    isRunning: observed.running,
    stop: observed.stop,
  };
}

// 停止并返回原始事实。clean 判定由调用方决定：产品自行退出/ SIGTERM 正常关闭
// 之外的任何事实（宽限期超时、升级 SIGKILL、残留进程）都必须保留并如实报告。
export async function stopDaemon(
  handle: DaemonHandle,
  graceMs: number,
): Promise<ProcessExitFact> {
  return handle.stop(graceMs);
}

// 停止事实的干净/非干净判定：供实际调用方与探针共用，避免各处复制判定逻辑。
// 干净 = 只有夹具实际发起的正常停止，或进程自行成功退出。信号值本身不能证明停止
// 由夹具发起，因此以 reason 归因（observe.stop 只在看到进程存活并亲自 kill(SIGTERM)
// 后才记 terminated；停止动作前进程已自行结束则记 exited）：
// - timedOut（宽限期耗尽升级 SIGKILL）或仍残留进程：清理失败。
// - reason=terminated（夹具对存活进程施加 SIGTERM）：被信号 SIGTERM 关闭，或捕获
//   SIGTERM 后干净 exit 0（真实 npm 直接守护进程的正常关闭）才算干净；其它信号即使
//   因回收竞态被记成 terminated，也一律非干净。
// - reason=exited（停止动作前进程已自行结束，信号无法归因于夹具）：只有 exit 0 且无
//   信号才算成功退出；非零退出码与自行 SIGTERM/SIGSEGV 都是清理失败。
// - spawn_error / sigkill_escalated 及其余事实：非干净。
export function isCleanStop(fact: ProcessExitFact): boolean {
  if (fact.timedOut || fact.stillRunning) return false;
  if (fact.reason === "terminated") {
    return (
      fact.signal === "SIGTERM" || (fact.signal === null && fact.exitCode === 0)
    );
  }
  if (fact.reason === "exited") {
    return fact.exitCode === 0 && fact.signal === null;
  }
  return false;
}
