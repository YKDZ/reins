import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  createCodexModelCatalog,
  createCodexTransport,
  type CodexChild,
} from "@reins/codex";
import { createSessionMachine } from "@reins/core";
import type {
  ProtocolMessage,
  ProtocolResponse,
  AdapterDriverFactory,
  DomainEvent,
  ProtocolMethod,
  WorkerDriverFactory,
} from "@reins/protocol";
import {
  WORKER_EVENT_REJECTION_REASONS,
  isSideEffectMethod,
  operationKeyClaimsSchema,
  serializeOperationKey,
  initializeResultSchema,
  diagnosticsResultSchema,
  makeDiagnosticId,
  diagnosticIdSchema,
  requestIdSchema,
  sessionIdSchema,
  turnIdSchema,
  REINS_PROTOCOL_MAJOR_VERSION,
  runtimeScopeIdSchema,
  WorkerStartFailure,
  type WorkerEventRejection,
} from "@reins/protocol";
import {
  createTransportError,
  createInMemoryTransportServer,
  createUnixSocketClient,
  createUnixSocketServer,
} from "@reins/transport";
import type {
  TransportConnection,
  TransportEvent,
  TransportServer,
} from "@reins/transport";
import * as v from "valibot";
import { afterEach, describe, expect, test, vi } from "vitest";

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
const testRuntimeScopeId = v.parse(
  runtimeScopeIdSchema,
  "00000000-0000-4000-8000-000000000000",
);

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

let handshakeSeq = 0;

