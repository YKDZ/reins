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
  runtimeScopeIdSchema,
  type DomainEvent,
  type WorkerSpec,
} from "@reins/protocol";
import * as v from "valibot";
import { describe, expect, test, vi } from "vitest";

import { openDiagnosticsRuntimeForTest } from "../../src/diagnostics-recorder.testing.ts";
import { openDiagnosticsStore } from "../../src/diagnostics-store.ts";
import { daemonGenerationSchema } from "../../src/generation.ts";
import type { HarnessAdapter } from "../../src/registry.ts";
import { createRoutingDriverFactory } from "../../src/routing-driver.ts";

const testRuntimeScopeId = v.parse(
  runtimeScopeIdSchema,
  "00000000-0000-4000-8000-000000000000",
);

function createNativeWorker(threadId: string) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const emitter = new EventEmitter();
  const requests: { method: string; params: unknown }[] = [];
  const responded: { id: number; result: unknown }[] = [];
  let outbound = "";
  let closeError: unknown;
  stdin.on("data", (chunk) => {
    outbound += String(chunk);
    for (;;) {
      const newline = outbound.indexOf("\n");
      if (newline < 0) break;
      const message = JSON.parse(outbound.slice(0, newline)) as {
        id?: number;
        method?: string;
        params?: unknown;
        result?: unknown;
      };
      outbound = outbound.slice(newline + 1);
      if (message.id === undefined) continue;
      if (message.method === undefined) {
        responded.push({ id: message.id, result: message.result });
        continue;
      }
      requests.push({ method: message.method, params: message.params });
      const result =
        message.method === "thread/start"
          ? { thread: { id: threadId } }
          : message.method === "turn/start"
            ? { turn: { id: "turn1" } }
            : message.method === "turn/steer"
              ? { turnId: "turn1" }
              : {};
      stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
    }
  });
  const transport = createCodexTransport({
    shutdownGraceMs: 5,
    spawnChild: () => ({
      stdin,
      stdout,
      on: (event, listener) => emitter.on(event, listener),
      kill() {
        emitter.emit("exit");
        stdout.end();
        if (closeError !== undefined) throw closeError;
        return true;
      },
    }),
  });
  return {
    transport,
    controls: {
      requests: () => [...requests],
      responded: () => [...responded],
      closed: () => transport.isClosed(),
      pushInbound(message: unknown) {
        stdout.write(`${JSON.stringify(message)}\n`);
      },
      setCloseError(error: unknown) {
        closeError = error;
      },
      end() {
        stdout.end();
        stdin.end();
        emitter.emit("exit");
      },
    },
  };
}

function codexRoutingFixture() {
  const workers: ReturnType<typeof createNativeWorker>[] = [];
  const events: DomainEvent[] = [];
  const adapter: HarnessAdapter = {
    driverFactory: createCodexDriver({
      transportFactory() {
        const worker = createNativeWorker(`thread-${workers.length + 1}`);
        workers.push(worker);
        return worker.transport;
      },
    }),
    modelCatalog: async () => ({ harness: "codex", models: [] }),
  };
  const driver = createRoutingDriverFactory(new Map([["codex", adapter]]), {
    record: async () => undefined,
    async query() {
      throw new Error("Unexpected diagnostic query");
    },
  })((event) => events.push(event));
  const alpha: WorkerSpec = {
    sessionId: v.parse(sessionIdSchema, "alpha@groute"),
    turnId: v.parse(turnIdSchema, "turn-alpha"),
    sessionName: v.parse(sessionNameSchema, "alpha"),
    harness: "codex",
    message: "caller task for alpha",
    cwd: "/tmp",
  };
  const beta: WorkerSpec = {
    ...alpha,
    sessionId: v.parse(sessionIdSchema, "beta@groute"),
    turnId: v.parse(turnIdSchema, "turn-beta"),
    sessionName: v.parse(sessionNameSchema, "beta"),
    message: "caller task for beta",
  };
  return { driver, workers, events, alpha, beta };
}

