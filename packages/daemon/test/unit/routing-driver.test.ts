import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  sessionIdSchema,
  sessionNameSchema,
  turnIdSchema,
  type WorkerDriver,
  type WorkerSpec,
} from "@reins/protocol";
import * as v from "valibot";
import { describe, expect, test } from "vitest";

import { openDiagnosticsRuntimeForTest } from "../../src/diagnostics-recorder.testing.ts";
import { openDiagnosticsStore } from "../../src/diagnostics-store.ts";
import { daemonGenerationSchema } from "../../src/generation.ts";
import type { HarnessAdapter } from "../../src/registry.ts";
import { createRoutingDriverFactory } from "../../src/routing-driver.ts";

describe("routing driver invariants", () => {
  test("binds real RecorderRuntime so adapter diagnostics are immediately exact-queryable", async () => {
    const root = await mkdtemp(join(tmpdir(), "reins-routing-diagnostics-"));
    const runtime = await openDiagnosticsRuntimeForTest({
      resolveState: async () => ({
        directory: root,
        diagnosticsDirectory: join(root, "diagnostics"),
        durable: true,
        retention: { maxAgeMs: 60_000, maxBytes: 1024 * 1024 },
      }),
      openStore: async (state) =>
        await openDiagnosticsStore({ directory: state.diagnosticsDirectory }),
      allocateGeneration: async () =>
        v.parse(daemonGenerationSchema, "routing"),
    });
    let accepted: ReturnType<typeof runtime.record> | undefined;
    const adapter: HarnessAdapter = {
      driverFactory: ({ diagnostics }) => ({
        start() {
          accepted = diagnostics({
            source: "adapter",
            harness: "diagnostic-fake",
            kind: "mapping_gap",
            operation: "spawn",
            reason: "unsupported_input",
            fields: ["reasoning"],
          });
        },
        deliver() {},
        interrupt() {},
        resolvePermission() {},
        terminate() {},
      }),
      capabilities: async () => ({ harness: "diagnostic-fake", models: [] }),
    };
    const driver = createRoutingDriverFactory(
      new Map([["diagnostic-fake", adapter]]),
      runtime,
    )(() => {});
    const spec: WorkerSpec = {
      sessionId: v.parse(sessionIdSchema, "diagnostic@groute"),
      turnId: v.parse(turnIdSchema, "turn-diagnostic"),
      harness: "diagnostic-fake",
      message: "start",
      cwd: "/tmp",
      authorizationMode: "allowAll",
      sessionName: v.parse(sessionNameSchema, "diagnostic"),
    };

    driver.start(spec);
    const diagnosticId = await accepted;
    expect(diagnosticId).toBeDefined();
    await expect(
      runtime.query({ diagnosticId: diagnosticId! }),
    ).resolves.toMatchObject({
      record: {
        source: "adapter",
        harness: "diagnostic-fake",
        kind: "mapping_gap",
      },
    });
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  test("does not silently drop delivery with no session routing entry", () => {
    const driver = createRoutingDriverFactory(new Map(), {
      record: async () => undefined,
    })(() => {});

    expect(() =>
      driver.deliver(
        v.parse(sessionIdSchema, "missing@groute"),
        v.parse(turnIdSchema, "turn-route"),
        "message",
      ),
    ).toThrow("No routing entry for session missing@groute");
  });

  test("does not retain failed starts and retains failed termination for retry", () => {
    let starts = 0;
    let terminations = 0;
    const worker: WorkerDriver = {
      start() {
        starts += 1;
        if (starts === 1) throw new Error("start failed");
      },
      deliver() {},
      interrupt() {},
      resolvePermission() {},
      terminate() {
        terminations += 1;
        if (terminations === 1) throw new Error("terminate failed");
      },
    };
    const adapter: HarnessAdapter = {
      driverFactory: () => worker,
      capabilities: async () => ({ harness: "fake", models: [] }),
    };
    const driver = createRoutingDriverFactory(new Map([["fake", adapter]]), {
      record: async () => undefined,
    })(() => {});
    const sessionId = v.parse(sessionIdSchema, "retry@groute");
    const spec: WorkerSpec = {
      sessionId,
      turnId: v.parse(turnIdSchema, "turn-route"),
      harness: "fake",
      message: "start",
      cwd: "/tmp",
      authorizationMode: "allowAll",
      sessionName: v.parse(sessionNameSchema, "retry"),
    };
    expect(() => driver.start(spec)).toThrow("start failed");
    expect(() => driver.deliver(sessionId, spec.turnId, "message")).toThrow(
      "No routing entry",
    );
    driver.start(spec);
    expect(() => driver.terminate(sessionId)).toThrow("terminate failed");
    expect(() => driver.terminate(sessionId)).not.toThrow();
  });
});
