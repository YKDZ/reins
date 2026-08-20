import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ProtocolMessage } from "@reins/protocol";
import { makeErrorCause } from "@reins/protocol";
import {
  createUnixSocketClient,
  resolveReinsSocketPath,
  type TransportConnection,
} from "@reins/transport";

import { machineError } from "./errors.ts";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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

  const args = resolveDaemonCommand(env);
  const adaptersModule = env.REINS_ADAPTERS_MODULE;
  if (adaptersModule !== undefined && adaptersModule !== "") {
    args.push("--adapters", adaptersModule);
  }
  const child = spawn(args[0] ?? "reins-daemon", args.slice(1), {
    // 不继承 stderr：管道场景下子进程持有的 fd 会拖住 CLI 事件循环；
    // daemon 启动失败时用户可前台运行 reins-daemon 查看错误（ADR-0009）。
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...env, REINS_SOCKET: socketPath },
  });
  options?.onSpawn?.(child);
  const timeoutMs = options?.timeoutMs ?? 5000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await tryConnect(socketPath);
    if (connected !== null) {
      // 让 CLI 进程不被 daemon 子进程句柄拖住，daemon 自行空闲退出。
      child.unref();
      return { connection: connected, child };
    }
    if (child.exitCode !== null) break;
    await sleep(50);
  }
  child.kill();
  throw machineError({
    code: "daemon_start_failed",
    cause: makeErrorCause(
      "timeout",
      `daemon failed to start within ${timeoutMs}ms (run reins-daemon in the foreground to see the error)`,
    ),
  });
}
