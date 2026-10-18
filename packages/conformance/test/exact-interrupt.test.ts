import { createReinsClient, type ReinsClient } from "@reins/client";
import type { HarnessAdapter } from "@reins/daemon";
import { openEphemeralDaemonForTest } from "@reins/daemon/testing";
import type {
  ConsumerContext,
  DomainEvent,
  SessionName,
  WorkerDriver,
  WorkerSpec,
} from "@reins/protocol";
import { afterEach, expect, test } from "vitest";

const daemons: Awaited<ReturnType<typeof openEphemeralDaemonForTest>>[] = [];
const clients: ReinsClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const daemon of daemons.splice(0)) await daemon.close();
});

async function fixture(interrupt: () => Promise<void>) {
  const calls = {
    interrupted: [] as unknown[][],
    terminated: 0,
    delivered: [] as Parameters<WorkerDriver["deliver"]>[],
    starts: [] as WorkerSpec[],
  };
  let publish!: (event: DomainEvent) => void;
  const adapter: HarnessAdapter = {
    modelCatalog: async () => ({ harness: "codex", models: [] }),
    driverFactory: ({ emit }) => {
      publish = emit;
      return {
        start(spec) {
          calls.starts.push(spec);
        },
        async deliver(...args) {
          calls.delivered.push(args);
        },
        async interrupt(...args) {
          calls.interrupted.push(args);
          await interrupt();
        },
        resolvePermission() {},
        async terminate() {
          calls.terminated += 1;
        },
      };
    },
  };
  const daemon = await openEphemeralDaemonForTest({
    adapters: new Map([["codex", adapter]]),
  });
  daemons.push(daemon);
  const client = createReinsClient(daemon.connect(), {
    consumerContext: "interrupt-consumer" as ConsumerContext,
    runtimeScopeId: daemon.runtimeScopeId,
  });
  clients.push(client);
  await client.initialize();
  return { client, calls, publish: (event: DomainEvent) => publish(event) };
}

const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

test("精确 interrupt 等原生接受才 ACK，取消独立观察且保留会话", async () => {
  let accept!: () => void;
  const accepted = new Promise<void>((resolve) => {
    accept = resolve;
  });
  const { client, calls, publish } = await fixture(() => accepted);
  const spawned = await client.request("spawn", {
    harness: "codex",
    cwd: "/tmp",
    sessionName: "exact-interrupt" as SessionName,
    message: "initial caller task",
  });
  if ("error" in spawned) throw new Error("Expected spawn ACK");
  const { sessionId, turnId } = spawned.result;
  const events: DomainEvent[] = [];
  client.onNotification((notification) => {
    if (notification.method === "event") events.push(notification.params.event);
  });
  await client.request("attach", {
    scope: "session",
    sessionId,
    replay: { mode: "available" },
  });
  let settled = false;
  const pending = client
    .request("interrupt", { sessionId, turnId })
    .then((value) => {
      settled = true;
      return value;
    });
  await flush();
  expect(calls.interrupted).toEqual([[sessionId, turnId]]);
  expect(settled).toBe(false);
  expect(events.filter((event) => event.type === "turn.completed")).toEqual([]);
  accept();
  expect(await pending).toMatchObject({ result: { sessionId, turnId } });
  expect(await client.request("list", {})).toMatchObject({
    result: [{ sessionId, state: "busy", activeTurnId: turnId }],
  });
  publish({
    type: "turn.completed",
    sessionId,
    turnId,
    stopReason: "cancelled",
    finalReply: null,
  });
  await flush();
  expect(
    events.filter((event) => event.type === "turn.completed"),
  ).toMatchObject([{ turnId, stopReason: "cancelled" }]);
  expect(calls.terminated).toBe(0);
  expect(calls.delivered).toEqual([]);
  const next = await client.request("send", {
    placement: "new_turn",
    sessionId,
    message: "explicit next caller task",
  });
  expect(next).toMatchObject({ result: { sessionId } });
  if ("result" in next) expect(next.result.turnId).not.toBe(turnId);
});

test("interrupt 结束先赢的拒绝保留原目标，不停止显式后继回合", async () => {
  let refuse!: (error: unknown) => void;
  const decision = new Promise<void>((_resolve, reject) => {
    refuse = reject;
  });
  const { client, calls, publish } = await fixture(() => decision);
  const spawned = await client.request("spawn", {
    harness: "codex",
    cwd: "/tmp",
    sessionName: "interrupt-race" as SessionName,
    message: "initial task",
  });
  if ("error" in spawned) throw new Error("Expected spawn ACK");
  const { sessionId, turnId } = spawned.result;
  const pending = client.request("interrupt", { sessionId, turnId });
  await flush();
  expect(calls.interrupted).toEqual([[sessionId, turnId]]);
  publish({
    type: "turn.completed",
    sessionId,
    turnId,
    stopReason: "end_turn",
    finalReply: "original done",
  });
  const next = await client.request("send", {
    placement: "new_turn",
    sessionId,
    message: "explicit successor",
  });
  if ("error" in next) throw new Error("Expected explicit new turn ACK");
  refuse({ code: "turn_not_active", sessionId, turnId });
  expect(await pending).toMatchObject({
    error: { code: "turn_not_active", sessionId, turnId },
  });
  expect(
    await client.request("interrupt", { sessionId, turnId }),
  ).toMatchObject({ error: { code: "turn_not_active" } });
  expect(await client.request("list", {})).toMatchObject({
    result: [{ state: "busy", activeTurnId: next.result.turnId }],
  });
  expect(calls.interrupted).toEqual([[sessionId, turnId]]);
  expect(calls.terminated).toBe(0);
  expect(calls.delivered).toHaveLength(1);
});

test("interrupt 错误父级在原生调用前拒绝，停止失败不伪造取消", async () => {
  const { client, calls } = await fixture(async () => {
    throw new Error("native interrupt rejected");
  });
  const spawn = async (name: string) => {
    const response = await client.request("spawn", {
      harness: "codex",
      cwd: "/tmp",
      sessionName: name as SessionName,
      message: "caller task",
    });
    if ("error" in response) throw new Error("Expected spawn ACK");
    return response.result;
  };
  const first = await spawn("interrupt-parent-a");
  const second = await spawn("interrupt-parent-b");
  expect(
    await client.request("interrupt", {
      sessionId: first.sessionId,
      turnId: second.turnId,
    }),
  ).toMatchObject({ error: { code: "invalid_params" } });
  expect(calls.interrupted).toEqual([]);
  expect(
    await client.request("interrupt", {
      sessionId: first.sessionId,
      turnId: first.turnId,
    }),
  ).toMatchObject({ error: { code: "internal_error" } });
  expect(
    await client.request("list", { sessionId: first.sessionId }),
  ).toMatchObject({ result: [{ state: "busy", activeTurnId: first.turnId }] });
  expect(calls.terminated).toBe(0);
});
