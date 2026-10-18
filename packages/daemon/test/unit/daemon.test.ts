import { randomUUID } from "node:crypto";

import {
  AlreadyDiagnosedError,
  HarnessModelCatalogFailure,
} from "@reins/adapter-kit";
import { createSessionMachine } from "@reins/core";
import {
  createInMemoryControlStore,
  type ControlStore,
} from "@reins/event-journal";
import type {
  DomainEvent,
  ModelCatalogResult,
  HarnessId,
  HarnessModelCatalog,
  PermissionOption,
  PermissionId,
  RequestId,
  PermissionResolution,
  ProtocolMessage,
  ProtocolMethod,
  ProtocolResponse,
  RuntimeScopeId,
  StopReason,
  SessionId,
  SpawnParams,
  TurnId,
  MessageId,
  ToolCallId,
  WorkerDriver,
  AdapterDriverFactory,
  AutonomousTurnCause,
  WorkerSpec,
} from "@reins/protocol";
import {
  isSideEffectMethod,
  encodeResumeCursor,
  attachResultSchema,
  operationKeyClaimsSchema,
  parseOperationKey,
  serializeOperationKey,
  initializeResultSchema,
  machineErrorSchema,
  makeDiagnosticId,
  REINS_PROTOCOL_MAJOR_VERSION,
  runtimeScopeIdSchema,
  sessionIdSchema,
  consumerContextSchema,
  spawnParamsSchema,
  WorkerDeliveryFailure,
  WorkerStartFailure,
} from "@reins/protocol";
import {
  createInMemoryTransportServer,
  type TransportConnection,
} from "@reins/transport";
import * as v from "valibot";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createDaemonForTest } from "../../src/daemon.testing.ts";
import type { Daemon } from "../../src/daemon.ts";
import type { DiagnosticsRuntime } from "../../src/diagnostics-recorder.ts";
import {
  createDaemonIdFactory,
  daemonGenerationSchema,
} from "../../src/generation.ts";
import {
  createDaemon,
  createProtocolServer,
  createRoutingDriverFactory,
} from "../../src/index.ts";
import type { AdapterRegistry, HarnessAdapter } from "../../src/registry.ts";

type PublicProtocolServerOptions = Parameters<typeof createProtocolServer>[0];
type PublicProtocolServerHasAttachReplayHook =
  "beforeAttachReplay" extends keyof PublicProtocolServerOptions ? true : false;
const publicProtocolServerHasAttachReplayHook: PublicProtocolServerHasAttachReplayHook = false;

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("等待条件超时");
    }
    await flush();
  }
}

const daemons: Daemon[] = [];
const testRuntimeScopeId: RuntimeScopeId = v.parse(
  runtimeScopeIdSchema,
  "00000000-0000-4000-8000-000000000000",
);
const testSessionIdPattern = new RegExp(
  `^session:${testRuntimeScopeId}:test:\\d+$`,
  "u",
);

let sessionCounter = 0;
const testIdentity = {
  session: () => {
    sessionCounter += 1;
    return v.parse(
      sessionIdSchema,
      `session:${testRuntimeScopeId}:test:${sessionCounter}`,
    );
  },
};

const testDiagnostics: DiagnosticsRuntime = {
  generation: v.parse(daemonGenerationSchema, "test"),
  sessionId: testIdentity.session,
  async record(input) {
    return input.kind === "lifecycle" && input.operation === "daemon"
      ? makeDiagnosticId(testRuntimeScopeId, "test", "1")
      : undefined;
  },
  async query() {
    return { records: [], truncated: false };
  },
  health() {
    return { status: "healthy", repairs: [] };
  },
  async close() {},
};

afterEach(async () => {
  for (const daemon of daemons.splice(0)) {
    await daemon.stop();
  }
});

function startDaemon(
  adapters: AdapterRegistry,
  options?: {
    idleTimeoutMs?: number;
    identity?: { session(): SessionId };
    runtimeScopeId?: RuntimeScopeId;
    beforeAttachReplay?: (sessionId: SessionId) => void;
    onEvent?: (event: DomainEvent) => void;
    assertWriterLease?: () => Promise<void>;
  },
): {
  server: ReturnType<typeof createInMemoryTransportServer<ProtocolMessage>>;
  daemon: Daemon;
} {
  const server = createInMemoryTransportServer<ProtocolMessage>();
  const daemon = createDaemonForTest({
    transport: server,
    adapters,
    identity: options?.identity ?? testIdentity,
    diagnostics: testDiagnostics,
    runtimeScopeId: options?.runtimeScopeId ?? testRuntimeScopeId,
    idleTimeoutMs: options?.idleTimeoutMs ?? 60_000,
    ...(options?.beforeAttachReplay === undefined
      ? {}
      : { beforeAttachReplay: options.beforeAttachReplay }),
    ...(options?.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    ...(options?.assertWriterLease === undefined
      ? {}
      : { assertWriterLease: options.assertWriterLease }),
  });
  daemons.push(daemon);
  void daemon.start();
  return { server, daemon };
}

type Requester = {
  (
    method: ProtocolMethod,
    params: unknown,
    timeoutMs?: number,
  ): Promise<ProtocolResponse>;
  request(
    method: ProtocolMethod,
    params: unknown,
    timeoutMs?: number,
  ): Promise<ProtocolResponse>;
};

const operationContexts = new WeakMap<
  TransportConnection<ProtocolMessage>,
  {
    generation: string;
    consumerContext: string;
    runtimeScopeId: RuntimeScopeId;
  }
>();

function testOperationKey(
  client: TransportConnection<ProtocolMessage>,
  method: ProtocolMethod,
  nonce: string = randomUUID(),
): string {
  const context = operationContexts.get(client);
  if (context === undefined || !isSideEffectMethod(method))
    throw new Error("OperationKey requires an initialized consumer connection");
  return serializeOperationKey(
    v.parse(operationKeyClaimsSchema, {
      runtimeScopeId: context.runtimeScopeId,
      consumer: context.consumerContext,
      kind: method,
      generation: context.generation,
      nonce,
    }),
  );
}

function makeRequester(
  client: TransportConnection<ProtocolMessage>,
  consumerContext = "test-consumer",
  runtimeScopeId = testRuntimeScopeId,
): Requester {
  let seq = 0;
  let handshake: Promise<ProtocolResponse> | undefined;
  const request = (
    method: ProtocolMethod,
    params: unknown,
    timeoutMs = 2000,
  ): Promise<ProtocolResponse> => {
    seq += 1;
    const requestId = `r${seq}` as RequestId;
    const send = (): Promise<ProtocolResponse> =>
      new Promise<ProtocolResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          unsubscribe();
          reject(new Error(`请求超时: ${method}`));
        }, timeoutMs);
        const unsubscribe = client.onEvent((event) => {
          if (event.kind !== "message") return;
          const message = event.message;
          if (message.kind === "response" && message.requestId === requestId) {
            clearTimeout(timer);
            unsubscribe();
            if (method === "initialize" && "result" in message) {
              const initialized = v.parse(
                initializeResultSchema,
                message.result,
              );
              const requested = params as {
                consumerContext?: unknown;
              };
              operationContexts.set(client, {
                generation: initialized.daemonGeneration,
                consumerContext: String(requested.consumerContext),
                runtimeScopeId: initialized.runtimeScopeId,
              });
            }
            resolve(message);
          }
        });
        client.send({
          kind: "request",
          requestId,
          method,
          params:
            method === "spawn" && typeof params === "object" && params !== null
              ? { cwd: "/tmp", ...params }
              : method === "initialize" &&
                  typeof params === "object" &&
                  params !== null
                ? { runtimeScopeId, ...params }
                : params,
          ...(isSideEffectMethod(method)
            ? { operationKey: testOperationKey(client, method) as never }
            : {}),
        });
      });
    if (method === "initialize") return send();
    // 领域动作前自动完成一次 initialize 握手（同连接幂等）。
    handshake ??= request("initialize", {
      protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
      consumerContext,
      runtimeScopeId,
    });
    return handshake.then(() => send());
  };
  const requester = request as Requester;
  requester.request = request;
  return requester;
}

function sendRaw(
  client: TransportConnection<ProtocolMessage>,
  message: unknown,
): Promise<ProtocolResponse> {
  const raw = message as { requestId?: unknown };
  const requestId =
    typeof raw?.requestId === "string" ? raw.requestId : `raw${Math.random()}`;
  return new Promise<ProtocolResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("原始请求超时"));
    }, 2000);
    const unsubscribe = client.onEvent((event) => {
      if (event.kind !== "message") return;
      const candidate = event.message;
      if (candidate.kind === "response" && candidate.requestId === requestId) {
        clearTimeout(timer);
        unsubscribe();
        resolve(candidate);
      }
    });
    const request = message as Record<string, unknown>;
    const testOperationId = request.testOperationId;
    if (
      typeof testOperationId === "string" &&
      typeof request.method === "string" &&
      isSideEffectMethod(request.method)
    ) {
      const { testOperationId: _testOperationId, ...wireRequest } = request;
      client.send({
        ...wireRequest,
        operationKey: testOperationKey(client, request.method, testOperationId),
      } as ProtocolMessage);
      return;
    }
    client.send(message as ProtocolMessage);
  });
}

function resultOf(response: ProtocolResponse): unknown {
  if ("result" in response) return response.result;
  throw new Error(`响应错误: ${JSON.stringify(response.error)}`);
}

function collectNotifications(client: TransportConnection<ProtocolMessage>): {
  events: DomainEvent[];
  ended: Array<{ sessionId: string; reason: string }>;
} {
  const events: DomainEvent[] = [];
  const ended: Array<{ sessionId: string; reason: string }> = [];
  client.onEvent((event) => {
    if (event.kind !== "message") return;
    const message = event.message;
    if (message.kind !== "notification") return;
    if (message.method === "event") {
      events.push(message.params.event);
    } else if (message.method === "attach.ended") {
      ended.push({
        sessionId: message.params.sessionId,
        reason: message.params.reason,
      });
    }
  });
  return { events, ended };
}

type FakeCalls = {
  factoryCalls: number;
  starts: number;
  specs: WorkerSpec[];
  delivered: Array<{ sessionId: string; turnId: string; message: string }>;
  interrupted: string[];
  resolved: PermissionResolution[];
  terminated: string[];
};

function createFakeHarness(options: {
  harness: HarnessId;
  modelCatalog: HarnessModelCatalog;
  autoPermission?: { options: PermissionOption[] };
  canCaptureHarnessStderr?: boolean;
  terminate?: (sessionId: SessionId) => Promise<void>;
  deliver?: (
    sessionId: SessionId,
    turnId: TurnId,
    message: string,
  ) => Promise<void>;
}): {
  adapter: HarnessAdapter;
  calls: FakeCalls;
  controls: {
    completeTurn(stopReason?: StopReason, finalReply?: string | null): void;
    beginAutonomousTurn(cause?: AutonomousTurnCause): Promise<TurnId>;
    emitWorkerMessage(content: string): void;
    emitText(messageId: MessageId, delta: string): void;
    emitToolRequest(toolCallId: ToolCallId, name: string): void;
    emitSnapshot(messageId: MessageId, content: string): void;
  };
} {
  const calls: FakeCalls = {
    factoryCalls: 0,
    starts: 0,
    specs: [],
    delivered: [],
    interrupted: [],
    resolved: [],
    terminated: [],
  };
  let emitEvent: ((event: DomainEvent) => void) | null = null;
  let beginAutonomousTurn:
    | ((cause?: AutonomousTurnCause) => Promise<TurnId>)
    | null = null;
  let current: { sessionId: SessionId; turnId: TurnId } | null = null;
  let permissionSeq = 0;
  let messageSeq = 0;

  const driver: WorkerDriver = {
    async start(spec) {
      calls.starts += 1;
      calls.specs.push(spec);
      current = { sessionId: spec.sessionId, turnId: spec.turnId };
      if (options.autoPermission !== undefined) {
        permissionSeq += 1;
        emitEvent?.({
          type: "permission.requested",
          sessionId: spec.sessionId,
          turnId: spec.turnId,
          permissionId: `p${permissionSeq}` as PermissionId,
          kind: "tool:Bash",
          input: { command: "echo hi" },
          options: options.autoPermission.options,
        });
      }
    },
    async deliver(sessionId, turnId, message) {
      current = { sessionId, turnId };
      calls.delivered.push({ sessionId, turnId, message });
      await options.deliver?.(sessionId, turnId, message);
    },
    async interrupt(sessionId) {
      calls.interrupted.push(sessionId);
    },
    resolvePermission(sessionId, permissionId, resolution) {
      void sessionId;
      void permissionId;
      calls.resolved.push(resolution);
    },
    async terminate(sessionId) {
      calls.terminated.push(sessionId);
      await options.terminate?.(sessionId);
    },
  };

  const adapter: HarnessAdapter = {
    driverFactory: ((context) => {
      calls.factoryCalls += 1;
      emitEvent = context.emit;
      beginAutonomousTurn = context.beginAutonomousTurn ?? null;
      return driver;
    }) satisfies AdapterDriverFactory,
    async modelCatalog() {
      return options.modelCatalog;
    },
    ...(options.canCaptureHarnessStderr === undefined
      ? {}
      : { canCaptureHarnessStderr: options.canCaptureHarnessStderr }),
  };

  return {
    adapter,
    calls,
    controls: {
      async beginAutonomousTurn(cause) {
        if (beginAutonomousTurn === null)
          throw new Error("worker 尚未注册自主回合入口");
        return beginAutonomousTurn(cause);
      },
      completeTurn(
        stopReason: StopReason = "end_turn",
        finalReply: string | null = "done",
      ) {
        if (current === null) throw new Error("没有进行中的回合");
        emitEvent?.({
          type: "turn.completed",
          sessionId: current.sessionId,
          turnId: current.turnId,
          ...(stopReason === "failed"
            ? {
                stopReason,
                failure: {
                  failureCategory: "unclassified" as const,
                  retryDisposition: "unknown" as const,
                },
              }
            : { stopReason }),
          finalReply,
        });
      },
      emitWorkerMessage(content: string) {
        if (current === null) throw new Error("没有进行中的回合");
        messageSeq += 1;
        emitEvent?.({
          type: "message",
          sessionId: current.sessionId,
          turnId: current.turnId,
          messageId: `w${messageSeq}` as MessageId,
          role: "worker",
          content,
        });
      },
      emitText(messageId, delta) {
        if (current === null) throw new Error("没有进行中的回合");
        emitEvent?.({
          type: "text.delta",
          sessionId: current.sessionId,
          turnId: current.turnId,
          messageId,
          delta,
        });
      },
      emitToolRequest(toolCallId, name) {
        if (current === null) throw new Error("没有进行中的回合");
        emitEvent?.({
          type: "tool.requested",
          sessionId: current.sessionId,
          turnId: current.turnId,
          toolCallId,
          name,
        });
      },
      emitSnapshot(messageId, content) {
        if (current === null) throw new Error("没有进行中的回合");
        emitEvent?.({
          type: "message",
          sessionId: current.sessionId,
          turnId: current.turnId,
          messageId,
          role: "worker",
          content,
        });
      },
    },
  };
}

function emptyModelCatalog(harness: HarnessId): HarnessModelCatalog {
  return { harness, models: [] };
}

describe("daemon 公共接口", () => {
  test("公开 protocol server 不接受或执行 attach replay 测试 hook", async () => {
    expect(publicProtocolServerHasAttachReplayHook).toBe(false);
    const transport = createInMemoryTransportServer<ProtocolMessage>();
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const adapters = new Map<HarnessId, HarnessAdapter>([
      ["codex", fake.adapter],
    ]);
    const machine = createSessionMachine({
      driverFactory: createRoutingDriverFactory(adapters, testDiagnostics),
      identity: testIdentity,
      diagnostics: {
        async record(input) {
          return await testDiagnostics.record({ ...input, source: "core" });
        },
      },
    });
    let replayHookCalls = 0;
    const runtimeOptions = {
      transport,
      machine,
      adapters,
      diagnostics: testDiagnostics,
      runtimeScopeId: testRuntimeScopeId,
      idleTimeoutMs: 60_000,
      beforeAttachReplay: () => {
        replayHookCalls += 1;
      },
    };
    const protocolServer = createProtocolServer(runtimeOptions);
    const running = protocolServer.start();
    await flush();
    const client = transport.connect();
    await flush();
    const requester = makeRequester(client);
    let sessionId: SessionId | undefined;
    try {
      sessionId = (
        resultOf(
          await requester.request("spawn", {
            sessionLabel: "public-interface",
            harness: "codex",
            message: "hello",
          }),
        ) as { sessionId: SessionId }
      ).sessionId;
      await expect(
        requester.request("attach", {
          scope: "session",
          sessionId,
          start: { mode: "snapshot" },
        }),
      ).resolves.toMatchObject({ result: { initial: { mode: "snapshot" } } });
      expect(machine.list({ sessionId })).toHaveLength(1);
      expect(replayHookCalls).toBe(0);
    } finally {
      if (sessionId !== undefined) await machine.kill({ sessionId });
      await protocolServer.stop();
      await running;
    }
  });
});

