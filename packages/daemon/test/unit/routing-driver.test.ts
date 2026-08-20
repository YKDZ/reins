import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { createCodexDriver, createCodexTransport } from "@reins/codex";
import { createSessionMachine } from "@reins/core";
import {
  diagnosticInputSchema,
  DriverFailure,
  makeDiagnosticId,
  sessionIdSchema,
  sessionNameSchema,
  turnIdSchema,
  type WorkerDriver,
  type WorkerSpec,
} from "@reins/protocol";
import * as v from "valibot";
import { describe, expect, test, vi } from "vitest";

import { openDiagnosticsRuntimeForTest } from "../../src/diagnostics-recorder.testing.ts";
import { openDiagnosticsStore } from "../../src/diagnostics-store.ts";
import { daemonGenerationSchema } from "../../src/generation.ts";
import type { HarnessAdapter } from "../../src/registry.ts";
import { createRoutingDriverFactory } from "../../src/routing-driver.ts";

describe("routing driver invariants", () => {
  test("verified driver diagnostic crosses routing without a duplicate core record", async () => {
    const sessionId = v.parse(sessionIdSchema, "verified@groute");
    const diagnosticId = makeDiagnosticId("route", "1");
    const query = vi.fn(async () => ({
      record: {
        v: 1 as const,
        diagnosticId,
        recordedAt: "2026-08-20T00:00:00.000Z",
        severity: "error" as const,
        source: "adapter" as const,
        harness: "verified",
        sessionId,
        kind: "request_failure" as const,
        operation: "kill" as const,
        stage: "terminate" as const,
        reason: "upstream_error" as const,
        message: {
          text: "close failed",
          truncated: false,
          originalBytes: 12,
        },
      },
    }));
    const adapter: HarnessAdapter = {
      driverFactory: () => ({
        start() {},
        deliver() {},
        interrupt() {},
        resolvePermission() {},
        async terminate() {
          throw new DriverFailure("close failed", diagnosticId);
        },
      }),
      capabilities: async () => ({ harness: "verified", models: [] }),
    };
    const record = vi.fn(async () => undefined);
    const driver = createRoutingDriverFactory(
      new Map([["verified", adapter]]),
      { record, query },
    )(() => {});
    driver.start({
      sessionId,
      turnId: v.parse(turnIdSchema, "turn-verified"),
      harness: "verified",
      message: "start",
      cwd: "/tmp",
      authorizationMode: "allowAll",
      sessionName: v.parse(sessionNameSchema, "verified"),
    });

    await expect(driver.terminate(sessionId)).rejects.toMatchObject({
      code: "internal_error",
      diagnosticId,
    });
    expect(query).toHaveBeenCalledWith({ diagnosticId });
    expect(record).not.toHaveBeenCalled();
  });

  test.each([
    {
      name: "worker lifecycle",
      record: {
        source: "adapter" as const,
        kind: "lifecycle" as const,
        operation: "worker" as const,
        reason: "closed" as const,
        severity: "info" as const,
      },
    },
    {
      name: "mapping gap",
      record: {
        source: "adapter" as const,
        kind: "mapping_gap" as const,
        operation: "spawn" as const,
        reason: "unsupported_input" as const,
        fields: ["reasoning"] as ["reasoning"],
        severity: "warning" as const,
      },
    },
    {
      name: "harness stderr",
      record: {
        source: "harness" as const,
        kind: "harness_stderr" as const,
        operation: "worker_process" as const,
        reason: "stderr_output" as const,
        text: { text: "stderr", truncated: false, originalBytes: 6 },
        severity: "info" as const,
      },
    },
    {
      name: "other turn terminate failure",
      record: {
        source: "adapter" as const,
        turnId: v.parse(turnIdSchema, "turn-other"),
        kind: "request_failure" as const,
        operation: "kill" as const,
        stage: "terminate" as const,
        reason: "upstream_error" as const,
        message: {
          text: "other turn",
          truncated: false,
          originalBytes: 10,
        },
        severity: "error" as const,
      },
    },
  ])(
    "terminate rejects unrelated $name provenance and records one core fallback",
    async ({ record: unrelated }) => {
      const sessionId = v.parse(sessionIdSchema, "unrelated@groute");
      const suppliedId = makeDiagnosticId("route", "2");
      const fallbackId = makeDiagnosticId("route", "3");
      const query = vi.fn(async () => ({
        record: {
          v: 1 as const,
          diagnosticId: suppliedId,
          recordedAt: "2026-08-20T00:00:00.000Z",
          harness: "unrelated",
          sessionId,
          ...unrelated,
        },
      }));
      const adapter: HarnessAdapter = {
        driverFactory: () => ({
          start() {},
          deliver() {},
          interrupt() {},
          resolvePermission() {},
          async terminate() {
            throw new DriverFailure("terminate failed", suppliedId);
          },
        }),
        capabilities: async () => ({ harness: "unrelated", models: [] }),
      };
      const recordFallback = vi.fn(async () => fallbackId);
      const machine = createSessionMachine({
        driverFactory: createRoutingDriverFactory(
          new Map([["unrelated", adapter]]),
          { record: async () => undefined, query },
        ),
        identity: { session: () => sessionId },
        diagnostics: { record: recordFallback },
      });
      await machine.spawn({
        sessionName: v.parse(sessionNameSchema, "unrelated"),
        harness: "unrelated",
        message: "start",
      });

      await expect(machine.kill({ ids: [sessionId] })).rejects.toMatchObject({
        code: "internal_error",
        diagnosticId: fallbackId,
      });
      expect(recordFallback).toHaveBeenCalledTimes(1);
      expect(recordFallback).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "request_failure",
          operation: "kill",
          stage: "terminate",
        }),
      );
    },
  );

  test("Codex malformed UTF-8 stderr is accepted by the real runtime and exact-queryable", async () => {
    const root = await mkdtemp(join(tmpdir(), "reins-routing-stderr-"));
    const runtime = await openDiagnosticsRuntimeForTest({
      resolveState: async () => ({
        directory: root,
        diagnosticsDirectory: join(root, "diagnostics"),
        durable: true,
        retention: { maxAgeMs: 60_000, maxBytes: 1024 * 1024 },
      }),
      openStore: async (state) =>
        await openDiagnosticsStore({ directory: state.diagnosticsDirectory }),
      allocateGeneration: async () => v.parse(daemonGenerationSchema, "stderr"),
    });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const emitter = new EventEmitter();
    let outbound = "";
    stdin.on("data", (chunk) => {
      outbound += String(chunk);
      for (;;) {
        const newline = outbound.indexOf("\n");
        if (newline < 0) break;
        const request = JSON.parse(outbound.slice(0, newline)) as {
          id?: number;
          method?: string;
        };
        outbound = outbound.slice(newline + 1);
        if (request.id === undefined) continue;
        const result =
          request.method === "thread/start"
            ? { thread: { id: "thread-real" } }
            : request.method === "turn/start"
              ? { turn: { id: "turn-real" } }
              : {};
        stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      }
    });
    const adapter: HarnessAdapter = {
      driverFactory: createCodexDriver({
        transportFactory: (options) =>
          createCodexTransport({
            ...options,
            captureHarnessStderr: true,
            shutdownGraceMs: 5,
            spawnChild: () => ({
              stdin,
              stdout,
              stderr,
              on: (event, listener) => emitter.on(event, listener),
              kill: () => {
                emitter.emit("exit");
                stdout.end();
                return true;
              },
            }),
          }),
      }),
      capabilities: async () => ({ harness: "codex", models: [] }),
      canCaptureHarnessStderr: true,
    };
    let validationError: unknown;
    const driver = createRoutingDriverFactory(new Map([["codex", adapter]]), {
      async record(input) {
        const parsed = v.safeParse(diagnosticInputSchema, input);
        if (!parsed.success) {
          validationError = parsed.issues;
          return undefined;
        }
        return await runtime.record(input);
      },
      query: (params) => runtime.query(params),
    })(() => {});
    const sessionId = v.parse(sessionIdSchema, "stderr@groute");
    driver.start({
      sessionId,
      turnId: v.parse(turnIdSchema, "turn-stderr"),
      harness: "codex",
      message: "start",
      cwd: "/tmp",
      authorizationMode: "allowAll",
      captureHarnessStderr: true,
      sessionName: v.parse(sessionNameSchema, "stderr"),
    });
    const invalidVectors = [
      Buffer.from([0xff]),
      Buffer.from([0xc0, 0xaf]),
      Buffer.from([0xe2, 0x28, 0xa1]),
      Buffer.from([0xf0, 0x9f]),
    ];
    for (const vector of invalidVectors.slice(0, -1)) stderr.write(vector);
    stderr.end(invalidVectors.at(-1));
    let records: Awaited<ReturnType<typeof runtime.query>> | undefined;
    await vi.waitFor(async () => {
      expect(validationError).toBeUndefined();
      records = await runtime.query({
        harness: "codex",
        kinds: ["harness_stderr"],
      });
      expect("records" in records ? records.records : []).toHaveLength(4);
    });
    if (records === undefined || !("records" in records)) {
      throw new Error("stderr diagnostic not found");
    }
    for (const [index, record] of records.records.entries()) {
      await expect(
        runtime.query({ diagnosticId: record.diagnosticId }),
      ).resolves.toMatchObject({
        record: {
          diagnosticId: record.diagnosticId,
          source: "harness",
          harness: "codex",
          text: {
            text: "",
            truncated: true,
            originalBytes: invalidVectors[index]!.byteLength,
          },
        },
      });
    }
    await driver.terminate(sessionId);
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  test("rejects unsafe adapter attempts to override diagnostic authority", async () => {
    const record = vi.fn(async () => undefined);
    let sink!: Parameters<HarnessAdapter["driverFactory"]>[0]["diagnostics"];
    const adapter: HarnessAdapter = {
      driverFactory: ({ diagnostics }) => {
        sink = diagnostics;
        return {
          start() {},
          deliver() {},
          interrupt() {},
          resolvePermission() {},
          async terminate() {},
        };
      },
      capabilities: async () => ({ harness: "owned", models: [] }),
    };
    const driver = createRoutingDriverFactory(new Map([["owned", adapter]]), {
      record,
      async query() {
        throw new Error("not found");
      },
    })(() => {});
    driver.start({
      sessionId: v.parse(sessionIdSchema, "owned@groute"),
      turnId: v.parse(turnIdSchema, "turn-owned"),
      harness: "owned",
      message: "start",
      cwd: "/tmp",
      authorizationMode: "allowAll",
      sessionName: v.parse(sessionNameSchema, "owned"),
    });

    await sink({
      source: "daemon",
      harness: "other",
      kind: "mapping_gap",
      operation: "spawn",
      reason: "unsupported_input",
      fields: ["reasoning"],
    } as never);
    await sink({
      source: undefined,
      kind: "mapping_gap",
      operation: "spawn",
      reason: "unsupported_input",
      fields: ["reasoning"],
    } as never);
    await sink({
      harness: undefined,
      kind: "mapping_gap",
      operation: "spawn",
      reason: "unsupported_input",
      fields: ["reasoning"],
    } as never);
    expect(record).not.toHaveBeenCalled();
  });

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
            kind: "mapping_gap",
            operation: "spawn",
            reason: "unsupported_input",
            fields: ["reasoning"],
          });
        },
        deliver() {},
        interrupt() {},
        resolvePermission() {},
        async terminate() {},
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
      async query() {
        throw new Error("not found");
      },
    })(() => {});

    expect(() =>
      driver.deliver(
        v.parse(sessionIdSchema, "missing@groute"),
        v.parse(turnIdSchema, "turn-route"),
        "message",
      ),
    ).toThrow("No routing entry for session missing@groute");
  });

  test("does not retain failed starts and retains failed termination for retry", async () => {
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
      async terminate() {
        terminations += 1;
        await Promise.resolve();
        if (terminations === 1) throw new Error("terminate failed");
      },
    };
    const adapter: HarnessAdapter = {
      driverFactory: () => worker,
      capabilities: async () => ({ harness: "fake", models: [] }),
    };
    const driver = createRoutingDriverFactory(new Map([["fake", adapter]]), {
      record: async () => undefined,
      async query() {
        throw new Error("not found");
      },
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
    await expect(driver.terminate(sessionId)).rejects.toThrow(
      "terminate failed",
    );
    await expect(driver.terminate(sessionId)).resolves.toBeUndefined();
  });
});
