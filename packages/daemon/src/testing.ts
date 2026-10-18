import { rm } from "node:fs/promises";

import type { ProtocolMessage } from "@reins/protocol";
import {
  protocolResponseSchema,
  REINS_PROTOCOL_MAJOR_VERSION,
  requestIdSchema,
} from "@reins/protocol";
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
      params: {
        protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
        consumerContext: "daemon-readiness",
      },
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
      identity: { session: () => openedRuntime.sessionId() },
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

    let lifecycle: "open" | "closing" | "cleanup_failed" | "closed" = "open";
    let closePromise: Promise<void> | undefined;
    return {
      connect() {
        if (lifecycle !== "open") {
          throw new Error(
            lifecycle === "cleanup_failed"
              ? "Ephemeral daemon cleanup failed"
              : `Ephemeral daemon is ${lifecycle}`,
          );
        }
        const connection = transport.connect();
        connections.add(connection);
        return connection;
      },
      close() {
        if (lifecycle === "closing" || lifecycle === "closed") {
          if (closePromise === undefined) {
            throw new Error("Ephemeral daemon close state is invalid");
          }
          return closePromise;
        }
        lifecycle = "closing";
        const attempt = (async () => {
          try {
            for (const connection of connections) connection.close();
            connections.clear();
            await createdDaemon.stop();
            await started;
            await openedRuntime.close();
            await rm(state.directory, { recursive: true, force: true });
            lifecycle = "closed";
          } catch (error) {
            lifecycle = "cleanup_failed";
            closePromise = undefined;
            throw error;
          }
        })();
        closePromise = attempt;
        return attempt;
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
