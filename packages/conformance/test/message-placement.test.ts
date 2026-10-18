import { createReinsClient, type ReinsClient } from "@reins/client";
import type { HarnessAdapter } from "@reins/daemon";
import { openEphemeralDaemonForTest } from "@reins/daemon/testing";
import {
  type ConsumerContext,
  type DomainEvent,
  type WorkerSpec,
  type WorkerDriver,
} from "@reins/protocol";
import { afterEach, expect, test } from "vitest";

const daemons: Awaited<ReturnType<typeof openEphemeralDaemonForTest>>[] = [];
const clients: ReinsClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const daemon of daemons.splice(0)) await daemon.close();
});

async function fixture(options?: { deliver?: () => Promise<void> }) {
  const calls = {
    delivered: [] as Parameters<WorkerDriver["deliver"]>[],
    starts: [] as WorkerSpec[],
  };
  let publish!: (event: DomainEvent) => void;
  const adapter: HarnessAdapter = {
    modelCatalog: async () => ({ harness: "codex", models: [] }),
    driverFactory: ({ emit }) => {
      publish = emit;
      return {
        async start(spec) {
          calls.starts.push(spec);
        },
        async deliver(...args) {
          calls.delivered.push(args);
          await options?.deliver?.();
        },
        async interrupt() {},
        resolvePermission() {},
        async terminate() {},
      };
    },
  };
  const daemon = await openEphemeralDaemonForTest({
    adapters: new Map([["codex", adapter]]),
  });
  daemons.push(daemon);
  const client = createReinsClient(daemon.connect(), {
    consumerContext: "placement-consumer" as ConsumerContext,
    runtimeScopeId: daemon.runtimeScopeId,
  });
  clients.push(client);
  await client.initialize();
  return { client, calls, publish: (event: DomainEvent) => publish(event) };
}

test("显式 new_turn 在 busy 拒绝，不能改投活动回合", async () => {
  const { client, calls } = await fixture();
  const spawned = await client.request("spawn", {
    harness: "codex",
    cwd: "/tmp",
    sessionLabel: "placement",
    message: "initial caller task",
  });
  if ("error" in spawned) throw new Error("Expected spawn ACK");
  const response = await client.request("send", {
    sessionId: spawned.result.sessionId,
    message: "new caller task",
    placement: "new_turn",
  });
  expect(response).toMatchObject({
    error: { code: "session_busy", sessionId: spawned.result.sessionId },
  });
  expect(calls.delivered).toEqual([]);
  expect(calls.starts).toHaveLength(1);
});

test("active_turn 的 ACK 与 caller 事实等待精确原生接受", async () => {
  let accept!: () => void;
  const accepted = new Promise<void>((resolve) => {
    accept = resolve;
  });
  const { client, calls } = await fixture({ deliver: () => accepted });
  const spawned = await client.request("spawn", {
    harness: "codex",
    cwd: "/tmp",
    sessionLabel: "accepted",
    message: "initial caller task",
  });
  if ("error" in spawned) throw new Error("Expected spawn ACK");
  const events: DomainEvent[] = [];
  client.onNotification((notification) => {
    if (notification.method === "event") events.push(notification.params.event);
  });
  await client.request("attach", {
    scope: "session",
    sessionId: spawned.result.sessionId,
    replay: { mode: "available" },
  });
  let settled = false;
  const sending = client
    .request("send", {
      placement: "active_turn",
      sessionId: spawned.result.sessionId,
      turnId: spawned.result.turnId,
      message: "explicit active task",
    })
    .then((ack) => {
      settled = true;
      return ack;
    });
  try {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(calls.delivered).toHaveLength(1);
    expect(settled).toBe(false);
    expect(
      events.filter(
        (event) => event.type === "message" && event.role === "caller",
      ),
    ).toEqual([]);
  } finally {
    accept();
  }
  expect(await sending).toMatchObject({
    result: {
      sessionId: spawned.result.sessionId,
      turnId: spawned.result.turnId,
    },
  });
  expect(
    events.filter(
      (event) => event.type === "message" && event.role === "caller",
    ),
  ).toEqual([
    expect.objectContaining({
      turnId: spawned.result.turnId,
      content: "explicit active task",
    }),
  ]);
});