describe("daemon 协议面（缝 C）", () => {
  test("模型目录诊断接受挂起仍返回部分结果，后续有限查询不被堵住", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const server = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport: server,
      adapters: new Map([
        ["codex", fake.adapter],
        [
          "qoder",
          {
            ...fake.adapter,
            async modelCatalog() {
              throw new Error("private native quota text");
            },
          },
        ],
      ]),
      identity: testIdentity,
      diagnostics: {
        ...testDiagnostics,
        record(input) {
          return input.kind === "request_failure" &&
            input.operation === "model_catalog"
            ? new Promise(() => {})
            : testDiagnostics.record(input);
        },
      },
      runtimeScopeId: testRuntimeScopeId,
    });
    daemons.push(daemon);
    void daemon.start();
    const client = server.connect();
    const requester = makeRequester(client);
    const response = await requester.request("modelCatalog", {});
    expect(resultOf(response)).toMatchObject({
      catalogs: [{ harness: "codex" }],
      failures: [
        {
          harness: "qoder",
          failure: {
            failureCategory: "unclassified",
            retryDisposition: "unknown",
          },
        },
      ],
    });
    expect(
      (resultOf(response) as ModelCatalogResult).failures[0],
    ).not.toHaveProperty("diagnosticId");
    expect(
      resultOf(await requester.request("diagnostics", { limit: 1 })),
    ).toEqual({ records: [], truncated: false });
  });
  test("initialize 握手交换协议主版本与 daemon 世代并绑定消费者", async () => {
    const { server } = startDaemon(new Map());
    const client = server.connect();
    await flush();
    const response = await makeRequester(client).request("initialize", {
      protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
      consumerContext: "alpha",
    });
    expect(response).toEqual({
      kind: "response",
      requestId: "r1",
      result: {
        protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
        daemonGeneration: "test",
        runtimeScopeId: testRuntimeScopeId,
      },
    });
  });

  test("协议主版本不匹配返回 protocol_version_mismatch 类型化错误", async () => {
    const { server } = startDaemon(new Map());
    const client = server.connect();
    await flush();
    const response = await makeRequester(client).request("initialize", {
      protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION - 1,
      consumerContext: "alpha",
    });
    expect(response).toMatchObject({
      kind: "response",
      requestId: "r1",
      error: {
        code: "protocol_version_mismatch",
        requestedProtocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION - 1,
        supportedProtocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
      },
    });
  });

  test("initialize 拒绝世代相同但运行作用域不同的连接", async () => {
    const { server } = startDaemon(new Map());
    const client = server.connect();
    const requester = makeRequester(client);
    const requestedRuntimeScopeId = v.parse(
      runtimeScopeIdSchema,
      "00000000-0000-4000-8000-000000000001",
    );

    await expect(
      requester.request("initialize", {
        protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
        consumerContext: "test-consumer",
        runtimeScopeId: requestedRuntimeScopeId,
      }),
    ).resolves.toMatchObject({
      error: {
        code: "runtime_scope_mismatch",
        requestedRuntimeScopeId,
        actualRuntimeScopeId: testRuntimeScopeId,
      },
    });
    await expect(
      requester.request("initialize", {
        protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
        consumerContext: "test-consumer",
        runtimeScopeId: testRuntimeScopeId,
      }),
    ).resolves.toMatchObject({
      result: { daemonGeneration: "test", runtimeScopeId: testRuntimeScopeId },
    });
    client.close();
  });

  test("不同运行作用域即使世代和消费者相同也不能互控会话", async () => {
    const generation = v.parse(daemonGenerationSchema, "test");
    const scopeA = testRuntimeScopeId;
    const scopeB = v.parse(
      runtimeScopeIdSchema,
      "00000000-0000-4000-8000-000000000001",
    );
    const fakeA = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const fakeB = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const daemonA = startDaemon(new Map([["codex", fakeA.adapter]]), {
      identity: createDaemonIdFactory(generation, scopeA),
      runtimeScopeId: scopeA,
    });
    const daemonB = startDaemon(new Map([["codex", fakeB.adapter]]), {
      identity: createDaemonIdFactory(generation, scopeB),
      runtimeScopeId: scopeB,
    });
    const requesterA = makeRequester(
      daemonA.server.connect(),
      "same-consumer",
      scopeA,
    );
    const requesterB = makeRequester(
      daemonB.server.connect(),
      "same-consumer",
      scopeB,
    );
    const spawnedA = resultOf(
      await requesterA("spawn", {
        harness: "codex",
        cwd: "/tmp",
        sessionLabel: "scope-a",
        message: "belongs to scope A",
      }),
    ) as { sessionId: SessionId };
    const spawnedB = resultOf(
      await requesterB("spawn", {
        harness: "codex",
        cwd: "/tmp",
        sessionLabel: "scope-b",
        message: "belongs to scope B",
      }),
    ) as { sessionId: SessionId };
    expect(spawnedB.sessionId).not.toBe(spawnedA.sessionId);

    const crossScopeKill = resultOf(
      await requesterB("kill", { sessionId: spawnedA.sessionId }),
    );

    expect(crossScopeKill).toEqual({
      sessionId: spawnedA.sessionId,
      status: "not_found",
    });
    expect(fakeB.calls.terminated).toEqual([]);
    expect(fakeB.calls.delivered).toEqual([]);
    expect(fakeB.calls.interrupted).toEqual([]);
  });

  test("initialize 缺少消费者上下文按参数校验拒绝，不采用默认绑定", async () => {
    const { server } = startDaemon(new Map());
    const client = server.connect();
    await flush();
    const response = await makeRequester(client).request("initialize", {
      protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
    });
    expect(response).toMatchObject({
      kind: "response",
      error: { code: "invalid_params" },
    });
  });

  test("未绑定消费者的连接在领域动作触达领域前被拒绝", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const { server } = startDaemon(new Map([["codex", fake.adapter]]));
    const client = server.connect();
    await flush();
    const response = await sendRaw(client, {
      kind: "request",
      requestId: "raw1",
      method: "spawn",
      params: {
        sessionLabel: "reviewer",
        harness: "codex",
        message: "hello",
        cwd: "/tmp",
      },
    });
    expect(response).toMatchObject({
      kind: "response",
      requestId: "raw1",
      error: { code: "protocol_error" },
    });
    expect(fake.calls.starts).toBe(0);
  });

  test("版本不匹配失败后连接仍未绑定，领域动作继续被拒绝", async () => {
    const { server } = startDaemon(new Map());
    const client = server.connect();
    await flush();
    await makeRequester(client).request("initialize", {
      protocolMajorVersion: 99,
      consumerContext: "alpha",
    });
    const response = await sendRaw(client, {
      kind: "request",
      requestId: "raw1",
      method: "list",
      params: {},
    });
    expect(response).toMatchObject({
      kind: "response",
      requestId: "raw1",
      error: { code: "protocol_error" },
    });
  });

  test("重复握手更换消费者被拒绝，同消费者握手幂等", async () => {
    const { server } = startDaemon(new Map());
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);
    await requester.request("initialize", {
      protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
      consumerContext: "alpha",
    });
    const conflicting = await requester.request("initialize", {
      protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
      consumerContext: "beta",
    });
    expect(conflicting).toMatchObject({
      kind: "response",
      error: { code: "protocol_error" },
    });
    const idempotent = await requester.request("initialize", {
      protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
      consumerContext: "alpha",
    });
    expect(idempotent).toMatchObject({
      kind: "response",
      result: {
        protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
        daemonGeneration: "test",
        runtimeScopeId: testRuntimeScopeId,
      },
    });
  });

  test("spawn 返回 sessionId，attach 回放历史事件并在 exitOn 命中时结束", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const { server } = startDaemon(new Map([["codex", fake.adapter]]));
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);

    const spawned = await requester("spawn", {
      sessionLabel: "reviewer",
      harness: "codex",
      message: "hello",
    });
    const sessionId = (resultOf(spawned) as { sessionId: string }).sessionId;
    expect(sessionId).toMatch(testSessionIdPattern);
    fake.controls.completeTurn("end_turn", "ok");

    const collector = collectNotifications(client);
    const attached = await requester("attach", {
      scope: "turn",
      sessionId,
      turnId: "t1",
      start: { mode: "history" },
    });
    expect(attached).toMatchObject({
      kind: "response",
      result: { initial: { mode: "history", replayed: 3 } },
    });
    expect(collector.events.map((event) => event.type)).toEqual([
      "turn.started",
      "message",
      "turn.completed",
    ]);
    expect(collector.ended).toEqual([{ sessionId, reason: "end_turn" }]);
  });

  test("未知 harness 返回 unknown_harness 并附合法 harness 列表", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const { server } = startDaemon(new Map([["codex", fake.adapter]]));
    const client = server.connect();
    await flush();
    const response = await makeRequester(client).request("spawn", {
      sessionLabel: "reviewer",
      harness: "qoder",
      message: "x",
      captureHarnessStderr: true,
    });
    expect(response).toMatchObject({
      kind: "response",
      error: {
        code: "unknown_harness",
        harness: "qoder",
        availableHarnesses: ["codex"],
      },
    });
    expect(fake.calls.factoryCalls).toBe(0);
  });

  test("unsupported stderr capture is rejected before session creation", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const { server } = startDaemon(new Map([["codex", fake.adapter]]));
    const client = server.connect();
    await flush();
    const collector = collectNotifications(client);

    const response = await makeRequester(client).request("spawn", {
      sessionLabel: "capture-test",
      harness: "codex",
      message: "hello",
      captureHarnessStderr: true,
    });

    expect(response).toMatchObject({
      error: { code: "unsupported_feature", feature: "capture_harness_stderr" },
    });
    expect(fake.calls.starts).toBe(0);
    expect(collector.events).toEqual([]);
  });

  test("stderr capture starts only when the registry explicitly supports it", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
      canCaptureHarnessStderr: true,
    });
    const { server } = startDaemon(new Map([["codex", fake.adapter]]));
    const client = server.connect();
    await flush();

    const response = await makeRequester(client).request("spawn", {
      sessionLabel: "capture-supported",
      harness: "codex",
      message: "hello",
      captureHarnessStderr: true,
    });

    expect(response).toMatchObject({
      result: {
        sessionId: expect.stringMatching(testSessionIdPattern),
      },
    });
    expect(fake.calls.starts).toBe(1);
    expect(fake.calls.specs[0]?.captureHarnessStderr).toBe(true);
  });

  test("spawn 参数不合法返回 invalid_params", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const { server } = startDaemon(new Map([["codex", fake.adapter]]));
    const client = server.connect();
    await flush();
    const response = await makeRequester(client).request("spawn", {
      harness: "codex",
    });
    expect(response).toMatchObject({
      kind: "response",
      error: { code: "invalid_params" },
    });
  });

  test("interrupt 拒绝已删除的 message 字段", async () => {
    const { server } = startDaemon(new Map());
    const client = server.connect();
    await flush();
    const response = await makeRequester(client).request("interrupt", {
      ids: ["s1"],
      message: "legacy explanation",
    });
    expect(response).toMatchObject({
      kind: "response",
      error: { code: "invalid_params" },
    });
  });

  test("wait 等待回合完成并返回终态", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const { server } = startDaemon(new Map([["codex", fake.adapter]]));
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);
    const spawned = await requester("spawn", {
      sessionLabel: "reviewer",
      harness: "codex",
      message: "hello",
    });
    const sessionId = (resultOf(spawned) as { sessionId: string }).sessionId;
    fake.controls.completeTurn("end_turn", "ok");
    const waited = await requester("wait", {
      targets: [{ sessionId, turnId: "t1" }],
      completion: "all",
      timeoutMs: 1000,
    });
    expect(resultOf(waited)).toEqual({
      status: "satisfied",
      pending: [],
      completed: [
        {
          sessionId,
          turnId: "t1",
          origin: { kind: "caller" },
          stopReason: "end_turn",
          finalReply: "ok",
          usage: undefined,
        },
      ],
    });
  });

  test("终态事件提交失败时 wait 与 list 只报告最后已提交状态", async () => {
    const backingStore = createInMemoryControlStore();
    let failEventWrite = false;
    const controlStore: ControlStore = {
      ...backingStore,
      recordEvent(event, session) {
        if (failEventWrite) throw new Error("回合终态未能写入存储");
        return backingStore.recordEvent(event, session);
      },
    };
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const server = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport: server,
      adapters: new Map([["codex", fake.adapter]]),
      identity: testIdentity,
      diagnostics: testDiagnostics,
      runtimeScopeId: testRuntimeScopeId,
      controlStore,
      idleTimeoutMs: 60_000,
    });
    const running = daemon.start();
    const connection = server.connect();
    const requester = makeRequester(connection);
    const spawned = resultOf(
      await requester("spawn", {
        harness: "codex",
        message: "保持最后已提交的 busy 状态",
      }),
    ) as { sessionId: SessionId; turnId: TurnId };
    const waiting = requester("wait", {
      targets: [{ sessionId: spawned.sessionId, turnId: spawned.turnId }],
      completion: "all",
      timeoutMs: 1_000,
    });
    await flush();

    failEventWrite = true;
    fake.controls.completeTurn("end_turn", "未提交的终态");

    expect(resultOf(await waiting)).toEqual({
      status: "unreachable",
      completed: [],
      pending: [],
      unreachable: [
        {
          sessionId: spawned.sessionId,
          turnId: spawned.turnId,
          reason: "commit_unavailable",
        },
      ],
    });
    expect(
      resultOf(await requester("list", { sessionId: spawned.sessionId })),
    ).toMatchObject([
      {
        sessionId: spawned.sessionId,
        state: "unreachable",
        lastKnownState: "busy",
        lastKnownActiveTurn: spawned.turnId,
        unreachableReason: "commit_unavailable",
      },
    ]);

    connection.close();
    await expect(daemon.stop()).rejects.toThrow();
    await expect(running).rejects.toThrow();
  });

  test("其他 spawn 登记写失败会唤醒已等待的回合", async () => {
    const backingStore = createInMemoryControlStore();
    let unavailable = false;
    const controlStore: ControlStore = {
      ...backingStore,
      health() {
        return unavailable ? { status: "unavailable" } : backingStore.health();
      },
      registerSpawn(input) {
        if (input.request.message === "fail the next registration") {
          unavailable = true;
          throw new Error("spawn registration write failed");
        }
        return backingStore.registerSpawn(input);
      },
    };
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const server = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport: server,
      adapters: new Map([["codex", fake.adapter]]),
      identity: testIdentity,
      diagnostics: testDiagnostics,
      runtimeScopeId: testRuntimeScopeId,
      controlStore,
      idleTimeoutMs: 60_000,
    });
    daemons.push(daemon);
    const running = daemon.start();
    const connection = server.connect();
    const requester = makeRequester(connection);
    const spawned = resultOf(
      await requester("spawn", {
        harness: "codex",
        message: "keep this turn active",
      }),
    ) as { sessionId: SessionId; turnId: TurnId };
    const waiting = requester("wait", {
      targets: [{ sessionId: spawned.sessionId, turnId: spawned.turnId }],
      completion: "all",
    });
    await flush();

    expect(
      await requester("spawn", {
        harness: "codex",
        message: "fail the next registration",
      }),
    ).toMatchObject({
      error: {
        code: "control_store_unavailable",
        stage: "register",
      },
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = await Promise.race([
      waiting,
      new Promise<"still_waiting">((resolve) => {
        timer = setTimeout(() => resolve("still_waiting"), 250);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    expect(waited).toMatchObject({
      result: {
        status: "unreachable",
        completed: [],
        pending: [],
        unreachable: [
          {
            sessionId: spawned.sessionId,
            turnId: spawned.turnId,
            reason: "commit_unavailable",
          },
        ],
      },
    });
    connection.close();
    await daemon.stop();
    await running;
    daemons.splice(daemons.indexOf(daemon), 1);
  });

  test("当前世代记录失去 machine 控制时仍可查询并标明不可等待", async () => {
    const controlStore = createInMemoryControlStore();
    const consumer = v.parse(consumerContextSchema, "test-consumer");
    const sessionId = testIdentity.session();
    const turnId = "persisted-turn" as TurnId;
    const request = v.parse(spawnParamsSchema, {
      harness: "codex",
      message: "seed a durable session without restoring its driver",
      cwd: "/tmp",
    }) as SpawnParams;
    const operationKey = serializeOperationKey(
      v.parse(operationKeyClaimsSchema, {
        runtimeScopeId: testRuntimeScopeId,
        consumer,
        kind: "spawn",
        generation: testDiagnostics.generation,
        nonce: randomUUID(),
      }),
    );
    const result = { sessionId, turnId, cwd: request.cwd };
    const session = {
      info: {
        sessionId,
        harness: request.harness,
        model: null,
        reasoning: null,
        cwd: request.cwd,
        spawnedAt: "2026-10-18T00:00:00.000Z",
        turns: 0,
        state: "busy" as const,
        activeTurnId: turnId,
      },
      runtimeScopeId: testRuntimeScopeId,
      consumer,
      generation: testDiagnostics.generation,
    };
    const events: DomainEvent[] = [
      {
        type: "session.created",
        sessionId,
        harness: request.harness,
        model: null,
        reasoning: null,
        cwd: request.cwd,
        spawnedAt: session.info.spawnedAt,
      },
      { type: "turn.started", sessionId, turnId },
    ];
    controlStore.registerSpawn({
      operationKey,
      runtimeScopeId: testRuntimeScopeId,
      consumer,
      generation: testDiagnostics.generation,
      request,
    });
    controlStore.markSpawnDispatched(operationKey);
    controlStore.commitSpawn({ operationKey, result, session, events });

    const server = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport: server,
      adapters: new Map(),
      identity: testIdentity,
      diagnostics: testDiagnostics,
      runtimeScopeId: testRuntimeScopeId,
      controlStore,
      idleTimeoutMs: 60_000,
    });
    const running = daemon.start();
    const connection = server.connect();
    const requester = makeRequester(connection);
    expect(await requester("list", {})).toMatchObject({
      result: [
        {
          sessionId,
          state: "unreachable",
          lastKnownState: "busy",
          lastKnownActiveTurn: turnId,
          unreachableReason: "control_lost",
        },
      ],
    });
    expect(
      await requester("wait", {
        targets: [{ sessionId, turnId }],
        completion: "all",
      }),
    ).toMatchObject({
      result: {
        status: "unreachable",
        completed: [],
        pending: [],
        unreachable: [{ sessionId, turnId, reason: "control_lost" }],
      },
    });

    connection.close();
    await daemon.stop();
    await running;
  });

  test("busy 中显式 active_turn 直接等待原生接受", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const { server } = startDaemon(new Map([["codex", fake.adapter]]));
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);
    const spawned = await requester("spawn", {
      sessionLabel: "reviewer",
      harness: "codex",
      message: "hello",
    });
    const sessionId = (resultOf(spawned) as { sessionId: string }).sessionId;

    const sent = await requester("send", {
      sessionId,
      message: "边界消息",
      placement: "active_turn",
      turnId: "t1",
    });
    expect(resultOf(sent)).toMatchObject({ deliveryPoint: "active_turn" });
    fake.controls.emitWorkerMessage("worker 部分产出");
    expect(fake.calls.delivered).toEqual([
      { sessionId, turnId: "t1", message: "边界消息" },
    ]);
  });

  test("idle 中 send 触发新回合", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const { server } = startDaemon(new Map([["codex", fake.adapter]]));
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);
    const spawned = await requester("spawn", {
      sessionLabel: "reviewer",
      harness: "codex",
      message: "hello",
    });
    const sessionId = (resultOf(spawned) as { sessionId: string }).sessionId;
    fake.controls.completeTurn();

    const sent = await requester("send", {
      placement: "new_turn",
      sessionId,
      message: "再来一轮",
    });
    expect(resultOf(sent)).toMatchObject({ deliveryPoint: "new_turn" });
    await waitFor(() => fake.calls.delivered.length > 0);
    expect(fake.calls.delivered).toEqual([
      { sessionId, turnId: "t2", message: "再来一轮" },
    ]);
  });

  test("新回合提交期间到达的终态仍进入已提交观察", async () => {
    let fake!: ReturnType<typeof createFakeHarness>;
    fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
      deliver: async () => {
        let remaining = 4;
        const emitAfterCommitStarts = (): void => {
          remaining -= 1;
          if (remaining === 0) fake.controls.completeTurn();
          else queueMicrotask(emitAfterCommitStarts);
        };
        queueMicrotask(emitAfterCommitStarts);
      },
    });
    const controlStore = createInMemoryControlStore();
    const server = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport: server,
      adapters: new Map([["codex", fake.adapter]]),
      identity: testIdentity,
      diagnostics: testDiagnostics,
      runtimeScopeId: testRuntimeScopeId,
      controlStore,
      idleTimeoutMs: 60_000,
    });
    daemons.push(daemon);
    void daemon.start();
    const connection = server.connect();
    const requester = makeRequester(connection);
    const spawned = resultOf(
      await requester("spawn", {
        harness: "codex",
        message: "start the first turn",
      }),
    ) as { sessionId: SessionId };
    fake.controls.completeTurn();

    const sent = resultOf(
      await requester("send", {
        placement: "new_turn",
        sessionId: spawned.sessionId,
        message: "start the second turn",
      }),
    ) as { turnId: TurnId };
    expect(
      controlStore
        .sessionEvents(spawned.sessionId)
        .filter(({ event }) => event.type === "turn.completed")
        .map(({ event }) =>
          event.type === "turn.completed" ? event.turnId : "",
        ),
    ).toEqual(["t1", sent.turnId]);
    expect(resultOf(await requester("list", {}))).toMatchObject([
      { sessionId: spawned.sessionId, state: "idle", turns: 2 },
    ]);
    expect(
      await requester("wait", {
        targets: [{ sessionId: spawned.sessionId, turnId: sent.turnId }],
        completion: "all",
        timeoutMs: 50,
      }),
    ).toMatchObject({
      result: {
        status: "satisfied",
        completed: [{ turnId: sent.turnId }],
        pending: [],
      },
    });
    connection.close();
    await daemon.stop();
    daemons.splice(daemons.indexOf(daemon), 1);
  });

  test("跨连接 attach + send 后会话保持存活，连接断开不杀会话", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const { server } = startDaemon(new Map([["codex", fake.adapter]]));
    const clientA = server.connect();
    const clientB = server.connect();
    await flush();
    const requesterA = makeRequester(clientA);
    const requesterB = makeRequester(clientB);

    const spawned = await requesterA("spawn", {
      sessionLabel: "reviewer",
      harness: "codex",
      message: "hello",
    });
    const sessionId = (resultOf(spawned) as { sessionId: string }).sessionId;
    fake.controls.completeTurn();

    const collector = collectNotifications(clientA);
    await requesterA("attach", {
      scope: "session",
      sessionId,
      start: { mode: "history" },
    });
    const sent = await requesterB("send", {
      placement: "new_turn",
      sessionId,
      message: "再来一轮",
    });
    expect(resultOf(sent)).toMatchObject({ deliveryPoint: "new_turn" });
    await waitFor(() => fake.calls.delivered.length > 0);
    fake.controls.completeTurn();

    const listed = await requesterB("list", {});
    const info = (
      resultOf(listed) as Array<{
        sessionId: string;
        state: string;
        turns: number;
      }>
    )[0];
    expect(info).toMatchObject({ sessionId, state: "idle", turns: 2 });
    expect(
      collector.events.some((event) => event.type === "session.killed"),
    ).toBe(false);
    expect(
      collector.events.some(
        (event) => event.type === "message" && event.role === "caller",
      ),
    ).toBe(true);

    clientA.close();
    await flush();
    const after = await requesterB("list", {});
    const sessions = resultOf(after) as Array<{ sessionId: string }>;
    expect(sessions.some((session) => session.sessionId === sessionId)).toBe(
      true,
    );
  });

  test("interrupt 返回带 turnId 的 ack，随后合成 cancelled", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const { server } = startDaemon(new Map([["codex", fake.adapter]]));
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);
    const spawned = await requester("spawn", {
      sessionLabel: "reviewer",
      harness: "codex",
      message: "hello",
    });
    const sessionId = (resultOf(spawned) as { sessionId: string }).sessionId;

    const interrupted = await requester("interrupt", {
      sessionId,
      turnId: "t1",
    });
    expect(resultOf(interrupted)).toEqual({ sessionId, turnId: "t1" });
    expect(fake.calls.interrupted).toEqual([sessionId]);
    fake.controls.completeTurn("cancelled", null);
    const waited = await requester("wait", {
      targets: [{ sessionId, turnId: "t1" }],
      completion: "all",
      timeoutMs: 1000,
    });
    expect(resultOf(waited)).toMatchObject({
      status: "satisfied",
      pending: [],
      completed: [{ sessionId, turnId: "t1", stopReason: "cancelled" }],
    });
  });

  test("kill 清理会话，wait 保留自然终态，未知 id 报 session_not_found", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const { server } = startDaemon(new Map([["codex", fake.adapter]]));
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);
    const spawned = await requester("spawn", {
      sessionLabel: "reviewer",
      harness: "codex",
      message: "hello",
    });
    const sessionId = (resultOf(spawned) as { sessionId: string }).sessionId;
    fake.controls.completeTurn();

    const killed = await requester("kill", { sessionId: sessionId });
    expect(resultOf(killed)).toEqual({ sessionId, status: "killed" });
    expect(fake.calls.terminated).toEqual([sessionId]);

    const waited = await requester("wait", {
      targets: [{ sessionId, turnId: "t1" }],
      completion: "all",
      timeoutMs: 1000,
    });
    expect(resultOf(waited)).toEqual({
      status: "satisfied",
      pending: [],
      completed: [
        {
          sessionId,
          turnId: "t1",
          origin: { kind: "caller" },
          stopReason: "end_turn",
          finalReply: "done",
        },
      ],
    });

    const missing = await requester("wait", {
      targets: [
        {
          sessionId: "session:00000000-0000-4000-8000-000000000000:missing:1",
          turnId: "t1",
        },
      ],
      completion: "all",
      timeoutMs: 1000,
    });
    expect(missing).toMatchObject({
      kind: "response",
      error: { code: "session_not_found" },
    });
  });

  test("attach 实时转发事件，权限决议走双工通道", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
      autoPermission: {
        options: [
          { outcome: "allow", scope: "once" },
          { outcome: "deny", feedback: false },
        ],
      },
    });
    const { server } = startDaemon(new Map([["codex", fake.adapter]]));
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);
    const collector = collectNotifications(client);
    const spawned = await requester("spawn", {
      sessionLabel: "reviewer",
      harness: "codex",
      message: "hello",
    });
    const sessionId = (resultOf(spawned) as { sessionId: string }).sessionId;
    await requester("attach", {
      scope: "session",
      sessionId,
      start: { mode: "history" },
    });

    const permissionEvent = collector.events.find(
      (event) => event.type === "permission.requested",
    );
    expect(permissionEvent).toBeDefined();
    const permissionId = (
      permissionEvent as Extract<DomainEvent, { type: "permission.requested" }>
    ).permissionId;

    const resolved = await requester("resolvePermission", {
      turnId: "t1",
      sessionId,
      permissionId,
      resolution: { outcome: "allow", scope: "once" },
    });
    expect(resolved).toMatchObject({
      kind: "response",
      result: { sessionId, permissionId },
    });
    expect(fake.calls.resolved).toEqual([{ outcome: "allow", scope: "once" }]);
    expect(
      collector.events.some((event) => event.type === "permission.resolved"),
    ).toBe(true);

    fake.controls.emitWorkerMessage("live");
    await waitFor(() =>
      collector.events.some(
        (event) => event.type === "message" && event.content === "live",
      ),
    );
  });

  test("explicit turn scope excludes older turn history", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const { server } = startDaemon(new Map([["codex", fake.adapter]]));
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);
    const spawned = await requester("spawn", {
      sessionLabel: "attach-target",
      harness: "codex",
      message: "first",
    });
    const sessionId = (resultOf(spawned) as { sessionId: SessionId }).sessionId;
    fake.controls.completeTurn("end_turn");
    await requester("send", {
      placement: "new_turn",
      sessionId,
      message: "second",
    });
    const collector = collectNotifications(client);

    const attached = await requester("attach", {
      scope: "turn",
      sessionId,
      turnId: "t2",
      start: { mode: "history" },
    });
    expect(attached).toMatchObject({
      result: { initial: { mode: "history", target: { sessionId } } },
    });
    expect(collector.ended).toEqual([]);
    expect(
      collector.events.some(
        (event) => event.type === "turn.completed" && event.turnId === "t1",
      ),
    ).toBe(false);

    fake.controls.completeTurn("end_turn");
    await waitFor(() => collector.ended.length === 1);
    expect(collector.ended).toEqual([{ sessionId, reason: "end_turn" }]);
  });

  test("attach queues a live event injected during replay behind history and before response", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    let injectLive: (() => void) | undefined;
    const { server } = startDaemon(new Map([["codex", fake.adapter]]), {
      beforeAttachReplay: () => injectLive?.(),
    });
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);
    const spawned = await requester("spawn", {
      sessionLabel: "attach-gap",
      harness: "codex",
      message: "first",
    });
    const sessionId = (resultOf(spawned) as { sessionId: SessionId }).sessionId;
    injectLive = () => fake.controls.emitWorkerMessage("live-during-replay");
    const order: string[] = [];
    client.onEvent((event) => {
      if (event.kind !== "message") return;
      if (
        event.message.kind === "response" &&
        event.message.requestId === "r3"
      ) {
        order.push("response");
      }
      if (
        event.message.kind === "notification" &&
        event.message.method === "event"
      ) {
        order.push(
          event.message.params.event.type === "message"
            ? "live"
            : event.message.params.event.type,
        );
      }
    });

    const attached = await requester("attach", {
      scope: "session",
      sessionId,
      start: { mode: "history" },
    });
    expect(attached).toMatchObject({
      result: { initial: { mode: "history", replayed: 3 } },
    });
    expect(order).toEqual([
      "response",
      "session.created",
      "turn.started",
      "live",
      "live",
    ]);
  });

  test("available replay preserves complete message history", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const { server } = startDaemon(new Map([["codex", fake.adapter]]));
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);
    const spawned = await requester("spawn", {
      sessionLabel: "coherent-slice",
      harness: "codex",
      message: "first",
    });
    const sessionId = (resultOf(spawned) as { sessionId: SessionId }).sessionId;
    const messageId = "m-coherent" as MessageId;
    const toolCallId = "c-coherent" as ToolCallId;
    fake.controls.emitText(messageId, "pre");
    fake.controls.emitToolRequest(toolCallId, "Read");
    fake.controls.emitText(messageId, "post");
    fake.controls.emitSnapshot(messageId, "prepost");
    const collector = collectNotifications(client);

    const attached = await requester("attach", {
      scope: "session",
      sessionId,
      start: { mode: "history" },
    });

    expect(attached).toMatchObject({
      result: { initial: { mode: "history", replayed: 7 } },
    });
    expect(
      collector.events.filter(
        (event) =>
          event.type !== "session.created" && event.type !== "turn.started",
      ),
    ).toEqual([
      {
        type: "message",
        sessionId,
        turnId: "t1",
        messageId: "m1",
        role: "caller",
        content: "first",
      },
      { type: "text.delta", sessionId, turnId: "t1", messageId, delta: "pre" },
      {
        type: "tool.requested",
        sessionId,
        turnId: "t1",
        toolCallId,
        name: "Read",
      },
      { type: "text.delta", sessionId, turnId: "t1", messageId, delta: "post" },
      {
        type: "message",
        sessionId,
        turnId: "t1",
        messageId,
        role: "worker",
        content: "prepost",
      },
    ]);
  });

  test("attach expands terminal replay for a completed message without a snapshot", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const { server } = startDaemon(new Map([["codex", fake.adapter]]));
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);
    const spawned = await requester("spawn", {
      sessionLabel: "coherent-terminal",
      harness: "codex",
      message: "first",
    });
    const sessionId = (resultOf(spawned) as { sessionId: SessionId }).sessionId;
    const messageId = "m-terminal" as MessageId;
    fake.controls.emitText(messageId, "observed");
    fake.controls.completeTurn("end_turn", "observed");
    const collector = collectNotifications(client);

    const attached = await requester("attach", {
      scope: "session",
      sessionId,
      start: { mode: "history" },
    });

    expect(attached).toMatchObject({
      result: { initial: { mode: "history", replayed: 5 } },
    });
    expect(collector.events.map((event) => event.type)).toEqual([
      "session.created",
      "turn.started",
      "message",
      "text.delta",
      "turn.completed",
    ]);
  });

  test("explicit none does not replay an active or completed message", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const { server } = startDaemon(new Map([["codex", fake.adapter]]));
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);
    const spawned = await requester("spawn", {
      sessionLabel: "coherent-zero",
      harness: "codex",
      message: "first",
    });
    const sessionId = (resultOf(spawned) as { sessionId: SessionId }).sessionId;
    const messageId = "m-zero" as MessageId;
    fake.controls.emitText(messageId, "hel");
    fake.controls.emitText(messageId, "lo");
    const activeCollector = collectNotifications(client);

    const active = await requester("attach", {
      scope: "session",
      sessionId,
      start: { mode: "snapshot" },
    });

    expect(active).toMatchObject({ result: { initial: { mode: "snapshot" } } });
    expect(activeCollector.events).toEqual([]);

    fake.controls.emitSnapshot(messageId, "hello");
    const idleClient = server.connect();
    await flush();
    const idleCollector = collectNotifications(idleClient);
    const idle = await makeRequester(idleClient)("attach", {
      scope: "session",
      sessionId,
      start: { mode: "snapshot" },
    });
    expect(idle).toMatchObject({ result: { initial: { mode: "snapshot" } } });
    expect(idleCollector.events).toEqual([]);
  });

  test("available replays full durable history without truncation", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const { server } = startDaemon(new Map([["codex", fake.adapter]]));
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);
    const spawned = await requester("spawn", {
      sessionLabel: "coherent-limit",
      harness: "codex",
      message: "first",
    });
    const sessionId = (resultOf(spawned) as { sessionId: SessionId }).sessionId;
    const messageId = "m-limit" as MessageId;
    for (const delta of ["a", "b", "c", "d"]) {
      fake.controls.emitText(messageId, delta);
    }
    const activeCollector = collectNotifications(client);
    const active = await requester("attach", {
      scope: "session",
      sessionId,
      start: { mode: "history" },
    });
    expect(active).toMatchObject({
      result: {
        initial: {
          mode: "history",
          replayed: 7,
          window: { truncated: false },
        },
      },
    });
    expect(activeCollector.events).toHaveLength(7);

    fake.controls.completeTurn("end_turn", "abcd");
    const idleClient = server.connect();
    await flush();
    const idleCollector = collectNotifications(idleClient);
    const completed = await makeRequester(idleClient)("attach", {
      scope: "session",
      sessionId,
      start: { mode: "history" },
    });
    expect(completed).toMatchObject({
      result: {
        initial: {
          mode: "history",
          replayed: 8,
          window: { truncated: false },
        },
      },
    });
    expect(idleCollector.events.at(-1)).toMatchObject({
      type: "turn.completed",
      stopReason: "end_turn",
    });
  });

  test("attach freezes its coherent replay selection before pending live injection", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const messageId = "m-boundary" as MessageId;
    let injectLive: (() => void) | undefined;
    const { server } = startDaemon(new Map([["codex", fake.adapter]]), {
      beforeAttachReplay: () => injectLive?.(),
    });
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);
    const spawned = await requester("spawn", {
      sessionLabel: "coherent-boundary",
      harness: "codex",
      message: "first",
    });
    const sessionId = (resultOf(spawned) as { sessionId: SessionId }).sessionId;
    fake.controls.emitText(messageId, "he");
    injectLive = () => fake.controls.emitText(messageId, "llo");
    const collector = collectNotifications(client);

    const attached = await requester("attach", {
      scope: "session",
      sessionId,
      start: { mode: "history" },
    });
    expect(attached).toMatchObject({
      result: { initial: { mode: "history", replayed: 4 } },
    });
    expect(
      collector.events.filter((event) => event.type === "text.delta"),
    ).toEqual([
      { type: "text.delta", sessionId, turnId: "t1", messageId, delta: "he" },
      {
        type: "text.delta",
        sessionId,
        turnId: "t1",
        messageId,
        delta: "llo",
      },
    ]);
  });

  test("attach ends once when its target completes reentrantly during replay", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    let completeTarget: (() => void) | undefined;
    const { server } = startDaemon(new Map([["codex", fake.adapter]]), {
      beforeAttachReplay: () => completeTarget?.(),
    });
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);
    const spawned = await requester("spawn", {
      sessionLabel: "attach-reentrant",
      harness: "codex",
      message: "first",
    });
    const sessionId = (resultOf(spawned) as { sessionId: SessionId }).sessionId;
    completeTarget = () => fake.controls.completeTurn("end_turn");
    const collector = collectNotifications(client);

    await requester("attach", {
      scope: "turn",
      sessionId,
      turnId: "t1",
      start: { mode: "history" },
    });
    await flush();

    expect(collector.ended).toEqual([{ sessionId, reason: "end_turn" }]);
    const eventCount = collector.events.length;
    await flush();
    expect(collector.ended).toHaveLength(1);
    expect(collector.events).toHaveLength(eventCount);
  });

  test("attach replay hook failure leaves no subscription behind", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    let fail = true;
    const { server } = startDaemon(new Map([["codex", fake.adapter]]), {
      beforeAttachReplay: () => {
        if (fail) throw new Error("replay hook failed");
      },
    });
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);
    const spawned = await requester("spawn", {
      sessionLabel: "attach-hook",
      harness: "codex",
      message: "first",
    });
    const sessionId = (resultOf(spawned) as { sessionId: SessionId }).sessionId;
    const collector = collectNotifications(client);
    await expect(
      requester("attach", {
        scope: "session",
        sessionId,
        start: { mode: "history" },
      }),
    ).resolves.toMatchObject({
      error: { code: "internal_error" },
    });
    fake.controls.emitWorkerMessage("after-failure");
    await flush();
    expect(collector.events).toEqual([]);
    fail = false;
    await expect(
      requester("attach", {
        scope: "session",
        sessionId,
        start: { mode: "history" },
      }),
    ).resolves.toMatchObject({
      result: { initial: { mode: "history", target: { sessionId } } },
    });
  });

  test("attach replay zero still ends for its already completed idle target", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const { server } = startDaemon(new Map([["codex", fake.adapter]]));
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);
    const spawned = await requester("spawn", {
      sessionLabel: "attach-idle",
      harness: "codex",
      message: "first",
    });
    const sessionId = (resultOf(spawned) as { sessionId: SessionId }).sessionId;
    fake.controls.completeTurn("end_turn");
    await flush();
    const collector = collectNotifications(client);

    const attached = await requester("attach", {
      scope: "turn",
      sessionId,
      turnId: "t1",
      start: { mode: "snapshot" },
    });

    expect(attached).toMatchObject({
      result: { initial: { mode: "snapshot", target: { sessionId } } },
    });
    const initial = v.parse(attachResultSchema, resultOf(attached)).initial;
    if (initial.mode !== "snapshot")
      throw new Error("Expected attach to return a snapshot");
    expect(initial.baseline.confirmedTerminals).toHaveLength(1);
    expect(collector.events).toEqual([]);
    expect(collector.ended).toEqual([{ sessionId, reason: "end_turn" }]);
  });

  test("turn subscription ends at every terminal and never follows a successor", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const { server } = startDaemon(new Map([["codex", fake.adapter]]));
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);
    const spawned = await requester("spawn", {
      sessionLabel: "attach-reason",
      harness: "codex",
      message: "first",
    });
    const sessionId = (resultOf(spawned) as { sessionId: SessionId }).sessionId;
    const collector = collectNotifications(client);
    await requester("attach", {
      scope: "turn",
      sessionId,
      turnId: "t1",
      start: { mode: "snapshot" },
    });

    fake.controls.completeTurn("failed");
    await requester("send", {
      placement: "new_turn",
      sessionId,
      message: "second",
    });
    fake.controls.completeTurn("end_turn");
    await flush();

    expect(collector.ended).toEqual([{ sessionId, reason: "failed" }]);
  });

  test("empty attach exitOn remains subscribed across turns until the session is killed", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const { server } = startDaemon(new Map([["codex", fake.adapter]]));
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);
    const spawned = await requester("spawn", {
      sessionLabel: "attach-session",
      harness: "codex",
      message: "first",
    });
    const sessionId = (resultOf(spawned) as { sessionId: SessionId }).sessionId;
    const collector = collectNotifications(client);
    await requester("attach", {
      scope: "session",
      sessionId,
      start: { mode: "snapshot" },
    });

    fake.controls.completeTurn();
    await requester("send", {
      placement: "new_turn",
      sessionId,
      message: "second",
    });
    fake.controls.completeTurn();
    await flush();
    expect(collector.ended).toEqual([]);

    await requester("kill", { sessionId: sessionId });
    await waitFor(() => collector.ended.length === 1);
    expect(collector.ended).toEqual([{ sessionId, reason: "session_killed" }]);
  });

  test("observation keeps the active attach target across complete history", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const { server } = startDaemon(new Map([["codex", fake.adapter]]));
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);
    const spawned = await requester("spawn", {
      sessionLabel: "attach-ring",
      harness: "codex",
      message: "first",
    });
    const sessionId = (resultOf(spawned) as { sessionId: SessionId }).sessionId;
    fake.controls.completeTurn();
    await requester("send", {
      placement: "new_turn",
      sessionId,
      message: "second",
    });
    const collector = collectNotifications(client);
    const attached = await requester("attach", {
      scope: "turn",
      sessionId,
      turnId: "t2",
      start: { mode: "history" },
    });

    expect(attached).toMatchObject({
      result: { initial: { mode: "history", replayed: 2 } },
    });
    expect(collector.ended).toEqual([]);
    fake.controls.completeTurn();
    await waitFor(() => collector.ended.length === 1);
    expect(collector.ended).toEqual([{ sessionId, reason: "end_turn" }]);
  });

  test("attach 到不存在的会话返回 session_not_found", async () => {
    const { server } = startDaemon(new Map());
    const client = server.connect();
    await flush();
    const response = await makeRequester(client).request("attach", {
      scope: "session",
      sessionId: "session:00000000-0000-4000-8000-000000000000:missing:1",
      start: { mode: "history" },
    });
    expect(response).toMatchObject({
      kind: "response",
      error: { code: "session_not_found" },
    });
  });

  test("attach 已 kill 的会话回放历史并以 session_killed 结束", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const { server } = startDaemon(new Map([["codex", fake.adapter]]));
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);
    const spawned = await requester("spawn", {
      sessionLabel: "reviewer",
      harness: "codex",
      message: "hello",
    });
    const sessionId = (resultOf(spawned) as { sessionId: string }).sessionId;
    fake.controls.completeTurn();
    await requester("kill", { sessionId: sessionId });

    const collector = collectNotifications(client);
    const attached = await requester("attach", {
      scope: "session",
      sessionId,
      start: { mode: "history" },
    });
    expect(attached).toMatchObject({
      kind: "response",
      result: { initial: { mode: "history", replayed: 5 } },
    });
    expect(collector.events.map((event) => event.type)).toEqual([
      "session.created",
      "turn.started",
      "message",
      "turn.completed",
      "session.killed",
    ]);
    expect(collector.ended).toEqual([{ sessionId, reason: "session_killed" }]);
  });

  test("模型目录聚合，单点失败不拖垮整体", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: {
        harness: "codex",
        models: [{ id: "m1", displayName: "M1", reasoningEfforts: ["low"] }],
      },
    });
    const dummyDriver: WorkerDriver = {
      async start() {},
      async deliver() {},
      async interrupt() {},
      resolvePermission() {},
      async terminate() {},
    };
    const badAdapter: HarnessAdapter = {
      driverFactory: () => dummyDriver,
      async modelCatalog() {
        throw new Error("boom");
      },
    };
    const { server } = startDaemon(
      new Map([
        ["codex", fake.adapter],
        ["qoder", badAdapter],
      ]),
    );
    const client = server.connect();
    await flush();
    const response = await makeRequester(client).request("modelCatalog", {});
    expect(resultOf(response)).toEqual({
      catalogs: [
        {
          harness: "codex",
          models: [{ id: "m1", displayName: "M1", reasoningEfforts: ["low"] }],
        },
      ],
      failures: [
        {
          harness: "qoder",
          code: "model_catalog_query_failed",
          failure: {
            failureCategory: "unclassified",
            retryDisposition: "unknown",
          },
        },
      ],
    });
  });

  test("模型目录聚合保留 adapter 提供的结构化失败分类", async () => {
    const adapter: HarnessAdapter = {
      driverFactory: () => ({
        async start() {},
        async deliver() {},
        async interrupt() {},
        resolvePermission() {},
        async terminate() {},
      }),
      async modelCatalog() {
        throw new HarnessModelCatalogFailure({
          failureCategory: "credential_rejected",
          retryDisposition: "external_state_change",
        });
      },
    };
    const { server } = startDaemon(new Map([["dsh", adapter]]));
    const client = server.connect();
    await flush();

    const response = await makeRequester(client).request("modelCatalog", {});
    const result = resultOf(response) as ModelCatalogResult;
    expect(result.failures).toEqual([
      {
        harness: "dsh",
        code: "model_catalog_query_failed",
        failure: {
          failureCategory: "credential_rejected",
          retryDisposition: "external_state_change",
        },
      },
    ]);
  });

  test("伪造 AlreadyDiagnosed 结构不会污染 modelCatalog response", async () => {
    const adapter: HarnessAdapter = {
      driverFactory: () => ({
        async start() {},
        async deliver() {},
        async interrupt() {},
        resolvePermission() {},
        async terminate() {},
      }),
      async modelCatalog() {
        throw { alreadyDiagnosed: true, diagnosticId: "not-a-diagnostic-id" };
      },
    };
    const { server } = startDaemon(new Map([["qoder", adapter]]));
    const client = server.connect();
    await flush();

    const response = await makeRequester(client).request("modelCatalog", {});
    expect(response).toMatchObject({
      kind: "response",
      result: {
        failures: [
          {
            harness: "qoder",
            code: "model_catalog_query_failed",
          },
        ],
      },
    });
    const result = resultOf(response) as ModelCatalogResult;
    expect(result.failures[0]).not.toHaveProperty("diagnosticId");
  });

  test("公开 AlreadyDiagnosed constructor 的悬空 ID 不成为 modelCatalog authority", async () => {
    const adapter: HarnessAdapter = {
      driverFactory: () => ({
        async start() {},
        async deliver() {},
        async interrupt() {},
        resolvePermission() {},
        async terminate() {},
      }),
      async modelCatalog() {
        throw new AlreadyDiagnosedError(
          "supplied",
          makeDiagnosticId(testRuntimeScopeId, "test", "1"),
        );
      },
    };
    const { server } = startDaemon(new Map([["qoder", adapter]]));
    const client = server.connect();
    await flush();

    const response = await makeRequester(client).request("modelCatalog", {});
    const result = resultOf(response) as ModelCatalogResult;
    expect(result.failures[0]).toMatchObject({
      harness: "qoder",
      code: "model_catalog_query_failed",
    });
    expect(result.failures[0]).not.toHaveProperty("diagnosticId");
  });

  test("模型目录忽略不相关诊断并记录一次 fallback", async () => {
    const suppliedId = makeDiagnosticId(testRuntimeScopeId, "test", "2");
    const fallbackId = makeDiagnosticId(testRuntimeScopeId, "test", "3");
    const modelCatalogRecords: unknown[] = [];
    const diagnostics: DiagnosticsRuntime = {
      ...testDiagnostics,
      async record(input) {
        if (
          input.kind === "request_failure" &&
          input.operation === "model_catalog"
        ) {
          modelCatalogRecords.push(input);
          return fallbackId;
        }
        return makeDiagnosticId(testRuntimeScopeId, "test", "1");
      },
      async query(params) {
        if ("diagnosticId" in params && params.diagnosticId === suppliedId) {
          return {
            record: {
              v: 1,
              diagnosticId: suppliedId,
              recordedAt: "2026-08-20T00:00:00.000Z",
              severity: "warning",
              source: "adapter",
              harness: "qoder",
              kind: "mapping_gap",
              operation: "spawn",
              reason: "unsupported_input",
              fields: ["reasoning"],
            },
          };
        }
        return { records: [], truncated: false };
      },
    };
    const adapter: HarnessAdapter = {
      driverFactory: () => ({
        async start() {},
        async deliver() {},
        async interrupt() {},
        resolvePermission() {},
        async terminate() {},
      }),
      async modelCatalog() {
        throw new AlreadyDiagnosedError("unrelated", suppliedId);
      },
    };
    const server = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemonForTest({
      transport: server,
      adapters: new Map([["qoder", adapter]]),
      identity: testIdentity,
      diagnostics,
      idleTimeoutMs: 60_000,
    });
    daemons.push(daemon);
    void daemon.start();
    const client = server.connect();
    await flush();

    const response = await makeRequester(client).request("modelCatalog", {});
    const result = resultOf(response) as ModelCatalogResult;
    expect(result.failures[0]).toMatchObject({
      harness: "qoder",
      diagnosticId: fallbackId,
    });
    expect(modelCatalogRecords).toHaveLength(1);
  });

  test("unexpected dispatch errors are schema-valid UTF-8 bounded causes", async () => {
    const failingDriver: WorkerDriver = {
      async start() {
        throw new WorkerStartFailure("a".repeat(5000), "not_accepted");
      },
      async deliver() {},
      async interrupt() {},
      resolvePermission() {},
      async terminate() {},
    };
    const adapter: HarnessAdapter = {
      driverFactory: () => failingDriver,
      async modelCatalog() {
        return emptyModelCatalog("codex");
      },
    };
    const { server } = startDaemon(new Map([["codex", adapter]]));
    const client = server.connect();
    await flush();

    const response = await makeRequester(client).request("spawn", {
      sessionLabel: "failing",
      harness: "codex",
      message: "hello",
    });
    if (!("error" in response)) throw new Error("expected machine error");
    expect(v.safeParse(machineErrorSchema, response.error).success).toBe(true);
    expect(response.error).toMatchObject({
      code: "internal_error",
      cause: { kind: "exception" },
    });
    if (response.error.code !== "internal_error") {
      throw new Error("expected internal error");
    }
    expect(new TextEncoder().encode(response.error.cause?.message).length).toBe(
      4 * 1024,
    );
  });

  test("未知方法返回 method_not_found，非法 envelope 返回 protocol_error", async () => {
    const { server } = startDaemon(new Map());
    const client = server.connect();
    await flush();
    const unknownMethod = await sendRaw(client, {
      kind: "request",
      requestId: "raw1",
      method: "launch",
      params: {},
    });
    expect(unknownMethod).toMatchObject({
      kind: "response",
      error: { code: "method_not_found" },
    });
    const malformed = await sendRaw(client, {
      kind: "request",
      requestId: "raw2",
      method: "spawn",
    });
    expect(malformed).toMatchObject({
      kind: "response",
      error: { code: "protocol_error" },
    });
  });

  test("路由 driver 按会话实例化所选 harness", async () => {
    const fakeA = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const fakeB = createFakeHarness({
      harness: "qoder",
      modelCatalog: emptyModelCatalog("qoder"),
    });
    const { server } = startDaemon(
      new Map([
        ["codex", fakeA.adapter],
        ["qoder", fakeB.adapter],
      ]),
    );
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);
    await requester("spawn", {
      sessionLabel: "a-one",
      harness: "codex",
      message: "1",
    });
    await requester("spawn", {
      sessionLabel: "a-two",
      harness: "codex",
      message: "2",
    });
    await requester("spawn", {
      sessionLabel: "b-one",
      harness: "qoder",
      message: "3",
    });
    expect(fakeA.calls.factoryCalls).toBe(2);
    expect(fakeA.calls.starts).toBe(2);
    expect(fakeB.calls.factoryCalls).toBe(1);
    expect(fakeB.calls.starts).toBe(1);
  });
});

