import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openControlStore } from "@reins/event-journal";
import {
  operationKeyClaimsSchema,
  requestIdSchema,
  REINS_PROTOCOL_MAJOR_VERSION,
  serializeOperationKey,
  type HarnessId,
  type OperationKey,
  type ProtocolMessage,
  type ProtocolResponse,
  type RequestId,
  type RuntimeScopeId,
  type SessionId,
  type WorkerDriver,
  WorkerStartFailure,
} from "@reins/protocol";
import {
  createInMemoryTransportServer,
  type TransportConnection,
} from "@reins/transport";
import * as v from "valibot";
import { afterEach, describe, expect, test } from "vitest";

import { createDaemon, type Daemon } from "../../src/daemon.ts";
import { openDiagnosticsRuntimeForTest } from "../../src/diagnostics-recorder.testing.ts";
import type { DiagnosticsRuntime } from "../../src/diagnostics-recorder.ts";
import { openDiagnosticsStoreForTest } from "../../src/diagnostics-store.testing.ts";
import { openDiagnosticsStore } from "../../src/diagnostics-store.ts";
import { daemonGenerationSchema } from "../../src/generation.ts";
import type { HarnessAdapter } from "../../src/registry.ts";
import { resolveDaemonState, type DaemonState } from "../../src/state.ts";

type TestConnection = TransportConnection<ProtocolMessage>;

const directories: string[] = [];
const runningDaemons: Array<{
  connection: TestConnection;
  daemon: Daemon;
  diagnostics: DiagnosticsRuntime;
  started: Promise<void>;
}> = [];

afterEach(async () => {
  for (const running of runningDaemons.splice(0)) {
    running.connection.close();
    await running.daemon.stop();
    await running.started.catch(() => undefined);
    await running.diagnostics.close();
  }
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const consumerContext = "same-consumer";

async function stateForTest(): Promise<DaemonState> {
  const directory = await mkdtemp(
    join(tmpdir(), "reins-operation-diagnostic-"),
  );
  directories.push(directory);
  return await resolveDaemonState({ env: { REINS_STATE_DIR: directory } });
}

async function openRuntime(
  state: DaemonState,
  generation: string,
  failAppend?: () => Error | undefined,
): Promise<DiagnosticsRuntime> {
  return await openDiagnosticsRuntimeForTest({
    resolveState: async () => state,
    openStore: async (resolvedState) => {
      const options = {
        directory: resolvedState.diagnosticsDirectory,
        runtimeScopeId: resolvedState.runtimeScopeId,
        ...(failAppend === undefined ? {} : { failAppend, stderr: () => {} }),
      };
      return failAppend === undefined
        ? await openDiagnosticsStore(options)
        : await openDiagnosticsStoreForTest(options);
    },
    allocateGeneration: async () => v.parse(daemonGenerationSchema, generation),
  });
}

async function startDaemonWithStores(
  state: DaemonState,
  diagnostics: DiagnosticsRuntime,
): Promise<{
  connection: TestConnection;
  daemon: Daemon;
  started: Promise<void>;
}> {
  const attempts = new Map<SessionId, number>();
  const driver: WorkerDriver = {
    async start() {
      throw new WorkerStartFailure("原生队列回执丢失", "unknown");
    },
    async deliver() {},
    async interrupt() {},
    resolvePermission() {},
    async terminate(sessionId) {
      const attempt = (attempts.get(sessionId) ?? 0) + 1;
      attempts.set(sessionId, attempt);
      if (attempt === 1) throw new Error("原生关闭确认失败");
    },
  };
  const adapter: HarnessAdapter = {
    driverFactory: () => driver,
    async modelCatalog() {
      return { harness: "codex", models: [] };
    },
  };
  const transport = createInMemoryTransportServer<ProtocolMessage>();
  const daemon = createDaemon({
    transport,
    adapters: new Map<HarnessId, HarnessAdapter>([["codex", adapter]]),
    identity: { session: () => diagnostics.sessionId() },
    diagnostics,
    runtimeScopeId: state.runtimeScopeId,
    controlStore: await openControlStore({
      directory: join(state.directory, "control"),
    }),
    idleTimeoutMs: 60_000,
  });
  const started = daemon.start();
  const connection = transport.connect();
  const running = { connection, daemon, diagnostics, started };
  runningDaemons.push(running);
  return { connection, daemon, started };
}

let requestCounter = 0;

function exchange(
  connection: TestConnection,
  request: Extract<ProtocolMessage, { kind: "request" }>,
): Promise<ProtocolResponse> {
  return new Promise<ProtocolResponse>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`协议请求超时：${request.method}`));
    }, 2_000);
    const unsubscribe = connection.onEvent((event) => {
      if (event.kind !== "message") return;
      const message = event.message;
      if (
        message.kind !== "response" ||
        message.requestId !== request.requestId
      )
        return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(message);
    });
    connection.send(request);
  });
}

async function initializedConnection(
  connection: TestConnection,
  state: DaemonState,
): Promise<{ generation: string; runtimeScopeId: RuntimeScopeId }> {
  requestCounter += 1;
  const requestId = v.parse(requestIdSchema, `initialize-${requestCounter}`);
  const response = await exchange(connection, {
    kind: "request",
    requestId,
    method: "initialize",
    params: {
      protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
      consumerContext,
    },
  });
  if (!("result" in response)) throw new Error("initialize handshake failed");
  const result = response.result as {
    daemonGeneration: string;
    runtimeScopeId: RuntimeScopeId;
  };
  expect(result.runtimeScopeId).toBe(state.runtimeScopeId);
  return {
    generation: result.daemonGeneration,
    runtimeScopeId: result.runtimeScopeId,
  };
}

