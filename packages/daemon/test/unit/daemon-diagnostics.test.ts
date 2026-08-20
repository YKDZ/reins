import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  createCodexCapabilities,
  createCodexTransport,
  type CodexChild,
} from "@reins/codex";
import type {
  ProtocolMessage,
  ProtocolResponse,
  AdapterDriverFactory,
} from "@reins/protocol";
import {
  diagnosticsResultSchema,
  makeDiagnosticId,
  diagnosticIdSchema,
  requestIdSchema,
  sessionNameSchema,
  turnIdSchema,
} from "@reins/protocol";
import { createInMemoryTransportServer } from "@reins/transport";
import type {
  TransportConnection,
  TransportEvent,
  TransportServer,
} from "@reins/transport";
import * as v from "valibot";
import { afterEach, describe, expect, test } from "vitest";

import { createDaemonForTest } from "../../src/daemon.testing.ts";
import { createDaemon } from "../../src/daemon.ts";
import { openDiagnosticsRuntimeForTest } from "../../src/diagnostics-recorder.testing.ts";
import type { DiagnosticsRuntime } from "../../src/diagnostics-recorder.ts";
import { openDiagnosticsStoreForTest } from "../../src/diagnostics-store.testing.ts";
import { openDiagnosticsStore } from "../../src/diagnostics-store.ts";
import { daemonGenerationSchema } from "../../src/generation.ts";
import type { HarnessAdapter } from "../../src/registry.ts";
import type { DaemonState } from "../../src/state.ts";

const directories: string[] = [];

