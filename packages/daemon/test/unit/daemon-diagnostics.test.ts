import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ProtocolMessage,
  ProtocolResponse,
  WorkerDriverFactory,
} from "@reins/protocol";
import { requestIdSchema } from "@reins/protocol";
import { createInMemoryTransportServer } from "@reins/transport";
import * as v from "valibot";
import { afterEach, describe, expect, test } from "vitest";

import { createDaemon } from "../../src/daemon.ts";
import { openDiagnosticsRuntimeForTest } from "../../src/diagnostics-recorder.testing.ts";
import { openDiagnosticsStore } from "../../src/diagnostics-store.ts";
import { daemonGenerationSchema } from "../../src/generation.ts";
import type { HarnessAdapter } from "../../src/registry.ts";
import type { DaemonState } from "../../src/state.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("daemon diagnostic error dispatch", () => {
  test("does not respond with an id until the real store can query it", async () => {
    const root = await mkdtemp(join(tmpdir(), "reins-daemon-diagnostic-"));
    directories.push(root);
    const state: DaemonState = {
      directory: root,
      diagnosticsDirectory: join(root, "diagnostics"),
      durable: true,
      retention: { maxAgeMs: 60_000, maxBytes: 1024 * 1024 },
    };
    const runtime = await openDiagnosticsRuntimeForTest({
      resolveState: async () => state,
      openStore: async () =>
        await openDiagnosticsStore({ directory: state.diagnosticsDirectory }),
      allocateGeneration: async () =>
        v.parse(daemonGenerationSchema, "dispatch"),
    });
    const driverFactory: WorkerDriverFactory = () => ({
      start() {
        throw new Error("worker start failed");
      },
      deliver() {},
      interrupt() {},
      resolvePermission() {},
      terminate() {},
    });
    const adapter: HarnessAdapter = {
      driverFactory,
      capabilities: async () => ({
        harness: "fake",
        models: [],
        authorizationModes: ["allowAll"],
        sandbox: { modes: [] },
      }),
    };
    const transport = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport,
      adapters: new Map([["fake", adapter]]),
      identity: { session: (name) => runtime.sessionId(name) },
      diagnostics: runtime,
      idleTimeoutMs: 60_000,
    });
    const running = daemon.start();
    const client = transport.connect();
    await Promise.resolve();
    try {
      const response = new Promise<ProtocolResponse>((resolve) => {
        client.onEvent((event) => {
          if (event.kind === "message" && event.message.kind === "response") {
            resolve(event.message);
          }
        });
      });
      client.send({
        kind: "request",
        requestId: v.parse(requestIdSchema, "r1"),
        method: "spawn",
        params: {
          sessionName: "failed-worker",
          harness: "fake",
          message: "start",
        },
      });
      const failed = await response;
      expect(failed).toMatchObject({
        error: {
          code: "internal_error",
          cause: { kind: "exception", message: "worker start failed" },
        },
      });
      if (
        !("error" in failed) ||
        failed.error.code !== "internal_error" ||
        failed.error.diagnosticId === undefined
      ) {
        throw new Error("Expected a diagnostic id");
      }
      await expect(
        runtime.query({ diagnosticId: failed.error.diagnosticId }),
      ).resolves.toMatchObject({
        record: { diagnosticId: failed.error.diagnosticId },
      });
    } finally {
      await daemon.stop();
      await running;
      await runtime.close();
    }
  });
});