test("原生接受先于终态时，caller 事实仍归原回合且在终态之前提交", async () => {
  let accept!: () => void;
  const accepted = new Promise<void>((resolve) => {
    accept = resolve;
  });
  const { client, calls, publish } = await fixture({ deliver: () => accepted });
  const spawned = await client.request("spawn", {
    harness: "codex",
    cwd: "/tmp",
    sessionLabel: "accept-race",
    message: "initial",
  });
  if ("error" in spawned) throw new Error("Expected spawn ACK");
  const events: DomainEvent[] = [];
  client.onNotification((notification) => {
    if (notification.method === "event") events.push(notification.params.event);
  });
  await client.request("attach", {
    scope: "session",
    sessionId: spawned.result.sessionId,
    replay: { mode: "available" },
  });
  events.length = 0;
  const sending = client.request("send", {
    placement: "active_turn",
    sessionId: spawned.result.sessionId,
    turnId: spawned.result.turnId,
    message: "accepted before end",
  });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(calls.delivered).toHaveLength(1);
  accept();
  publish({
    type: "turn.completed",
    sessionId: spawned.result.sessionId,
    turnId: spawned.result.turnId,
    stopReason: "end_turn",
    finalReply: null,
  });
  expect(await sending).toHaveProperty("result");
  expect(events.map((event) => event.type)).toEqual([
    "message",
    "turn.completed",
  ]);
  expect(events[0]).toMatchObject({
    turnId: spawned.result.turnId,
    role: "caller",
    content: "accepted before end",
  });
  expect(await client.request("list", {})).toMatchObject({
    result: [{ state: "idle" }],
  });
});

test("idle new_turn 原子预留且等待接受，并发请求不会重复创建回合", async () => {
  let accept!: () => void;
  const accepted = new Promise<void>((resolve) => {
    accept = resolve;
  });
  const { client, calls, publish } = await fixture({ deliver: () => accepted });
  const spawned = await client.request("spawn", {
    harness: "codex",
    cwd: "/tmp",
    sessionLabel: "new-race",
    message: "initial",
  });
  if ("error" in spawned) throw new Error("Expected spawn ACK");
  publish({
    type: "turn.completed",
    sessionId: spawned.result.sessionId,
    turnId: spawned.result.turnId,
    stopReason: "end_turn",
    finalReply: null,
  });
  const events: DomainEvent[] = [];
  client.onNotification((notification) => {
    if (notification.method === "event") events.push(notification.params.event);
  });
  await client.request("attach", {
    scope: "session",
    sessionId: spawned.result.sessionId,
    replay: { mode: "available" },
  });
  events.length = 0;
  let settled = false;
  const sending = client
    .request("send", {
      placement: "new_turn",
      sessionId: spawned.result.sessionId,
      message: "new accepted task",
    })
    .then((ack) => {
      settled = true;
      return ack;
    });
  try {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(calls.delivered).toHaveLength(1);
    expect(settled).toBe(false);
    expect(events).toEqual([]);
    expect(
      await client.request("send", {
        placement: "new_turn",
        sessionId: spawned.result.sessionId,
        message: "concurrent rejected task",
      }),
    ).toMatchObject({ error: { code: "session_busy" } });
  } finally {
    accept();
  }
  const ack = await sending;
  expect(ack).toMatchObject({ result: { deliveryPoint: "new_turn" } });
  expect(events.map((event) => event.type)).toEqual([
    "turn.started",
    "message",
  ]);
  expect(calls.delivered).toHaveLength(1);
});

test("错误父级和已结束目标拒绝，消息不会流入后继回合", async () => {
  const { client, calls, publish } = await fixture();
  const first = await client.request("spawn", {
    harness: "codex",
    cwd: "/tmp",
    sessionLabel: "parent-one",
    message: "one",
  });
  const second = await client.request("spawn", {
    harness: "codex",
    cwd: "/tmp",
    sessionLabel: "parent-two",
    message: "two",
  });
  if ("error" in first || "error" in second)
    throw new Error("Expected spawn ACKs");
  const events: DomainEvent[] = [];
  client.onNotification((notification) => {
    if (notification.method === "event") events.push(notification.params.event);
  });
  await client.request("attach", {
    scope: "session",
    sessionId: first.result.sessionId,
    replay: { mode: "available" },
  });
  events.length = 0;
  expect(
    await client.request("send", {
      placement: "active_turn",
      sessionId: first.result.sessionId,
      turnId: second.result.turnId,
      message: "wrong parent task",
    }),
  ).toMatchObject({ error: { code: "invalid_params" } });
  expect(calls.delivered).toEqual([]);
  expect(events).toEqual([]);
  publish({
    type: "turn.completed",
    sessionId: first.result.sessionId,
    turnId: first.result.turnId,
    stopReason: "end_turn",
    finalReply: null,
  });
  expect(
    await client.request("send", {
      placement: "active_turn",
      sessionId: first.result.sessionId,
      turnId: first.result.turnId,
      message: "ended target task",
    }),
  ).toMatchObject({ error: { code: "turn_not_active" } });
  const next = await client.request("send", {
    placement: "new_turn",
    sessionId: first.result.sessionId,
    message: "next explicit task",
  });
  expect(next).toHaveProperty("result");
  expect(calls.delivered).toEqual([
    [
      first.result.sessionId,
      expect.any(String),
      "next explicit task",
      "new_turn",
    ],
  ]);
  expect(
    events.filter(
      (event) => event.type === "message" && event.role === "caller",
    ),
  ).toEqual([expect.objectContaining({ content: "next explicit task" })]);
});