describe("daemon 空闲退出", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("无连接且无会话时超时退出", async () => {
    vi.useFakeTimers();
    const server = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport: server,
      adapters: new Map(),
      identity: testIdentity,
      diagnostics: testDiagnostics,
      runtimeScopeId: testRuntimeScopeId,
      idleTimeoutMs: 100,
    });
    const started = daemon.start();
    const readiness = server.connect();
    await makeRequester(readiness).request("list", {});
    readiness.close();
    await vi.advanceTimersByTimeAsync(100);
    await expect(started).resolves.toBeUndefined();
  });

  test("创建提交与首次停止均失败时，pending driver 阻止空闲退出并可再次收束", async () => {
    vi.useFakeTimers();
    let terminationAttempts = 0;
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
      terminate: async () => {
        terminationAttempts += 1;
        if (terminationAttempts === 1) throw new Error("first stop failed");
      },
    });
    const backingStore = createInMemoryControlStore();
    const controlStore: ControlStore = {
      ...backingStore,
      commitSpawn() {
        throw new Error("injected commit failure");
      },
    };
    const server = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport: server,
      adapters: new Map([["codex", fake.adapter]]),
      identity: testIdentity,
      diagnostics: testDiagnostics,
      runtimeScopeId: testRuntimeScopeId,
      controlStore,
      idleTimeoutMs: 100,
    });
    daemons.push(daemon);
    let startedResolved = false;
    const started = daemon.start().then(() => {
      startedResolved = true;
    });
    const connection = server.connect();
    const requester = makeRequester(connection);
    const response = await requester("spawn", {
      harness: "codex",
      sessionLabel: "accepted-but-uncommitted",
      message: "keep the pending worker reachable",
    });
    expect(response).toMatchObject({
      error: {
        code: "control_store_unavailable",
        stage: "commit",
        acceptance: "accepted",
        cleanupCause: { kind: "closed" },
      },
    });
    expect(fake.calls.starts).toBe(1);
    expect(terminationAttempts).toBe(1);
    expect(await requester("list", {})).toMatchObject({ result: [] });

    connection.close();
    await vi.advanceTimersByTimeAsync(100);
    expect(startedResolved).toBe(false);
    expect(terminationAttempts).toBe(1);

    await daemon.stop();
    await expect(started).resolves.toBeUndefined();
    expect(terminationAttempts).toBe(2);
  });

  test("存储故障后仍尝试kill，已关闭但未提交时不返回成功", async () => {
    let writeUnavailable = false;
    let spawnCommits = 0;
    let killCommits = 0;
    const backingStore = createInMemoryControlStore();
    const controlStore: ControlStore = {
      ...backingStore,
      health() {
        return writeUnavailable
          ? { status: "unavailable" }
          : backingStore.health();
      },
      registerSpawn(input) {
        if (writeUnavailable) throw new Error("injected store failure");
        return backingStore.registerSpawn(input);
      },
      markSpawnDispatched(operationKey) {
        if (writeUnavailable) throw new Error("injected store failure");
        backingStore.markSpawnDispatched(operationKey);
      },
      commitSpawn(input) {
        spawnCommits += 1;
        if (spawnCommits === 2) {
          writeUnavailable = true;
          throw new Error("injected result commit failure");
        }
        return backingStore.commitSpawn(input);
      },
      failSpawn(operationKey, error) {
        if (writeUnavailable) throw new Error("injected store failure");
        backingStore.failSpawn(operationKey, error);
      },
      recordEvent(event, session) {
        if (writeUnavailable) throw new Error("injected event commit failure");
        return backingStore.recordEvent(event, session);
      },
      commitKill(input) {
        killCommits += 1;
        if (writeUnavailable) throw new Error("injected kill commit failure");
        return backingStore.commitKill(input);
      },
    };
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const server = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport: server,
      adapters: new Map([["codex", fake.adapter]]),
      identity: testIdentity,
      diagnostics: testDiagnostics,
      runtimeScopeId: testRuntimeScopeId,
      controlStore,
      idleTimeoutMs: 60_000,
    });
    const running = daemon.start();
    const connection = server.connect();
    const requester = makeRequester(connection);
    const first = resultOf(
      await requester("spawn", {
        harness: "codex",
        sessionLabel: "committed-session",
        message: "start A",
      }),
    ) as { sessionId: SessionId };
    const failed = await requester("spawn", {
      harness: "codex",
      sessionLabel: "failed-session",
      message: "start B",
    });
    expect(failed).toMatchObject({
      error: {
        code: "control_store_unavailable",
        stage: "commit",
        acceptance: "accepted",
      },
    });
    expect(fake.calls.starts).toBe(2);

    const stopped = await requester("kill", { sessionId: first.sessionId });
    expect(stopped).toMatchObject({
      error: {
        code: "control_store_unavailable",
        stage: "commit",
        acceptance: "accepted",
        acceptedResult: {
          sessionId: first.sessionId,
          status: "killed",
        },
        operationKey: expect.any(String),
      },
    });
    if (
      !("error" in stopped) ||
      stopped.error.code !== "control_store_unavailable" ||
      stopped.error.stage !== "commit"
    )
      throw new Error("预期主动停止提交故障");
    expect(parseOperationKey(stopped.error.operationKey).kind).toBe("kill");
    expect(
      resultOf(
        await requester("getOperation", {
          operationKey: stopped.error.operationKey,
        }),
      ),
    ).toMatchObject({
      status: "accepted_uncommitted",
      result: { sessionId: first.sessionId, status: "killed" },
    });
    expect(fake.calls.terminated).toContain(first.sessionId);
    expect(killCommits).toBe(1);
    expect(await requester("list", {})).toMatchObject({
      result: [
        {
          sessionId: first.sessionId,
          state: "unreachable",
          lastKnownState: "busy",
          unreachableReason: "commit_unavailable",
        },
      ],
    });
    writeUnavailable = false;
    await expect(
      sendRaw(connection, {
        kind: "request",
        requestId: "kill-accepted-result-retry-commit",
        method: "kill",
        params: { sessionId: first.sessionId },
        operationKey: stopped.error.operationKey,
      }),
    ).resolves.toMatchObject({
      result: { sessionId: first.sessionId, status: "killed" },
    });
    expect(killCommits).toBe(2);
    expect(
      fake.calls.terminated.filter(
        (sessionId) => sessionId === first.sessionId,
      ),
    ).toHaveLength(1);
    expect(
      resultOf(
        await requester("getOperation", {
          operationKey: stopped.error.operationKey,
        }),
      ),
    ).toMatchObject({
      status: "succeeded",
      result: { sessionId: first.sessionId, status: "killed" },
    });
    connection.close();
    await expect(daemon.stop()).resolves.toBeUndefined();
    await expect(running).resolves.toBeUndefined();
  });

  test("kill 注册失败仍执行关闭，查询确认结果未入账", async () => {
    const backingStore = createInMemoryControlStore();
    const controlStore: ControlStore = {
      ...backingStore,
      registerKill() {
        throw new Error("kill registration failed");
      },
      markKillDispatched() {
        throw new Error("kill dispatch marker failed");
      },
      commitKill() {
        throw new Error("kill result commit failed");
      },
    };
    let terminationAttempts = 0;
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
      terminate: async () => {
        terminationAttempts += 1;
      },
    });
    const server = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport: server,
      adapters: new Map([["codex", fake.adapter]]),
      identity: testIdentity,
      diagnostics: testDiagnostics,
      runtimeScopeId: testRuntimeScopeId,
      controlStore,
      idleTimeoutMs: 60_000,
    });
    const running = daemon.start();
    const connection = server.connect();
    const requester = makeRequester(connection);
    const spawned = resultOf(
      await requester("spawn", {
        harness: "codex",
        sessionLabel: "kill-registration-failure",
        message: "启动后注入停止登记失败",
      }),
    ) as { sessionId: SessionId };
    const other = resultOf(
      await requester("spawn", {
        harness: "codex",
        sessionLabel: "kill-registration-failure-other",
        message: "验证已接受结果的参数绑定",
      }),
    ) as { sessionId: SessionId };
    const operationKey = testOperationKey(connection, "kill");

    const stopped = await sendRaw(connection, {
      kind: "request",
      requestId: "kill-registration-failure",
      method: "kill",
      params: { sessionId: spawned.sessionId },
      operationKey,
    });

    expect(stopped).toMatchObject({
      error: {
        code: "control_store_unavailable",
        stage: "commit",
        acceptance: "accepted",
        acceptedResult: { sessionId: spawned.sessionId, status: "killed" },
      },
    });
    expect(terminationAttempts).toBe(1);
    expect(backingStore.getOperation(operationKey as never)).toBeUndefined();
    const queried = resultOf(
      await requester("getOperation", { operationKey }),
    ) as { status: string };
    expect(queried.status).toBe("accepted_uncommitted");
    await expect(
      sendRaw(connection, {
        kind: "request",
        requestId: "kill-registration-failure-reused",
        method: "kill",
        params: { sessionId: other.sessionId },
        operationKey,
      }),
    ).resolves.toMatchObject({
      error: { code: "operation_key_conflict" },
    });
    expect(terminationAttempts).toBe(1);
    expect(backingStore.getSession(other.sessionId)?.info.state).toBe("busy");
    expect(backingStore.getSession(spawned.sessionId)?.info.state).toBe("busy");
    expect(
      backingStore
        .sessionEvents(spawned.sessionId)
        .some(({ event }) => event.type === "session.killed"),
    ).toBe(false);

    connection.close();
    await daemon.stop();
    await running;
  });

  test("kill 注册故障时核实既有操作后才可派发", async () => {
    const backingStore = createInMemoryControlStore();
    let registerUnavailable = false;
    let readUnavailable = false;
    let failKillUnavailable = false;
    const controlStore: ControlStore = {
      ...backingStore,
      registerKill(input) {
        if (registerUnavailable)
          throw new Error("kill registration read failed");
        return backingStore.registerKill(input);
      },
      markKillDispatched(operationKey) {
        if (registerUnavailable)
          throw new Error("kill dispatch marker unavailable");
        return backingStore.markKillDispatched(operationKey);
      },
      failKill(operationKey, error) {
        if (failKillUnavailable) throw new Error("kill failure write failed");
        return backingStore.failKill(operationKey, error);
      },
      getOperation(operationKey) {
        if (readUnavailable) throw new Error("operation read failed");
        return backingStore.getOperation(operationKey);
      },
    };
    const attempts = new Map<SessionId, number>();
    let unknownSessionId: SessionId | undefined;
    let partialSessionId: SessionId | undefined;
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
      terminate: async (sessionId) => {
        const count = (attempts.get(sessionId) ?? 0) + 1;
        attempts.set(sessionId, count);
        if (sessionId === unknownSessionId && count === 1)
          throw {
            code: "internal_error",
            cause: {
              kind: "timeout",
              message: "official deletion confirmation absent",
            },
          };
        if (sessionId === partialSessionId && count === 1)
          throw {
            code: "internal_error",
            cause: { kind: "closed", message: "owned resource release failed" },
            effect: { kind: "session_closed", sessionId },
          };
      },
    });
    const server = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport: server,
      adapters: new Map([["codex", fake.adapter]]),
      identity: testIdentity,
      diagnostics: testDiagnostics,
      runtimeScopeId: testRuntimeScopeId,
      controlStore,
      idleTimeoutMs: 60_000,
    });
    const running = daemon.start();
    const connection = server.connect();
    const requester = makeRequester(connection);
    const sessions = new Map<string, SessionId>();
    for (const label of [
      "A",
      "B",
      "unknown",
      "dispatched",
      "unreadable",
      "partial",
    ]) {
      const spawned = resultOf(
        await requester("spawn", {
          harness: "codex",
          sessionLabel: `kill-register-${label}`,
          message: `创建 ${label} 的关闭测试会话`,
        }),
      ) as { sessionId: SessionId };
      sessions.set(label, spawned.sessionId);
    }
    const sendKill = (
      requestId: string,
      operationKey: string,
      sessionId: SessionId,
    ) =>
      sendRaw(connection, {
        kind: "request",
        requestId,
        method: "kill",
        params: { sessionId },
        operationKey,
      });
    const seedDispatched = (operationKey: string, sessionId: SessionId) => {
      const claims = parseOperationKey(operationKey);
      backingStore.registerKill({
        operationKey: operationKey as never,
        runtimeScopeId: claims.runtimeScopeId,
        consumer: claims.consumer,
        generation: claims.generation,
        request: { sessionId },
      });
      backingStore.markKillDispatched(operationKey as never);
    };

    const boundKey = testOperationKey(connection, "kill");
    await expect(
      sendKill("kill-register-a", boundKey, sessions.get("A")!),
    ).resolves.toMatchObject({
      result: { sessionId: sessions.get("A"), status: "killed" },
    });
    registerUnavailable = true;
    await expect(
      sendKill("kill-register-reused-on-b", boundKey, sessions.get("B")!),
    ).resolves.toMatchObject({
      error: { code: "operation_key_conflict" },
    });
    expect(attempts.get(sessions.get("A")!)).toBe(1);
    expect(attempts.get(sessions.get("B")!)).toBeUndefined();
    expect(backingStore.getSession(sessions.get("B")!)?.info.state).toBe(
      "busy",
    );
    expect(backingStore.getOperation(boundKey as never)).toMatchObject({
      kind: "kill",
      request: { sessionId: sessions.get("A") },
      status: "succeeded",
      result: { sessionId: sessions.get("A"), status: "killed" },
    });

    registerUnavailable = false;
    unknownSessionId = sessions.get("unknown");
    const unknownKey = testOperationKey(connection, "kill");
    await expect(
      sendKill("kill-register-unknown-first", unknownKey, unknownSessionId!),
    ).resolves.toMatchObject({
      error: {
        code: "operation_outcome_unknown",
        cause: {
          kind: "timeout",
          message: "official deletion confirmation absent",
        },
      },
    });
    expect(backingStore.getOperation(unknownKey as never)).toMatchObject({
      status: "outcome_unknown",
    });
    registerUnavailable = true;
    await expect(
      sendKill("kill-register-unknown-retry", unknownKey, unknownSessionId!),
    ).resolves.toMatchObject({
      error: {
        code: "operation_outcome_unknown",
        operationKey: unknownKey,
        cause: {
          kind: "timeout",
          message: "official deletion confirmation absent",
        },
      },
    });
    expect(attempts.get(unknownSessionId!)).toBe(1);
    await expect(
      sendKill("kill-register-unknown-reused", unknownKey, sessions.get("B")!),
    ).resolves.toMatchObject({
      error: { code: "operation_key_conflict" },
    });
    expect(attempts.get(sessions.get("B")!)).toBeUndefined();

    const dispatchedKey = testOperationKey(connection, "kill");
    seedDispatched(dispatchedKey, sessions.get("dispatched")!);
    await expect(
      sendKill(
        "kill-register-dispatched-retry",
        dispatchedKey,
        sessions.get("dispatched")!,
      ),
    ).resolves.toMatchObject({
      error: {
        code: "operation_outcome_unknown",
        operationKey: dispatchedKey,
      },
    });
    expect(attempts.get(sessions.get("dispatched")!)).toBeUndefined();

    const unreadableKey = testOperationKey(connection, "kill");
    seedDispatched(unreadableKey, sessions.get("unreadable")!);
    readUnavailable = true;
    await expect(
      sendKill(
        "kill-register-unreadable-retry",
        unreadableKey,
        sessions.get("B")!,
      ),
    ).resolves.toMatchObject({
      error: {
        code: "control_store_unavailable",
        operationKey: unreadableKey,
        stage: "register",
        acceptance: "unknown",
      },
    });
    expect(attempts.get(sessions.get("unreadable")!)).toBeUndefined();
    expect(attempts.get(sessions.get("B")!)).toBeUndefined();

    readUnavailable = false;
    partialSessionId = sessions.get("partial");
    failKillUnavailable = true;
    const partialKey = testOperationKey(connection, "kill");
    await expect(
      sendKill("kill-register-partial-first", partialKey, partialSessionId!),
    ).resolves.toMatchObject({
      error: {
        code: "internal_error",
        effect: { kind: "session_closed", sessionId: partialSessionId },
        cleanupCause: { kind: "io", message: "kill failure write failed" },
      },
    });
    await expect(
      sendKill("kill-register-partial-reused", partialKey, sessions.get("B")!),
    ).resolves.toMatchObject({
      error: { code: "operation_key_conflict" },
    });
    expect(attempts.get(partialSessionId!)!).toBe(1);
    expect(attempts.get(sessions.get("B")!)).toBeUndefined();
    failKillUnavailable = false;
    connection.close();
    await daemon.stop();
    await running;
  });

  test("既有事件写故障不覆盖失败的原生停止原因", async () => {
    const backingStore = createInMemoryControlStore();
    let failEventWrite = false;
    let terminationAttempts = 0;
    const controlStore: ControlStore = {
      ...backingStore,
      recordEvent(event, session) {
        if (failEventWrite) throw new Error("先前事件无法写入存储");
        return backingStore.recordEvent(event, session);
      },
    };
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
      terminate: async () => {
        terminationAttempts += 1;
        if (terminationAttempts === 1) throw new Error("原生停止请求被拒绝");
      },
    });
    const server = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport: server,
      adapters: new Map([["codex", fake.adapter]]),
      identity: testIdentity,
      diagnostics: testDiagnostics,
      runtimeScopeId: testRuntimeScopeId,
      controlStore,
      idleTimeoutMs: 60_000,
    });
    const running = daemon.start();
    const connection = server.connect();
    const requester = makeRequester(connection);
    const spawned = resultOf(
      await requester("spawn", {
        harness: "codex",
        sessionLabel: "stop-error-cause",
        message: "创建活动 worker",
      }),
    ) as { sessionId: SessionId };
    failEventWrite = true;
    fake.controls.emitWorkerMessage("触发事件写入失败");

    const stopped = await requester("kill", { sessionId: spawned.sessionId });
    expect(stopped).toMatchObject({
      error: {
        code: "control_store_unavailable",
        stage: "event",
        sessionId: spawned.sessionId,
        eventType: "message",
        turnId: expect.any(String),
        cause: {
          kind: "io",
          message: expect.stringContaining("先前事件无法写入存储"),
        },
        cleanupCause: {
          kind: "closed",
          message: expect.stringContaining("原生停止请求被拒绝"),
        },
      },
    });
    expect(stopped).not.toHaveProperty("error.operationKey");
    expect(terminationAttempts).toBeGreaterThan(0);
    connection.close();
    await expect(daemon.stop()).rejects.toThrow();
    await expect(running).rejects.toThrow();
    expect(terminationAttempts).toBe(2);
  });

  test("先前会话写故障保留主因并关联目标会话停止失败", async () => {
    const backingStore = createInMemoryControlStore();
    let failEventWrite = false;
    let allowStopB = false;
    const controlStore: ControlStore = {
      ...backingStore,
      recordEvent(event, session) {
        if (failEventWrite) throw new Error("A_EVENT_WRITE_IO");
        return backingStore.recordEvent(event, session);
      },
    };
    const codex = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const qoder = createFakeHarness({
      harness: "qoder",
      modelCatalog: emptyModelCatalog("qoder"),
      terminate: async () => {
        if (!allowStopB) throw new Error("B_STOP_NATIVE");
      },
    });
    const server = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport: server,
      adapters: new Map([
        ["codex", codex.adapter],
        ["qoder", qoder.adapter],
      ]),
      identity: testIdentity,
      diagnostics: testDiagnostics,
      runtimeScopeId: testRuntimeScopeId,
      controlStore,
      idleTimeoutMs: 60_000,
    });
    const running = daemon.start();
    const connection = server.connect();
    const requester = makeRequester(connection);
    const a = resultOf(
      await requester("spawn", {
        harness: "codex",
        sessionLabel: "event-store-target-a",
        message: "start A",
      }),
    ) as { sessionId: SessionId };
    const b = resultOf(
      await requester("spawn", {
        harness: "qoder",
        sessionLabel: "stop-target-b",
        message: "start B",
      }),
    ) as { sessionId: SessionId };

    failEventWrite = true;
    codex.controls.emitWorkerMessage("A body");
    await vi.waitFor(() =>
      expect(codex.calls.terminated).toContain(a.sessionId),
    );
    const stopped = await requester("kill", { sessionId: b.sessionId });

    expect(stopped).toMatchObject({
      error: {
        code: "control_store_unavailable",
        stage: "event",
        sessionId: a.sessionId,
        eventType: "message",
        cause: { kind: "io", message: "A_EVENT_WRITE_IO" },
        cleanupCause: {
          kind: "closed",
          message: expect.stringContaining("B_STOP_NATIVE"),
        },
        cleanupSessionId: b.sessionId,
      },
    });
    expect(stopped).not.toHaveProperty("error.operationKey");
    expect(qoder.calls.terminated).toContain(b.sessionId);

    allowStopB = true;
    connection.close();
    await expect(daemon.stop()).rejects.toThrow();
    await expect(running).rejects.toThrow();
  });

  test("自主回合提交失败会停止worker并结束既有观察", async () => {
    const backingStore = createInMemoryControlStore();
    const controlStore: ControlStore = {
      ...backingStore,
      recordEvent(event, session) {
        if (event.type === "turn.started" && event.origin?.kind === "harness")
          throw new Error("AUTONOMOUS_TURN_EVENT_IO");
        return backingStore.recordEvent(event, session);
      },
    };
    const codex = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const server = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport: server,
      adapters: new Map([["codex", codex.adapter]]),
      identity: testIdentity,
      diagnostics: testDiagnostics,
      runtimeScopeId: testRuntimeScopeId,
      controlStore,
      idleTimeoutMs: 60_000,
    });
    const running = daemon.start();
    const connection = server.connect();
    const requester = makeRequester(connection);
    const spawned = resultOf(
      await requester("spawn", {
        harness: "codex",
        sessionLabel: "autonomous-commit-failure",
        message: "创建可观察会话",
      }),
    ) as { sessionId: SessionId; turnId: TurnId };
    codex.controls.completeTurn();
    const observations = collectNotifications(connection);
    expect(
      resultOf(
        await requester("attach", {
          scope: "session",
          sessionId: spawned.sessionId,
          start: { mode: "snapshot" },
        }),
      ),
    ).toMatchObject({ initial: { mode: "snapshot" } });

    await expect(
      codex.controls.beginAutonomousTurn({
        source: { kind: "fixture_job", id: "job-uncommitted" },
        causedBy: { turnId: spawned.turnId },
      }),
    ).rejects.toThrow("AUTONOMOUS_TURN_EVENT_IO");
    await waitFor(() => codex.calls.terminated.includes(spawned.sessionId));
    await vi.waitFor(() =>
      expect(observations.ended).toContainEqual({
        sessionId: spawned.sessionId,
        reason: "control_unavailable",
      }),
    );

    expect(
      backingStore
        .sessionEvents(spawned.sessionId)
        .some(
          (entry) =>
            entry.event.type === "turn.started" &&
            entry.event.origin?.kind === "harness",
        ),
    ).toBe(false);
    expect(observations.events).not.toContainEqual(
      expect.objectContaining({
        type: "turn.started",
        sessionId: spawned.sessionId,
        origin: expect.objectContaining({ kind: "harness" }),
      }),
    );
    expect(codex.calls.terminated).toEqual([spawned.sessionId]);

    connection.close();
    await expect(daemon.stop()).rejects.toThrow();
    await expect(running).rejects.toThrow();
  });

  test("caller新回合进入原生接受阶段后拒绝竞争的自主回合", async () => {
    let releaseDelivery!: () => void;
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
      deliver: async () => deliveryGate,
    });
    const backingStore = createInMemoryControlStore();
    const server = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport: server,
      adapters: new Map([["codex", fake.adapter]]),
      identity: testIdentity,
      diagnostics: testDiagnostics,
      runtimeScopeId: testRuntimeScopeId,
      controlStore: backingStore,
      idleTimeoutMs: 60_000,
    });
    daemons.push(daemon);
    void daemon.start();
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);
    const spawned = resultOf(
      await requester("spawn", {
        harness: "codex",
        sessionLabel: "autonomous-caller-race",
        message: "初始回合",
      }),
    ) as { sessionId: SessionId; turnId: TurnId };
    fake.controls.completeTurn();

    const sending = requester("send", {
      placement: "new_turn",
      sessionId: spawned.sessionId,
      message: "caller先进入原生接受",
    });
    let autonomousFailure: unknown;
    try {
      await waitFor(() => fake.calls.delivered.length === 1);
      await fake.controls.beginAutonomousTurn({
        source: { kind: "fixture_job", id: "caller-race" },
        causedBy: { turnId: spawned.turnId },
      });
    } catch (error) {
      autonomousFailure = error;
    } finally {
      releaseDelivery();
    }
    expect(autonomousFailure).toMatchObject({ code: "session_busy" });
    expect(resultOf(await sending)).toMatchObject({
      deliveryPoint: "new_turn",
    });
    expect(
      backingStore
        .sessionEvents(spawned.sessionId)
        .filter(
          (entry) =>
            entry.event.type === "turn.started" &&
            entry.event.origin?.kind === "caller",
        ),
    ).toHaveLength(2);
    expect(
      backingStore
        .sessionEvents(spawned.sessionId)
        .some(
          (entry) =>
            entry.event.type === "turn.started" &&
            entry.event.origin?.kind === "harness",
        ),
    ).toBe(false);
    client.close();
  });

  test("自有资源释放失败且故障记录未落盘时查询保留已确认关闭效果", async () => {
    const backingStore = createInMemoryControlStore();
    let queryUnavailable = false;
    const controlStore: ControlStore = {
      ...backingStore,
      failKill() {
        throw new Error("kill failure write failed");
      },
      getOperation(operationKey) {
        if (queryUnavailable) throw new Error("operation query unavailable");
        return backingStore.getOperation(operationKey);
      },
    };
    let terminationAttempts = 0;
    let closedSessionId: SessionId | undefined;
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
      terminate: async (sessionId) => {
        terminationAttempts += 1;
        if (terminationAttempts === 1) {
          closedSessionId = sessionId;
          throw {
            code: "internal_error",
            cause: { kind: "closed", message: "owned resource release failed" },
            effect: { kind: "session_closed", sessionId },
          };
        }
      },
    });
    const server = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport: server,
      adapters: new Map([["codex", fake.adapter]]),
      identity: testIdentity,
      diagnostics: testDiagnostics,
      runtimeScopeId: testRuntimeScopeId,
      controlStore,
      idleTimeoutMs: 60_000,
    });
    daemons.push(daemon);
    const running = daemon.start();
    const connection = server.connect();
    const requester = makeRequester(connection);
    const spawned = resultOf(
      await requester("spawn", {
        harness: "codex",
        message: "partially closed worker",
      }),
    ) as { sessionId: SessionId };
    const other = resultOf(
      await requester("spawn", {
        harness: "codex",
        message: "worker outside the original kill request",
      }),
    ) as { sessionId: SessionId };
    await requester("list", {});
    const operationKey = testOperationKey(connection, "kill");
    const stopped = await sendRaw(connection, {
      kind: "request",
      requestId: "kill-partial-effect",
      method: "kill",
      params: { sessionId: spawned.sessionId },
      operationKey,
    });
    expect(stopped).toMatchObject({
      error: {
        code: "internal_error",
        cause: { kind: "closed" },
        cleanupCause: { kind: "io", message: "kill failure write failed" },
        effect: {
          kind: "session_closed",
          sessionId: spawned.sessionId,
        },
      },
    });
    await expect(
      sendRaw(connection, {
        kind: "request",
        requestId: "kill-partial-effect-same-key-retry",
        method: "kill",
        params: { sessionId: spawned.sessionId },
        operationKey,
      }),
    ).resolves.toMatchObject({
      error: {
        code: "internal_error",
        cause: { kind: "closed" },
        cleanupCause: { kind: "io", message: "kill failure write failed" },
        effect: {
          kind: "session_closed",
          sessionId: spawned.sessionId,
        },
      },
    });
    expect(terminationAttempts).toBe(1);
    expect(closedSessionId).toBe(spawned.sessionId);
    const uncommitted = await requester("getOperation", { operationKey });
    expect(resultOf(uncommitted)).toMatchObject({
      status: "partial_effect_uncommitted",
      operationKey,
      error: {
        code: "internal_error",
        effect: {
          kind: "session_closed",
          sessionId: spawned.sessionId,
        },
      },
      cause: { kind: "io", message: "kill failure write failed" },
    });

    queryUnavailable = true;
    expect(
      resultOf(await requester("getOperation", { operationKey })),
    ).toMatchObject({
      status: "partial_effect_unconfirmed",
      operationKey,
      error: {
        code: "internal_error",
        effect: {
          kind: "session_closed",
          sessionId: spawned.sessionId,
        },
      },
      cause: { kind: "io" },
    });
    await expect(
      sendRaw(connection, {
        kind: "request",
        requestId: "kill-partial-effect-unconfirmed-retry",
        method: "kill",
        params: { sessionId: spawned.sessionId },
        operationKey,
      }),
    ).resolves.toMatchObject({
      error: {
        code: "internal_error",
        cause: { kind: "closed" },
        cleanupCause: { kind: "io", message: "kill failure write failed" },
        effect: {
          kind: "session_closed",
          sessionId: spawned.sessionId,
        },
      },
    });
    expect(terminationAttempts).toBe(1);
    await expect(
      sendRaw(connection, {
        kind: "request",
        requestId: "kill-partial-effect-changed-target",
        method: "kill",
        params: { sessionId: other.sessionId },
        operationKey,
      }),
    ).resolves.toMatchObject({
      error: { code: "operation_key_conflict" },
    });
    expect(terminationAttempts).toBe(1);
    expect(backingStore.getSession(spawned.sessionId)?.info.state).toBe("busy");
    expect(
      backingStore
        .sessionEvents(spawned.sessionId)
        .some(({ event }) => event.type === "session.killed"),
    ).toBe(false);
    await expect(
      sendRaw(connection, {
        kind: "request",
        requestId: "kill-partial-effect-new-key",
        method: "kill",
        params: { sessionId: spawned.sessionId },
        operationKey: testOperationKey(connection, "kill"),
      }),
    ).resolves.toMatchObject({
      result: { sessionId: spawned.sessionId, status: "killed" },
    });
    expect(terminationAttempts).toBe(2);
    connection.close();
    await daemon.stop();
    await expect(running).resolves.toBeUndefined();
  });

  test("关闭效果已知但操作查询失败时同一key不重复释放资源", async () => {
    const backingStore = createInMemoryControlStore();
    let queryUnavailable = false;
    const controlStore: ControlStore = {
      ...backingStore,
      failKill() {
        throw new Error("kill failure write failed");
      },
      getOperation(operationKey) {
        if (queryUnavailable) throw new Error("operation query unavailable");
        return backingStore.getOperation(operationKey);
      },
    };
    let terminationAttempts = 0;
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
      terminate: async (sessionId) => {
        terminationAttempts += 1;
        if (terminationAttempts === 1)
          throw {
            code: "internal_error",
            cause: { kind: "closed", message: "owned resource release failed" },
            effect: { kind: "session_closed", sessionId },
          };
      },
    });
    const server = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport: server,
      adapters: new Map([["codex", fake.adapter]]),
      identity: testIdentity,
      diagnostics: testDiagnostics,
      runtimeScopeId: testRuntimeScopeId,
      controlStore,
      idleTimeoutMs: 60_000,
    });
    daemons.push(daemon);
    const running = daemon.start();
    const connection = server.connect();
    const requester = makeRequester(connection);
    const spawned = resultOf(
      await requester("spawn", {
        harness: "codex",
        message: "close confirmed while result persistence is unreadable",
      }),
    ) as { sessionId: SessionId };
    const operationKey = testOperationKey(connection, "kill");
    queryUnavailable = true;
    await expect(
      sendRaw(connection, {
        kind: "request",
        requestId: "kill-partial-effect-unconfirmed-first",
        method: "kill",
        params: { sessionId: spawned.sessionId },
        operationKey,
      }),
    ).resolves.toMatchObject({
      error: {
        code: "internal_error",
        cause: { kind: "closed" },
        cleanupCause: { kind: "io", message: "kill failure write failed" },
        effect: {
          kind: "session_closed",
          sessionId: spawned.sessionId,
        },
      },
    });
    expect(
      resultOf(await requester("getOperation", { operationKey })),
    ).toMatchObject({
      status: "partial_effect_unconfirmed",
      operationKey,
      error: {
        code: "internal_error",
        effect: {
          kind: "session_closed",
          sessionId: spawned.sessionId,
        },
      },
    });
    await expect(
      sendRaw(connection, {
        kind: "request",
        requestId: "kill-partial-effect-unconfirmed-same-key",
        method: "kill",
        params: { sessionId: spawned.sessionId },
        operationKey,
      }),
    ).resolves.toMatchObject({
      error: {
        code: "internal_error",
        cause: { kind: "closed" },
        cleanupCause: { kind: "io", message: "kill failure write failed" },
        effect: {
          kind: "session_closed",
          sessionId: spawned.sessionId,
        },
      },
    });
    expect(terminationAttempts).toBe(1);

    queryUnavailable = false;
    expect(
      resultOf(await requester("getOperation", { operationKey })),
    ).toMatchObject({
      status: "partial_effect_uncommitted",
      operationKey,
      error: {
        code: "internal_error",
        effect: {
          kind: "session_closed",
          sessionId: spawned.sessionId,
        },
      },
    });
    await expect(
      sendRaw(connection, {
        kind: "request",
        requestId: "kill-partial-effect-unconfirmed-new-key",
        method: "kill",
        params: { sessionId: spawned.sessionId },
        operationKey: testOperationKey(connection, "kill"),
      }),
    ).resolves.toMatchObject({
      result: { sessionId: spawned.sessionId, status: "killed" },
    });
    expect(terminationAttempts).toBe(2);
    connection.close();
    await daemon.stop();
    await expect(running).resolves.toBeUndefined();
  });

  test("部分关闭已知后不因pending或缺少记录而重复清理", async () => {
    const backingStore = createInMemoryControlStore();
    let pendingOperationKey: string | undefined;
    let unregisteredOperationKey: string | undefined;
    let failPendingMarker = true;
    let failUnregisteredOnce = true;
    let pendingMarkerAttempts = 0;
    let unregisteredAttempts = 0;
    const controlStore: ControlStore = {
      ...backingStore,
      registerKill(input) {
        if (input.operationKey === unregisteredOperationKey) {
          unregisteredAttempts += 1;
          if (failUnregisteredOnce) {
            failUnregisteredOnce = false;
            throw new Error("kill registration failed before writing");
          }
        }
        return backingStore.registerKill(input);
      },
      markKillDispatched(operationKey) {
        if (operationKey === pendingOperationKey) pendingMarkerAttempts += 1;
        if (operationKey === pendingOperationKey && failPendingMarker) {
          failPendingMarker = false;
          throw new Error("kill dispatch marker failed before writing");
        }
        if (backingStore.getOperation(operationKey) === undefined)
          throw new Error("kill dispatch marker has no registered operation");
        return backingStore.markKillDispatched(operationKey);
      },
      failKill() {
        throw new Error("kill failure write failed");
      },
    };
    const attempts = new Map<SessionId, number>();
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
      terminate: async (sessionId) => {
        const count = (attempts.get(sessionId) ?? 0) + 1;
        attempts.set(sessionId, count);
        if (count === 1)
          throw {
            code: "internal_error",
            cause: { kind: "closed", message: "owned resource release failed" },
            effect: { kind: "session_closed", sessionId },
          };
      },
    });
    const server = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport: server,
      adapters: new Map([["codex", fake.adapter]]),
      identity: testIdentity,
      diagnostics: testDiagnostics,
      runtimeScopeId: testRuntimeScopeId,
      controlStore,
      idleTimeoutMs: 60_000,
    });
    daemons.push(daemon);
    const running = daemon.start();
    const connection = server.connect();
    const requester = makeRequester(connection);
    const pendingSession = resultOf(
      await requester("spawn", {
        harness: "codex",
        message: "pending kill record after marker write failure",
      }),
    ) as { sessionId: SessionId };
    const unregisteredSession = resultOf(
      await requester("spawn", {
        harness: "codex",
        message: "no kill record after registration write failure",
      }),
    ) as { sessionId: SessionId };
    pendingOperationKey = testOperationKey(connection, "kill");
    unregisteredOperationKey = testOperationKey(connection, "kill");

    await expect(
      sendRaw(connection, {
        kind: "request",
        requestId: "kill-pending-partial-first",
        method: "kill",
        params: { sessionId: pendingSession.sessionId },
        operationKey: pendingOperationKey,
      }),
    ).resolves.toMatchObject({
      error: {
        code: "internal_error",
        effect: {
          kind: "session_closed",
          sessionId: pendingSession.sessionId,
        },
      },
    });
    await expect(
      sendRaw(connection, {
        kind: "request",
        requestId: "kill-pending-partial-same-key",
        method: "kill",
        params: { sessionId: pendingSession.sessionId },
        operationKey: pendingOperationKey,
      }),
    ).resolves.toMatchObject({
      error: {
        code: "internal_error",
        effect: {
          kind: "session_closed",
          sessionId: pendingSession.sessionId,
        },
      },
    });
    expect(attempts.get(pendingSession.sessionId)).toBe(1);
    expect(pendingMarkerAttempts).toBe(1);

    await expect(
      sendRaw(connection, {
        kind: "request",
        requestId: "kill-unregistered-partial-first",
        method: "kill",
        params: { sessionId: unregisteredSession.sessionId },
        operationKey: unregisteredOperationKey,
      }),
    ).resolves.toMatchObject({
      error: {
        code: "internal_error",
        effect: {
          kind: "session_closed",
          sessionId: unregisteredSession.sessionId,
        },
      },
    });
    expect(
      resultOf(
        await requester("getOperation", {
          operationKey: unregisteredOperationKey,
        }),
      ),
    ).toMatchObject({
      status: "partial_effect_uncommitted",
      operationKey: unregisteredOperationKey,
      error: {
        code: "internal_error",
        effect: {
          kind: "session_closed",
          sessionId: unregisteredSession.sessionId,
        },
      },
    });
    await expect(
      sendRaw(connection, {
        kind: "request",
        requestId: "kill-unregistered-partial-same-key",
        method: "kill",
        params: { sessionId: unregisteredSession.sessionId },
        operationKey: unregisteredOperationKey,
      }),
    ).resolves.toMatchObject({
      error: {
        code: "internal_error",
        effect: {
          kind: "session_closed",
          sessionId: unregisteredSession.sessionId,
        },
      },
    });
    expect(attempts.get(unregisteredSession.sessionId)).toBe(1);
    expect(unregisteredAttempts).toBe(1);
    connection.close();
    await daemon.stop();
    await expect(running).resolves.toBeUndefined();
  });

  test("关闭未知时查询保留确认失败与自有资源清理次因", async () => {
    const backingStore = createInMemoryControlStore();
    let terminationAttempts = 0;
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
      terminate: async () => {
        terminationAttempts += 1;
        if (terminationAttempts === 1)
          throw {
            code: "internal_error",
            cause: { kind: "timeout", message: "thread/delete timed out" },
            cleanupCause: {
              kind: "closed",
              message: "owned transport cleanup failed",
            },
          };
      },
    });
    const server = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport: server,
      adapters: new Map([["codex", fake.adapter]]),
      identity: testIdentity,
      diagnostics: testDiagnostics,
      runtimeScopeId: testRuntimeScopeId,
      controlStore: backingStore,
      idleTimeoutMs: 60_000,
    });
    const running = daemon.start();
    const connection = server.connect();
    const requester = makeRequester(connection);
    const spawned = resultOf(
      await requester("spawn", {
        harness: "codex",
        sessionLabel: "kill-close-unknown",
        message: "等待官方关闭确认",
      }),
    ) as { sessionId: SessionId };
    const operationKey = testOperationKey(connection, "kill");
    const stopped = await sendRaw(connection, {
      kind: "request",
      requestId: "kill-close-unknown",
      method: "kill",
      params: { sessionId: spawned.sessionId },
      operationKey,
    });

    expect(stopped).toMatchObject({
      error: {
        code: "operation_outcome_unknown",
        operationKey,
        cause: { kind: "timeout", message: "thread/delete timed out" },
        cleanupCause: {
          kind: "closed",
          message: "owned transport cleanup failed",
        },
      },
    });
    expect(
      resultOf(await requester("getOperation", { operationKey })),
    ).toMatchObject({
      status: "outcome_unknown",
      operationKey,
      cause: { kind: "timeout", message: "thread/delete timed out" },
      cleanupCause: {
        kind: "closed",
        message: "owned transport cleanup failed",
      },
    });
    expect(backingStore.getSession(spawned.sessionId)?.info.state).toBe("busy");
    expect(
      backingStore
        .sessionEvents(spawned.sessionId)
        .some(({ event }) => event.type === "session.killed"),
    ).toBe(false);
    expect(terminationAttempts).toBe(1);

    connection.close();
    await daemon.stop();
    await running;
  });

  test("普通事件写入失败会停止对应worker并隔离其他会话", async () => {
    const backingStore = createInMemoryControlStore();
    let failEventWrite = false;
    const controlStore: ControlStore = {
      ...backingStore,
      recordEvent(event, session) {
        if (failEventWrite) throw new Error("事件正文写入失败");
        return backingStore.recordEvent(event, session);
      },
    };
    const codex = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const qoder = createFakeHarness({
      harness: "qoder",
      modelCatalog: emptyModelCatalog("qoder"),
    });
    const server = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport: server,
      adapters: new Map([
        ["codex", codex.adapter],
        ["qoder", qoder.adapter],
      ]),
      identity: testIdentity,
      diagnostics: testDiagnostics,
      runtimeScopeId: testRuntimeScopeId,
      controlStore,
      idleTimeoutMs: 60_000,
    });
    const running = daemon.start();
    const connection = server.connect();
    const requester = makeRequester(connection);
    const first = resultOf(
      await requester("spawn", {
        harness: "codex",
        sessionLabel: "event-write-failure",
        message: "运行 A",
      }),
    ) as { sessionId: SessionId };
    const second = resultOf(
      await requester("spawn", {
        harness: "qoder",
        sessionLabel: "unaffected-session",
        message: "运行 B",
      }),
    ) as { sessionId: SessionId };

    const observations = collectNotifications(connection);
    expect(
      resultOf(
        await requester("attach", {
          scope: "session",
          sessionId: first.sessionId,
          start: { mode: "snapshot" },
        }),
      ),
    ).toMatchObject({ initial: { mode: "snapshot" } });
    expect(
      resultOf(
        await requester("attach", {
          scope: "session",
          sessionId: second.sessionId,
          start: { mode: "snapshot" },
        }),
      ),
    ).toMatchObject({ initial: { mode: "snapshot" } });
    codex.controls.emitWorkerMessage("A 已提交正文");
    qoder.controls.emitWorkerMessage("B 已提交正文");
    await vi.waitFor(() =>
      expect(
        observations.events.filter(
          (event) =>
            event.type === "message" &&
            (event.sessionId === first.sessionId ||
              event.sessionId === second.sessionId),
        ),
      ).toHaveLength(2),
    );

    failEventWrite = true;
    codex.controls.emitWorkerMessage("正文无法提交");
    await waitFor(() => codex.calls.terminated.includes(first.sessionId));
    await vi.waitFor(() => expect(observations.ended).toHaveLength(2));

    expect(codex.calls.terminated).toEqual([first.sessionId]);
    expect(qoder.calls.terminated).toEqual([]);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(observations.events).toMatchObject([
      {
        type: "message",
        sessionId: first.sessionId,
        content: "A 已提交正文",
      },
      {
        type: "message",
        sessionId: second.sessionId,
        content: "B 已提交正文",
      },
    ]);
    expect(observations.events).not.toContainEqual(
      expect.objectContaining({
        type: "message",
        sessionId: first.sessionId,
        content: "正文无法提交",
      }),
    );
    expect(observations.ended).toEqual([
      { sessionId: first.sessionId, reason: "control_unavailable" },
      { sessionId: second.sessionId, reason: "control_unavailable" },
    ]);
    expect(
      resultOf(
        await requester("wait", {
          targets: [{ sessionId: first.sessionId, turnId: "t1" }],
          completion: "all",
          timeoutMs: 0,
        }),
      ),
    ).toMatchObject({
      status: "unreachable",
      unreachable: [
        { sessionId: first.sessionId, reason: "commit_unavailable" },
      ],
    });
    expect(
      resultOf(
        await requester("attach", {
          scope: "session",
          sessionId: first.sessionId,
          start: { mode: "snapshot" },
        }),
      ),
    ).toMatchObject({
      initial: {
        mode: "snapshot",
        baseline: {
          session: {
            state: "unreachable",
            unreachableReason: "commit_unavailable",
          },
        },
      },
    });
    expect(
      resultOf(
        await requester("attach", {
          scope: "session",
          sessionId: second.sessionId,
          start: { mode: "snapshot" },
        }),
      ),
    ).toMatchObject({
      initial: {
        mode: "snapshot",
        baseline: {
          session: {
            state: "unreachable",
            unreachableReason: "commit_unavailable",
          },
        },
      },
    });
    await vi.waitFor(() => expect(observations.ended).toHaveLength(4));
    expect(observations.ended.slice(2)).toEqual([
      { sessionId: first.sessionId, reason: "control_unavailable" },
      { sessionId: second.sessionId, reason: "control_unavailable" },
    ]);
    connection.close();
    await expect(daemon.stop()).rejects.toThrow();
    await expect(running).rejects.toThrow();
  });

  test("提交已落盘但回执丢失时保留持久成功结果", async () => {
    const backingStore = createInMemoryControlStore();
    let lostAcknowledgment = true;
    const controlStore: ControlStore = {
      ...backingStore,
      commitSpawn(input) {
        const committed = backingStore.commitSpawn(input);
        if (lostAcknowledgment) {
          lostAcknowledgment = false;
          throw new Error("injected lost commit acknowledgment");
        }
        return committed;
      },
    };
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const server = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport: server,
      adapters: new Map([["codex", fake.adapter]]),
      identity: testIdentity,
      diagnostics: testDiagnostics,
      runtimeScopeId: testRuntimeScopeId,
      controlStore,
      idleTimeoutMs: 60_000,
    });
    daemons.push(daemon);
    const running = daemon.start();
    const connection = server.connect();
    await makeRequester(connection)("initialize", {
      protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
      consumerContext: "test-consumer",
    });
    const operationKey = testOperationKey(
      connection,
      "spawn",
      "01234567-0123-4123-8123-0123456789ac",
    );
    const spawned = await sendRaw(connection, {
      kind: "request",
      requestId: "spawn-after-commit-ack-loss",
      method: "spawn",
      operationKey,
      params: {
        harness: "codex",
        sessionLabel: "durable-after-ack-loss",
        cwd: "/tmp",
        message: "start once",
      },
    });
    expect(spawned).toHaveProperty("result");
    const operation = await sendRaw(connection, {
      kind: "request",
      requestId: "read-after-commit-ack-loss",
      method: "getOperation",
      params: { operationKey },
    });
    expect(operation).toMatchObject({
      result: { status: "succeeded", operationKey },
    });
    expect(fake.calls.starts).toBe(1);
    expect(fake.calls.terminated).toHaveLength(0);
    connection.close();
    await daemon.stop();
    await running;
  });

  test("接受已知但提交状态无法核实时，同键重试保留接受事实", async () => {
    const backingStore = createInMemoryControlStore();
    let commitPending = true;
    let verificationUnavailable = false;
    const controlStore: ControlStore = {
      ...backingStore,
      commitSpawn() {
        if (commitPending) {
          commitPending = false;
          verificationUnavailable = true;
          throw new Error("spawn 提交回执丢失");
        }
        throw new Error("spawn 不应重复提交");
      },
      getOperation(operationKey) {
        if (verificationUnavailable)
          throw new Error("spawn 提交状态核验不可用");
        return backingStore.getOperation(operationKey);
      },
    };
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const server = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport: server,
      adapters: new Map([["codex", fake.adapter]]),
      identity: testIdentity,
      diagnostics: testDiagnostics,
      runtimeScopeId: testRuntimeScopeId,
      controlStore,
      idleTimeoutMs: 60_000,
    });
    daemons.push(daemon);
    const running = daemon.start();
    const connection = server.connect();
    await makeRequester(connection)("initialize", {
      protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
      consumerContext: "test-consumer",
    });
    const operationKey = testOperationKey(
      connection,
      "spawn",
      "01234567-0123-4123-8123-0123456789bd",
    );
    const request = {
      kind: "request",
      method: "spawn",
      operationKey,
      params: {
        harness: "codex",
        sessionLabel: "accepted-unconfirmed",
        cwd: "/tmp",
        message: "保留首次已接受的结果",
      },
    } as const;
    const first = await sendRaw(connection, {
      ...request,
      requestId: "spawn-unconfirmed-first",
    });
    expect(first).toMatchObject({
      error: {
        code: "control_store_unavailable",
        stage: "commit",
        acceptance: "accepted",
      },
    });
    const retry = await sendRaw(connection, {
      ...request,
      requestId: "spawn-unconfirmed-retry",
    });
    expect(retry).toMatchObject({
      error: {
        code: "control_store_unavailable",
        stage: "commit",
        acceptance: "accepted",
      },
    });
    const queried = await sendRaw(connection, {
      kind: "request",
      requestId: "spawn-unconfirmed-query",
      method: "getOperation",
      params: { operationKey },
    });
    expect(queried).toMatchObject({
      result: {
        status: "accepted_unconfirmed",
        operationKey,
        result: { sessionId: expect.any(String) },
      },
    });
    expect(fake.calls.starts).toBe(1);
    connection.close();
    await daemon.stop();
    await running;
  });

  test("原生接受仍在等待时查询为处理中，接受后查询为成功", async () => {
    let startInvokedResolve!: () => void;
    const startInvoked = new Promise<void>((resolve) => {
      startInvokedResolve = resolve;
    });
    let acceptResolve!: () => void;
    const accepted = new Promise<void>((resolve) => {
      acceptResolve = resolve;
    });
    const driver: WorkerDriver = {
      async start() {
        startInvokedResolve();
        await accepted;
      },
      async deliver() {},
      async interrupt() {},
      resolvePermission() {},
      async terminate() {},
    };
    const adapter: HarnessAdapter = {
      driverFactory: () => driver,
      async modelCatalog() {
        return emptyModelCatalog("codex");
      },
    };
    const server = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport: server,
      adapters: new Map([["codex", adapter]]),
      identity: testIdentity,
      diagnostics: testDiagnostics,
      runtimeScopeId: testRuntimeScopeId,
      controlStore: createInMemoryControlStore(),
      idleTimeoutMs: 60_000,
    });
    const running = daemon.start();
    const connection = server.connect();
    await makeRequester(connection)("initialize", {
      protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
      consumerContext: "test-consumer",
    });
    const operationKey = testOperationKey(
      connection,
      "spawn",
      "01234567-0123-4123-8123-0123456789ad",
    );
    const spawn = sendRaw(connection, {
      kind: "request",
      requestId: "spawn-while-accepting",
      method: "spawn",
      operationKey,
      params: {
        harness: "codex",
        sessionLabel: "acceptance-pending",
        cwd: "/tmp",
        message: "wait for native acceptance",
      },
    });
    await startInvoked;

    const duringStart = await sendRaw(connection, {
      kind: "request",
      requestId: "read-while-accepting",
      method: "getOperation",
      params: { operationKey },
    });
    expect(duringStart).toMatchObject({
      result: { status: "pending", operationKey },
    });

    acceptResolve();
    expect(await spawn).toHaveProperty("result");
    const afterStart = await sendRaw(connection, {
      kind: "request",
      requestId: "read-after-acceptance",
      method: "getOperation",
      params: { operationKey },
    });
    expect(afterStart).toMatchObject({
      result: { status: "succeeded", operationKey },
    });
    connection.close();
    await daemon.stop();
    await running;
  });

  test("启动接受未知且停止失败时查询保留两个原因", async () => {
    let terminationAttempts = 0;
    const driver: WorkerDriver = {
      async start() {
        throw new WorkerStartFailure("原生队列回执丢失", "unknown");
      },
      async deliver() {},
      async interrupt() {},
      resolvePermission() {},
      async terminate() {
        terminationAttempts += 1;
        if (terminationAttempts === 1) throw new Error("原生关闭确认失败");
      },
    };
    const adapter: HarnessAdapter = {
      driverFactory: () => driver,
      async modelCatalog() {
        return emptyModelCatalog("codex");
      },
    };
    const server = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport: server,
      adapters: new Map([["codex", adapter]]),
      identity: testIdentity,
      diagnostics: testDiagnostics,
      runtimeScopeId: testRuntimeScopeId,
      controlStore: createInMemoryControlStore(),
      idleTimeoutMs: 60_000,
    });
    const running = daemon.start();
    const connection = server.connect();
    await makeRequester(connection)("initialize", {
      protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
      consumerContext: "test-consumer",
    });
    const operationKey = testOperationKey(
      connection,
      "spawn",
      "01234567-0123-4123-8123-0123456789ae",
    );
    const failed = await sendRaw(connection, {
      kind: "request",
      requestId: "spawn-acceptance-unknown",
      method: "spawn",
      operationKey,
      params: {
        harness: "codex",
        sessionLabel: "unknown-acceptance",
        cwd: "/tmp",
        message: "observe unknown acceptance",
      },
    });
    expect(failed).toMatchObject({
      error: {
        code: "operation_outcome_unknown",
        cause: { message: expect.stringContaining("原生队列回执丢失") },
        cleanupCause: {
          message: expect.stringContaining("原生关闭确认失败"),
        },
      },
    });

    const queried = await sendRaw(connection, {
      kind: "request",
      requestId: "read-acceptance-unknown",
      method: "getOperation",
      params: { operationKey },
    });
    expect(queried).toMatchObject({
      result: {
        status: "outcome_unknown",
        operationKey,
        cause: { message: expect.stringContaining("原生队列回执丢失") },
        cleanupCause: {
          message: expect.stringContaining("原生关闭确认失败"),
        },
      },
    });
    expect(terminationAttempts).toBe(1);
    connection.close();
    await daemon.stop();
    await running;
    expect(terminationAttempts).toBe(2);
  });

  test("明确未接受且停止失败时持久失败保留两个原因", async () => {
    let terminationAttempts = 0;
    const driver: WorkerDriver = {
      async start() {
        throw new WorkerStartFailure("原生启动明确拒绝", "not_accepted");
      },
      async deliver() {},
      async interrupt() {},
      resolvePermission() {},
      async terminate() {
        terminationAttempts += 1;
        if (terminationAttempts === 1) throw new Error("启动后资源停止失败");
      },
    };
    const adapter: HarnessAdapter = {
      driverFactory: () => driver,
      async modelCatalog() {
        return emptyModelCatalog("codex");
      },
    };
    const server = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport: server,
      adapters: new Map([["codex", adapter]]),
      identity: testIdentity,
      diagnostics: testDiagnostics,
      runtimeScopeId: testRuntimeScopeId,
      controlStore: createInMemoryControlStore(),
      idleTimeoutMs: 60_000,
    });
    const running = daemon.start();
    const connection = server.connect();
    await makeRequester(connection)("initialize", {
      protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
      consumerContext: "test-consumer",
    });
    const operationKey = testOperationKey(
      connection,
      "spawn",
      "01234567-0123-4123-8123-0123456789af",
    );
    const failed = await sendRaw(connection, {
      kind: "request",
      requestId: "spawn-not-accepted",
      method: "spawn",
      operationKey,
      params: {
        harness: "codex",
        sessionLabel: "not-accepted",
        cwd: "/tmp",
        message: "preserve both failures",
      },
    });
    expect(failed).toMatchObject({
      error: {
        code: "internal_error",
        cause: { message: expect.stringContaining("原生启动明确拒绝") },
        cleanupCause: {
          message: expect.stringContaining("启动后资源停止失败"),
        },
      },
    });
    const queried = await sendRaw(connection, {
      kind: "request",
      requestId: "read-not-accepted",
      method: "getOperation",
      params: { operationKey },
    });
    expect(queried).toMatchObject({
      result: {
        status: "failed",
        operationKey,
        error: {
          code: "internal_error",
          cause: { message: expect.stringContaining("原生启动明确拒绝") },
          cleanupCause: {
            message: expect.stringContaining("启动后资源停止失败"),
          },
        },
      },
    });
    expect(terminationAttempts).toBe(1);
    connection.close();
    await daemon.stop();
    await running;
    expect(terminationAttempts).toBe(2);
  });

  test("有会话时保持存活，全部清理后退出", async () => {
    vi.useFakeTimers();
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const server = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport: server,
      adapters: new Map([["codex", fake.adapter]]),
      identity: testIdentity,
      diagnostics: testDiagnostics,
      runtimeScopeId: testRuntimeScopeId,
      idleTimeoutMs: 100,
    });
    const started = daemon.start();
    const client = server.connect();
    await flush();
    const spawned = await makeRequester(client).request("spawn", {
      sessionLabel: "reviewer",
      harness: "codex",
      message: "hi",
    });
    const sessionId = (resultOf(spawned) as { sessionId: string }).sessionId;
    let settled = false;
    void started.then(() => {
      settled = true;
    });
    try {
      // busy 会话 + 无连接 → 不空闲
      client.close();
      await flush();
      vi.advanceTimersByTime(500);
      await flush();
      expect(settled).toBe(false);

      // 回合完成 → 会话仍是常驻 idle，daemon 不退出
      fake.controls.completeTurn();
      await flush();
      vi.advanceTimersByTime(500);
      await flush();
      expect(settled).toBe(false);

      // kill 全部清理后才空闲退出
      const client2 = server.connect();
      await flush();
      await makeRequester(client2).request("kill", { sessionId: sessionId });
      client2.close();
      await flush();
      vi.advanceTimersByTime(100);
      await flush();
      await expect(started).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("显式停止等待所有 worker 清理完成后才关闭 transport", async () => {
    let releaseTermination!: () => void;
    const termination = new Promise<void>((resolve) => {
      releaseTermination = resolve;
    });
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
      terminate: async () => await termination,
    });
    const server = createInMemoryTransportServer<ProtocolMessage>();
    const events: DomainEvent[] = [];
    const daemon = createDaemonForTest({
      transport: server,
      adapters: new Map([["codex", fake.adapter]]),
      identity: testIdentity,
      diagnostics: testDiagnostics,
      runtimeScopeId: testRuntimeScopeId,
      idleTimeoutMs: 60_000,
      onEvent: (event) => events.push(event),
    });
    const lifetime = daemon.start();
    const client = server.connect();
    await flush();
    await makeRequester(client).request("spawn", {
      sessionLabel: "shutdown-owner",
      harness: "codex",
      message: "hi",
    });

    let stopped = false;
    const stopping = daemon.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    expect(events.some((event) => event.type === "session.killed")).toBe(false);

    const rejected = await makeRequester(client).request("spawn", {
      sessionLabel: "must-not-start",
      harness: "codex",
      message: "late",
    });
    expect(rejected).toMatchObject({
      error: { code: "daemon_shutting_down" },
    });
    expect(fake.calls.starts).toBe(1);

    releaseTermination();
    await stopping;
    await lifetime;
    expect(events.at(-1)).toMatchObject({ type: "session.killed" });
  });

  test("启动诊断尚未接受时 stop 等待并保持 started→stopped 顺序", async () => {
    let releaseStarted!: () => void;
    const startedGate = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    let enteredStarted!: () => void;
    const startedEntered = new Promise<void>((resolve) => {
      enteredStarted = resolve;
    });
    const lifecycle: string[] = [];
    const diagnostics: DiagnosticsRuntime = {
      ...testDiagnostics,
      async record(input) {
        if (
          input.kind === "lifecycle" &&
          input.operation === "daemon" &&
          input.reason === "started"
        ) {
          enteredStarted();
          await startedGate;
        }
        if (input.kind === "lifecycle" && input.operation === "daemon") {
          lifecycle.push(input.reason);
        }
        return makeDiagnosticId(testRuntimeScopeId, "test", "1");
      },
    };
    const server = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport: server,
      adapters: new Map(),
      identity: testIdentity,
      diagnostics,
      runtimeScopeId: testRuntimeScopeId,
      idleTimeoutMs: 60_000,
    });

    const lifetime = daemon.start();
    await startedEntered;
    let stopped = false;
    const stopping = daemon.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    expect(lifecycle).toEqual([]);

    releaseStarted();
    await stopping;
    await lifetime;
    expect(lifecycle).toEqual(["started", "stopped"]);
  });

  test("started 未被接受则启动失败，queued spawn 不会创建 worker", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const diagnostics: DiagnosticsRuntime = {
      ...testDiagnostics,
      async record(input) {
        if (
          input.kind === "lifecycle" &&
          input.operation === "daemon" &&
          input.reason === "started"
        ) {
          return undefined;
        }
        return makeDiagnosticId(testRuntimeScopeId, "test", "1");
      },
    };
    const server = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport: server,
      adapters: new Map([["codex", fake.adapter]]),
      identity: testIdentity,
      diagnostics,
      runtimeScopeId: testRuntimeScopeId,
      idleTimeoutMs: 60_000,
    });
    const startup = daemon.start();
    const client = server.connect();
    // 故意在握手缺席时排队 spawn：验证启动失败路径不会放行领域动作。
    const response = sendRaw(client, {
      kind: "request",
      requestId: "raw1",
      method: "spawn",
      params: {
        sessionLabel: "queued-start",
        harness: "codex",
        message: "must not start",
      },
    });

    await expect(startup).rejects.toThrow(
      "Daemon start lifecycle was not accepted",
    );
    await daemon.stop();
    await expect(response).resolves.toMatchObject({
      requestId: "raw1",
      error: { code: "daemon_shutting_down" },
    });
    expect(fake.calls.starts).toBe(0);
  });

  test("启动与 transport 收口同时失败时保留已归一化的启动根因", async () => {
    const secretSentinel = ["listen", "root", "sentinel"].join("-");
    const startError = new Error(secretSentinel);
    const closeError = new Error("transport close rejected");
    const daemon = createDaemon({
      transport: {
        async listen() {
          throw startError;
        },
        onConnection() {
          return () => {};
        },
        async close() {
          throw closeError;
        },
      },
      adapters: new Map(),
      identity: testIdentity,
      diagnostics: testDiagnostics,
      runtimeScopeId: testRuntimeScopeId,
      idleTimeoutMs: 60_000,
    });

    const failure: unknown = await daemon
      .start()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      cause: {
        code: "io_error",
        fact: {
          kind: "transport_failure",
          operation: "listen",
          reason: "io_error",
        },
      },
      errors: [
        {
          code: "io_error",
          fact: {
            kind: "transport_failure",
            operation: "listen",
            reason: "io_error",
          },
        },
        closeError,
      ],
    });
    const aggregate = failure as AggregateError;
    expect(aggregate.errors[0]).toBe(aggregate.cause);
    expect(String(aggregate.cause).includes(secretSentinel)).toBe(false);
  });

  test("transport close 拒绝不撤销已建立的 daemon stopped logical commit", async () => {
    const backing = createInMemoryTransportServer<ProtocolMessage>();
    const lifecycle: string[] = [];
    const diagnostics: DiagnosticsRuntime = {
      ...testDiagnostics,
      async record(input) {
        if (input.kind === "lifecycle" && input.operation === "daemon") {
          lifecycle.push(input.reason);
        }
        return makeDiagnosticId(testRuntimeScopeId, "test", "1");
      },
    };
    let rejectClose = true;
    const daemon = createDaemon({
      transport: {
        listen: () => backing.listen(),
        onConnection: (listener) => backing.onConnection(listener),
        async close() {
          if (rejectClose) throw new Error("transport close rejected");
          await backing.close();
        },
      },
      adapters: new Map(),
      identity: testIdentity,
      diagnostics,
      runtimeScopeId: testRuntimeScopeId,
      idleTimeoutMs: 60_000,
    });
    const lifetime = daemon.start();
    const lifetimeFailure = expect(lifetime).rejects.toThrow(
      "transport close rejected",
    );
    await vi.waitFor(() => expect(lifecycle).toEqual(["started"]));

    await expect(daemon.stop()).rejects.toThrow("transport close rejected");
    await lifetimeFailure;
    expect(lifecycle).toEqual(["started", "stopped"]);
    rejectClose = false;
    await expect(daemon.stop()).resolves.toBeUndefined();
    expect(lifecycle).toEqual(["started", "stopped"]);
  });

  test("worker 清理失败不关闭 daemon，下一次 stop 可精确重试", async () => {
    let attempts = 0;
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
      terminate: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("cleanup rejected");
      },
    });
    const server = createInMemoryTransportServer<ProtocolMessage>();
    const events: DomainEvent[] = [];
    const daemon = createDaemonForTest({
      transport: server,
      adapters: new Map([["codex", fake.adapter]]),
      identity: testIdentity,
      diagnostics: testDiagnostics,
      runtimeScopeId: testRuntimeScopeId,
      idleTimeoutMs: 60_000,
      onEvent: (event) => events.push(event),
    });
    const lifetime = daemon.start();
    const client = server.connect();
    await flush();
    await makeRequester(client).request("spawn", {
      sessionLabel: "retry-shutdown",
      harness: "codex",
      message: "hi",
    });

    await expect(daemon.stop()).rejects.toThrow("Worker cleanup failed");
    expect(events.some((event) => event.type === "session.killed")).toBe(false);
    let lifetimeSettled = false;
    void lifetime.then(() => {
      lifetimeSettled = true;
    });
    await flush();
    expect(lifetimeSettled).toBe(false);

    await expect(daemon.stop()).resolves.toBeUndefined();
    await lifetime;
    expect(attempts).toBe(2);
    expect(events.at(-1)).toMatchObject({ type: "session.killed" });
  });
});

