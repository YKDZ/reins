import { createReinsClient, parseRetryToken } from "@reins/client";
import type { HarnessAdapter } from "@reins/daemon";
import { openEphemeralDaemonForTest } from "@reins/daemon/testing";
import type { ConsumerContext, SessionId, SessionName } from "@reins/protocol";
import { afterEach, expect, test } from "vitest";
const daemons: Awaited<ReturnType<typeof openEphemeralDaemonForTest>>[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
});
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
const testIdentity = {
  session: (name: string) => (name + "@gtest") as SessionId,
};
function createFakeHarness(options: {
  harness: string;
  capability: { harness: string; models: never[] };
  terminate?: (id: SessionId) => Promise<void>;
}) {
  const calls = { starts: 0, terminated: [] as SessionId[] };
  const adapter: HarnessAdapter = {
    capabilities: async () => options.capability,
    driverFactory: () => ({
      start() {
        calls.starts += 1;
      },
      async deliver() {},
      async interrupt() {},
      resolvePermission() {},
      async terminate(id) {
        calls.terminated.push(id);
        await options.terminate?.(id);
      },
    }),
  };
  return { calls, adapter };
}

test("命令结果恢复：ACK 丢失后新客户端恢复原 spawn，原消息仅启动一次", async () => {
  const fake = createFakeHarness({
    harness: "fake",
    capability: { harness: "fake", models: [] },
  });
  const daemon = await openEphemeralDaemonForTest({
    adapters: new Map([["fake", fake.adapter]]),
  });
  daemons.push(daemon);
  const server = daemon;
  const transport = server.connect();
  let dropAck = false;
  const client = createReinsClient(
    {
      send: (message) => transport.send(message),
      close: () => transport.close(),
      onEvent: (listener) =>
        transport.onEvent((event) => {
          if (
            dropAck &&
            event.kind === "message" &&
            event.message.kind === "response"
          ) {
            transport.close();
            listener({ kind: "closed" });
            return;
          }
          listener(event);
        }),
    },
    { consumerContext: "test-consumer" as ConsumerContext },
  );
  await client.initialize();
  const params = {
    harness: "fake",
    cwd: "/tmp",
    sessionName: "lost-ack" as SessionName,
    message: "sensitive-message",
  };
  dropAck = true;
  let unknown: { code: string; retryToken: string } | undefined;
  try {
    await client.request("spawn", params);
  } catch (error) {
    unknown = JSON.parse((error as Error).message);
  }
  expect(unknown).toMatchObject({
    code: "command_outcome_unknown",
    cause: "disconnected",
  });
  expect(fake.calls.starts).toBe(1);
  expect(JSON.stringify(unknown)).not.toContain("sensitive-message");
  const recovery = createReinsClient(server.connect(), {
    consumerContext: "test-consumer" as ConsumerContext,
  });
  await recovery.initialize();
  expect(await recovery.retry(unknown!.retryToken, params)).toMatchObject({
    result: { sessionId: "lost-ack@gtest" },
  });
  expect(fake.calls.starts).toBe(1);
  expect(parseRetryToken(unknown!.retryToken)).toMatchObject({
    method: "spawn",
    daemonGeneration: "test",
  });
  client.close();
  recovery.close();
});

test("命令结果恢复：超时不取消原执行，重连显式加入仍在途的 kill", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake = createFakeHarness({
    harness: "fake",
    capability: { harness: "fake", models: [] },
    terminate: async () => blocked,
  });
  const daemon = await openEphemeralDaemonForTest({
    adapters: new Map([["fake", fake.adapter]]),
  });
  daemons.push(daemon);
  const server = daemon;
  const client = createReinsClient(server.connect(), {
    consumerContext: "test-consumer" as ConsumerContext,
  });
  const recovery = createReinsClient(server.connect(), {
    consumerContext: "test-consumer" as ConsumerContext,
  });
  try {
    await client.initialize();
    await recovery.initialize();
    await client.request("spawn", {
      harness: "fake",
      cwd: "/tmp",
      sessionName: "inflight" as SessionName,
      message: "initial",
    });
    const params = { sessionId: testIdentity.session("inflight") };
    let token: string | undefined;
    try {
      await client.request("kill", params, 5);
    } catch (error) {
      token = (JSON.parse((error as Error).message) as { retryToken: string })
        .retryToken;
    }
    expect(token).toEqual(expect.any(String));
    client.close();
    let settled = false;
    const joined = recovery.retry(token!, params).then((result) => {
      settled = true;
      return result;
    });
    await flush();
    expect(settled).toBe(false);
    expect(fake.calls.terminated).toHaveLength(1);
    release();
    expect(await joined).toMatchObject({
      result: { sessionId: "inflight@gtest", status: "killed" },
    });
    expect(fake.calls.terminated).toHaveLength(1);
  } finally {
    release();
    client.close();
    recovery.close();
  }
});

test("命令结果恢复：损坏的匹配 ACK 保留原身份，新连接取回原结果且不重复执行", async () => {
  const fake = createFakeHarness({
    harness: "fake",
    capability: { harness: "fake", models: [] },
  });
  const daemon = await openEphemeralDaemonForTest({
    adapters: new Map([["fake", fake.adapter]]),
  });
  daemons.push(daemon);
  const transport = daemon.connect();
  let originalAck: unknown;
  let commandId: unknown;
  let spawnRequestId: unknown;
  const client = createReinsClient(
    {
      send(message) {
        if (message.kind === "request" && message.method === "spawn") {
          commandId = message.commandId;
          spawnRequestId = message.requestId;
        }
        transport.send(message);
      },
      close: () => transport.close(),
      onEvent: (listener) =>
        transport.onEvent((event) => {
          if (
            event.kind === "message" &&
            event.message.kind === "response" &&
            event.message.requestId === spawnRequestId &&
            "result" in event.message
          ) {
            originalAck = event.message.result;
            listener({
              kind: "message",
              message: { ...event.message, result: {} },
            });
          } else listener(event);
        }),
    },
    { consumerContext: "test-consumer" as ConsumerContext },
  );
  const recovery = createReinsClient(daemon.connect(), {
    consumerContext: "test-consumer" as ConsumerContext,
  });
  try {
    await client.initialize();
    const params = {
      harness: "fake",
      cwd: "/tmp",
      sessionName: "invalid-ack" as SessionName,
      message: "caller authored private task",
    };
    let unknown: { retryToken: string } | undefined;
    try {
      await client.request("spawn", params);
    } catch (error) {
      unknown = JSON.parse((error as Error).message);
    }
    expect(originalAck).toEqual({
      sessionId: "invalid-ack@gtest",
      turnId: "t1",
      cwd: "/tmp",
    });
    expect(fake.calls.starts).toBe(1);
    expect(unknown).toMatchObject({
      code: "command_outcome_unknown",
      cause: "invalid_daemon_response",
      commandId,
      daemonGeneration: "test",
      retryToken: expect.any(String),
    });
    expect(JSON.stringify(unknown)).not.toContain(params.message);
    expect(parseRetryToken(unknown!.retryToken).commandId).toBe(commandId);
    await recovery.initialize();
    expect(await recovery.request("list", {})).toMatchObject({
      result: [{ sessionId: "invalid-ack@gtest" }],
    });
    expect(await recovery.retry(unknown!.retryToken, params)).toMatchObject({
      result: originalAck,
    });
    expect(fake.calls.starts).toBe(1);
  } finally {
    client.close();
    recovery.close();
  }
});