test("结束先于原生拒绝时，没有 caller 事实或后继回合残留", async () => {
  let reject!: (error: unknown) => void;
  const native = new Promise<void>((_, rejectNative) => {
    reject = rejectNative;
  });
  let attempts = 0;
  const { client, calls, publish } = await fixture({
    deliver: () => (++attempts === 1 ? native : Promise.resolve()),
  });
  const spawned = await client.request("spawn", {
    harness: "codex",
    cwd: "/tmp",
    sessionLabel: "end-wins",
    message: "initial",
  });
  if ("error" in spawned) throw new Error("Expected spawn ACK");
  const events: DomainEvent[] = [];
  client.onNotification((notification) => {
    if (notification.method === "event") events.push(notification.params.event);
  });
  await client.request("attach", {
    scope: "session",
    sessionId: spawned.result.sessionId,
    replay: { mode: "available" },
  });
  events.length = 0;
  const sending = client.request("send", {
    placement: "active_turn",
    sessionId: spawned.result.sessionId,
    turnId: spawned.result.turnId,
    message: "rejected task",
  });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(calls.delivered).toHaveLength(1);
  publish({
    type: "turn.completed",
    sessionId: spawned.result.sessionId,
    turnId: spawned.result.turnId,
    stopReason: "end_turn",
    finalReply: null,
  });
  reject({
    code: "turn_not_active",
    sessionId: spawned.result.sessionId,
    turnId: spawned.result.turnId,
  });
  expect(await sending).toMatchObject({ error: { code: "turn_not_active" } });
  expect(events.map((event) => event.type)).toEqual(["turn.completed"]);
  expect(
    await client.request("send", {
      placement: "new_turn",
      sessionId: spawned.result.sessionId,
      message: "next explicit task",
    }),
  ).toHaveProperty("result");
  expect(calls.delivered.map((call) => call[2])).toEqual([
    "rejected task",
    "next explicit task",
  ]);
  expect(
    events.filter(
      (event) => event.type === "message" && event.role === "caller",
    ),
  ).toEqual([expect.objectContaining({ content: "next explicit task" })]);
});

test.each(["active_turn", "new_turn"] as const)(
  "停止成功与待接受 %s 竞争时，caller 事实不会出现在 killed 之后",
  async (placement) => {
    let accept!: () => void;
    const accepted = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const { client, calls, publish } = await fixture({
      deliver: () => accepted,
    });
    const spawned = await client.request("spawn", {
      harness: "codex",
      cwd: "/tmp",
      sessionLabel: "kill-race",
      message: "initial",
    });
    if ("error" in spawned) throw new Error("Expected spawn ACK");
    if (placement === "new_turn")
      publish({
        type: "turn.completed",
        sessionId: spawned.result.sessionId,
        turnId: spawned.result.turnId,
        stopReason: "end_turn",
        finalReply: null,
      });
    const events: DomainEvent[] = [];
    client.onNotification((notification) => {
      if (notification.method === "event")
        events.push(notification.params.event);
    });
    await client.request("attach", {
      scope: "session",
      sessionId: spawned.result.sessionId,
      replay: { mode: "available" },
    });
    events.length = 0;
    const sending = client.request(
      "send",
      placement === "active_turn"
        ? {
            placement,
            sessionId: spawned.result.sessionId,
            turnId: spawned.result.turnId,
            message: "accepted before stop",
          }
        : {
            placement,
            sessionId: spawned.result.sessionId,
            message: "accepted before stop",
          },
    );
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(calls.delivered).toHaveLength(1);
    const killing = client.request("kill", {
      sessionId: spawned.result.sessionId,
    });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    accept();
    expect(await sending).toHaveProperty("result");
    expect(await killing).toHaveProperty("result");
    expect(events.map((event) => event.type)).toEqual(
      placement === "active_turn"
        ? ["message", "turn.completed", "session.killed"]
        : ["turn.started", "message", "turn.completed", "session.killed"],
    );
  },
);