describe("daemon 消费者范围（01 票第 2 项）", () => {
  test("异消费者的句柄动作与查询把他人会话按不存在呈现", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const { server } = startDaemon(new Map([["codex", fake.adapter]]));
    const alphaClient = server.connect();
    const betaClient = server.connect();
    await flush();
    const alpha = makeRequester(alphaClient, "alpha");
    const beta = makeRequester(betaClient, "beta");

    const spawned = await alpha("spawn", {
      sessionLabel: "owned-by-alpha",
      harness: "codex",
      message: "hello",
    });
    const sessionId = (resultOf(spawned) as { sessionId: string }).sessionId;
    fake.controls.completeTurn();

    expect(resultOf(await alpha("list", {}))).toHaveLength(1);

    const sent = await beta("send", {
      placement: "new_turn",
      sessionId,
      message: "侵入",
    });
    expect(sent).toMatchObject({ error: { code: "session_not_found" } });
    expect(fake.calls.delivered).toEqual([]);

    const waited = await beta("wait", {
      targets: [{ sessionId, turnId: "t1" }],
      completion: "all",
      timeoutMs: 1000,
    });
    expect(waited).toMatchObject({ error: { code: "session_not_found" } });

    const interrupted = await beta("interrupt", { sessionId, turnId: "t1" });
    expect(interrupted).toMatchObject({ error: { code: "session_not_found" } });
    expect(fake.calls.interrupted).toEqual([]);

    const attached = await beta("attach", {
      scope: "session",
      sessionId,
      start: { mode: "history" },
    });
    expect(attached).toMatchObject({ error: { code: "session_not_found" } });

    const killed = await beta("kill", { sessionId: sessionId });
    expect(resultOf(killed)).toEqual({ sessionId, status: "not_found" });
    expect(fake.calls.terminated).toEqual([]);

    expect(resultOf(await beta("list", {}))).toEqual([]);

    const alphaKilled = await alpha("kill", { sessionId: sessionId });
    expect(resultOf(alphaKilled)).toEqual({ sessionId, status: "killed" });
  });

  test("同一消费者绑定跨短连接保持范围", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
    });
    const { server } = startDaemon(new Map([["codex", fake.adapter]]));
    const firstAlpha = server.connect();
    await flush();
    const sessionId = (
      resultOf(
        await makeRequester(firstAlpha, "alpha")("spawn", {
          sessionLabel: "short-lived",
          harness: "codex",
          message: "hello",
        }),
      ) as { sessionId: string }
    ).sessionId;
    fake.controls.completeTurn();
    firstAlpha.close();
    await flush();

    const secondAlpha = makeRequester(server.connect(), "alpha");
    await flush();
    const listed = await secondAlpha("list", {});
    expect(
      (resultOf(listed) as Array<{ sessionId: string }>).map(
        (session) => session.sessionId,
      ),
    ).toContain(sessionId);
    const sent = await secondAlpha("send", {
      placement: "new_turn",
      sessionId,
      message: "同绑定续用",
    });
    expect(resultOf(sent)).toMatchObject({ deliveryPoint: "new_turn" });

    const intruder = makeRequester(server.connect(), "beta");
    await flush();
    expect(resultOf(await intruder("list", {}))).toEqual([]);
    expect(
      await intruder("send", {
        placement: "new_turn",
        sessionId,
        message: "越域",
      }),
    ).toMatchObject({ error: { code: "session_not_found" } });
  });

  test("挂起权限只能由会话归属消费者决议", async () => {
    const fake = createFakeHarness({
      harness: "codex",
      modelCatalog: emptyModelCatalog("codex"),
      autoPermission: {
        options: [
          { outcome: "allow", scope: "once" },
          { outcome: "deny", feedback: false },
        ],
      },
    });
    const { server } = startDaemon(new Map([["codex", fake.adapter]]));
    const alphaClient = server.connect();
    await flush();
    const alpha = makeRequester(alphaClient, "alpha");
    const collector = collectNotifications(alphaClient);
    const spawned = await alpha("spawn", {
      sessionLabel: "guarded",
      harness: "codex",
      message: "hello",
    });
    const sessionId = (resultOf(spawned) as { sessionId: string }).sessionId;
    await alpha("attach", {
      scope: "session",
      sessionId,
      start: { mode: "history" },
    });
    const permissionEvent = collector.events.find(
      (event) => event.type === "permission.requested",
    );
    expect(permissionEvent).toBeDefined();
    const permissionId = (
      permissionEvent as Extract<DomainEvent, { type: "permission.requested" }>
    ).permissionId;

    const beta = makeRequester(server.connect(), "beta");
    await flush();
    await expect(
      beta("resolvePermission", {
        turnId: "t1",
        sessionId,
        permissionId,
        resolution: { outcome: "allow", scope: "once" },
      }),
    ).resolves.toMatchObject({ error: { code: "session_not_found" } });
    expect(fake.calls.resolved).toEqual([]);

    const resolved = await alpha("resolvePermission", {
      turnId: "t1",
      sessionId,
      permissionId,
      resolution: { outcome: "allow", scope: "once" },
    });
    expect(resultOf(resolved)).toMatchObject({ sessionId, permissionId });
    expect(fake.calls.resolved).toEqual([{ outcome: "allow", scope: "once" }]);
  });
});

