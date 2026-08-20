import { noopDiagnosticEmitter } from "@reins/core";
import type {
  DomainEvent,
  CapabilitiesResult,
  HarnessCapability,
  PermissionOption,
  PermissionId,
  RequestId,
  PermissionResolution,
  ProtocolMessage,
  ProtocolMethod,
  ProtocolResponse,
  StopReason,
  SessionId,
  TurnId,
  MessageId,
  WorkerDriver,
  WorkerDriverFactory,
} from "@reins/protocol";
import { machineErrorSchema, sessionIdSchema } from "@reins/protocol";
import {
  createInMemoryTransportServer,
  type TransportConnection,
} from "@reins/transport";
import * as v from "valibot";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { Daemon } from "../../src/daemon.ts";
import { createDaemon } from "../../src/index.ts";
import type { HarnessAdapter } from "../../src/registry.ts";

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

const testIdentity = {
  session: (sessionName: string) =>
    v.parse(sessionIdSchema, `${sessionName}@gdaemontest`),
};

afterEach(async () => {
  for (const daemon of daemons.splice(0)) {
    await daemon.stop();
  }
});

function startDaemon(
  adapters: Map<string, HarnessAdapter>,
  options?: { idleTimeoutMs?: number; eventLogLimit?: number },
): {
  server: ReturnType<typeof createInMemoryTransportServer<ProtocolMessage>>;
  daemon: Daemon;
} {
  const server = createInMemoryTransportServer<ProtocolMessage>();
  const daemon = createDaemon({
    transport: server,
    adapters,
    identity: testIdentity,
    diagnostics: noopDiagnosticEmitter,
    idleTimeoutMs: options?.idleTimeoutMs ?? 60_000,
    ...(options?.eventLogLimit === undefined
      ? {}
      : { eventLogLimit: options.eventLogLimit }),
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

function makeRequester(
  client: TransportConnection<ProtocolMessage>,
): Requester {
  let seq = 0;
  const request = (
    method: ProtocolMethod,
    params: unknown,
    timeoutMs = 2000,
  ): Promise<ProtocolResponse> => {
    seq += 1;
    const requestId = `r${seq}` as RequestId;
    return new Promise<ProtocolResponse>((resolve, reject) => {
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
          resolve(message);
        }
      });
      client.send({ kind: "request", requestId, method, params });
    });
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
      events.push(message.params);
    } else if (message.method === "attach.ended") {
      ended.push(message.params);
    }
  });
  return { events, ended };
}

type FakeCalls = {
  factoryCalls: number;
  starts: number;
  delivered: Array<{ sessionId: string; turnId: string; message: string }>;
  interrupted: string[];
  resolved: PermissionResolution[];
  terminated: string[];
};