async function waitForDaemonLifecycle(
  runtime: DiagnosticsRuntime,
): Promise<void> {
  for (;;) {
    const result = await runtime.query({
      kinds: ["lifecycle"],
      sources: ["daemon"],
    });
    if ("records" in result && result.records.length > 0) return;
    await Promise.resolve();
  }
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("daemon diagnostic error dispatch", () => {
  test("serves exact and filtered diagnostics from the real recorder store", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "reins-daemon-diagnostic-query-"),
    );
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
      allocateGeneration: async () => v.parse(daemonGenerationSchema, "query"),
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });
    const first = await runtime.record({
      source: "daemon",
      kind: "lifecycle",
      operation: "daemon",
      reason: "started",
    });
    await runtime.record({
      source: "daemon",
      kind: "lifecycle",
      operation: "daemon",
      reason: "stopped",
    });
    const transport = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemonForTest({
      transport,
      adapters: new Map(),
      identity: { session: (name) => runtime.sessionId(name) },
      diagnostics: runtime,
    });
    const running = daemon.start();
    const client = transport.connect();
    await Promise.resolve();
    const request = async (requestId: string, params: unknown) => {
      const response = new Promise<ProtocolResponse>((resolve) => {
        client.onEvent((event) => {
          if (event.kind === "message" && event.message.kind === "response") {
            resolve(event.message);
          }
        });
      });
      client.send({
        kind: "request",
        requestId: v.parse(requestIdSchema, requestId),
        method: "diagnostics",
        params,
      });
      return await response;
    };
    try {
      const exact = await request("exact", { diagnosticId: first });
      expect(exact).toMatchObject({
        result: { record: { diagnosticId: first } },
      });
      const filtered = await request("filter", {
        sources: ["daemon"],
        limit: 1,
      });
      expect(filtered).toMatchObject({
        result: {
          records: [{ kind: "lifecycle", reason: "started" }],
          truncated: true,
        },
      });
    } finally {
      await daemon.stop();
      await running;
      await runtime.close();
    }
  });

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
    const driverFactory: AdapterDriverFactory = () => ({
      start() {
        throw new Error("worker start failed");
      },
      deliver() {},
      interrupt() {},
      resolvePermission() {},
      async terminate() {},
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
    const daemon = createDaemonForTest({
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

  test("omits a dangling diagnostic id after the real store append failure", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "reins-daemon-diagnostic-append-"),
    );
    directories.push(root);
    const state: DaemonState = {
      directory: root,
      diagnosticsDirectory: join(root, "diagnostics"),
      durable: true,
      retention: { maxAgeMs: 60_000, maxBytes: 1024 * 1024 },
    };
    let rejectAppend = false;
    const runtime = await openDiagnosticsRuntimeForTest({
      resolveState: async () => state,
      openStore: async () =>
        await openDiagnosticsStoreForTest({
          directory: state.diagnosticsDirectory,
          failAppend: () =>
            rejectAppend ? new Error("append rejected") : undefined,
        }),
      allocateGeneration: async () => v.parse(daemonGenerationSchema, "append"),
    });
    const adapter: HarnessAdapter = {
      driverFactory: () => ({
        start() {
          throw new Error("worker start failed");
        },
        deliver() {},
        interrupt() {},
        resolvePermission() {},
        async terminate() {},
      }),
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
    });
    const running = daemon.start();
    const client = transport.connect();
    await waitForDaemonLifecycle(runtime);
    rejectAppend = true;
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
        requestId: v.parse(requestIdSchema, "append-failure"),
        method: "spawn",
        params: {
          sessionName: "append-failure",
          harness: "fake",
          message: "start",
        },
      });
      const failed = await response;
      expect(failed).toMatchObject({ error: { code: "internal_error" } });
      if (!("error" in failed)) throw new Error("Expected a failed response");
      expect("diagnosticId" in failed.error).toBe(false);
      expect(runtime.health().status).toBe("degraded");
    } finally {
      await daemon.stop();
      await running;
      await runtime.close();
    }
  });

  test("returns diagnostics_unavailable when the real store query degrades", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "reins-daemon-diagnostic-query-fail-"),
    );
    directories.push(root);
    const state: DaemonState = {
      directory: root,
      diagnosticsDirectory: join(root, "diagnostics"),
      durable: true,
      retention: { maxAgeMs: 60_000, maxBytes: 1024 * 1024 },
    };
    let rejectQuery = false;
    const runtime = await openDiagnosticsRuntimeForTest({
      resolveState: async () => state,
      openStore: async () =>
        await openDiagnosticsStoreForTest({
          directory: state.diagnosticsDirectory,
          failQuery: () =>
            rejectQuery ? new Error("query rejected") : undefined,
        }),
      allocateGeneration: async () =>
        v.parse(daemonGenerationSchema, "queryfail"),
    });
    const transport = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport,
      adapters: new Map(),
      identity: { session: (name) => runtime.sessionId(name) },
      diagnostics: runtime,
    });
    const running = daemon.start();
    const client = transport.connect();
    await waitForDaemonLifecycle(runtime);
    rejectQuery = true;
    try {
      const response = new Promise<ProtocolResponse>((resolve) => {
        client.onEvent((event) => {
          if (event.kind === "message" && event.message.kind === "response")
            resolve(event.message);
        });
      });
      client.send({
        kind: "request",
        requestId: v.parse(requestIdSchema, "query-failure"),
        method: "diagnostics",
        params: {},
      });
      await expect(response).resolves.toMatchObject({
        error: { code: "diagnostics_unavailable" },
      });
      expect(runtime.health().status).toBe("degraded");
    } finally {
      await daemon.stop();
      await running;
      await runtime.close();
    }
  });

  test("keeps successful capabilities while linking one failed harness to a real diagnostic", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "reins-daemon-capability-diagnostic-"),
    );
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
      allocateGeneration: async () => v.parse(daemonGenerationSchema, "caps"),
    });
    const driverFactory: AdapterDriverFactory = () => ({
      start() {},
      deliver() {},
      interrupt() {},
      resolvePermission() {},
      async terminate() {},
    });
    const transport = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport,
      adapters: new Map([
        [
          "good",
          {
            driverFactory,
            capabilities: async () => ({ harness: "good", models: [] }),
          },
        ],
        [
          "bad",
          {
            driverFactory,
            capabilities: async () => {
              throw new Error("capability failed");
            },
          },
        ],
        [
          "mismatch",
          {
            driverFactory,
            capabilities: async () => ({ harness: "other", models: [] }),
          },
        ],
        [
          "malformed",
          {
            driverFactory,
            capabilities: async () => JSON.parse('{"harness":"malformed"}'),
          },
        ],
      ]),
      identity: { session: (name) => runtime.sessionId(name) },
      diagnostics: runtime,
    });
    const running = daemon.start();
    const client = transport.connect();
    await Promise.resolve();
    try {
      const response = new Promise<ProtocolResponse>((resolve) => {
        client.onEvent((event) => {
          if (event.kind === "message" && event.message.kind === "response")
            resolve(event.message);
        });
      });
      client.send({
        kind: "request",
        requestId: v.parse(requestIdSchema, "capabilities"),
        method: "capabilities",
        params: {},
      });
      const result = await response;
      expect(result).toMatchObject({
        result: {
          capabilities: [{ harness: "good" }],
          failures: [
            { harness: "bad", code: "capability_query_failed" },
            { harness: "mismatch", code: "capability_query_failed" },
            { harness: "malformed", code: "capability_query_failed" },
          ],
        },
      });
      if (!("result" in result)) throw new Error("Expected capability result");
      const failure = result.result as {
        failures: Array<{ diagnosticId?: unknown }>;
      };
      const diagnosticId = failure.failures[1]?.diagnosticId;
      if (typeof diagnosticId !== "string")
        throw new Error("Expected a diagnostic id");
      await expect(
        runtime.query({
          diagnosticId: v.parse(diagnosticIdSchema, diagnosticId),
        }),
      ).resolves.toMatchObject({
        record: {
          kind: "request_failure",
          operation: "capabilities",
          harness: "mismatch",
        },
      });
    } finally {
      await daemon.stop();
      await running;
      await runtime.close();
    }
  });

  test("Codex malformed model/list does not reuse an unrelated protocol diagnostic for capabilities", async () => {
    const root = await mkdtemp(join(tmpdir(), "reins-daemon-codex-caps-"));
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
      allocateGeneration: async () => v.parse(daemonGenerationSchema, "caps"),
    });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const emitter = new EventEmitter();
    const child: CodexChild = {
      stdin,
      stdout,
      on: (event, listener) => emitter.on(event, listener),
      kill: () => {
        emitter.emit("exit");
        stdout.end();
        return true;
      },
    };
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
        stdout.write(
          `${JSON.stringify({
            id: request.id,
            result:
              request.method === "model/list"
                ? { data: [{ model: "broken" }] }
                : {},
          })}\n`,
        );
      }
    });
    const driverFactory: AdapterDriverFactory = () => ({
      start() {},
      deliver() {},
      interrupt() {},
      resolvePermission() {},
      async terminate() {},
    });
    const transport = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport,
      adapters: new Map([
        [
          "codex",
          {
            driverFactory,
            capabilities: createCodexCapabilities({
              transportFactory: (options) =>
                createCodexTransport({
                  ...options,
                  spawnChild: () => child,
                }),
            }),
          },
        ],
      ]),
      identity: { session: (name) => runtime.sessionId(name) },
      diagnostics: runtime,
    });
    const running = daemon.start();
    const client = transport.connect();
    await Promise.resolve();
    try {
      const response = new Promise<ProtocolResponse>((resolve) => {
        client.onEvent((event) => {
          if (event.kind === "message" && event.message.kind === "response")
            resolve(event.message);
        });
      });
      client.send({
        kind: "request",
        requestId: v.parse(requestIdSchema, "codex-capabilities"),
        method: "capabilities",
        params: {},
      });
      const result = await response;
      if (!("result" in result)) throw new Error("Expected capability result");
      const failure = (
        result.result as {
          failures: Array<{ diagnosticId?: unknown }>;
        }
      ).failures[0];
      if (typeof failure?.diagnosticId !== "string")
        throw new Error("Expected a diagnostic id");

      await expect(
        runtime.query({
          diagnosticId: v.parse(diagnosticIdSchema, failure.diagnosticId),
        }),
      ).resolves.toMatchObject({
        record: {
          source: "daemon",
          harness: "codex",
          kind: "request_failure",
          operation: "capabilities",
          stage: "query",
        },
      });
      await expect(
        runtime.query({ kinds: ["protocol_violation"], limit: 100 }),
      ).resolves.toMatchObject({
        records: [expect.objectContaining({ kind: "protocol_violation" })],
      });
      await expect(
        runtime.query({
          harness: "codex",
          kinds: ["request_failure"],
          limit: 100,
        }),
      ).resolves.toMatchObject({
        records: [
          expect.objectContaining({
            operation: "capabilities",
            stage: "query",
          }),
        ],
      });
    } finally {
      await daemon.stop();
      await running;
      await runtime.close();
    }
  });

  test("queries one stable store snapshot while a later record is accepted", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "reins-daemon-diagnostic-snapshot-"),
    );
    directories.push(root);
    const state: DaemonState = {
      directory: root,
      diagnosticsDirectory: join(root, "diagnostics"),
      durable: true,
      retention: { maxAgeMs: 60_000, maxBytes: 1024 * 1024 },
    };
    let blockQueries = false;
    let entered = 0;
    let releaseQueries!: () => void;
    const queriesBlocked = new Promise<void>((resolve) => {
      releaseQueries = resolve;
    });
    let secondQuery!: () => void;
    const lateQueryEntered = new Promise<void>((resolve) => {
      secondQuery = resolve;
    });
    let firstQuery!: () => void;
    const firstQueryEntered = new Promise<void>((resolve) => {
      firstQuery = resolve;
    });
    const runtime = await openDiagnosticsRuntimeForTest({
      resolveState: async () => state,
      openStore: async () =>
        await openDiagnosticsStoreForTest({
          directory: state.diagnosticsDirectory,
          beforeQueryRead: async () => {
            if (!blockQueries) return;
            entered += 1;
            if (entered === 1) firstQuery();
            if (entered === 2) secondQuery();
            await queriesBlocked;
          },
        }),
      allocateGeneration: async () =>
        v.parse(daemonGenerationSchema, "snapshot"),
    });
    await runtime.record({
      source: "daemon",
      kind: "lifecycle",
      operation: "daemon",
      reason: "started",
    });
    const transport = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport,
      adapters: new Map(),
      identity: { session: (name) => runtime.sessionId(name) },
      diagnostics: runtime,
    });
    const running = daemon.start();
    const client = transport.connect();
    await Promise.resolve();
    try {
      const ready = new Promise<void>((resolve) => {
        const unsubscribe = client.onEvent((event) => {
          if (
            event.kind === "message" &&
            event.message.kind === "response" &&
            event.message.requestId === "snapshot-ready"
          ) {
            unsubscribe();
            resolve();
          }
        });
      });
      client.send({
        kind: "request",
        requestId: v.parse(requestIdSchema, "snapshot-ready"),
        method: "initialize",
        params: {},
      });
      await ready;
      blockQueries = true;
      const response = new Promise<ProtocolResponse>((resolve) => {
        client.onEvent((event) => {
          if (event.kind === "message" && event.message.kind === "response")
            resolve(event.message);
        });
      });
      client.send({
        kind: "request",
        requestId: v.parse(requestIdSchema, "snapshot"),
        method: "diagnostics",
        params: {},
      });
      await firstQueryEntered;
      const late = runtime.record({
        source: "daemon",
        kind: "lifecycle",
        operation: "daemon",
        reason: "stopped",
      });
      await lateQueryEntered;
      releaseQueries();
      await late;
      await expect(response).resolves.toMatchObject({
        result: {
          records: [{ reason: "started" }, { reason: "started" }],
          truncated: false,
        },
      });
    } finally {
      releaseQueries();
      await daemon.stop();
      await running;
      await runtime.close();
    }
  });

  test("records one transport failure when response write and read error both fail", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "reins-daemon-transport-failure-"),
    );
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
        v.parse(daemonGenerationSchema, "transport"),
    });
    const writeFailure = new Error("界".repeat(30_000));
    const writeFailureText = String(writeFailure);
    let listener:
      | ((event: TransportEvent<ProtocolMessage>) => void)
      | undefined;
    const connection: TransportConnection<ProtocolMessage> = {
      send() {
        throw writeFailure;
      },
      onEvent(next) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      close() {},
    };
    const queryTransport = createInMemoryTransportServer<ProtocolMessage>();
    let accept:
      | ((connection: TransportConnection<ProtocolMessage>) => void)
      | undefined;
    const transport: TransportServer<ProtocolMessage> = {
      listen: () => queryTransport.listen(),
      close: () => queryTransport.close(),
      onConnection(next) {
        accept = next;
        const unsubscribeQueryTransport = queryTransport.onConnection(next);
        return () => {
          accept = undefined;
          unsubscribeQueryTransport();
        };
      },
    };
    const daemon = createDaemon({
      transport,
      adapters: new Map(),
      identity: { session: (name) => runtime.sessionId(name) },
      diagnostics: runtime,
    });
    const running = daemon.start();
    await Promise.resolve();
    try {
      accept?.(connection);
      await Promise.resolve();
      const receive = listener;
      receive?.({
        kind: "message",
        message: {
          kind: "request",
          requestId: v.parse(requestIdSchema, "transport-failure"),
          method: "initialize",
          params: {},
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const result = await runtime.query({ kinds: ["transport_failure"] });
        if ("records" in result && result.records.length > 0) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      receive?.({
        kind: "error",
        error: Object.assign(new Error("read failed"), {
          code: "transport_closed" as const,
        }),
      });
      const client = queryTransport.connect();
      await Promise.resolve();
      const query = async (attempt: number): Promise<ProtocolResponse> => {
        const requestId = v.parse(requestIdSchema, `query-${attempt}`);
        const response = new Promise<ProtocolResponse>((resolve) => {
          const unsubscribe = client.onEvent((event) => {
            if (
              event.kind === "message" &&
              event.message.kind === "response" &&
              event.message.requestId === requestId
            ) {
              unsubscribe();
              resolve(event.message);
            }
          });
        });
        client.send({
          kind: "request",
          requestId,
          method: "diagnostics",
          params: { kinds: ["transport_failure"] },
        });
        return await response;
      };
      let response: ProtocolResponse | undefined;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        response = await query(attempt);
        const parsed =
          "result" in response
            ? v.safeParse(diagnosticsResultSchema, response.result)
            : undefined;
        if (
          parsed?.success === true &&
          "records" in parsed.output &&
          parsed.output.records.length > 0
        ) {
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      expect(response).toMatchObject({
        result: {
          records: [
            {
              kind: "transport_failure",
              operation: "write",
              reason: "io_error",
              message: {
                truncated: true,
                originalBytes: Buffer.byteLength(writeFailureText, "utf8"),
              },
            },
          ],
          truncated: false,
        },
      });
      if (response === undefined || !("result" in response)) {
        throw new Error("Expected one queried transport diagnostic");
      }
      const result = v.parse(diagnosticsResultSchema, response.result);
      if (
        !("records" in result) ||
        result.records.length !== 1 ||
        result.records[0]?.kind !== "transport_failure"
      ) {
        throw new Error("Expected one queried transport diagnostic");
      }
      const record = result.records[0];
      const retainedBytes = Buffer.byteLength(record.message.text, "utf8");
      expect(retainedBytes).toBeGreaterThan(4 * 1024);
      expect(retainedBytes).toBeLessThanOrEqual(64 * 1024);
      expect(record.message.text.endsWith("界")).toBe(true);
    } finally {
      await daemon.stop();
      await running;
      await runtime.close();
    }
  });

  test("records one failing event subscriber without recursive diagnostics", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "reins-daemon-listener-failure-"),
    );
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
        v.parse(daemonGenerationSchema, "listener"),
    });
    const adapter: HarnessAdapter = {
      driverFactory: () => ({
        start() {},
        deliver() {},
        interrupt() {},
        resolvePermission() {},
        async terminate() {},
      }),
      capabilities: async () => ({ harness: "fake", models: [] }),
    };
    let failed = false;
    const transport = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemonForTest({
      transport,
      adapters: new Map([["fake", adapter]]),
      identity: { session: (name) => runtime.sessionId(name) },
      diagnostics: runtime,
      onEvent: () => {
        if (!failed) {
          failed = true;
          throw new Error("subscriber failed");
        }
      },
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
        requestId: v.parse(requestIdSchema, "listener-failure"),
        method: "spawn",
        params: {
          sessionName: "listener-failure",
          harness: "fake",
          message: "start",
        },
      });
      await response;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      await expect(
        runtime.query({ kinds: ["lifecycle"], sources: ["core"] }),
      ).resolves.toMatchObject({
        records: [{ operation: "event_delivery", reason: "listener_failed" }],
        truncated: false,
      });
    } finally {
      await daemon.stop();
      await running;
      await runtime.close();
    }
  });

  test("applies diagnostics filters inclusively with OR dimensions and AND intersections", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "reins-daemon-diagnostic-filters-"),
    );
    directories.push(root);
    const state: DaemonState = {
      directory: root,
      diagnosticsDirectory: join(root, "diagnostics"),
      durable: true,
      retention: { maxAgeMs: 60_000, maxBytes: 1024 * 1024 },
    };
    let now = new Date("2026-08-20T00:00:00.000Z");
    const runtime = await openDiagnosticsRuntimeForTest({
      resolveState: async () => state,
      openStore: async () =>
        await openDiagnosticsStore({ directory: state.diagnosticsDirectory }),
      allocateGeneration: async () =>
        v.parse(daemonGenerationSchema, "filters"),
      now: () => now,
    });
    const sessionId = runtime.sessionId(v.parse(sessionNameSchema, "filters"));
    const turnId = v.parse(turnIdSchema, "turn-filter");
    await runtime.record({
      source: "daemon",
      kind: "lifecycle",
      operation: "daemon",
      reason: "started",
    });
    now = new Date("2026-08-20T00:00:01.000Z");
    await runtime.record({
      source: "adapter",
      harness: "one",
      sessionId,
      turnId,
      kind: "lifecycle",
      operation: "worker",
      reason: "initialized",
    });
    now = new Date("2026-08-20T00:00:02.000Z");
    const failed = await runtime.record({
      source: "adapter",
      harness: "two",
      sessionId,
      turnId,
      kind: "lifecycle",
      operation: "worker",
      reason: "exited_unexpectedly",
    });
    if (failed === undefined) throw new Error("Expected a diagnostic id");
    const transport = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport,
      adapters: new Map(),
      identity: { session: (name) => runtime.sessionId(name) },
      diagnostics: runtime,
    });
    const running = daemon.start();
    const client = transport.connect();
    await Promise.resolve();
    let sequence = 0;
    const request = async (params: unknown): Promise<ProtocolResponse> => {
      sequence += 1;
      const requestId = v.parse(requestIdSchema, `filter-${sequence}`);
      const response = new Promise<ProtocolResponse>((resolve) => {
        client.onEvent((event) => {
          if (
            event.kind === "message" &&
            event.message.kind === "response" &&
            event.message.requestId === requestId
          ) {
            resolve(event.message);
          }
        });
      });
      client.send({
        kind: "request",
        requestId,
        method: "diagnostics",
        params,
      });
      return await response;
    };
    try {
      await expect(request({ diagnosticId: failed })).resolves.toMatchObject({
        result: { record: { diagnosticId: failed, severity: "error" } },
      });
      await expect(
        request({ sources: ["daemon", "adapter"] }),
      ).resolves.toMatchObject({
        result: {
          records: [
            { source: "daemon" },
            { source: "adapter" },
            { source: "adapter" },
            { source: "daemon" },
          ],
        },
      });
      await expect(
        request({ kinds: ["lifecycle"], minSeverity: "error" }),
      ).resolves.toMatchObject({
        result: { records: [{ harness: "two", severity: "error" }] },
      });
      await expect(
        request({ sessionId, turnId, harness: "one" }),
      ).resolves.toMatchObject({
        result: { records: [{ harness: "one", turnId }] },
      });
      await expect(
        request({
          sources: ["adapter"],
          since: "2026-08-20T00:00:01.000Z",
          until: "2026-08-20T00:00:02.000Z",
        }),
      ).resolves.toMatchObject({
        result: { records: [{ harness: "one" }, { harness: "two" }] },
      });
      await expect(
        request({ sources: ["adapter"], limit: 2 }),
      ).resolves.toMatchObject({
        result: {
          records: [{ harness: "one" }, { harness: "two" }],
          truncated: false,
        },
      });
      await expect(
        request({ diagnosticId: makeDiagnosticId("filters", "missing") }),
      ).resolves.toMatchObject({
        error: { code: "diagnostic_not_found" },
      });
    } finally {
      await daemon.stop();
      await running;
      await runtime.close();
    }
  });
});