function operationKey(
  claims: { generation: string; runtimeScopeId: RuntimeScopeId },
  nonce: string,
): OperationKey<"spawn"> {
  const parsed = v.parse(operationKeyClaimsSchema, {
    runtimeScopeId: claims.runtimeScopeId,
    consumer: consumerContext,
    kind: "spawn",
    generation: claims.generation,
    nonce,
  });
  return serializeOperationKey({ ...parsed, kind: "spawn" });
}

function nextRequestId(): RequestId {
  requestCounter += 1;
  return v.parse(requestIdSchema, `request-${requestCounter}`);
}

function diagnosticIdFromError(response: ProtocolResponse): string | undefined {
  if (!("error" in response)) return undefined;
  const error: unknown = response.error;
  if (
    typeof error !== "object" ||
    error === null ||
    !("diagnosticId" in error) ||
    typeof error.diagnosticId !== "string"
  )
    return undefined;
  return error.diagnosticId;
}

function diagnosticIdFromRecord(
  response: ProtocolResponse,
): string | undefined {
  if (!("result" in response)) return undefined;
  const result: unknown = response.result;
  if (
    typeof result !== "object" ||
    result === null ||
    !("status" in result && result.status === "outcome_unknown") ||
    !("diagnosticId" in result) ||
    typeof result.diagnosticId !== "string"
  )
    return undefined;
  return result.diagnosticId;
}

describe("未知 spawn 操作的诊断关联", () => {
  test("操作保留可查询主诊断，重启后引用仍有效", async () => {
    const state = await stateForTest();
    const firstRuntime = await openRuntime(state, "first");
    const firstDaemon = await startDaemonWithStores(state, firstRuntime);
    const firstHandshake = await initializedConnection(
      firstDaemon.connection,
      state,
    );
    const key = operationKey(
      firstHandshake,
      "00000000-0000-4000-8000-000000000101",
    );
    const failure = await exchange(firstDaemon.connection, {
      kind: "request",
      requestId: nextRequestId(),
      method: "spawn",
      operationKey: key,
      params: { harness: "codex", cwd: "/tmp", message: "unknown" },
    });
    expect(failure).toMatchObject({
      error: {
        code: "operation_outcome_unknown",
        cause: { message: "原生队列回执丢失" },
        cleanupCause: { message: "原生关闭确认失败" },
      },
    });
    const diagnosticId = diagnosticIdFromError(failure);
    expect(diagnosticId).toBeDefined();

    const operation = await exchange(firstDaemon.connection, {
      kind: "request",
      requestId: nextRequestId(),
      method: "getOperation",
      params: { operationKey: key },
    });
    expect(diagnosticIdFromRecord(operation)).toBe(diagnosticId);
    expect(operation).toMatchObject({
      result: {
        status: "outcome_unknown",
        operationKey: key,
        cause: { message: "原生队列回执丢失" },
        cleanupCause: { message: "原生关闭确认失败" },
      },
    });
    const queried = await exchange(firstDaemon.connection, {
      kind: "request",
      requestId: nextRequestId(),
      method: "diagnostics",
      params: { diagnosticId },
    });
    expect(queried).toMatchObject({ result: { record: { diagnosticId } } });

    firstDaemon.connection.close();
    await firstDaemon.daemon.stop();
    await firstDaemon.started;
    await firstRuntime.close();
    runningDaemons.splice(
      runningDaemons.findIndex(
        (running) => running.daemon === firstDaemon.daemon,
      ),
      1,
    );

    const secondRuntime = await openRuntime(state, "second");
    const secondDaemon = await startDaemonWithStores(state, secondRuntime);
    const secondHandshake = await initializedConnection(
      secondDaemon.connection,
      state,
    );
    expect(secondHandshake.generation).toBe("second");
    const restoredOperation = await exchange(secondDaemon.connection, {
      kind: "request",
      requestId: nextRequestId(),
      method: "getOperation",
      params: { operationKey: key },
    });
    expect(diagnosticIdFromRecord(restoredOperation)).toBe(diagnosticId);
    const restoredDiagnostic = await exchange(secondDaemon.connection, {
      kind: "request",
      requestId: nextRequestId(),
      method: "diagnostics",
      params: { diagnosticId },
    });
    expect(restoredDiagnostic).toMatchObject({
      result: { record: { diagnosticId } },
    });
  }, 30_000);

  test("诊断未成功持久时只保留原失败和停止失败，不伪造引用", async () => {
    const state = await stateForTest();
    let failAppend = false;
    const runtime = await openRuntime(state, "failedwrite", () =>
      failAppend ? new Error("诊断写入失败") : undefined,
    );
    const running = await startDaemonWithStores(state, runtime);
    const handshake = await initializedConnection(running.connection, state);
    failAppend = true;
    const key = operationKey(handshake, "00000000-0000-4000-8000-000000000201");
    const failure = await exchange(running.connection, {
      kind: "request",
      requestId: nextRequestId(),
      method: "spawn",
      operationKey: key,
      params: { harness: "codex", cwd: "/tmp", message: "unknown" },
    });
    expect(failure).toMatchObject({
      error: {
        code: "operation_outcome_unknown",
        cause: { message: "原生队列回执丢失" },
        cleanupCause: { message: "原生关闭确认失败" },
      },
    });
    expect(diagnosticIdFromError(failure)).toBeUndefined();
    const queried = await exchange(running.connection, {
      kind: "request",
      requestId: nextRequestId(),
      method: "getOperation",
      params: { operationKey: key },
    });
    expect(diagnosticIdFromRecord(queried)).toBeUndefined();
    expect(queried).toMatchObject({
      result: {
        status: "outcome_unknown",
        cause: { message: "原生队列回执丢失" },
        cleanupCause: { message: "原生关闭确认失败" },
      },
    });
  }, 30_000);
});
