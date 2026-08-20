import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as v from "valibot";
import { afterEach, describe, expect, test } from "vitest";

import { runDaemonLifecycle, type Daemon } from "../../src/daemon.ts";
import { openDiagnosticsRuntimeForTest } from "../../src/diagnostics-recorder.testing.ts";
import type { DiagnosticsRuntime } from "../../src/diagnostics-recorder.ts";
import { openDiagnosticsStore } from "../../src/diagnostics-store.ts";
import { daemonGenerationSchema } from "../../src/generation.ts";
import type { DaemonState } from "../../src/state.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function realRuntime(): Promise<{
  runtime: DiagnosticsRuntime;
  state: DaemonState;
}> {
  const root = await mkdtemp(join(tmpdir(), "reins-lifecycle-test-"));
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
    allocateGeneration: async () => v.parse(daemonGenerationSchema, "life"),
  });
  return { runtime, state };
}

describe("daemon diagnostics lifecycle ownership", () => {
  test("natural completion stops daemon before closing and flushing the real runtime", async () => {
    const { runtime, state } = await realRuntime();
    const diagnosticId = await runtime.record({
      source: "daemon",
      kind: "lifecycle",
      operation: "daemon",
      reason: "started",
    });
    const order: string[] = [];
    const daemon: Daemon = {
      async start() {
        order.push("start");
      },
      async stop() {
        order.push("stop");
      },
    };
    await runDaemonLifecycle(daemon, {
      record: (input) => runtime.record(input),
      async close() {
        order.push("close");
        await runtime.close();
      },
    });

    expect(order).toEqual(["start", "stop", "close"]);
    const reopened = await openDiagnosticsStore({
      directory: state.diagnosticsDirectory,
    });
    await expect(
      reopened.query({ kinds: ["lifecycle"] }),
    ).resolves.toMatchObject({
      records: [
        { operation: "daemon", reason: "started" },
        { operation: "diagnostics_store", reason: "initialized" },
        { operation: "diagnostics_store", reason: "closed" },
      ],
    });
    await expect(
      reopened.query({ diagnosticId: diagnosticId! }),
    ).resolves.toMatchObject({ record: { diagnosticId } });
    await reopened.close();
  });

  test("start failure still stops before closing the runtime", async () => {
    const { runtime, state } = await realRuntime();
    const order: string[] = [];
    await expect(
      runDaemonLifecycle(
        {
          async start() {
            order.push("start");
            throw new Error("listen failed");
          },
          async stop() {
            order.push("stop");
          },
        },
        {
          record: (input) => runtime.record(input),
          async close() {
            order.push("close");
            await runtime.close();
          },
        },
      ),
    ).rejects.toThrow("listen failed");
    expect(order).toEqual(["start", "stop", "close"]);
    const reopened = await openDiagnosticsStore({
      directory: state.diagnosticsDirectory,
    });
    await reopened.close();
  });

  test("stop failure keeps the diagnostics runtime open for cleanup retry", async () => {
    const { runtime } = await realRuntime();
    let closes = 0;
    await expect(
      runDaemonLifecycle(
        {
          async start() {},
          async stop() {
            throw new Error("worker cleanup failed");
          },
        },
        {
          record: (input) => runtime.record(input),
          async close() {
            closes += 1;
            await runtime.close();
          },
        },
      ),
    ).rejects.toThrow("worker cleanup failed");
    expect(closes).toBe(0);
    await expect(
      runtime.record({
        source: "daemon",
        kind: "lifecycle",
        operation: "diagnostics_store",
        reason: "invariant_failed",
      }),
    ).resolves.toBeDefined();
    await runtime.close();
  });

  test("repeated signal shutdown closes exactly once after stop", async () => {
    const { runtime, state } = await realRuntime();
    let releaseStart!: () => void;
    const started = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let stops = 0;
    const daemon: Daemon = {
      async start() {
        await started;
      },
      async stop() {
        stops += 1;
        releaseStart();
      },
    };
    let shutdown: Promise<void> | undefined;
    const ownedDaemon: Daemon = {
      start: () => daemon.start(),
      stop: () => (shutdown ??= daemon.stop()),
    };
    let closes = 0;
    const lifecycle = runDaemonLifecycle(ownedDaemon, {
      record: (input) => runtime.record(input),
      async close() {
        closes += 1;
        await runtime.close();
      },
    });
    await ownedDaemon.stop();
    await ownedDaemon.stop();
    await lifecycle;

    expect(stops).toBe(1);
    expect(closes).toBe(1);
    const reopened = await openDiagnosticsStore({
      directory: state.diagnosticsDirectory,
    });
    await reopened.close();
  });
});