// 领域动作前必须在同一连接完成 initialize 握手；此 helper 只服务测试装配。
async function bindConsumer(
  client: TransportConnection<ProtocolMessage>,
  consumerContext = "test-consumer",
): Promise<void> {
  handshakeSeq += 1;
  const requestId = v.parse(
    requestIdSchema,
    `handshake-${String(handshakeSeq)}`,
  );
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
    method: "initialize",
    params: {
      protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
      consumerContext,
      runtimeScopeId: testRuntimeScopeId,
    },
  });
  const settled = await response;
  if ("error" in settled) {
    throw new Error(`Handshake failed: ${settled.error.code}`);
  }
  const generation = v.parse(
    initializeResultSchema,
    settled.result,
  ).daemonGeneration;
  const send = client.send.bind(client);
  client.send = (message) =>
    send(
      message.kind === "request" &&
        message.method === "initialize" &&
        typeof message.params === "object" &&
        message.params !== null
        ? {
            ...message,
            params: { runtimeScopeId: testRuntimeScopeId, ...message.params },
          }
        : message.kind === "request" &&
            isSideEffectMethod(message.method) &&
            message.operationKey === undefined
          ? {
              ...message,
              operationKey: serializeOperationKey(
                v.parse(operationKeyClaimsSchema, {
                  runtimeScopeId: testRuntimeScopeId,
                  consumer: consumerContext,
                  kind: message.method,
                  generation,
                  nonce: randomUUID(),
                }),
              ),
            }
          : message,
    );
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
describe("daemon diagnostic error dispatch", () => {
  test("malformed NDJSON produces closed secret-safe diagnostics through the real transport and store", async () => {
    const root = await mkdtemp(join(tmpdir(), "reins-daemon-safe-transport-"));
    directories.push(root);
    const state: DaemonState = {
      directory: root,
      diagnosticsDirectory: join(root, "diagnostics"),
      runtimeScopeId: testRuntimeScopeId,
      retention: { maxAgeMs: 60_000, maxBytes: 1024 * 1024 },
    };
    const runtime = await openDiagnosticsRuntimeForTest({
      resolveState: async () => state,
      openStore: async () =>
        await openDiagnosticsStore({ directory: state.diagnosticsDirectory }),
      allocateGeneration: async () =>
        v.parse(daemonGenerationSchema, "safetransport"),
    });
    const socketPath = join(root, "reins.sock");
    const transport = createUnixSocketServer<ProtocolMessage>({
      path: socketPath,
    });
    const daemon = createDaemon({
      transport,
      adapters: new Map(),
      identity: { session: () => runtime.sessionId() },
      diagnostics: runtime,
      runtimeScopeId: state.runtimeScopeId,
    });
    const running = daemon.start();
    await waitForDaemonLifecycle(runtime);
    const secretSentinel = ["ticket11", "secret", "sentinel"].join("-");
    const malformedFrame = `${JSON.stringify({
      kind: "request",
      requestId: "unsafe-frame",
      method: "send",
      params: {
        message: {
          content: [
            { type: "text", text: "ordinary body" },
            {
              type: "tool_result",
              content: secretSentinel,
            },
          ],
        },
      },
    }).slice(0, -1)},\n`;
    const raw = connect(socketPath);
    try {
      await new Promise<void>((resolve, reject) => {
        raw.once("connect", resolve);
        raw.once("error", reject);
      });
      const rawClosed = new Promise<void>((resolve) => {
        raw.once("close", () => resolve());
      });
      raw.end(malformedFrame);
      await rawClosed;

      const client = await createUnixSocketClient<ProtocolMessage>(socketPath);
      try {
        await bindConsumer(client);
        const requestId = v.parse(requestIdSchema, "safe-query");
        const nextResponse = new Promise<ProtocolResponse>((resolve) => {
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
        const response = await nextResponse;

        if (!("result" in response)) {
          throw new Error("Expected queried transport diagnostics");
        }
        const invalidRequestId = v.parse(requestIdSchema, "invalid-shape");
        const invalidResponse = new Promise<ProtocolResponse>((resolve) => {
          const unsubscribe = client.onEvent((event) => {
            if (
              event.kind === "message" &&
              event.message.kind === "response" &&
              event.message.requestId === invalidRequestId
            ) {
              unsubscribe();
              resolve(event.message);
            }
          });
        });
        client.send({
          kind: "request",
          requestId: invalidRequestId,
          method: "initialize",
          params: {},
          extraEvidence: secretSentinel,
        } as unknown as ProtocolMessage);
        await expect(invalidResponse).resolves.toMatchObject({
          error: { code: "protocol_error" },
        });

        const protocolRequestId = v.parse(requestIdSchema, "protocol-query");
        const nextProtocolResponse = new Promise<ProtocolResponse>(
          (resolve) => {
            const unsubscribe = client.onEvent((event) => {
              if (
                event.kind === "message" &&
                event.message.kind === "response" &&
                event.message.requestId === protocolRequestId
              ) {
                unsubscribe();
                resolve(event.message);
              }
            });
          },
        );
        client.send({
          kind: "request",
          requestId: protocolRequestId,
          method: "diagnostics",
          params: { kinds: ["protocol_violation"] },
        });
        const protocolResponse = await nextProtocolResponse;
        expect(protocolResponse).toMatchObject({
          result: {
            records: [
              {
                kind: "protocol_violation",
                operation: "validate_daemon_request",
                stage: "envelope",
                reason: "invalid_shape",
              },
            ],
            truncated: false,
          },
        });
        if (!("result" in protocolResponse)) {
          throw new Error("Expected queried protocol diagnostics");
        }
        const transportResult = v.parse(
          diagnosticsResultSchema,
          response.result,
        );
        const protocolResult = v.parse(
          diagnosticsResultSchema,
          protocolResponse.result,
        );
        if (
          !("records" in transportResult) ||
          !("records" in protocolResult) ||
          transportResult.records[0] === undefined ||
          protocolResult.records[0] === undefined
        ) {
          throw new Error("Expected filtered diagnostic records");
        }
        expect(Object.keys(transportResult.records[0]).sort()).toEqual([
          "diagnosticId",
          "inputBytes",
          "kind",
          "operation",
          "reason",
          "recordedAt",
          "severity",
          "source",
          "v",
        ]);
        expect(Object.keys(protocolResult.records[0]).sort()).toEqual([
          "diagnosticId",
          "kind",
          "operation",
          "reason",
          "recordedAt",
          "severity",
          "source",
          "stage",
          "v",
        ]);
        const queryText = JSON.stringify([response.result, protocolResponse]);
        const prettyText = JSON.stringify(
          [transportResult, protocolResult],
          null,
          2,
        );
        const files = await readdir(state.diagnosticsDirectory, {
          withFileTypes: true,
        });
        const storeText = (
          await Promise.all(
            files
              .filter((entry) => entry.isFile())
              .map(
                async (entry) =>
                  await readFile(
                    join(state.diagnosticsDirectory, entry.name),
                    "utf8",
                  ),
              ),
          )
        ).join("\n");
        expect(queryText.includes(secretSentinel)).toBe(false);
        expect(prettyText.includes(secretSentinel)).toBe(false);
        expect(storeText.includes(secretSentinel)).toBe(false);
        expect(queryText.includes("ordinary body")).toBe(false);
        expect(storeText.includes("tool_result")).toBe(false);
        expect(response).toMatchObject({
          result: {
            records: [
              {
                kind: "transport_failure",
                operation: "read",
                reason: "invalid_frame",
                inputBytes: Buffer.byteLength(malformedFrame, "utf8") - 1,
              },
            ],
            truncated: false,
          },
        });
      } finally {
        client.close();
      }
    } finally {
      raw.destroy();
      await daemon.stop();
      await running;
      await runtime.close();
    }
  });

  test("queries a synchronously registered worker rejection without polling", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "reins-daemon-immediate-rejection-query-"),
    );
    directories.push(root);
    const state: DaemonState = {
      directory: root,
      diagnosticsDirectory: join(root, "diagnostics"),
      runtimeScopeId: testRuntimeScopeId,
      retention: { maxAgeMs: 60_000, maxBytes: 1024 * 1024 },
    };
    const runtime = await openDiagnosticsRuntimeForTest({
      resolveState: async () => state,
      openStore: async () =>
        await openDiagnosticsStore({ directory: state.diagnosticsDirectory }),
      allocateGeneration: async () => v.parse(daemonGenerationSchema, "query"),
    });
    let emit!: (event: DomainEvent) => void;
    const machine = createSessionMachine({
      driverFactory: (ingress) => {
        emit = ingress;
        return {
          async start() {},
          async deliver() {},
          async interrupt() {},
          resolvePermission() {},
          async terminate() {},
        };
      },
      identity: { session: () => runtime.sessionId() },
      diagnostics: {
        async record(input) {
          return await runtime.record({ source: "core", ...input });
        },
      },
    });
    const { sessionId } = await machine.spawn({
      sessionLabel: "immediate-query",
      harness: "codex",
      message: "start",
      cwd: "/tmp",
    });

    emit({ type: "session.killed", sessionId });
    const result = await runtime.query({
      sources: ["core"],
      kinds: ["protocol_violation"],
    });
    await runtime.close();

    expect("records" in result ? result.records : []).toEqual([
      expect.objectContaining({
        source: "core",
        sessionId,
        kind: "protocol_violation",
        operation: "validate_worker_event",
        reason: "driver_event_forbidden",
        eventType: "session.killed",
        sessionState: "busy",
      }),
    ]);
  });

  test("drains a worker rejection registered before immediate runtime close", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "reins-daemon-immediate-rejection-close-"),
    );
    directories.push(root);
    const state: DaemonState = {
      directory: root,
      diagnosticsDirectory: join(root, "diagnostics"),
      runtimeScopeId: testRuntimeScopeId,
      retention: { maxAgeMs: 60_000, maxBytes: 1024 * 1024 },
    };
    const runtime = await openDiagnosticsRuntimeForTest({
      resolveState: async () => state,
      openStore: async () =>
        await openDiagnosticsStore({ directory: state.diagnosticsDirectory }),
      allocateGeneration: async () => v.parse(daemonGenerationSchema, "drain"),
    });
    let emit!: (event: DomainEvent) => void;
    const driverFactory: WorkerDriverFactory = (ingress) => {
      emit = ingress;
      return {
        async start() {},
        async deliver() {},
        async interrupt() {},
        resolvePermission() {},
        async terminate() {},
      };
    };
    const machine = createSessionMachine({
      driverFactory,
      identity: { session: () => runtime.sessionId() },
      diagnostics: {
        async record(input) {
          return await runtime.record({ source: "core", ...input });
        },
      },
    });
    const { sessionId } = await machine.spawn({
      sessionLabel: "immediate-close",
      harness: "codex",
      message: "start",
      cwd: "/tmp",
    });

    emit({
      type: "session.killed",
      sessionId,
    });
    await runtime.close();

    const files = await readdir(state.diagnosticsDirectory, {
      withFileTypes: true,
    });
    const storeText = (
      await Promise.all(
        files
          .filter((entry) => entry.isFile())
          .map(
            async (entry) =>
              await readFile(
                join(state.diagnosticsDirectory, entry.name),
                "utf8",
              ),
          ),
      )
    ).join("\n");
    expect(storeText).toContain('"kind":"protocol_violation"');
    expect(storeText).toContain('"reason":"driver_event_forbidden"');
  });

  test("persists every typed worker rejection without event payloads", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "reins-daemon-worker-rejection-"),
    );
    directories.push(root);
    const state: DaemonState = {
      directory: root,
      diagnosticsDirectory: join(root, "diagnostics"),
      runtimeScopeId: testRuntimeScopeId,
      retention: { maxAgeMs: 60_000, maxBytes: 1024 * 1024 },
    };
    const runtime = await openDiagnosticsRuntimeForTest({
      resolveState: async () => state,
      openStore: async () =>
        await openDiagnosticsStore({ directory: state.diagnosticsDirectory }),
      allocateGeneration: async () => v.parse(daemonGenerationSchema, "typed"),
    });
    let emit!: (event: DomainEvent) => void;
    const driverFactory: AdapterDriverFactory = (context) => {
      emit = context.emit;
      return {
        async start() {},
        async deliver() {},
        async interrupt() {},
        resolvePermission() {},
        async terminate() {},
      };
    };
    const transport = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport,
      adapters: new Map([
        [
          "codex",
          {
            driverFactory,
            modelCatalog: async () => ({ harness: "codex", models: [] }),
          },
        ],
      ]),
      identity: { session: () => runtime.sessionId() },
      diagnostics: runtime,
      runtimeScopeId: testRuntimeScopeId,
    });
    const running = daemon.start();
    const client = transport.connect();
    await waitForDaemonLifecycle(runtime);
    await bindConsumer(client);
    let requestSeq = 0;
    const request = async (method: ProtocolMethod, params: unknown) => {
      requestSeq += 1;
      const requestId = v.parse(requestIdSchema, `typed-${requestSeq}`);
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
      client.send({ kind: "request", requestId, method, params });
      return await response;
    };
    const spawn = async (sessionLabel: string) => {
      const response = await request("spawn", {
        sessionLabel,
        harness: "codex",
        message: "caller-authored",
        cwd: "/tmp",
      });
      if (!("result" in response)) throw new Error("Expected spawn result");
      return (response.result as { sessionId: DomainEvent["sessionId"] })
        .sessionId;
    };
    try {
      const active = await spawn("typed-active-daemon");
      emit({
        type: "session.created",
        sessionId: active,
        harness: "codex",
        model: null,
        reasoning: null,
        cwd: "/sentinel-cwd",
        sessionLabel: "forged",
        spawnedAt: "sentinel-time",
      });
      emit({
        type: "turn.started",
        sessionId: active,
        turnId: v.parse(turnIdSchema, "t99"),
      });
      emit({ type: "session.killed", sessionId: active });
      emit({
        type: "message",
        sessionId: active,
        turnId: v.parse(turnIdSchema, "t99"),
        messageId: "m-mismatch" as never,
        role: "worker",
        content: "sentinel-mismatch",
      });
      emit({
        type: "message",
        sessionId: active,
        turnId: v.parse(turnIdSchema, "t1"),
        messageId: "m1" as never,
        role: "worker",
        content: "accepted",
      });
      emit({
        type: "message",
        sessionId: active,
        turnId: v.parse(turnIdSchema, "t1"),
        messageId: "m1" as never,
        role: "worker",
        content: "sentinel-content",
      });
      emit({
        type: "tool.requested",
        sessionId: active,
        turnId: v.parse(turnIdSchema, "t1"),
        toolCallId: "c1" as never,
        name: "Read",
      });
      emit({
        type: "tool.requested",
        sessionId: active,
        turnId: v.parse(turnIdSchema, "t1"),
        toolCallId: "c1" as never,
        name: "sentinel-tool-name",
      });
      emit({
        type: "tool.completed",
        sessionId: active,
        turnId: v.parse(turnIdSchema, "t1"),
        toolCallId: "c2" as never,
        name: "Read",
        result: "accepted",
        isError: false,
      });
      emit({
        type: "tool.completed",
        sessionId: active,
        turnId: v.parse(turnIdSchema, "t1"),
        toolCallId: "c2" as never,
        name: "Read",
        result: "sentinel-tool-result",
        isError: false,
      });
      emit({
        type: "permission.requested",
        sessionId: active,
        turnId: v.parse(turnIdSchema, "t1"),
        permissionId: "p1" as never,
        kind: "tool:Bash",
        input: { value: "accepted" },
        options: [{ outcome: "allow", scope: "once" }],
      });
      emit({
        type: "permission.resolved",
        sessionId: active,
        turnId: v.parse(turnIdSchema, "t99"),
        permissionId: "p1" as never,
        resolution: { outcome: "deny", feedback: "sentinel-feedback" },
      });
      emit({
        type: "permission.resolved",
        sessionId: active,
        turnId: v.parse(turnIdSchema, "t1"),
        permissionId: "missing" as never,
        resolution: { outcome: "deny", feedback: "sentinel-feedback" },
      });
      emit({
        type: "permission.resolved",
        sessionId: active,
        turnId: v.parse(turnIdSchema, "t1"),
        permissionId: "p1" as never,
        resolution: { outcome: "allow", scope: "once" },
      });
      emit({
        type: "permission.requested",
        sessionId: active,
        turnId: v.parse(turnIdSchema, "t1"),
        permissionId: "p1" as never,
        kind: "tool:Bash",
        input: { value: "sentinel-permission-input" },
        options: [{ outcome: "allow", scope: "once" }],
      });

      const idle = await spawn("typed-idle-daemon");
      emit({
        type: "turn.completed",
        sessionId: idle,
        turnId: v.parse(turnIdSchema, "t2"),
        stopReason: "end_turn",
        finalReply: "sentinel-final-reply",
        usage: { marker: "sentinel-usage" },
      });
      emit({
        type: "text.delta",
        sessionId: idle,
        turnId: v.parse(turnIdSchema, "t2"),
        messageId: "m-after" as never,
        delta: "sentinel-delta",
      });
      emit({
        type: "message",
        sessionId: idle,
        turnId: v.parse(turnIdSchema, "t77"),
        messageId: "m-idle" as never,
        role: "worker",
        content: "sentinel-idle",
      });

      const killed = await spawn("typed-killed-daemon");
      await request("kill", { sessionId: killed });
      emit({
        type: "message",
        sessionId: killed,
        turnId: v.parse(turnIdSchema, "t3"),
        messageId: "m-killed" as never,
        role: "worker",
        content: "sentinel-killed",
      });
      emit({
        type: "message",
        sessionId: runtime.sessionId(),
        turnId: v.parse(turnIdSchema, "t1"),
        messageId: "m-unknown" as never,
        role: "worker",
        content: "sentinel-unknown",
        nativePayload: { value: "sentinel-native-payload" },
      } as DomainEvent);

      let query!: ProtocolResponse;
      await vi.waitFor(async () => {
        query = await request("diagnostics", {
          kinds: ["protocol_violation"],
          sources: ["core"],
          limit: 100,
        });
        expect(query).toMatchObject({ result: { records: expect.any(Array) } });
        if (!("result" in query))
          throw new Error("Expected diagnostics result");
        expect((query.result as { records: unknown[] }).records).toHaveLength(
          14,
        );
      });
      if (!("result" in query)) throw new Error("Expected diagnostics result");
      const records = (query.result as { records: Array<{ reason: string }> })
        .records;
      const reasonCounts = Object.fromEntries(
        records.map(({ reason }) => [reason, 0]),
      ) as Record<string, number>;
      for (const { reason } of records)
        reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
      expect(new Set(Object.keys(reasonCounts))).toEqual(
        new Set(WORKER_EVENT_REJECTION_REASONS),
      );
      expect(reasonCounts).toEqual({
        unknown_session: 1,
        session_killed: 1,
        driver_event_forbidden: 3,
        turn_not_active: 1,
        turn_mismatch: 1,
        event_after_turn_completed: 1,
        message_already_completed: 1,
        tool_already_requested: 1,
        tool_already_completed: 1,
        permission_id_reused: 1,
        permission_not_pending: 1,
        permission_turn_mismatch: 1,
      } satisfies Record<WorkerEventRejection["reason"], number>);
      expect(records).toMatchObject([
        {
          reason: "driver_event_forbidden",
          eventType: "session.created",
          sessionState: "busy",
        },
        {
          reason: "driver_event_forbidden",
          eventType: "turn.started",
          sessionState: "busy",
        },
        {
          reason: "driver_event_forbidden",
          eventType: "session.killed",
          sessionState: "busy",
        },
        {
          reason: "turn_mismatch",
          eventTurnId: "t99",
          activeTurnId: "t1",
        },
        { reason: "message_already_completed", messageId: "m1" },
        { reason: "tool_already_requested", toolCallId: "c1" },
        { reason: "tool_already_completed", toolCallId: "c2" },
        {
          reason: "permission_turn_mismatch",
          permissionId: "p1",
          eventTurnId: "t99",
          activeTurnId: "t1",
        },
        { reason: "permission_not_pending", permissionId: "missing" },
        { reason: "permission_id_reused", permissionId: "p1" },
        {
          reason: "event_after_turn_completed",
          eventTurnId: "t2",
          sessionState: "idle",
        },
        {
          reason: "turn_not_active",
          eventTurnId: "t77",
          sessionState: "idle",
        },
        {
          reason: "session_killed",
          eventTurnId: "t3",
          sessionState: "killed",
        },
        {
          reason: "unknown_session",
          eventTurnId: "t1",
          sessionState: "unknown",
        },
      ]);
      const protocolJson = JSON.stringify(query);
      const files = await readdir(state.diagnosticsDirectory, {
        withFileTypes: true,
      });
      const storeText = (
        await Promise.all(
          files
            .filter((entry) => entry.isFile())
            .map(
              async (entry) =>
                await readFile(
                  join(state.diagnosticsDirectory, entry.name),
                  "utf8",
                ),
            ),
        )
      ).join("\n");
      for (const sentinel of [
        "sentinel-content",
        "sentinel-delta",
        "sentinel-tool-result",
        "sentinel-permission-input",
        "sentinel-final-reply",
        "sentinel-usage",
        "sentinel-native-payload",
        "sentinel-feedback",
      ])
        expect(`${protocolJson}\n${storeText}`).not.toContain(sentinel);
    } finally {
      await daemon.stop();
      await running;
      await runtime.close();
    }
  });

  test("serves exact and filtered diagnostics from the real recorder store", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "reins-daemon-diagnostic-query-"),
    );
    directories.push(root);
    const state: DaemonState = {
      directory: root,
      diagnosticsDirectory: join(root, "diagnostics"),
      runtimeScopeId: testRuntimeScopeId,
      retention: { maxAgeMs: 60_000, maxBytes: 1024 * 1024 },
    };
    const runtime = await openDiagnosticsRuntimeForTest({
      resolveState: async () => state,
      openStore: async () =>
        await openDiagnosticsStoreForTest({
          directory: state.diagnosticsDirectory,
          now: () => new Date("2026-08-20T00:00:00.000Z"),
        }),
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
      identity: { session: () => runtime.sessionId() },
      diagnostics: runtime,
      runtimeScopeId: testRuntimeScopeId,
    });
    const running = daemon.start();
    const client = transport.connect();
    await Promise.resolve();
    await bindConsumer(client);
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
      runtimeScopeId: testRuntimeScopeId,
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
      async start() {
        throw new WorkerStartFailure("worker start failed", "not_accepted");
      },
      async deliver() {},
      async interrupt() {},
      resolvePermission() {},
      async terminate() {},
    });
    const adapter: HarnessAdapter = {
      driverFactory,
      modelCatalog: async () => ({
        harness: "codex",
        models: [],
      }),
    };
    const transport = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemonForTest({
      transport,
      adapters: new Map([["codex", adapter]]),
      identity: { session: () => runtime.sessionId() },
      diagnostics: runtime,
      runtimeScopeId: testRuntimeScopeId,
      idleTimeoutMs: 60_000,
    });
    const running = daemon.start();
    const client = transport.connect();
    await Promise.resolve();
    await bindConsumer(client);
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
          sessionLabel: "failed-worker",
          cwd: "/tmp",
          harness: "codex",
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
      runtimeScopeId: testRuntimeScopeId,
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
        async start() {
          throw new WorkerStartFailure("worker start failed", "not_accepted");
        },
        async deliver() {},
        async interrupt() {},
        resolvePermission() {},
        async terminate() {},
      }),
      modelCatalog: async () => ({
        harness: "codex",
        models: [],
      }),
    };
    const transport = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport,
      adapters: new Map([["codex", adapter]]),
      identity: { session: () => runtime.sessionId() },
      diagnostics: runtime,
      runtimeScopeId: testRuntimeScopeId,
    });
    const running = daemon.start();
    const client = transport.connect();
    await waitForDaemonLifecycle(runtime);
    await bindConsumer(client);
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
          sessionLabel: "append-failure",
          cwd: "/tmp",
          harness: "codex",
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
      runtimeScopeId: testRuntimeScopeId,
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
      identity: { session: () => runtime.sessionId() },
      diagnostics: runtime,
      runtimeScopeId: testRuntimeScopeId,
    });
    const running = daemon.start();
    const client = transport.connect();
    await waitForDaemonLifecycle(runtime);
    await bindConsumer(client);
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

  test("keeps successful catalogs while linking a mismatched harness to a real diagnostic", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "reins-daemon-modelCatalog-diagnostic-"),
    );
    directories.push(root);
    const state: DaemonState = {
      directory: root,
      diagnosticsDirectory: join(root, "diagnostics"),
      runtimeScopeId: testRuntimeScopeId,
      retention: { maxAgeMs: 60_000, maxBytes: 1024 * 1024 },
    };
    const runtime = await openDiagnosticsRuntimeForTest({
      resolveState: async () => state,
      openStore: async () =>
        await openDiagnosticsStore({ directory: state.diagnosticsDirectory }),
      allocateGeneration: async () => v.parse(daemonGenerationSchema, "caps"),
    });
    const driverFactory: AdapterDriverFactory = () => ({
      async start() {},
      async deliver() {},
      async interrupt() {},
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
            modelCatalog: async () => ({ harness: "codex", models: [] }),
          },
        ],
        [
          "qoder",
          {
            driverFactory,
            modelCatalog: async () => ({ harness: "codex", models: [] }),
          },
        ],
      ]),
      identity: { session: () => runtime.sessionId() },
      diagnostics: runtime,
      runtimeScopeId: testRuntimeScopeId,
    });
    const running = daemon.start();
    const client = transport.connect();
    await Promise.resolve();
    await bindConsumer(client);
    try {
      const response = new Promise<ProtocolResponse>((resolve) => {
        client.onEvent((event) => {
          if (event.kind === "message" && event.message.kind === "response")
            resolve(event.message);
        });
      });
      client.send({
        kind: "request",
        requestId: v.parse(requestIdSchema, "model-catalog"),
        method: "modelCatalog",
        params: {},
      });
      const result = await response;
      expect(result).toMatchObject({
        result: {
          catalogs: [{ harness: "codex" }],
          failures: [{ harness: "qoder", code: "model_catalog_query_failed" }],
        },
      });
      if (!("result" in result))
        throw new Error("Expected modelCatalog result");
      const failure = result.result as {
        failures: Array<{ diagnosticId?: unknown }>;
      };
      const diagnosticId = failure.failures[0]?.diagnosticId;
      if (typeof diagnosticId !== "string")
        throw new Error("Expected a diagnostic id");
      await expect(
        runtime.query({
          diagnosticId: v.parse(diagnosticIdSchema, diagnosticId),
        }),
      ).resolves.toMatchObject({
        record: {
          kind: "request_failure",
          operation: "model_catalog",
          harness: "qoder",
        },
      });
    } finally {
      await daemon.stop();
      await running;
      await runtime.close();
    }
  });

  test("Codex malformed model/list does not reuse an unrelated protocol diagnostic for the model catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "reins-daemon-codex-caps-"));
    directories.push(root);
    const state: DaemonState = {
      directory: root,
      diagnosticsDirectory: join(root, "diagnostics"),
      runtimeScopeId: testRuntimeScopeId,
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
      async start() {},
      async deliver() {},
      async interrupt() {},
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
            modelCatalog: createCodexModelCatalog({
              transportFactory: (options) =>
                createCodexTransport({
                  ...options,
                  spawnChild: () => child,
                }),
            }),
          },
        ],
      ]),
      identity: { session: () => runtime.sessionId() },
      diagnostics: runtime,
      runtimeScopeId: testRuntimeScopeId,
    });
    const running = daemon.start();
    const client = transport.connect();
    await Promise.resolve();
    await bindConsumer(client);
    try {
      const response = new Promise<ProtocolResponse>((resolve) => {
        client.onEvent((event) => {
          if (event.kind === "message" && event.message.kind === "response")
            resolve(event.message);
        });
      });
      client.send({
        kind: "request",
        requestId: v.parse(requestIdSchema, "codex-model-catalog"),
        method: "modelCatalog",
        params: {},
      });
      const result = await response;
      if (!("result" in result))
        throw new Error("Expected modelCatalog result");
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
          operation: "model_catalog",
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
            operation: "model_catalog",
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
      runtimeScopeId: testRuntimeScopeId,
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
      identity: { session: () => runtime.sessionId() },
      diagnostics: runtime,
      runtimeScopeId: testRuntimeScopeId,
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
        params: {
          protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
          consumerContext: "test-consumer",
          runtimeScopeId: testRuntimeScopeId,
        },
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

  test("diagnostics query 只等待 acceptance watermark 前的因果工作", async () => {
    const root = await mkdtemp(join(tmpdir(), "reins-daemon-query-watermark-"));
    directories.push(root);
    const state: DaemonState = {
      directory: root,
      diagnosticsDirectory: join(root, "diagnostics"),
      runtimeScopeId: testRuntimeScopeId,
      retention: { maxAgeMs: 60_000, maxBytes: 1024 * 1024 },
    };
    const runtime = await openDiagnosticsRuntimeForTest({
      resolveState: async () => state,
      openStore: async () =>
        await openDiagnosticsStore({ directory: state.diagnosticsDirectory }),
      allocateGeneration: async () =>
        v.parse(daemonGenerationSchema, "querywatermark"),
    });
    let releasePre!: () => void;
    const preReleased = new Promise<void>((resolve) => {
      releasePre = resolve;
    });
    let preEntered!: () => void;
    const preRecordEntered = new Promise<void>((resolve) => {
      preEntered = resolve;
    });
    let preCompleted!: () => void;
    const preRecordCompleted = new Promise<void>((resolve) => {
      preCompleted = resolve;
    });
    let completePost!: () => void;
    const postCompleted = new Promise<void>((resolve) => {
      completePost = resolve;
    });
    let protocolViolations = 0;
    let queryCalls = 0;
    let postRecordEntered = false;
    const diagnostics: DiagnosticsRuntime = {
      generation: runtime.generation,
      sessionId: () => runtime.sessionId(),
      async record(input) {
        if (input.kind !== "protocol_violation") {
          return await runtime.record(input);
        }
        protocolViolations += 1;
        if (protocolViolations === 1) {
          preEntered();
          await preReleased;
          const result = await runtime.record(input);
          preCompleted();
          return result;
        }
        postRecordEntered = true;
        const result = await runtime.record(input);
        completePost();
        return result;
      },
      query(params) {
        queryCalls += 1;
        return runtime.query(params);
      },
      health: () => runtime.health(),
      close: () => runtime.close(),
    };
    let queryAccepted!: () => void;
    const accepted = new Promise<void>((resolve) => {
      queryAccepted = resolve;
    });
    const transport = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemonForTest({
      transport,
      adapters: new Map(),
      identity: { session: () => runtime.sessionId() },
      diagnostics,
      onDiagnosticsQueryAccepted: queryAccepted,
    });
    const running = daemon.start();
    await waitForDaemonLifecycle(runtime);
    const preClient = transport.connect();
    const queryClient = transport.connect();
    const postClient = transport.connect();
    await Promise.resolve();
    await bindConsumer(queryClient);

    const sendInvalid = async (
      client: TransportConnection<ProtocolMessage>,
      requestId: string,
    ): Promise<void> => {
      const responded = new Promise<void>((resolve) => {
        const unsubscribe = client.onEvent((event) => {
          if (
            event.kind === "message" &&
            event.message.kind === "response" &&
            event.message.requestId === requestId
          ) {
            unsubscribe();
            resolve();
          }
        });
      });
      client.send({
        kind: "request",
        requestId: v.parse(requestIdSchema, requestId),
        method: "diagnostics",
        params: {},
        extra: "invalid-shape",
      } as unknown as ProtocolMessage);
      await responded;
    };

    try {
      await sendInvalid(preClient, "pre-watermark");
      await preRecordEntered;
      const response = new Promise<ProtocolResponse>((resolve) => {
        const unsubscribe = queryClient.onEvent((event) => {
          if (
            event.kind === "message" &&
            event.message.kind === "response" &&
            event.message.requestId === "watermarked-query"
          ) {
            unsubscribe();
            resolve(event.message);
          }
        });
      });
      queryClient.send({
        kind: "request",
        requestId: v.parse(requestIdSchema, "watermarked-query"),
        method: "diagnostics",
        params: { kinds: ["protocol_violation"] },
      });
      await accepted;
      await sendInvalid(postClient, "post-watermark");
      expect(postRecordEntered).toBe(false);

      releasePre();
      await preRecordCompleted;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(queryCalls).toBe(1);
      await expect(response).resolves.toMatchObject({
        result: {
          records: [
            {
              kind: "protocol_violation",
              operation: "validate_daemon_request",
            },
          ],
          truncated: false,
        },
      });
      await postCompleted;
      await expect(
        diagnostics.query({ kinds: ["protocol_violation"] }),
      ).resolves.toMatchObject({
        records: [
          { operation: "validate_daemon_request" },
          { operation: "validate_daemon_request" },
        ],
        truncated: false,
      });
    } finally {
      releasePre();
      await daemon.stop();
      await running;
      await runtime.close();
    }
  });

  test("普通 write Error 归一化且同连接后续 read failure 去重", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "reins-daemon-transport-failure-"),
    );
    directories.push(root);
    const state: DaemonState = {
      directory: root,
      diagnosticsDirectory: join(root, "diagnostics"),
      runtimeScopeId: testRuntimeScopeId,
      retention: { maxAgeMs: 60_000, maxBytes: 1024 * 1024 },
    };
    const runtime = await openDiagnosticsRuntimeForTest({
      resolveState: async () => state,
      openStore: async () =>
        await openDiagnosticsStore({ directory: state.diagnosticsDirectory }),
      allocateGeneration: async () =>
        v.parse(daemonGenerationSchema, "transport"),
    });
    const secretSentinel = ["plain", "write", "sentinel"].join("-");
    let inspectedUnbrandedError = false;
    const unbrandedFailure = new Proxy(new Error(secretSentinel), {
      get() {
        inspectedUnbrandedError = true;
        throw new Error("Unbranded transport error was inspected");
      },
    });
    let listener:
      | ((event: TransportEvent<ProtocolMessage>) => void)
      | undefined;
    const connection: TransportConnection<ProtocolMessage> = {
      send() {
        throw unbrandedFailure;
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
      identity: { session: () => runtime.sessionId() },
      diagnostics: runtime,
      runtimeScopeId: testRuntimeScopeId,
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
          params: {
            protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
            consumerContext: "test-consumer",
            runtimeScopeId: testRuntimeScopeId,
          },
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
        error: createTransportError({
          code: "io_error",
          fact: {
            kind: "transport_failure",
            operation: "read",
            reason: "io_error",
          },
        }),
      });
      const client = queryTransport.connect();
      await Promise.resolve();
      await bindConsumer(client);
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
      expect(Object.keys(record).sort()).toEqual([
        "diagnosticId",
        "kind",
        "operation",
        "reason",
        "recordedAt",
        "severity",
        "source",
        "v",
      ]);
      expect(inspectedUnbrandedError).toBe(false);
    } finally {
      await daemon.stop();
      await running;
      await runtime.close();
    }
  });

  test("普通 listen Error 只以闭合事实进入真实 store 与 query", async () => {
    const root = await mkdtemp(join(tmpdir(), "reins-daemon-listen-failure-"));
    directories.push(root);
    const state: DaemonState = {
      directory: root,
      diagnosticsDirectory: join(root, "diagnostics"),
      runtimeScopeId: testRuntimeScopeId,
      retention: { maxAgeMs: 60_000, maxBytes: 1024 * 1024 },
    };
    const runtime = await openDiagnosticsRuntimeForTest({
      resolveState: async () => state,
      openStore: async () =>
        await openDiagnosticsStore({ directory: state.diagnosticsDirectory }),
      allocateGeneration: async () =>
        v.parse(daemonGenerationSchema, "listenfailure"),
    });
    const secretSentinel = ["plain", "listen", "sentinel"].join("-");
    const daemon = createDaemon({
      transport: {
        async listen() {
          throw new Error(secretSentinel);
        },
        onConnection() {
          return () => {};
        },
        async close() {},
      },
      adapters: new Map(),
      identity: { session: () => runtime.sessionId() },
      diagnostics: runtime,
      runtimeScopeId: testRuntimeScopeId,
    });

    try {
      const failure: unknown = await daemon
        .start()
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: "io_error",
        message: "io_error",
        fact: {
          kind: "transport_failure",
          operation: "listen",
          reason: "io_error",
        },
      });
      const result = await runtime.query({ kinds: ["transport_failure"] });
      expect(result).toMatchObject({
        records: [
          {
            kind: "transport_failure",
            operation: "listen",
            reason: "io_error",
          },
        ],
        truncated: false,
      });
      const files = await readdir(state.diagnosticsDirectory, {
        withFileTypes: true,
      });
      const storeText = (
        await Promise.all(
          files
            .filter((entry) => entry.isFile())
            .map(
              async (entry) =>
                await readFile(
                  join(state.diagnosticsDirectory, entry.name),
                  "utf8",
                ),
            ),
        )
      ).join("\n");
      expect(JSON.stringify([failure, result]).includes(secretSentinel)).toBe(
        false,
      );
      expect(storeText.includes(secretSentinel)).toBe(false);
    } finally {
      await runtime.close();
    }
  });

  test("未接受的 transport fact 不占用连接级去重槽", async () => {
    const root = await mkdtemp(join(tmpdir(), "reins-daemon-dedup-retry-"));
    directories.push(root);
    const state: DaemonState = {
      directory: root,
      diagnosticsDirectory: join(root, "diagnostics"),
      runtimeScopeId: testRuntimeScopeId,
      retention: { maxAgeMs: 60_000, maxBytes: 1024 * 1024 },
    };
    const runtime = await openDiagnosticsRuntimeForTest({
      resolveState: async () => state,
      openStore: async () =>
        await openDiagnosticsStore({ directory: state.diagnosticsDirectory }),
      allocateGeneration: async () =>
        v.parse(daemonGenerationSchema, "dedupretry"),
    });
    let rejectFirstTransport = true;
    let releaseRejectedTransport!: () => void;
    const rejectedTransportReleased = new Promise<void>((resolve) => {
      releaseRejectedTransport = resolve;
    });
    let enterRejectedTransport!: () => void;
    const rejectedTransportEntered = new Promise<void>((resolve) => {
      enterRejectedTransport = resolve;
    });
    let enterAcceptedTransport!: () => void;
    const acceptedTransportEntered = new Promise<void>((resolve) => {
      enterAcceptedTransport = resolve;
    });
    let releaseAcceptedTransport!: () => void;
    const acceptedTransportReleased = new Promise<void>((resolve) => {
      releaseAcceptedTransport = resolve;
    });
    let diagnosticsQueryCalls = 0;
    const diagnostics: DiagnosticsRuntime = {
      generation: runtime.generation,
      sessionId: () => runtime.sessionId(),
      async record(input) {
        if (input.kind === "transport_failure" && rejectFirstTransport) {
          rejectFirstTransport = false;
          enterRejectedTransport();
          await rejectedTransportReleased;
          return undefined;
        }
        if (input.kind === "transport_failure") {
          enterAcceptedTransport();
          await acceptedTransportReleased;
        }
        return await runtime.record(input);
      },
      query: (params) => {
        diagnosticsQueryCalls += 1;
        return runtime.query(params);
      },
      health: () => runtime.health(),
      close: () => runtime.close(),
    };
    let accept:
      | ((connection: TransportConnection<ProtocolMessage>) => void)
      | undefined;
    const queryTransport = createInMemoryTransportServer<ProtocolMessage>();
    const transport: TransportServer<ProtocolMessage> = {
      listen: () => queryTransport.listen(),
      close: () => queryTransport.close(),
      onConnection(listener) {
        accept = listener;
        const unsubscribeQueryTransport = queryTransport.onConnection(listener);
        return () => {
          accept = undefined;
          unsubscribeQueryTransport();
        };
      },
    };
    const secretSentinel = ["dedup", "retry", "sentinel"].join("-");
    let listener:
      | ((event: TransportEvent<ProtocolMessage>) => void)
      | undefined;
    const connection: TransportConnection<ProtocolMessage> = {
      send() {
        throw new Error(secretSentinel);
      },
      onEvent(next) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      close() {},
    };
    let queryAccepted!: () => void;
    const acceptedQuery = new Promise<void>((resolve) => {
      queryAccepted = resolve;
    });
    const daemon = createDaemonForTest({
      transport,
      adapters: new Map(),
      identity: { session: () => runtime.sessionId() },
      diagnostics,
      onDiagnosticsQueryAccepted: queryAccepted,
    });
    const running = daemon.start();
    await waitForDaemonLifecycle(runtime);

    try {
      accept?.(connection);
      const receive = listener;
      receive?.({
        kind: "message",
        message: {
          kind: "request",
          requestId: v.parse(requestIdSchema, "dedup-first"),
          method: "initialize",
          params: {
            protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
            consumerContext: "test-consumer",
            runtimeScopeId: testRuntimeScopeId,
          },
        },
      });
      await rejectedTransportEntered;
      receive?.({
        kind: "error",
        error: createTransportError({
          code: "io_error",
          fact: {
            kind: "transport_failure",
            operation: "read",
            reason: "io_error",
          },
        }),
      });
      const client = queryTransport.connect();
      await Promise.resolve();
      await bindConsumer(client);
      const response = new Promise<ProtocolResponse>((resolve) => {
        const unsubscribe = client.onEvent((event) => {
          if (
            event.kind === "message" &&
            event.message.kind === "response" &&
            event.message.requestId === "dedup-query"
          ) {
            unsubscribe();
            resolve(event.message);
          }
        });
      });
      client.send({
        kind: "request",
        requestId: v.parse(requestIdSchema, "dedup-query"),
        method: "diagnostics",
        params: { kinds: ["transport_failure"] },
      });
      await acceptedQuery;
      releaseRejectedTransport();
      await acceptedTransportEntered;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(diagnosticsQueryCalls).toBe(0);
      releaseAcceptedTransport();
      await expect(response).resolves.toMatchObject({
        result: {
          records: [
            {
              kind: "transport_failure",
              operation: "read",
              reason: "io_error",
            },
          ],
          truncated: false,
        },
      });
      const storeText = await readFile(
        join(state.diagnosticsDirectory, "active.ndjson"),
        "utf8",
      );
      expect(storeText.includes(secretSentinel)).toBe(false);
    } finally {
      releaseRejectedTransport();
      releaseAcceptedTransport();
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
      runtimeScopeId: testRuntimeScopeId,
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
        async start() {},
        async deliver() {},
        async interrupt() {},
        resolvePermission() {},
        async terminate() {},
      }),
      modelCatalog: async () => ({ harness: "codex", models: [] }),
    };
    let failed = false;
    const transport = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemonForTest({
      transport,
      adapters: new Map([["codex", adapter]]),
      identity: { session: () => runtime.sessionId() },
      diagnostics: runtime,
      runtimeScopeId: testRuntimeScopeId,
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
    await bindConsumer(client);
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
          sessionLabel: "listener-failure",
          cwd: "/tmp",
          harness: "codex",
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
      runtimeScopeId: testRuntimeScopeId,
      retention: { maxAgeMs: 60_000, maxBytes: 1024 * 1024 },
    };
    let now = new Date("2026-08-20T00:00:00.000Z");
    const runtime = await openDiagnosticsRuntimeForTest({
      resolveState: async () => state,
      openStore: async () =>
        await openDiagnosticsStoreForTest({
          directory: state.diagnosticsDirectory,
          now: () => now,
        }),
      allocateGeneration: async () =>
        v.parse(daemonGenerationSchema, "filters"),
      now: () => now,
    });
    const sessionId = runtime.sessionId();
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
      harness: "codex",
      sessionId,
      turnId,
      kind: "lifecycle",
      operation: "worker",
      reason: "initialized",
    });
    now = new Date("2026-08-20T00:00:02.000Z");
    const failed = await runtime.record({
      source: "adapter",
      harness: "qoder",
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
      identity: { session: () => runtime.sessionId() },
      diagnostics: runtime,
      runtimeScopeId: testRuntimeScopeId,
    });
    const running = daemon.start();
    const client = transport.connect();
    await Promise.resolve();
    await bindConsumer(client);
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
        result: { records: [{ harness: "qoder", severity: "error" }] },
      });
      await expect(
        request({ sessionId, turnId, harness: "codex" }),
      ).resolves.toMatchObject({
        result: { records: [{ harness: "codex", turnId }] },
      });
      await expect(
        request({
          sources: ["adapter"],
          since: "2026-08-20T00:00:01.000Z",
          until: "2026-08-20T00:00:02.000Z",
        }),
      ).resolves.toMatchObject({
        result: { records: [{ harness: "codex" }, { harness: "qoder" }] },
      });
      await expect(
        request({ sources: ["adapter"], limit: 2 }),
      ).resolves.toMatchObject({
        result: {
          records: [{ harness: "codex" }, { harness: "qoder" }],
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

describe("daemon 消费者诊断归属（01 票第 2、3 项）", () => {
  const clock = () => new Date("2026-08-20T00:00:00.000Z");

  async function openScopedRuntime(
    generation: string,
    directory: string,
  ): Promise<DiagnosticsRuntime> {
    return await openDiagnosticsRuntimeForTest({
      resolveState: async (): Promise<DaemonState> => ({
        directory,
        diagnosticsDirectory: join(directory, "diagnostics"),
        runtimeScopeId: testRuntimeScopeId,
        retention: { maxAgeMs: 60_000, maxBytes: 1024 * 1024 },
      }),
      openStore: async (state) =>
        await openDiagnosticsStoreForTest({
          directory: state.diagnosticsDirectory,
          now: clock,
        }),
      allocateGeneration: async () =>
        v.parse(daemonGenerationSchema, generation),
      now: clock,
      stderr: (message) => {
        process.stderr.write(`${message}\n`);
      },
    });
  }

  function scopedDaemon(
    transport: TransportServer<ProtocolMessage>,
    runtime: DiagnosticsRuntime,
  ): { daemon: { stop(): Promise<void> }; running: Promise<void> } {
    const daemon = createDaemonForTest({
      transport,
      adapters: new Map(),
      identity: { session: () => runtime.sessionId() },
      diagnostics: runtime,
      runtimeScopeId: testRuntimeScopeId,
    });
    return { daemon, running: daemon.start() };
  }

  async function request(
    client: TransportConnection<ProtocolMessage>,
    label: string,
    method: ProtocolMethod,
    params: unknown,
  ): Promise<ProtocolResponse> {
    const requestId = v.parse(requestIdSchema, label);
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
      method,
      params:
        method === "initialize" && typeof params === "object" && params !== null
          ? { runtimeScopeId: testRuntimeScopeId, ...params }
          : params,
    } as unknown as ProtocolMessage);
    return await response;
  }

  async function query(
    client: TransportConnection<ProtocolMessage>,
    label: string,
    params: unknown,
  ): Promise<ProtocolResponse> {
    return await request(client, label, "diagnostics", params);
  }

  async function rejectEnvelope(
    client: TransportConnection<ProtocolMessage>,
    label: string,
  ): Promise<void> {
    const requestId = v.parse(requestIdSchema, label);
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
    // 顶层多余键使 envelope 解析失败，daemon 记录 protocol_violation。
    client.send({
      kind: "request",
      requestId,
      method: "send",
      params: { sessionId: "sess-1", message: "ignored" },
      ownershipSentinel: label,
    } as unknown as ProtocolMessage);
    await expect(response).resolves.toMatchObject({
      error: { code: "protocol_error" },
    });
  }

  function recordsOf(response: ProtocolResponse) {
    if (!("result" in response)) {
      throw new Error("Expected diagnostics records response");
    }
    const parsed = v.parse(diagnosticsResultSchema, response.result);
    return "records" in parsed ? parsed.records : [parsed.record];
  }

  async function boundClient(
    transport: ReturnType<
      typeof createInMemoryTransportServer<ProtocolMessage>
    >,
    consumer: string,
  ): Promise<TransportConnection<ProtocolMessage>> {
    const client = transport.connect();
    await Promise.resolve();
    await bindConsumer(client, consumer);
    return client;
  }

  async function waitForRecords(
    client: TransportConnection<ProtocolMessage>,
    label: string,
    params: unknown,
  ): Promise<ProtocolResponse> {
    for (let attempt = 0; attempt !== 20; attempt += 1) {
      const response = await query(
        client,
        `${label}-${String(attempt)}`,
        params,
      );
      if (recordsOf(response).length > 0) return response;
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
    }
    throw new Error("Expected a diagnostic record to be accepted");
  }

  test("他人请求造成的诊断对 beta 不可见且 exact id 视为不存在", async () => {
    const root = await mkdtemp(join(tmpdir(), "reins-daemon-scope-diag-"));
    directories.push(root);
    const runtime = await openScopedRuntime("scopeone", root);
    const transport = createInMemoryTransportServer<ProtocolMessage>();
    const { daemon, running } = scopedDaemon(transport, runtime);
    const alpha = await boundClient(transport, "alpha");
    try {
      await rejectEnvelope(alpha, "alpha-envelope");
      const owned = await query(alpha, "alpha-query", {
        kinds: ["protocol_violation"],
      });
      expect(owned).toMatchObject({
        result: { records: [{ stage: "envelope" }], truncated: false },
      });
      const foreignId = recordsOf(owned)[0]?.diagnosticId;

      const beta = await boundClient(transport, "beta");
      await expect(
        query(beta, "beta-kind-query", { kinds: ["protocol_violation"] }),
      ).resolves.toMatchObject({
        result: { records: [], truncated: false },
      });
      await expect(
        query(beta, "beta-exact-query", { diagnosticId: foreignId }),
      ).resolves.toMatchObject({ error: { code: "diagnostic_not_found" } });
      const betaAll = recordsOf(await query(beta, "beta-list-query", {}));
      expect(betaAll.some((entry) => entry.diagnosticId === foreignId)).toBe(
        false,
      );
      // daemon 全局生命周期事实不属于任何消费者，对所有连接可见。
      expect(
        recordsOf(
          await query(beta, "beta-global-query", { sources: ["daemon"] }),
        )
          .map((entry) => entry.reason)
          .includes("started"),
      ).toBe(true);
      expect(
        recordsOf(await query(alpha, "alpha-list-query", {})).some(
          (entry) => entry.diagnosticId === foreignId,
        ),
      ).toBe(true);
    } finally {
      await daemon.stop();
      await running;
      await runtime.close();
    }
  });

  test("诊断归属写入真实 store 并在 daemon 重启后保持", async () => {
    const root = await mkdtemp(join(tmpdir(), "reins-daemon-scope-restart-"));
    directories.push(root);
    const first = await openScopedRuntime("scopetwo", root);
    const firstTransport = createInMemoryTransportServer<ProtocolMessage>();
    const opened = scopedDaemon(firstTransport, first);
    const alpha = await boundClient(firstTransport, "alpha");
    await rejectEnvelope(alpha, "restart-envelope");
    const foreignId = recordsOf(
      await query(alpha, "restart-own-query", {
        kinds: ["protocol_violation"],
      }),
    )[0]?.diagnosticId;
    await opened.daemon.stop();
    await opened.running;
    await first.close();

    const second = await openScopedRuntime("scopethree", root);
    const secondTransport = createInMemoryTransportServer<ProtocolMessage>();
    const restarted = scopedDaemon(secondTransport, second);
    try {
      const intruder = await boundClient(secondTransport, "beta");
      await expect(
        query(intruder, "restart-foreign-query", {
          kinds: ["protocol_violation"],
        }),
      ).resolves.toMatchObject({
        result: { records: [], truncated: false },
      });
      await expect(
        query(intruder, "restart-foreign-exact", { diagnosticId: foreignId }),
      ).resolves.toMatchObject({ error: { code: "diagnostic_not_found" } });

      const owner = await boundClient(secondTransport, "alpha");
      expect(
        recordsOf(await query(owner, "restart-owner-query", {})).some(
          (entry) => entry.diagnosticId === foreignId,
        ),
      ).toBe(true);
    } finally {
      await restarted.daemon.stop();
      await restarted.running;
      await second.close();
    }
  });

  test("会话在请求栈之外产生的事实继承发起会话的消费者归属", async () => {
    const root = await mkdtemp(join(tmpdir(), "reins-daemon-session-owner-"));
    directories.push(root);
    let emit!: (event: DomainEvent) => void;
    const driverFactory: AdapterDriverFactory = (context) => {
      emit = context.emit;
      return {
        async start() {},
        async deliver() {},
        async interrupt() {},
        resolvePermission() {},
        async terminate() {},
      };
    };
    const runtime = await openScopedRuntime("scopefour", root);
    const transport = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemonForTest({
      transport,
      adapters: new Map([
        [
          "codex",
          {
            driverFactory,
            modelCatalog: async () => ({ harness: "codex", models: [] }),
          },
        ],
      ]),
      identity: { session: () => runtime.sessionId() },
      diagnostics: runtime,
      runtimeScopeId: testRuntimeScopeId,
    });
    const running = daemon.start();
    const alpha = await boundClient(transport, "alpha");
    try {
      const spawned = await request(alpha, "alpha-spawn", "spawn", {
        sessionLabel: "scoped-session",
        harness: "codex",
        message: "start",
        cwd: root,
      });
      if (!("result" in spawned)) {
        throw new Error(`Spawn failed: ${JSON.stringify(spawned)}`);
      }
      const sessionId = v.parse(
        sessionIdSchema,
        (spawned.result as { sessionId: unknown }).sessionId,
      );
      // 事件在 spawn 响应之后到达，不处于任何请求的异步上下文中。
      emit({ type: "session.killed", sessionId });

      const owned = recordsOf(
        await waitForRecords(alpha, "session-owner", {
          kinds: ["protocol_violation"],
          sources: ["core"],
        }),
      );
      expect(owned[0]).toMatchObject({
        sessionId,
        operation: "validate_worker_event",
      });
      const ownedId = owned[0]?.diagnosticId;

      const beta = await boundClient(transport, "beta");
      await expect(
        query(beta, "beta-session-owner", {
          kinds: ["protocol_violation"],
          sources: ["core"],
        }),
      ).resolves.toMatchObject({
        result: { records: [], truncated: false },
      });
      await expect(
        query(beta, "beta-session-exact", { diagnosticId: ownedId }),
      ).resolves.toMatchObject({ error: { code: "diagnostic_not_found" } });
    } finally {
      await daemon.stop();
      await running;
      await runtime.close();
    }
  });

  test("spawn 返回前登记的 harness 事实属于发起请求的消费者", async () => {
    const root = await mkdtemp(join(tmpdir(), "reins-daemon-spawn-owner-"));
    directories.push(root);
    const driverFactory: AdapterDriverFactory = ({ diagnostics }) => ({
      async start(spec) {
        void diagnostics({
          kind: "harness_stderr",
          operation: "worker_process",
          reason: "stderr_output",
          sessionId: spec.sessionId,
          text: { text: "boom", truncated: false, originalBytes: 4 },
        });
        throw new WorkerStartFailure("start failed", "not_accepted");
      },
      async deliver() {},
      async interrupt() {},
      resolvePermission() {},
      async terminate() {},
    });
    const runtime = await openScopedRuntime("scopefive", root);
    const transport = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemonForTest({
      transport,
      adapters: new Map([
        [
          "codex",
          {
            driverFactory,
            modelCatalog: async () => ({ harness: "codex", models: [] }),
          },
        ],
      ]),
      identity: { session: () => runtime.sessionId() },
      diagnostics: runtime,
      runtimeScopeId: testRuntimeScopeId,
    });
    const running = daemon.start();
    const alpha = await boundClient(transport, "alpha");
    try {
      const spawned = await request(alpha, "alpha-failing-spawn", "spawn", {
        sessionLabel: "failing-session",
        harness: "codex",
        message: "start",
        cwd: root,
      });
      expect(spawned).toMatchObject({ error: expect.any(Object) });

      const owned = await waitForRecords(alpha, "spawn-owner", {
        kinds: ["harness_stderr"],
      });
      expect(recordsOf(owned)[0]).toMatchObject({ harness: "codex" });
      const ownedId = recordsOf(owned)[0]?.diagnosticId;

      const beta = await boundClient(transport, "beta");
      await expect(
        query(beta, "beta-spawn-owner", { kinds: ["harness_stderr"] }),
      ).resolves.toMatchObject({
        result: { records: [], truncated: false },
      });
      await expect(
        query(beta, "beta-spawn-exact", { diagnosticId: ownedId }),
      ).resolves.toMatchObject({ error: { code: "diagnostic_not_found" } });
    } finally {
      await daemon.stop();
      await running;
      await runtime.close();
    }
  });
});