test("命令结果恢复：同身份 spawn 跨连接返回原 ACK 且仅创建一次", async () => {
  const fake = createFakeHarness({
    harness: "codex",
    modelCatalog: { harness: "codex", models: [] },
  });
  const { server } = startDaemon(new Map([["codex", fake.adapter]]));
  const a = server.connect();
  const b = server.connect();
  await makeRequester(a)("initialize", {
    protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
    consumerContext: "same-consumer",
  });
  await makeRequester(b)("initialize", {
    protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
    consumerContext: "same-consumer",
  });
  const command = {
    kind: "request",
    method: "spawn",
    testOperationId: "01234567-0123-4123-8123-0123456789ab",
    params: {
      harness: "codex",
      cwd: "/tmp",
      sessionLabel: "recoverable",
      message: "caller original",
    },
  };
  const first = await sendRaw(a, { ...command, requestId: "original" });
  const replay = await sendRaw(b, { ...command, requestId: "recovered" });
  expect(first).toMatchObject({
    result: { sessionId: expect.stringMatching(testSessionIdPattern) },
  });
  expect(replay).toEqual({ ...first, requestId: "recovered" });
  expect(fake.calls.starts).toBe(1);
  a.close();
  b.close();
});

test("writer lease 丢失时保留读取、缓存结果和必要停止", async () => {
  let writerHeld = true;
  const fake = createFakeHarness({
    harness: "codex",
    modelCatalog: { harness: "codex", models: [] },
    autoPermission: { options: [{ outcome: "allow", scope: "once" }] },
  });
  const { server } = startDaemon(new Map([["codex", fake.adapter]]), {
    assertWriterLease: async () => {
      if (!writerHeld) throw new Error("writer lease lost");
    },
  });
  const a = server.connect();
  const b = server.connect();
  const consumerContext = "lease-owner";
  await makeRequester(a)("initialize", {
    protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
    consumerContext,
  });
  await makeRequester(b)("initialize", {
    protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
    consumerContext,
  });
  const original = {
    kind: "request",
    method: "spawn",
    testOperationId: "00000001-0123-4123-8123-0123456789ab",
    params: {
      harness: "codex",
      cwd: "/tmp",
      sessionLabel: "lease-keeps-facts",
      message: "start before lease loss",
    },
  };
  const spawned = await sendRaw(a, { ...original, requestId: "original" });
  expect(spawned).toHaveProperty("result.sessionId");
  writerHeld = false;

  expect(await sendRaw(b, { ...original, requestId: "cached" })).toEqual({
    ...spawned,
    requestId: "cached",
  });
  const requester = makeRequester(a);
  const sessionId = (spawned as { result: { sessionId: SessionId } }).result
    .sessionId;
  expect(resultOf(await requester("list", {}))).toMatchObject([{ sessionId }]);
  expect(
    await requester("attach", {
      scope: "session",
      sessionId,
      start: { mode: "history" },
    }),
  ).toMatchObject({
    result: { initial: { mode: "history", target: { sessionId } } },
  });
  expect(resultOf(await requester("diagnostics", { limit: 1 }))).toEqual({
    records: [],
    truncated: false,
  });

  expect(
    await sendRaw(a, {
      kind: "request",
      requestId: "new-execution",
      method: "spawn",
      testOperationId: "00000002-0123-4123-8123-0123456789ab",
      params: {
        harness: "codex",
        cwd: "/tmp",
        sessionLabel: "lease-refuses-new-execution",
        message: "must not start",
      },
    }),
  ).toMatchObject({
    error: {
      code: "internal_error",
      cause: { kind: "closed" },
    },
  });
  expect(
    await sendRaw(a, {
      kind: "request",
      requestId: "new-turn",
      method: "send",
      testOperationId: "00000005-0123-4123-8123-0123456789ab",
      params: {
        placement: "new_turn",
        sessionId,
        message: "must not send after lease loss",
      },
    }),
  ).toMatchObject({
    error: {
      code: "internal_error",
      cause: { kind: "closed" },
    },
  });
  expect(
    await sendRaw(a, {
      kind: "request",
      requestId: "continue-permission",
      method: "resolvePermission",
      testOperationId: "00000006-0123-4123-8123-0123456789ab",
      params: {
        sessionId,
        turnId: "t1",
        permissionId: "p1",
        resolution: { outcome: "allow", scope: "once" },
      },
    }),
  ).toMatchObject({
    error: {
      code: "internal_error",
      cause: { kind: "closed" },
    },
  });
  expect(fake.calls.starts).toBe(1);
  expect(fake.calls.delivered).toEqual([]);
  expect(fake.calls.resolved).toEqual([]);

  expect(
    await sendRaw(a, {
      kind: "request",
      requestId: "interrupt-existing",
      method: "interrupt",
      testOperationId: "00000007-0123-4123-8123-0123456789ab",
      params: { sessionId, turnId: "t1" },
    }),
  ).toMatchObject({ result: { sessionId } });
  expect(fake.calls.interrupted).toEqual([sessionId]);

  expect(
    await sendRaw(a, {
      kind: "request",
      requestId: "stop-existing",
      method: "kill",
      testOperationId: "00000008-0123-4123-8123-0123456789ab",
      params: { sessionId },
    }),
  ).toMatchObject({ result: { sessionId, status: "killed" } });
  expect(fake.calls.terminated).toEqual([sessionId]);
  a.close();
  b.close();
});

