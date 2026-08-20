#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createCodexCapabilities,
  createCodexDriver,
  createCodexTransport,
} from "@reins/codex";
import type { ProtocolMessage } from "@reins/protocol";
import {
  createQoderCapabilities,
  createQoderDriver,
  createRealQoderSdk,
} from "@reins/qoder";
import {
  createUnixSocketServer,
  resolveReinsSocketPath,
} from "@reins/transport";

import { createDaemon } from "./daemon.ts";
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
      },
    ],
    [
      "codex",
      {
        driverFactory: createCodexDriver({
          transportFactory: () => createCodexTransport({}),
        }),
        capabilities: createCodexCapabilities(),
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
  const daemon = createDaemon({
    transport,
    adapters,
    idleTimeoutMs: idleTimeoutFromEnv(process.env),
  });
  const shutdown = async (): Promise<void> => {
    await daemon.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
  await daemon.start();
}

void main().catch((error: unknown) => {
  console.error("reins-daemon failed to start", error);
  process.exit(1);
});