describe("routing driver invariants", () => {
  test("same-harness session actions reach only their own native worker", async () => {
    const { driver, workers, alpha, beta } = codexRoutingFixture();
    try {
      driver.start(alpha);
      await vi.waitFor(() => {
        expect(workers[0]?.controls.requests().at(-1)?.method).toBe(
          "turn/start",
        );
      });
      driver.start(beta);
      await vi.waitFor(() => {
        expect(workers[1]?.controls.requests().at(-1)?.method).toBe(
          "turn/start",
        );
      });
      const [workerA, workerB] = workers;
      if (workerA === undefined || workerB === undefined) {
        throw new Error("Expected two native workers");
      }
      const initialA = workerA.controls.requests().length;
      const initialB = workerB.controls.requests().length;
      await driver.deliver(
        alpha.sessionId,
        alpha.turnId,
        "caller message for alpha",
        "active_turn",
      );
      await driver.interrupt(alpha.sessionId, alpha.turnId);
      await driver.terminate(alpha.sessionId);
      expect(workerA.controls.requests().slice(initialA)).toEqual([
        {
          method: "turn/steer",
          params: {
            threadId: "thread-1",
            input: [
              {
                type: "text",
                text: "caller message for alpha",
                text_elements: [],
              },
            ],
            expectedTurnId: "turn1",
          },
        },
        {
          method: "turn/interrupt",
          params: { threadId: "thread-1", turnId: "turn1" },
        },
        { method: "thread/delete", params: { threadId: "thread-1" } },
      ]);
      expect(workerA.controls.closed()).toBe(true);
      expect(workerB.controls.requests().slice(initialB)).toEqual([]);
      expect(workerB.controls.closed()).toBe(false);

      await driver.deliver(
        beta.sessionId,
        beta.turnId,
        "caller message for beta",
        "active_turn",
      );
      await driver.interrupt(beta.sessionId, beta.turnId);
      await driver.terminate(beta.sessionId);
      expect(workerB.controls.requests().slice(initialB)).toMatchObject([
        {
          method: "turn/steer",
          params: {
            threadId: "thread-2",
            input: [{ text: "caller message for beta" }],
          },
        },
        {
          method: "turn/interrupt",
          params: { threadId: "thread-2", turnId: "turn1" },
        },
        { method: "thread/delete", params: { threadId: "thread-2" } },
      ]);
      expect(workerB.controls.closed()).toBe(true);
    } finally {
      for (const worker of workers) worker.controls.end();
    }
  });

  test("session-local permission ids resolve only on their own native worker", async () => {
    const { driver, workers, events, alpha, beta } = codexRoutingFixture();
    try {
      for (const spec of [alpha, beta]) {
        driver.start(spec);
        await vi.waitFor(() => {
          expect(workers.at(-1)?.controls.requests().at(-1)?.method).toBe(
            "turn/start",
          );
        });
      }
      const [workerA, workerB] = workers;
      if (workerA === undefined || workerB === undefined) {
        throw new Error("Expected two native workers");
      }
      for (const [index, worker] of workers.entries()) {
        worker.controls.pushInbound({
          id: index + 7,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: `thread-${index + 1}`,
            turnId: "turn1",
            itemId: "command",
            command: "pwd",
            availableDecisions: ["accept", "decline"],
          },
        });
      }
      await vi.waitFor(() => {
        expect(
          events.filter((event) => event.type === "permission.requested"),
        ).toHaveLength(2);
      });
      const permissionA = events.find(
        (event) =>
          event.type === "permission.requested" &&
          event.sessionId === alpha.sessionId,
      );
      const permissionB = events.find(
        (event) =>
          event.type === "permission.requested" &&
          event.sessionId === beta.sessionId,
      );
      if (
        permissionA?.type !== "permission.requested" ||
        permissionB?.type !== "permission.requested"
      ) {
        throw new Error("Expected permissions from both sessions");
      }
      expect(permissionA.permissionId).toBe(permissionB.permissionId);
      driver.resolvePermission(alpha.sessionId, permissionA.permissionId, {
        outcome: "allow",
        scope: "once",
      });
      expect(workerA.controls.responded()).toEqual([
        { id: 7, result: { decision: "accept" } },
      ]);
      expect(workerB.controls.responded()).toEqual([]);
      driver.resolvePermission(beta.sessionId, permissionB.permissionId, {
        outcome: "deny",
      });
      expect(workerB.controls.responded()).toEqual([
        { id: 8, result: { decision: "decline" } },
      ]);
      expect(workerA.controls.responded()).toEqual([
        { id: 7, result: { decision: "accept" } },
      ]);
      await driver.terminate(alpha.sessionId);
      await driver.terminate(beta.sessionId);
    } finally {
      for (const worker of workers) worker.controls.end();
    }
  });

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
        harness: "codex",
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
        async deliver() {},
        async interrupt() {},
        resolvePermission() {},
        async terminate() {
          throw new DriverFailure("close failed", diagnosticId);
        },
      }),
      modelCatalog: async () => ({ harness: "codex", models: [] }),
    };
    const record = vi.fn(async () => undefined);
    const driver = createRoutingDriverFactory(new Map([["codex", adapter]]), {
      record,
      query,
    })(() => {});
    driver.start({
      sessionId,
      turnId: v.parse(turnIdSchema, "turn-verified"),
      harness: "codex",
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
          harness: "codex",
          sessionId,
          ...unrelated,
        },
      }));
      const adapter: HarnessAdapter = {
        driverFactory: () => ({
          start() {},
          async deliver() {},
          async interrupt() {},
          resolvePermission() {},
          async terminate() {
            throw new DriverFailure("terminate failed", suppliedId);
          },
        }),
        modelCatalog: async () => ({ harness: "qoder", models: [] }),
      };
      const recordFallback = vi.fn(async () => fallbackId);
      const machine = createSessionMachine({
        driverFactory: createRoutingDriverFactory(
          new Map([["qoder", adapter]]),
          { record: async () => undefined, query },
        ),
        identity: { session: () => sessionId },
        diagnostics: { record: recordFallback },
      });
      await machine.spawn({
        cwd: "/tmp",
        sessionName: v.parse(sessionNameSchema, "unrelated"),
        harness: "qoder",
        message: "start",
      });

      await expect(
        machine.kill({ sessionId: sessionId }),
      ).rejects.toMatchObject({
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
        runtimeScopeId: testRuntimeScopeId,
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
      modelCatalog: async () => ({ harness: "codex", models: [] }),
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
          async deliver() {},
          async interrupt() {},
          resolvePermission() {},
          async terminate() {},
        };
      },
      modelCatalog: async () => ({ harness: "qoder", models: [] }),
    };
    const driver = createRoutingDriverFactory(new Map([["qoder", adapter]]), {
      record,
      async query() {
        throw new Error("not found");
      },
    })(() => {});
    driver.start({
      sessionId: v.parse(sessionIdSchema, "owned@groute"),
      turnId: v.parse(turnIdSchema, "turn-owned"),
      harness: "qoder",
      message: "start",
      cwd: "/tmp",
      authorizationMode: "allowAll",
      sessionName: v.parse(sessionNameSchema, "owned"),
    });

    await sink({
      source: "daemon",
      harness: "qoder",
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
        runtimeScopeId: testRuntimeScopeId,
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
        async deliver() {},
        async interrupt() {},
        resolvePermission() {},
        async terminate() {},
      }),
      modelCatalog: async () => ({ harness: "codex", models: [] }),
    };
    const driver = createRoutingDriverFactory(
      new Map([["codex", adapter]]),
      runtime,
    )(() => {});
    const spec: WorkerSpec = {
      sessionId: v.parse(sessionIdSchema, "diagnostic@groute"),
      turnId: v.parse(turnIdSchema, "turn-diagnostic"),
      harness: "codex",
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
        harness: "codex",
        kind: "mapping_gap",
      },
    });
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  test("does not silently drop delivery with no session routing entry", async () => {
    const driver = createRoutingDriverFactory(new Map(), {
      record: async () => undefined,
      async query() {
        throw new Error("not found");
      },
    })(() => {});

    await expect(
      driver.deliver(
        v.parse(sessionIdSchema, "missing@groute"),
        v.parse(turnIdSchema, "turn-route"),
        "message",
        "active_turn",
      ),
    ).rejects.toThrow("No routing entry for session missing@groute");
  });

  test("does not retain failed starts and retains failed termination for retry", async () => {
    const workers: ReturnType<typeof createNativeWorker>[] = [];
    const codexDriverFactory = createCodexDriver({
      transportFactory() {
        const worker = createNativeWorker("thread-retry");
        workers.push(worker);
        return worker.transport;
      },
    });
    let starts = 0;
    const adapter: HarnessAdapter = {
      driverFactory(context) {
        if (starts++ !== 0) return codexDriverFactory(context);
        return {
          start() {
            throw new Error("start failed");
          },
          async deliver() {},
          async interrupt() {},
          resolvePermission() {},
          async terminate() {},
        };
      },
      modelCatalog: async () => ({ harness: "codex", models: [] }),
    };
    const driver = createRoutingDriverFactory(new Map([["codex", adapter]]), {
      record: async () => undefined,
      async query() {
        throw new Error("not found");
      },
    })(() => {});
    const sessionId = v.parse(sessionIdSchema, "retry@groute");
    const spec: WorkerSpec = {
      sessionId,
      turnId: v.parse(turnIdSchema, "turn-route"),
      harness: "codex",
      message: "start",
      cwd: "/tmp",
      authorizationMode: "allowAll",
      sessionName: v.parse(sessionNameSchema, "retry"),
    };
    try {
      expect(() => driver.start(spec)).toThrow("start failed");
      await expect(
        driver.deliver(sessionId, spec.turnId, "message", "active_turn"),
      ).rejects.toThrow("No routing entry");
      driver.start(spec);
      await vi.waitFor(() => {
        expect(workers[0]?.controls.requests().at(-1)?.method).toBe(
          "turn/start",
        );
      });
      const retryWorker = workers[0];
      if (retryWorker === undefined) throw new Error("Expected retry worker");
      await driver.deliver(
        sessionId,
        spec.turnId,
        "retry message",
        "active_turn",
      );
      expect(retryWorker.controls.requests().at(-1)).toMatchObject({
        method: "turn/steer",
        params: { input: [{ text: "retry message" }] },
      });
      retryWorker.controls.setCloseError(new Error("terminate failed"));
      await expect(driver.terminate(sessionId)).rejects.toThrow(
        "terminate failed",
      );
      retryWorker.controls.setCloseError(undefined);
      await expect(driver.terminate(sessionId)).resolves.toBeUndefined();
      expect(retryWorker.controls.closed()).toBe(true);
      await expect(
        driver.deliver(
          sessionId,
          spec.turnId,
          "after termination",
          "active_turn",
        ),
      ).rejects.toThrow("No routing entry");
    } finally {
      for (const worker of workers) worker.controls.end();
    }
  });
});