test("自主回合入口在writer lease丢失后不提交并停止原worker", async () => {
  let writerHeld = true;
  let leaseChecks = 0;
  const fake = createFakeHarness({
    harness: "codex",
    modelCatalog: { harness: "codex", models: [] },
  });
  const server = createInMemoryTransportServer<ProtocolMessage>();
  const daemon = createDaemonForTest({
    transport: server,
    adapters: new Map([["codex", fake.adapter]]),
    identity: testIdentity,
    diagnostics: testDiagnostics,
    runtimeScopeId: testRuntimeScopeId,
    idleTimeoutMs: 60_000,
    assertWriterLease: async () => {
      leaseChecks += 1;
      if (!writerHeld) throw new Error("writer lease lost");
    },
  });
  const running = daemon.start();
  void running.catch(() => undefined);
  const connection = server.connect();
  const requester = makeRequester(connection);
  const spawned = resultOf(
    await requester("spawn", {
      harness: "codex",
      sessionLabel: "autonomous-writer-lease-loss",
      message: "create a session before lease loss",
      cwd: "/tmp",
    }),
  ) as { sessionId: SessionId; turnId: TurnId };
  fake.controls.completeTurn();
  const observations = collectNotifications(connection);
  expect(
    resultOf(
      await requester("attach", {
        scope: "session",
        sessionId: spawned.sessionId,
        start: { mode: "snapshot" },
      }),
    ),
  ).toMatchObject({ initial: { mode: "snapshot" } });

  writerHeld = false;
  const checksBeforeAutonomousStart = leaseChecks;
  await expect(
    fake.controls.beginAutonomousTurn({
      source: { kind: "fixture_job", id: "job-after-lease-loss" },
      causedBy: { turnId: spawned.turnId },
    }),
  ).rejects.toMatchObject({
    code: "internal_error",
    cause: { kind: "closed" },
  });
  expect(leaseChecks).toBe(checksBeforeAutonomousStart + 1);
  await waitFor(() => fake.calls.terminated.includes(spawned.sessionId));
  await vi.waitFor(() =>
    expect(observations.ended).toContainEqual({
      sessionId: spawned.sessionId,
      reason: "control_unavailable",
    }),
  );
  expect(fake.calls.terminated).toEqual([spawned.sessionId]);
  expect(observations.events).not.toContainEqual(
    expect.objectContaining({
      type: "turn.started",
      sessionId: spawned.sessionId,
      origin: expect.objectContaining({ kind: "harness" }),
    }),
  );
  expect(
    resultOf(await requester("list", { sessionId: spawned.sessionId })),
  ).toMatchObject([{ sessionId: spawned.sessionId, state: "unreachable" }]);

  connection.close();
  await daemon.stop().catch(() => undefined);
  await running.catch(() => undefined);
});

