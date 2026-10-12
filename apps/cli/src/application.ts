import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { createReinsClient, type ReinsClient } from "@reins/client";
import type {
  ConsumerContext,
  ErrorCause,
  MachineError,
  ProtocolMessage,
} from "@reins/protocol";
import { machineErrorSchema, makeErrorCause } from "@reins/protocol";
import {
  createUnixSocketClient,
  isTransportErrorCode,
  resolveReinsSocketPath,
  type TransportConnection,
  type TransportErrorCode,
} from "@reins/transport";
import lockfile from "proper-lockfile";
import * as v from "valibot";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const STARTUP_REPORT_FD = 3;
const STARTUP_REPORT_MAX_BYTES = 8 * 1024;
const STARTUP_REPORT_DRAIN_TIMEOUT_MS = 1_000;

type StartupReportFailure =
  | { kind: "cause"; cause: ErrorCause }
  | { kind: "transport"; code: TransportErrorCode };

type StartupReport = {
  done: Promise<void>;
  failure(): StartupReportFailure | undefined;
  close(): void;
};

async function tryConnect(
  socketPath: string,
): Promise<TransportConnection<ProtocolMessage> | null> {
  try {
    return await createUnixSocketClient<ProtocolMessage>(socketPath);
  } catch {
    return null;
  }
}

// 只使用显式命令或运行包内的 daemon；开发入口由调用方提供所属包的构建产物。
function resolveDaemonCommand(
  env: NodeJS.ProcessEnv,
  moduleUrl: string | URL = import.meta.url,
): string[] {
  const explicit = env.REINS_DAEMON_BIN;
  if (explicit !== undefined && explicit !== "") return [explicit];
  const siblingPath = fileURLToPath(new URL("./reins-daemon.js", moduleUrl));
  if (existsSync(siblingPath)) return [process.execPath, siblingPath];
  throw {
    code: "daemon_start_failed",
    cause: makeErrorCause("io", "Unable to locate the reins-daemon executable"),
  } satisfies MachineError;
}

export type ConnectReinsOptions = {
  consumerContext: ConsumerContext;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

export type ReinsStartupTransportFailure = {
  readonly kind: "reins_startup_transport_failure";
  readonly code: TransportErrorCode;
};

export function isReinsStartupTransportFailure(
  error: unknown,
): error is ReinsStartupTransportFailure {
  return (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    error.kind === "reins_startup_transport_failure" &&
    "code" in error &&
    isTransportErrorCode(error.code)
  );
}

// 返回已完成协议握手的客户端；CLI 和其他调用方共享同一启动入口。
export async function connectReins(
  options: ConnectReinsOptions,
): Promise<ReinsClient> {
  const env = options.env ?? process.env;
  const socketPath = resolveReinsSocketPath({ env });
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  let spawnError: Error | undefined;
  let launchError: Error | undefined;
  let handshakeError: MachineError | undefined;
  let child: ChildProcess | undefined;
  let startup: ReturnType<typeof collectStartupReport> | undefined;
  let releaseLaunch: (() => Promise<void>) | undefined;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const connected = await tryConnect(socketPath);
    if (connected !== null) {
      const ready = await initializeClient(
        connected,
        options.consumerContext,
        deadline,
      );
      if (ready.error === undefined) {
        startup?.close();
        await releaseLaunch?.();
        // 客户端结束时不拖住短命调用方，daemon 按会话与空闲规则退出。
        child?.unref();
        return ready.client;
      }
      handshakeError = ready.error;
      ready.client.close();

      if (child !== undefined && !hasExited(child)) {
        await terminateChild(child);
        await drainStartupReport(startup);
        const reportedFailure = startup?.failure();
        startup?.close();
        await releaseLaunch?.();
        if (reportedFailure !== undefined) {
          throw daemonStartupFailure(reportedFailure);
        }
        throw handshakeError;
      }
      if (releaseLaunch !== undefined) {
        startup?.close();
        await releaseLaunch();
        throw handshakeError;
      }
      if (Date.now() >= deadline) throw handshakeError;
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
        // 获得启动锁后再次握手，覆盖前一赢家刚上线的竞争窗口。
        const winner = await tryConnect(socketPath);
        if (winner !== null) {
          const ready = await initializeClient(
            winner,
            options.consumerContext,
            deadline,
          );
          if (ready.error === undefined) {
            startup?.close();
            await releaseLaunch();
            return ready.client;
          }
          ready.client.close();
          handshakeError = ready.error;
          await releaseLaunch();
          releaseLaunch = undefined;
          throw handshakeError;
        }
        if (Date.now() >= deadline) break;

        let args: string[];
        try {
          args = resolveDaemonCommand(env);
        } catch (error) {
          await releaseLaunch();
          releaseLaunch = undefined;
          throw error;
        }
        const adaptersModule = env.REINS_ADAPTERS_MODULE;
        if (adaptersModule !== undefined && adaptersModule !== "") {
          args.push("--adapters", adaptersModule);
        }
        child = spawn(args[0] ?? process.execPath, args.slice(1), {
          // fd 3 只承载启动窗口的有界机器报告；正常后台 stdout/stderr 仍不进入 CLI。
          stdio: ["ignore", "ignore", "ignore", "pipe"],
          env: {
            ...env,
            REINS_SOCKET: socketPath,
            REINS_STARTUP_FD: String(STARTUP_REPORT_FD),
          },
        });
        startup = collectStartupReport(
          child.stdio[STARTUP_REPORT_FD] as Readable | null | undefined,
        );
        child.once("error", (error) => {
          spawnError = error;
        });
      }
    }
    // 自己拉起的进程可能输掉外部竞争；继续观察同一 socket 直到总时限。
    await sleep(50);
  }

  const childAliveAtDeadline = child !== undefined && !hasExited(child);
  if (child !== undefined) await terminateChild(child);
  await drainStartupReport(startup);
  const reportedFailure = startup?.failure();
  startup?.close();
  await releaseLaunch?.();
  if (reportedFailure !== undefined) {
    throw daemonStartupFailure(reportedFailure);
  }
  if (handshakeError !== undefined) throw handshakeError;
  const cause =
    launchError === undefined && spawnError === undefined
      ? child === undefined || childAliveAtDeadline
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
      : makeErrorCause("io", (spawnError ?? launchError)?.message ?? "unknown");
  throw { code: "daemon_start_failed", cause } satisfies MachineError;
}