function createFakeHarness(options: {
  harness: string;
  capability: HarnessCapability;
  autoPermission?: { options: PermissionOption[] };
}): {
  adapter: HarnessAdapter;
  calls: FakeCalls;
  controls: {
    completeTurn(stopReason?: StopReason, finalReply?: string | null): void;
    emitWorkerMessage(content: string): void;
  };
} {
  const calls: FakeCalls = {
    factoryCalls: 0,
    starts: 0,
    delivered: [],
    interrupted: [],
    resolved: [],
    terminated: [],
  };
  let emitEvent: ((event: DomainEvent) => void) | null = null;
  let current: { sessionId: SessionId; turnId: TurnId } | null = null;
  let permissionSeq = 0;
  let messageSeq = 0;

  const driver: WorkerDriver = {
    start(spec) {
      calls.starts += 1;
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
    deliver(sessionId, turnId, message) {
      current = { sessionId, turnId };
      calls.delivered.push({ sessionId, turnId, message });
    },
    interrupt(sessionId) {
      calls.interrupted.push(sessionId);
    },
    resolvePermission(sessionId, permissionId, resolution) {
      void sessionId;
      void permissionId;
      calls.resolved.push(resolution);
    },
    terminate(sessionId) {
      calls.terminated.push(sessionId);
    },
  };

  const adapter: HarnessAdapter = {
    driverFactory: ((emit: (event: DomainEvent) => void) => {
      calls.factoryCalls += 1;
      emitEvent = emit;
      return driver;
    }) satisfies WorkerDriverFactory,
    async capabilities() {
      return options.capability;
    },
  };

  return {
    adapter,
    calls,
    controls: {
      completeTurn(
        stopReason: StopReason = "end_turn",
        finalReply: string | null = "done",
      ) {
        if (current === null) throw new Error("没有进行中的回合");
        emitEvent?.({
          type: "turn.completed",
          sessionId: current.sessionId,
          turnId: current.turnId,
          stopReason,
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
    },
  };
}

function emptyCapability(harness: string): HarnessCapability {
  return { harness, models: [] };
}

describe("daemon 协议面（缝 C）", () => {
  test("initialize 返回空结果", async () => {
    const { server } = startDaemon(new Map());
    const client = server.connect();
    await flush();
    const response = await makeRequester(client).request("initialize", {});
    expect(response).toEqual({ kind: "response", requestId: "r1", result: {} });
  });

  test("spawn 返回 sessionId，attach 回放历史事件并在 exitOn 命中时结束", async () => {
    const fake = createFakeHarness({
      harness: "fake",
      capability: emptyCapability("fake"),
    });
    const { server } = startDaemon(new Map([["fake", fake.adapter]]));
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);

    const spawned = await requester("spawn", {
      sessionName: "reviewer",
      harness: "fake",
      message: "hello",
    });
    expect(spawned).toMatchObject({
      kind: "response",
      result: { sessionId: "reviewer@gdaemontest" },
    });
    fake.controls.completeTurn("end_turn", "ok");

    const collector = collectNotifications(client);
    const attached = await requester("attach", {
      sessionId: "reviewer@gdaemontest",
      exitOn: ["end_turn"],
    });
    expect(attached).toMatchObject({
      kind: "response",
      result: { sessionId: "reviewer@gdaemontest", replayed: 3 },
    });
    expect(collector.events.map((event) => event.type)).toEqual([
      "session.created",
      "turn.started",
      "turn.completed",
    ]);
    expect(collector.ended).toEqual([
      { sessionId: "reviewer@gdaemontest", reason: "end_turn" },
    ]);
  });

  test("未知 harness 返回 unknown_harness 并附合法 harness 列表", async () => {
    const fake = createFakeHarness({
      harness: "fake",
      capability: emptyCapability("fake"),
    });
    const { server } = startDaemon(new Map([["fake", fake.adapter]]));
    const client = server.connect();
    await flush();
    const response = await makeRequester(client).request("spawn", {
      sessionName: "reviewer",
      harness: "nope",
      message: "x",
    });
    expect(response).toMatchObject({
      kind: "response",
      error: {
        code: "unknown_harness",
        harness: "nope",
        availableHarnesses: ["fake"],
      },
    });
    expect(fake.calls.factoryCalls).toBe(0);
  });

  test("spawn 参数不合法返回 invalid_params", async () => {
    const fake = createFakeHarness({
      harness: "fake",
      capability: emptyCapability("fake"),
    });
    const { server } = startDaemon(new Map([["fake", fake.adapter]]));
    const client = server.connect();
    await flush();
    const response = await makeRequester(client).request("spawn", {
      harness: "fake",
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
      harness: "fake",
      capability: emptyCapability("fake"),
    });
    const { server } = startDaemon(new Map([["fake", fake.adapter]]));
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);
    const spawned = await requester("spawn", {
      sessionName: "reviewer",
      harness: "fake",
      message: "hello",
    });
    const sessionId = (resultOf(spawned) as { sessionId: string }).sessionId;
    fake.controls.completeTurn("end_turn", "ok");
    const waited = await requester("wait", {
      ids: [sessionId],
      timeoutMs: 1000,
    });
    expect(resultOf(waited)).toEqual({
      status: "completed",
      results: [
        {
          sessionId,
          status: "completed",
          turn: {
            sessionId,
            turnId: "t1",
            stopReason: "end_turn",
            finalReply: "ok",
            usage: undefined,
          },
        },
      ],
    });
  });

  test("busy 中 send 在下一个消息边界注入", async () => {
    const fake = createFakeHarness({
      harness: "fake",
      capability: emptyCapability("fake"),
    });
    const { server } = startDaemon(new Map([["fake", fake.adapter]]));
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);
    const spawned = await requester("spawn", {
      sessionName: "reviewer",
      harness: "fake",
      message: "hello",
    });
    const sessionId = (resultOf(spawned) as { sessionId: string }).sessionId;

    const sent = await requester("send", {
      sessionId,
      message: "边界消息",
    });
    expect(resultOf(sent)).toMatchObject({ deliveryPoint: "boundary" });
    expect(fake.calls.delivered).toEqual([]);

    fake.controls.emitWorkerMessage("worker 部分产出");
    await waitFor(() => fake.calls.delivered.length > 0);
    expect(fake.calls.delivered).toEqual([
      { sessionId, turnId: "t1", message: "边界消息" },
    ]);
  });

  test("idle 中 send 触发新回合", async () => {
    const fake = createFakeHarness({
      harness: "fake",
      capability: emptyCapability("fake"),
    });
    const { server } = startDaemon(new Map([["fake", fake.adapter]]));
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);
    const spawned = await requester("spawn", {
      sessionName: "reviewer",
      harness: "fake",
      message: "hello",
    });
    const sessionId = (resultOf(spawned) as { sessionId: string }).sessionId;
    fake.controls.completeTurn();

    const sent = await requester("send", { sessionId, message: "再来一轮" });
    expect(resultOf(sent)).toMatchObject({ deliveryPoint: "new_turn" });
    await waitFor(() => fake.calls.delivered.length > 0);
    expect(fake.calls.delivered).toEqual([
      { sessionId, turnId: "t2", message: "再来一轮" },
    ]);
  });

  test("跨连接 attach + send 后会话保持存活，连接断开不杀会话", async () => {
    const fake = createFakeHarness({
      harness: "fake",
      capability: emptyCapability("fake"),
    });
    const { server } = startDaemon(new Map([["fake", fake.adapter]]));
    const clientA = server.connect();
    const clientB = server.connect();
    await flush();
    const requesterA = makeRequester(clientA);
    const requesterB = makeRequester(clientB);

    const spawned = await requesterA("spawn", {
      sessionName: "reviewer",
      harness: "fake",
      message: "hello",
    });
    const sessionId = (resultOf(spawned) as { sessionId: string }).sessionId;
    fake.controls.completeTurn();

    const collector = collectNotifications(clientA);
    await requesterA("attach", { sessionId });
    const sent = await requesterB("send", {
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
      harness: "fake",
      capability: emptyCapability("fake"),
    });
    const { server } = startDaemon(new Map([["fake", fake.adapter]]));
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);
    const spawned = await requester("spawn", {
      sessionName: "reviewer",
      harness: "fake",
      message: "hello",
    });
    const sessionId = (resultOf(spawned) as { sessionId: string }).sessionId;

    const interrupted = await requester("interrupt", { ids: [sessionId] });
    expect(resultOf(interrupted)).toEqual([
      { sessionId, status: "requested", turnId: "t1" },
    ]);
    expect(fake.calls.interrupted).toEqual([sessionId]);
    fake.controls.completeTurn("cancelled", null);
    const waited = await requester("wait", {
      ids: [sessionId],
      timeoutMs: 1000,
    });
    expect(resultOf(waited)).toMatchObject({
      status: "completed",
      results: [{ sessionId, status: "completed" }],
    });
  });

  test("kill 清理会话，wait 返回 per-id killed，未知 id 报 session_not_found", async () => {
    const fake = createFakeHarness({
      harness: "fake",
      capability: emptyCapability("fake"),
    });
    const { server } = startDaemon(new Map([["fake", fake.adapter]]));
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);
    const spawned = await requester("spawn", {
      sessionName: "reviewer",
      harness: "fake",
      message: "hello",
    });
    const sessionId = (resultOf(spawned) as { sessionId: string }).sessionId;
    fake.controls.completeTurn();

    const killed = await requester("kill", { ids: [sessionId] });
    expect(resultOf(killed)).toEqual([{ sessionId, status: "killed" }]);
    expect(fake.calls.terminated).toEqual([sessionId]);

    const waited = await requester("wait", {
      ids: [sessionId],
      timeoutMs: 1000,
    });
    expect(resultOf(waited)).toEqual({
      status: "completed",
      results: [{ sessionId, status: "killed" }],
    });

    const missing = await requester("wait", {
      ids: ["missing@gdaemontest"],
      timeoutMs: 1000,
    });
    expect(missing).toMatchObject({
      kind: "response",
      error: { code: "session_not_found" },
    });
  });

  test("attach 实时转发事件，权限决议走双工通道", async () => {
    const fake = createFakeHarness({
      harness: "fake",
      capability: emptyCapability("fake"),
      autoPermission: {
        options: [
          { outcome: "allow", scope: "once" },
          { outcome: "deny", feedback: false },
        ],
      },
    });
    const { server } = startDaemon(new Map([["fake", fake.adapter]]));
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);
    const collector = collectNotifications(client);
    const spawned = await requester("spawn", {
      sessionName: "reviewer",
      harness: "fake",
      message: "hello",
    });
    const sessionId = (resultOf(spawned) as { sessionId: string }).sessionId;
    await requester("attach", { sessionId });

    const permissionEvent = collector.events.find(
      (event) => event.type === "permission.requested",
    );
    expect(permissionEvent).toBeDefined();
    const permissionId = (
      permissionEvent as Extract<DomainEvent, { type: "permission.requested" }>
    ).permissionId;

    const resolved = await requester("resolvePermission", {
      sessionId,
      permissionId,
      resolution: { outcome: "allow", scope: "once" },
    });
    expect(resolved).toMatchObject({
      kind: "response",
      result: {},
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

  test("attach 到不存在的会话返回 session_not_found", async () => {
    const { server } = startDaemon(new Map());
    const client = server.connect();
    await flush();
    const response = await makeRequester(client).request("attach", {
      sessionId: "missing@gdaemontest",
    });
    expect(response).toMatchObject({
      kind: "response",
      error: { code: "session_not_found" },
    });
  });

  test("attach 已 kill 的会话回放历史并以 session_killed 结束", async () => {
    const fake = createFakeHarness({
      harness: "fake",
      capability: emptyCapability("fake"),
    });
    const { server } = startDaemon(new Map([["fake", fake.adapter]]));
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);
    const spawned = await requester("spawn", {
      sessionName: "reviewer",
      harness: "fake",
      message: "hello",
    });
    const sessionId = (resultOf(spawned) as { sessionId: string }).sessionId;
    fake.controls.completeTurn();
    await requester("kill", { ids: [sessionId] });

    const collector = collectNotifications(client);
    const attached = await requester("attach", { sessionId });
    expect(attached).toMatchObject({
      kind: "response",
      result: { sessionId, replayed: 4 },
    });
    expect(collector.events.map((event) => event.type)).toEqual([
      "session.created",
      "turn.started",
      "turn.completed",
      "session.killed",
    ]);
    expect(collector.ended).toEqual([{ sessionId, reason: "session_killed" }]);
  });

  test("capabilities 聚合，单点失败不拖垮整体", async () => {
    const fake = createFakeHarness({
      harness: "fake",
      capability: {
        harness: "fake",
        models: [{ id: "m1", displayName: "M1", reasoningEfforts: ["low"] }],
      },
    });
    const dummyDriver: WorkerDriver = {
      start() {},
      deliver() {},
      interrupt() {},
      resolvePermission() {},
      terminate() {},
    };
    const badAdapter: HarnessAdapter = {
      driverFactory: () => dummyDriver,
      async capabilities() {
        throw new Error("boom");
      },
    };
    const { server } = startDaemon(
      new Map([
        ["fake", fake.adapter],
        ["bad", badAdapter],
      ]),
    );
    const client = server.connect();
    await flush();
    const response = await makeRequester(client).request("capabilities", {});
    expect(resultOf(response)).toEqual({
      capabilities: [
        {
          harness: "fake",
          models: [{ id: "m1", displayName: "M1", reasoningEfforts: ["low"] }],
        },
      ],
      failures: [
        {
          harness: "bad",
          code: "capability_query_failed",
          cause: { kind: "exception", message: "Error: boom" },
        },
      ],
    });
  });

  test("capability failure causes are UTF-8 bounded", async () => {
    const dummyDriver: WorkerDriver = {
      start() {},
      deliver() {},
      interrupt() {},
      resolvePermission() {},
      terminate() {},
    };
    const makeFailingAdapter = (message: string): HarnessAdapter => ({
      driverFactory: () => dummyDriver,
      async capabilities() {
        throw new Error(message);
      },
    });
    const { server } = startDaemon(
      new Map([
        ["ascii", makeFailingAdapter("a".repeat(5000))],
        ["unicode", makeFailingAdapter("界".repeat(2000))],
      ]),
    );
    const client = server.connect();
    await flush();

    const result = resultOf(
      await makeRequester(client).request("capabilities", {}),
    ) as CapabilitiesResult;
    const causes = result.failures.map((failure) => failure.cause);
    expect(causes).toHaveLength(2);
    for (const cause of causes) {
      expect(cause).toBeDefined();
      expect(
        new TextEncoder().encode(cause?.message).length,
      ).toBeLessThanOrEqual(4 * 1024);
    }
    expect(causes[0]?.message).toHaveLength(4 * 1024);
    expect(causes[1]?.message).toHaveLength("Error: ".length + 1363);
  });

  test("unexpected dispatch errors are schema-valid UTF-8 bounded causes", async () => {
    const failingDriver: WorkerDriver = {
      start() {
        throw new Error("a".repeat(5000));
      },
      deliver() {},
      interrupt() {},
      resolvePermission() {},
      terminate() {},
    };
    const adapter: HarnessAdapter = {
      driverFactory: () => failingDriver,
      async capabilities() {
        return emptyCapability("failing");
      },
    };
    const { server } = startDaemon(new Map([["failing", adapter]]));
    const client = server.connect();
    await flush();

    const response = await makeRequester(client).request("spawn", {
      sessionName: "failing",
      harness: "failing",
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

  test("路由 driver 按 harness 懒实例化并复用", async () => {
    const fakeA = createFakeHarness({
      harness: "a",
      capability: emptyCapability("a"),
    });
    const fakeB = createFakeHarness({
      harness: "b",
      capability: emptyCapability("b"),
    });
    const { server } = startDaemon(
      new Map([
        ["a", fakeA.adapter],
        ["b", fakeB.adapter],
      ]),
    );
    const client = server.connect();
    await flush();
    const requester = makeRequester(client);
    await requester("spawn", {
      sessionName: "a-one",
      harness: "a",
      message: "1",
    });
    await requester("spawn", {
      sessionName: "a-two",
      harness: "a",
      message: "2",
    });
    await requester("spawn", {
      sessionName: "b-one",
      harness: "b",
      message: "3",
    });
    expect(fakeA.calls.factoryCalls).toBe(1);
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
      diagnostics: noopDiagnosticEmitter,
      idleTimeoutMs: 100,
    });
    const started = daemon.start();
    await flush();
    vi.advanceTimersByTime(100);
    await flush();
    await expect(started).resolves.toBeUndefined();
  });

  test("有会话时保持存活，全部清理后退出", async () => {
    vi.useFakeTimers();
    const fake = createFakeHarness({
      harness: "fake",
      capability: emptyCapability("fake"),
    });
    const server = createInMemoryTransportServer<ProtocolMessage>();
    const daemon = createDaemon({
      transport: server,
      adapters: new Map([["fake", fake.adapter]]),
      identity: testIdentity,
      diagnostics: noopDiagnosticEmitter,
      idleTimeoutMs: 100,
    });
    const started = daemon.start();
    const client = server.connect();
    await flush();
    const spawned = await makeRequester(client).request("spawn", {
      sessionName: "reviewer",
      harness: "fake",
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
      await makeRequester(client2).request("kill", { ids: [sessionId] });
      client2.close();
      await flush();
      vi.advanceTimersByTime(100);
      await flush();
      await expect(started).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