test("writer lease 在模型目录等待期间丢失会阻止 native spawn", async () => {
  let writerHeld = true;
  let announceCatalogStarted!: () => void;
  let releaseCatalog!: () => void;
  const catalogStarted = new Promise<void>((resolve) => {
    announceCatalogStarted = resolve;
  });
  const catalogWait = new Promise<void>((resolve) => {
    releaseCatalog = resolve;
  });
  const fake = createFakeHarness({
    harness: "codex",
    modelCatalog: {
      harness: "codex",
      models: [
        { id: "available", displayName: "Available", reasoningEfforts: [] },
      ],
    },
  });
  fake.adapter.modelCatalog = async () => {
    announceCatalogStarted();
    await catalogWait;
    return {
      harness: "codex",
      models: [
        { id: "available", displayName: "Available", reasoningEfforts: [] },
      ],
    };
  };
  const { server } = startDaemon(new Map([["codex", fake.adapter]]), {
    assertWriterLease: async () => {
      if (!writerHeld) throw new Error("writer lease lost");
    },
  });
  const connection = server.connect();
  const requester = makeRequester(connection);
  await requester("initialize", {
    protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
    consumerContext: "lease-waiter",
  });
  const command = {
    kind: "request",
    requestId: "waiting-spawn",
    method: "spawn",
    testOperationId: "00000004-0123-4123-8123-0123456789ab",
    params: {
      harness: "codex",
      model: "available",
      cwd: "/tmp",
      sessionLabel: "lease-lost-during-catalog",
      message: "must not dispatch after catalog wait",
    },
  };
  const resultPromise = sendRaw(connection, command);
  await catalogStarted;
  writerHeld = false;
  releaseCatalog();
  await expect(resultPromise).resolves.toMatchObject({
    error: {
      code: "internal_error",
      cause: { kind: "closed" },
    },
  });
  expect(fake.calls.starts).toBe(0);
  expect(resultOf(await requester("list", {}))).toEqual([]);
  connection.close();
});

test("命令结果恢复：其他消费者不能用原身份取结果或另起副作用", async () => {
  const fake = createFakeHarness({
    harness: "codex",
    modelCatalog: { harness: "codex", models: [] },
  });
  const { server } = startDaemon(new Map([["codex", fake.adapter]]));
  const a = server.connect(),
    b = server.connect();
  await makeRequester(a, "alpha")("initialize", {
    protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
    consumerContext: "alpha",
  });
  await makeRequester(b, "beta")("initialize", {
    protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
    consumerContext: "beta",
  });
  const operationKey = testOperationKey(
    a,
    "spawn",
    "01234567-0123-4123-8123-0123456789ab",
  );
  const command = {
    kind: "request",
    method: "spawn",
    operationKey,
    params: {
      harness: "codex",
      cwd: "/tmp",
      sessionLabel: "private-command",
      message: "private",
    },
  };
  expect(
    await sendRaw(a, { ...command, requestId: "original" }),
  ).toHaveProperty("result");
  expect(await sendRaw(b, { ...command, requestId: "foreign" })).toMatchObject({
    error: { code: "operation_key_scope_mismatch" },
  });
  expect(fake.calls.starts).toBe(1);
  a.close();
  b.close();
});

