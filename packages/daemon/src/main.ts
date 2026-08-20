#!/usr/bin/env node

import { closeSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createCodexCapabilities,
  createCodexDriver,
  createCodexTransport,
} from "@reins/codex";
import type { ProtocolMessage } from "@reins/protocol";
import { makeErrorCause } from "@reins/protocol";
import {
  createQoderCapabilities,
  createQoderDriver,
  createRealQoderSdk,
} from "@reins/qoder";
import {
  createUnixSocketServer,
  resolveReinsSocketPath,
} from "@reins/transport";

import { createDaemon, runDaemonLifecycle } from "./daemon.ts";
import { openDiagnosticsRuntime } from "./diagnostics-recorder.ts";
import type { HarnessAdapter } from "./registry.ts";
import { DEFAULT_IDLE_TIMEOUT_MS } from "./server.ts";

// 发布阶段的拼接点（ADR-0011）：默认注册两个真实 adapter；
// --adapters <module> 可用外部模块整体替换注册表（测试与扩展入口）。
function builtInAdapters(): Map<string, HarnessAdapter> {
  const qoderSdk = createRealQoderSdk();
  return new Map<string, HarnessAdapter>([
    [
      "qoder",
      {
        driverFactory: createQoderDriver({ sdk: qoderSdk }),
        capabilities: createQoderCapabilities(qoderSdk),
        canCaptureHarnessStderr: false,
      },
    ],
    [
      "codex",
      {
        driverFactory: createCodexDriver({
          transportFactory: (options) => createCodexTransport(options),
        }),
        capabilities: createCodexCapabilities(),
        canCaptureHarnessStderr: true,
      },
    ],
  ]);
}

async function loadAdapters(
  modulePath: string | undefined,
): Promise<Map<string, HarnessAdapter>> {
  if (modulePath === undefined) return builtInAdapters();
  const imported = (await import(pathToFileURL(modulePath).href)) as {
    default?: unknown;
  };
  const value = imported.default;
  if (value instanceof Map) {
    return new Map(value as Map<string, HarnessAdapter>);
  }
  if (typeof value === "object" && value !== null) {
    return new Map(Object.entries(value as Record<string, HarnessAdapter>));
  }
  throw new Error(
    `--adapters module must default-export a Map or object: ${modulePath}`,
  );
}

function parseFlags(argv: readonly string[]): {
  adaptersModule: string | undefined;
} {
  let adaptersModule: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--adapters") {
      adaptersModule = argv[index + 1];
      index += 1;
    } else if (arg?.startsWith("--adapters=")) {
      adaptersModule = arg.slice("--adapters=".length);
    }
  }
  return { adaptersModule };
}

function idleTimeoutFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env.REINS_IDLE_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_IDLE_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_IDLE_TIMEOUT_MS;
}

function installCrashHandlers(): void {
  process.on("uncaughtException", (error) => {
    console.error("reins-daemon uncaught exception", error);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("reins-daemon unhandled rejection", reason);
    process.exit(1);
  });
}

async function main(): Promise<void> {
  installCrashHandlers();
  const flags = parseFlags(process.argv.slice(2));
  const adaptersModule =
    flags.adaptersModule ?? process.env.REINS_ADAPTERS_MODULE;
  const socketPath = resolveReinsSocketPath(process.env);
  await mkdir(dirname(socketPath), { recursive: true });
  const adapters = await loadAdapters(adaptersModule);
  const transport = createUnixSocketServer<ProtocolMessage>({
    path: socketPath,
  });
  const diagnosticsRuntime = await openDiagnosticsRuntime();
  const daemon = createDaemon({
    transport,
    adapters,
    identity: {
      session: (sessionName) => diagnosticsRuntime.sessionId(sessionName),
    },
    diagnostics: diagnosticsRuntime,
    idleTimeoutMs: idleTimeoutFromEnv(process.env),
  });
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= daemon.stop();
    return shutdownPromise;
  };
  process.on("SIGINT", () => {
    void shutdown().catch(() => undefined);
  });
  process.on("SIGTERM", () => {
    void shutdown().catch(() => undefined);
  });
  await runDaemonLifecycle(
    { start: () => daemon.start(), stop: shutdown },
    diagnosticsRuntime,
  );
}

void main().catch((error: unknown) => {
  reportStartupFailure(error);
  console.error("reins-daemon failed to start", error);
  process.exitCode = 1;
});

function reportStartupFailure(error: unknown): void {
  const rawFd = process.env.REINS_STARTUP_FD;
  if (rawFd === undefined || !/^\d+$/u.test(rawFd)) return;
  const fd = Number(rawFd);
  if (!Number.isSafeInteger(fd) || fd < 3) return;
  try {
    writeFileSync(
      fd,
      `${JSON.stringify({
        v: 1,
        cause: makeErrorCause("exception", String(error)),
      })}\n`,
    );
    closeSync(fd);
  } catch {
    // 启动报告是辅助通道；进程仍按原始启动错误失败。
  }
}