async function initializeClient(
  connection: TransportConnection<ProtocolMessage>,
  consumerContext: ConsumerContext,
  deadline: number,
): Promise<{ client: ReinsClient; error?: MachineError }> {
  const client = createReinsClient(connection, { consumerContext });
  let closedError: MachineError | undefined;
  const unsubscribe = client.onClosed((reason) => {
    closedError = reason;
  });
  try {
    const response = await client.initialize(
      Math.max(1, deadline - Date.now()),
    );
    return "error" in response ? { client, error: response.error } : { client };
  } catch (error) {
    return { client, error: closedError ?? machineErrorFromRejection(error) };
  } finally {
    unsubscribe();
  }
}

function machineErrorFromRejection(error: unknown): MachineError {
  if (error instanceof Error) {
    try {
      const parsed: unknown = JSON.parse(error.message);
      const result = v.safeParse(machineErrorSchema, parsed);
      if (result.success) return result.output;
    } catch {
      // 客户端 rejection 不是机器错误 JSON 时使用断连错误。
    }
  }
  return { code: "daemon_disconnected" };
}

async function drainStartupReport(
  startup: ReturnType<typeof collectStartupReport> | undefined,
): Promise<void> {
  if (startup !== undefined) {
    await Promise.race([startup.done, sleep(STARTUP_REPORT_DRAIN_TIMEOUT_MS)]);
  }
}

function daemonStartupFailure(
  failure: StartupReportFailure,
): MachineError | ReinsStartupTransportFailure {
  if (failure.kind === "transport") {
    return {
      kind: "reins_startup_transport_failure",
      code: failure.code,
    };
  }
  return {
    code: "daemon_start_failed",
    cause: failure.cause,
  };
}

function isLaunchLockContention(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ELOCKED"
  );
}

function collectStartupReport(
  stream: Readable | null | undefined,
): StartupReport {
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
    failure() {
      for (const line of text.trim().split("\n").reverse()) {
        try {
          const parsed = JSON.parse(line) as {
            v?: unknown;
            cause?: { kind?: unknown; message?: unknown };
            transport?: { code?: unknown };
          };
          const transportCode = parsed.transport?.code;
          if (parsed.v === 1 && isTransportErrorCode(transportCode)) {
            return { kind: "transport", code: transportCode };
          }
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
            return { kind: "cause", cause: makeErrorCause(kind, message) };
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