test("命令结果恢复：成功、机器错误和冲突均不再次执行业务", async () => {
  const fake = createFakeHarness({
    harness: "codex",
    modelCatalog: { harness: "codex", models: [] },
    autoPermission: { options: [{ outcome: "allow", scope: "once" }] },
  });
  const { server } = startDaemon(new Map([["codex", fake.adapter]]));
  const a = server.connect(),
    b = server.connect();
  await makeRequester(a)("initialize", {
    protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
    consumerContext: "test-consumer",
  });
  await makeRequester(b)("initialize", {
    protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
    consumerContext: "test-consumer",
  });
  const command = async (
    method: ProtocolMethod,
    params: unknown,
    id: string,
  ) => {
    const testOperationId = `${id.padStart(8, "0")}-0123-4123-8123-0123456789ab`;
    const original = await sendRaw(a, {
      kind: "request",
      requestId: `a${id}`,
      method,
      params,
      testOperationId,
    });
    const recovered = await sendRaw(b, {
      kind: "request",
      requestId: `b${id}`,
      method,
      params,
      testOperationId,
    });
    expect(recovered).toEqual({ ...original, requestId: `b${id}` });
    return original;
  };
  const sessionId = testIdentity.session();
  const missing = await command(
    "send",
    { placement: "new_turn", sessionId, message: "before spawn" },
    "1",
  );
  expect(missing).toMatchObject({ error: { code: "session_not_found" } });
  const spawned = await command(
    "spawn",
    {
      harness: "codex",
      cwd: "/tmp",
      sessionLabel: "commands",
      message: "initial",
      authorizationMode: "interactive",
    },
    "2",
  );
  const spawnedSessionId = (resultOf(spawned) as { sessionId: SessionId })
    .sessionId;
  // 状态已经变化；原来的机器错误仍是原请求的权威结果。
  expect(
    await sendRaw(b, {
      kind: "request",
      requestId: "old-error",
      method: "send",
      params: { placement: "new_turn", message: "before spawn", sessionId },
      testOperationId: "00000001-0123-4123-8123-0123456789ab",
    }),
  ).toMatchObject({ error: { code: "session_not_found" } });
  expect(
    await command(
      "resolvePermission",
      {
        turnId: "t1",
        sessionId: spawnedSessionId,
        permissionId: "p1",
        resolution: { outcome: "allow", scope: "once" },
      },
      "5",
    ),
  ).toHaveProperty("result");
  fake.controls.completeTurn();
  expect(
    await command(
      "send",
      { placement: "new_turn", sessionId: spawnedSessionId, message: "once" },
      "3",
    ),
  ).toHaveProperty("result");
  expect(
    await command(
      "interrupt",
      { sessionId: spawnedSessionId, turnId: "t2" },
      "4",
    ),
  ).toHaveProperty("result");
  expect(
    await sendRaw(b, {
      kind: "request",
      requestId: "changed",
      method: "send",
      params: { placement: "new_turn", sessionId, message: "different" },
      testOperationId: "00000003-0123-4123-8123-0123456789ab",
    }),
  ).toMatchObject({ error: { code: "operation_key_conflict" } });
  expect(
    await sendRaw(b, {
      kind: "request",
      requestId: "changed-method",
      method: "kill",
      params: { sessionId: sessionId },
      operationKey: testOperationKey(
        a,
        "send",
        "00000003-0123-4123-8123-0123456789ab",
      ),
    }),
  ).toMatchObject({ error: { code: "operation_key_conflict" } });
  expect(
    await command("kill", { sessionId: spawnedSessionId }, "6"),
  ).toHaveProperty("result");
  expect(fake.calls.starts).toBe(1);
  expect(fake.calls.delivered).toHaveLength(1);
  expect(fake.calls.interrupted).toHaveLength(1);
  expect(fake.calls.resolved).toHaveLength(1);
  expect(fake.calls.terminated).toHaveLength(1);
  a.close();
  b.close();
});

test("操作账本只在首次 spawn 时校验模型目录", async () => {
  let modelCatalog: HarnessModelCatalog = {
    harness: "codex",
    models: [
      { id: "available", displayName: "Available", reasoningEfforts: ["high"] },
    ],
  };
  let modelCatalogQueries = 0;
  const fake = createFakeHarness({ harness: "codex", modelCatalog });
  fake.adapter.modelCatalog = async () => {
    modelCatalogQueries += 1;
    return modelCatalog;
  };
  const { server } = startDaemon(new Map([["codex", fake.adapter]]));
  const connection = server.connect();
  await makeRequester(connection)("initialize", {
    protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
    consumerContext: "test-consumer",
  });
  const params = {
    harness: "codex",
    cwd: "/tmp",
    sessionLabel: "model-catalog-ledger",
    message: "original intent",
    model: "not-yet-available",
  };
  const rejected = {
    kind: "request",
    method: "spawn",
    testOperationId: "00000001-0123-4123-8123-0123456789ab",
    params,
  };
  const first = await sendRaw(connection, {
    ...rejected,
    requestId: "invalid-original",
  });
  expect(first).toMatchObject({
    error: {
      code: "invalid_params",
      issues: [{ issue: "invalid_value", path: "model" }],
    },
  });
  expect(fake.calls.starts).toBe(0);

  modelCatalog = {
    harness: "codex",
    models: [
      {
        id: "not-yet-available",
        displayName: "New model",
        reasoningEfforts: ["high"],
      },
    ],
  };
  expect(
    await sendRaw(connection, {
      ...rejected,
      requestId: "invalid-recovered",
    }),
  ).toEqual({ ...first, requestId: "invalid-recovered" });
  expect(modelCatalogQueries).toBe(1);
  expect(fake.calls.starts).toBe(0);

  const unsupportedReasoning = await sendRaw(connection, {
    kind: "request",
    method: "spawn",
    testOperationId: "00000003-0123-4123-8123-0123456789ab",
    requestId: "invalid-reasoning",
    params: {
      ...params,
      sessionLabel: "model-catalog-reasoning",
      model: "not-yet-available",
      reasoning: "vendor-future-tier",
    },
  });
  expect(unsupportedReasoning).toMatchObject({
    error: {
      code: "invalid_params",
      issues: [{ issue: "invalid_value", path: "reasoning" }],
    },
  });
  expect(modelCatalogQueries).toBe(2);
  expect(fake.calls.starts).toBe(0);

  const accepted = {
    ...rejected,
    testOperationId: "00000002-0123-4123-8123-0123456789ab",
    requestId: "accepted-original",
  };
  const created = await sendRaw(connection, accepted);
  const createdSessionId = (resultOf(created) as { sessionId: string })
    .sessionId;
  expect(createdSessionId).toMatch(testSessionIdPattern);
  expect(fake.calls.starts).toBe(1);

  modelCatalog = { harness: "codex", models: [] };
  expect(
    await sendRaw(connection, { ...accepted, requestId: "accepted-recovered" }),
  ).toEqual({ ...created, requestId: "accepted-recovered" });
  expect(modelCatalogQueries).toBe(3);
  expect(fake.calls.starts).toBe(1);
  connection.close();
});

test("active_turn send 同键正文冲突仍沿原操作指纹缓存拒绝", async () => {
  const fake = createFakeHarness({
    harness: "codex",
    modelCatalog: emptyModelCatalog("codex"),
  });
  const { server } = startDaemon(new Map([["codex", fake.adapter]]));
  const connection = server.connect();
  const requester = makeRequester(connection);
  const spawned = resultOf(
    await requester("spawn", {
      sessionLabel: "active-send-fingerprint",
      harness: "codex",
      message: "start the original turn",
    }),
  ) as { sessionId: SessionId; turnId: TurnId };
  const operationKey = testOperationKey(
    connection,
    "send",
    "00000006-0123-4123-8123-0123456789ab",
  );
  const original = {
    kind: "request",
    method: "send",
    operationKey,
    params: {
      placement: "active_turn",
      sessionId: spawned.sessionId,
      turnId: spawned.turnId,
      message: "deliver once",
    },
  } as const;
  expect(
    await sendRaw(connection, {
      ...original,
      requestId: "active-send-original",
    }),
  ).toHaveProperty("result");
  expect(
    await sendRaw(connection, {
      ...original,
      requestId: "active-send-conflict",
      params: { ...original.params, message: "must not dispatch" },
    }),
  ).toMatchObject({ error: { code: "operation_key_conflict" } });
  expect(fake.calls.delivered).toEqual([
    {
      sessionId: spawned.sessionId,
      turnId: spawned.turnId,
      message: "deliver once",
    },
  ]);
  connection.close();
});

test("模型目录查询失败时不把 harness 误判为未知或拒绝模型", async () => {
  const fake = createFakeHarness({
    harness: "codex",
    modelCatalog: emptyModelCatalog("codex"),
  });
  fake.adapter.modelCatalog = async () => {
    throw new Error("model catalog unavailable");
  };
  const { server } = startDaemon(new Map([["codex", fake.adapter]]));
  const connection = server.connect();
  const response = await makeRequester(connection)("spawn", {
    sessionLabel: "model-catalog-query-failed",
    harness: "codex",
    model: "live-model",
    message: "continue with explicitly supplied model",
  });
  expect(resultOf(response)).toMatchObject({
    sessionId: expect.stringMatching(testSessionIdPattern),
  });
  expect(fake.calls.starts).toBe(1);
  expect(fake.calls.specs[0]).toMatchObject({ model: "live-model" });
  connection.close();
});

test("新回合明确未接受但失败记录不可写时查询保留已知拒绝", async () => {
  const backingStore = createInMemoryControlStore();
  let failureWrites = 0;
  const controlStore: ControlStore = {
    ...backingStore,
    failSend() {
      failureWrites += 1;
      throw new Error("send failure record unavailable");
    },
  };
  const fake = createFakeHarness({
    harness: "codex",
    modelCatalog: emptyModelCatalog("codex"),
    deliver: async () => {
      throw new WorkerDeliveryFailure(
        "native queue rejected the turn",
        "not_accepted",
      );
    },
  });
  const server = createInMemoryTransportServer<ProtocolMessage>();
  const daemon = createDaemon({
    transport: server,
    adapters: new Map([["codex", fake.adapter]]),
    identity: testIdentity,
    diagnostics: testDiagnostics,
    runtimeScopeId: testRuntimeScopeId,
    controlStore,
    idleTimeoutMs: 60_000,
  });
  daemons.push(daemon);
  const running = daemon.start();
  const connection = server.connect();
  await makeRequester(connection)("initialize", {
    protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
    consumerContext: "test-consumer",
  });
  const spawned = resultOf(
    await makeRequester(connection)("spawn", {
      sessionLabel: "send-not-accepted",
      harness: "codex",
      message: "initial turn",
    }),
  ) as { sessionId: SessionId };
  fake.controls.completeTurn();
  await makeRequester(connection)("list", {});

  const request = {
    kind: "request",
    method: "send",
    testOperationId: "00000007-0123-4123-8123-0123456789ab",
    params: {
      sessionId: spawned.sessionId,
      message: "rejected turn",
      placement: "new_turn",
    },
  } as const;
  const first = await sendRaw(connection, {
    ...request,
    requestId: "send-not-accepted-first",
  });
  expect(first).toMatchObject({
    error: {
      code: "control_store_unavailable",
      stage: "failure",
      acceptance: "not_dispatched",
      cause: { message: expect.stringContaining("native queue rejected") },
    },
  });
  const operationKey = testOperationKey(
    connection,
    "send",
    request.testOperationId,
  );
  const queried = await sendRaw(connection, {
    kind: "request",
    requestId: "send-not-accepted-query",
    method: "getOperation",
    params: { operationKey },
  });
  expect(queried).toMatchObject({
    result: {
      status: "not_accepted_uncommitted",
      error: {
        code: "internal_error",
        cause: { message: "native queue rejected the turn" },
      },
      cause: { kind: "io", message: "send failure record unavailable" },
    },
  });
  expect(backingStore.getOperation(operationKey as never)?.status).toBe(
    "dispatched",
  );
  const retry = await sendRaw(connection, {
    ...request,
    requestId: "send-not-accepted-retry",
  });
  expect(retry).toMatchObject({
    error: {
      code: "internal_error",
      cause: { message: "native queue rejected the turn" },
    },
  });
  expect(fake.calls.delivered).toHaveLength(1);
  expect(failureWrites).toBe(1);
  connection.close();
  await daemon.stop();
  await running;
});

test("kill 恢复返回原清理失败，新身份才会重试", async () => {
  let attempts = 0;
  const fake = createFakeHarness({
    harness: "codex",
    modelCatalog: emptyModelCatalog("codex"),
    terminate: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("cleanup rejected");
    },
  });
  const events: DomainEvent[] = [];
  const { server } = startDaemon(new Map([["codex", fake.adapter]]), {
    onEvent: (event) => events.push(event),
  });
  const connection = server.connect();
  const request = makeRequester(connection);
  const spawned = resultOf(
    await request("spawn", {
      sessionLabel: "kill-recovery",
      harness: "codex",
      message: "keep the worker until cleanup succeeds",
    }),
  ) as { sessionId: string };
  const original = {
    kind: "request",
    method: "kill",
    testOperationId: "00000001-0123-4123-8123-0123456789ab",
    params: { sessionId: spawned.sessionId },
  };
  const failed = await sendRaw(connection, {
    ...original,
    requestId: "kill-original",
  });
  expect(failed).toMatchObject({ error: { code: "internal_error" } });
  expect(attempts).toBe(1);
  expect(events.some((event) => event.type === "session.killed")).toBe(false);

  expect(
    await sendRaw(connection, { ...original, requestId: "kill-recovered" }),
  ).toEqual({ ...failed, requestId: "kill-recovered" });
  expect(attempts).toBe(1);

  const retried = await sendRaw(connection, {
    ...original,
    testOperationId: "00000002-0123-4123-8123-0123456789ab",
    requestId: "kill-new-operation",
  });
  expect(retried).toMatchObject({
    result: { sessionId: spawned.sessionId, status: "killed" },
  });
  await flush();
  expect(attempts).toBe(2);
  expect(
    events.filter((event) => event.type === "turn.completed"),
  ).toHaveLength(1);
  expect(
    events.filter((event) => event.type === "session.killed"),
  ).toHaveLength(1);
  connection.close();
});

test("命令结果恢复：参数拒绝也是已知结果，不能用修改后的参数复用身份", async () => {
  const fake = createFakeHarness({
    harness: "codex",
    modelCatalog: { harness: "codex", models: [] },
  });
  const { server } = startDaemon(new Map([["codex", fake.adapter]]));
  const connection = server.connect();
  await makeRequester(connection)("initialize", {
    protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
    consumerContext: "test-consumer",
  });
  const base = {
    kind: "request",
    method: "spawn",
    testOperationId: "01234567-0123-4123-8123-0123456789ab",
  };
  expect(
    await sendRaw(connection, {
      ...base,
      requestId: "invalid",
      params: {
        harness: "codex",
        cwd: "/tmp",
        sessionLabel: "params",
        message: "unavailable model",
        model: "unavailable",
      },
    }),
  ).toMatchObject({ error: { code: "invalid_params" } });
  expect(
    await sendRaw(connection, {
      ...base,
      requestId: "changed",
      params: {
        harness: "codex",
        cwd: "/tmp",
        sessionLabel: "params",
        message: "now valid",
      },
    }),
  ).toMatchObject({ error: { code: "operation_key_conflict" } });
  expect(fake.calls.starts).toBe(0);
  connection.close();
});

test("命令结果恢复：接纳请求后立即断连不撤销原消费者下的执行", async () => {
  const fake = createFakeHarness({
    harness: "codex",
    modelCatalog: { harness: "codex", models: [] },
  });
  const server = createInMemoryTransportServer<ProtocolMessage>();
  let disconnect = true;
  const daemon = createDaemon({
    transport: {
      ...server,
      onConnection(listener) {
        return server.onConnection((connection) =>
          listener({
            ...connection,
            onEvent(receive) {
              return connection.onEvent((event) => {
                receive(event);
                if (
                  disconnect &&
                  event.kind === "message" &&
                  event.message.kind === "request" &&
                  event.message.method === "spawn"
                ) {
                  disconnect = false;
                  // 接纳与 cleanup 同步完成；尚未运行账本中的业务微任务。
                  receive({ kind: "closed" });
                  connection.close();
                }
              });
            },
          }),
        );
      },
    },
    adapters: new Map([["codex", fake.adapter]]),
    identity: testIdentity,
    diagnostics: testDiagnostics,
    runtimeScopeId: testRuntimeScopeId,
    idleTimeoutMs: 60_000,
  });
  daemons.push(daemon);
  void daemon.start();
  const client = server.connect();
  await makeRequester(client)("initialize", {
    protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
    consumerContext: "original-consumer",
  });
  const command = {
    kind: "request",
    method: "spawn",
    testOperationId: "01234567-0123-4123-8123-0123456789ab",
    params: {
      harness: "codex",
      cwd: "/tmp",
      sessionLabel: "accepted",
      message: "original",
    },
  };
  const { testOperationId, ...wireCommand } = command;
  client.send({
    ...wireCommand,
    requestId: "accepted-original",
    operationKey: testOperationKey(client, "spawn", testOperationId),
  } as ProtocolMessage);
  await flush();
  const recovery = server.connect();
  try {
    await makeRequester(recovery)("initialize", {
      protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
      consumerContext: "original-consumer",
    });
    expect(
      await sendRaw(recovery, { ...command, requestId: "accepted-recovered" }),
    ).toMatchObject({
      result: {
        sessionId: expect.stringMatching(testSessionIdPattern),
      },
    });
    expect(fake.calls.starts).toBe(1);
    expect(
      await makeRequester(recovery, "original-consumer")("list", {}),
    ).toMatchObject({
      result: [{ sessionId: expect.stringMatching(testSessionIdPattern) }],
    });
  } finally {
    client.close();
    recovery.close();
  }
});

test("none turn scope ends from authoritative terminal state while retaining full history", async () => {
  const fake = createFakeHarness({
    harness: "codex",
    modelCatalog: emptyModelCatalog("codex"),
  });
  const { server } = startDaemon(new Map([["codex", fake.adapter]]));
  const client = server.connect();
  await flush();
  const request = makeRequester(client);
  const spawned = await request("spawn", {
    sessionLabel: "retained-terminal",
    harness: "codex",
    message: "first",
  });
  const { sessionId, turnId } = resultOf(spawned) as {
    sessionId: SessionId;
    turnId: TurnId;
  };
  const target = { sessionId, turnId };
  fake.controls.completeTurn();
  await request("send", {
    sessionId: target.sessionId,
    placement: "new_turn",
    message: "second",
  });
  fake.controls.completeTurn();
  const collector = collectNotifications(client);
  expect(
    await request("attach", {
      scope: "turn",
      ...target,
      start: { mode: "snapshot" },
    }),
  ).toHaveProperty("result");
  await flush();
  expect(collector.events).toEqual([]);
  expect(collector.ended).toEqual([
    { sessionId: target.sessionId, reason: "end_turn" },
  ]);
});

test("after 固定历史前缀并在 initial 响应前缓存实时事件", async () => {
  const fake = createFakeHarness({
    harness: "codex",
    modelCatalog: emptyModelCatalog("codex"),
  });
  let inject: (() => void) | undefined;
  const { server } = startDaemon(new Map([["codex", fake.adapter]]), {
    beforeAttachReplay: () => inject?.(),
  });
  const client = server.connect();
  await flush();
  const requester = makeRequester(client);
  const spawned = await requester("spawn", {
    sessionLabel: "after-boundary",
    harness: "codex",
    message: "first",
  });
  const { sessionId } = resultOf(spawned) as { sessionId: SessionId };
  const messageId = "boundary" as MessageId;
  fake.controls.emitText(messageId, "he");
  inject = () => {
    fake.controls.emitText(messageId, "llo");
    fake.controls.emitSnapshot(messageId, "hello");
    fake.controls.completeTurn("end_turn", "hello");
  };
  const wire: ProtocolMessage[] = [];
  client.onEvent((event) => {
    if (event.kind === "message") wire.push(event.message);
  });
  const ack = await requester("attach", {
    scope: "turn",
    sessionId,
    turnId: "t1",
    start: {
      mode: "after",
      cursor: encodeResumeCursor({
        target: { scope: "turn", sessionId, turnId: "t1" as TurnId },
        runtimeScopeId: v.parse(
          runtimeScopeIdSchema,
          "00000000-0000-4000-8000-000000000000",
        ),
        daemonGeneration: v.parse(daemonGenerationSchema, "test"),
        eventId: 1,
      }),
    },
  });
  await flush();
  expect(ack).toMatchObject({
    result: {
      initial: {
        mode: "after",
        replayed: 3,
        window: { oldest: 1, head: 4, truncated: false },
      },
    },
  });
  expect(wire[0]).toMatchObject({
    kind: "response",
    result: expect.anything(),
  });
  const notifications = wire.filter(
    (message) => message.kind === "notification",
  );
  expect(
    notifications
      .filter((message) => message.method === "event")
      .map((message) => message.params.eventId),
  ).toEqual([2, 3, 4, 5, 6, 7]);
  expect(notifications.at(-1)).toMatchObject({
    method: "attach.ended",
    params: { reason: "end_turn", lastEventId: 7 },
  });
});

test("after 游标按运行范围绑定，即使会话、世代和序号相同也拒绝串用", async () => {
  const fake = createFakeHarness({
    harness: "codex",
    modelCatalog: emptyModelCatalog("codex"),
  });
  const { server, daemon } = startDaemon(new Map([["codex", fake.adapter]]));
  const client = server.connect();
  await flush();
  const requester = makeRequester(client);
  const spawned = await requester("spawn", {
    harness: "codex",
    message: "scope-bound cursor",
    cwd: "/tmp",
  });
  const { sessionId, turnId } = resultOf(spawned) as {
    sessionId: SessionId;
    turnId: TurnId;
  };
  const cursor = encodeResumeCursor({
    target: { scope: "turn", sessionId, turnId },
    runtimeScopeId: v.parse(
      runtimeScopeIdSchema,
      "00000000-0000-4000-8000-000000000001",
    ),
    daemonGeneration: v.parse(daemonGenerationSchema, "test"),
    eventId: 0,
  });
  expect(
    await requester("attach", {
      scope: "turn",
      sessionId,
      turnId,
      start: { mode: "after", cursor },
    }),
  ).toMatchObject({ error: { code: "invalid_params" } });
  await daemon.stop();
});
