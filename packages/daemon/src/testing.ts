import { rm } from "node:fs/promises";

import type { ProtocolMessage } from "@reins/protocol";
import { protocolResponseSchema, requestIdSchema } from "@reins/protocol";
import {
  createInMemoryTransportServer,
  type TransportConnection,
} from "@reins/transport";
import * as v from "valibot";

import { createDaemon } from "./daemon.ts";
import { openDiagnosticsRuntimeForTest } from "./diagnostics-recorder.testing.ts";
import { openDiagnosticsStore } from "./diagnostics-store.ts";
import { daemonGenerationSchema } from "./generation.ts";
import type { AdapterRegistry } from "./registry.ts";
import { resolveDaemonState } from "./state.ts";

export type EphemeralDaemon = {
  connect(): TransportConnection<ProtocolMessage>;
  close(): Promise<void>;
};

async function waitUntilReady(
  connection: TransportConnection<ProtocolMessage>,
  startPromise: Promise<void>,
): Promise<void> {
  const requestId = v.parse(requestIdSchema, "testing-ready");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      action();
    };
    const unsubscribe = connection.onEvent((event) => {
      if (event.kind !== "message") return;
      const parsed = v.safeParse(protocolResponseSchema, event.message);
      if (!parsed.success || parsed.output.requestId !== requestId) return;
      const response = parsed.output;
      if ("error" in response) {
        finish(() => reject(new Error(JSON.stringify(response.error))));
        return;
      }
      finish(resolve);
    });
    void startPromise.then(
      () => finish(() => reject(new Error("Daemon stopped before ready"))),
      (error: unknown) => finish(() => reject(error)),
    );
    connection.send({
      kind: "request",
      requestId,
      method: "initialize",
      params: {},
    });
  });
}

// 仅供跨包 conformance 测试组合真实 daemon；不暴露内部事件注入或时序 hook。
export async function openEphemeralDaemonForTest(options: {
  adapters: AdapterRegistry;
}): Promise<EphemeralDaemon> {
  const state = await resolveDaemonState({ env: {} });
  let runtime:
    | Awaited<ReturnType<typeof openDiagnosticsRuntimeForTest>>
    | undefined;
  let daemon: ReturnType<typeof createDaemon> | undefined;
  let startPromise: Promise<void> | undefined;
  const connections = new Set<TransportConnection<ProtocolMessage>>();
  try {
    runtime = await openDiagnosticsRuntimeForTest({
      resolveState: async () => state,
      openStore: async () =>
        await openDiagnosticsStore({ directory: state.diagnosticsDirectory }),
      allocateGeneration: async () => v.parse(daemonGenerationSchema, "test"),
    });
    const openedRuntime = runtime;
    const transport = createInMemoryTransportServer<ProtocolMessage>();
    const createdDaemon = createDaemon({
      transport,
      adapters: options.adapters,
      identity: { session: (name) => openedRuntime.sessionId(name) },
      diagnostics: openedRuntime,
      idleTimeoutMs: 60_000,
    });
    daemon = createdDaemon;
    const started = createdDaemon.start();
    startPromise = started;
    const readinessConnection = transport.connect();
    connections.add(readinessConnection);
    try {
      await waitUntilReady(readinessConnection, started);
    } finally {
      readinessConnection.close();
      connections.delete(readinessConnection);
    }

    let closePromise: Promise<void> | undefined;
    return {
      connect() {
        const connection = transport.connect();
        connections.add(connection);
        return connection;
      },
      close() {
        if (closePromise !== undefined) return closePromise;
        closePromise = (async () => {
          for (const connection of connections) connection.close();
          connections.clear();
          try {
            const stopped = createdDaemon.stop();
            const lifecycle = await Promise.allSettled([stopped, started]);
            const failures = lifecycle.flatMap((result) =>
              result.status === "rejected" ? [result.reason] : [],
            );
            if (failures.length > 0) {
              throw new AggregateError(
                failures,
                "Ephemeral daemon cleanup failed",
              );
            }
          } finally {
            try {
              await openedRuntime.close();
            } finally {
              await rm(state.directory, { recursive: true, force: true });
            }
          }
        })();
        return closePromise;
      },
    };
  } catch (error) {
    for (const connection of connections) connection.close();
    await daemon?.stop().catch(() => {});
    await startPromise?.catch(() => {});
    await runtime?.close().catch(() => {});
    await rm(state.directory, { recursive: true, force: true });
    throw error;
  }
}
