import { REINS_PROTOCOL_MAJOR_VERSION } from "@reins/protocol";
import { createInMemoryTransportPair } from "@reins/transport";
import { expect, test, vi } from "vitest";

import { createReinsClient } from "../../src/index.ts";

const binding = { consumerContext: "alpha" as const };

test("initialize 以必填消费者上下文与协议主版本握手并交出 daemon 世代", async () => {
  const pair = createInMemoryTransportPair();
  const client = createReinsClient(pair.client as never, binding);
  const handshake = client.initialize();
  pair.server.send({
    kind: "response",
    requestId: "cli1",
    result: {
      protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
      daemonGeneration: "ab12cd" as never,
    },
  });

  await expect(handshake).resolves.toEqual({
    kind: "response",
    requestId: "cli1",
    result: {
      protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
      daemonGeneration: "ab12cd",
    },
  });
  client.close();
});

test("握手请求携带消费者绑定而非领域参数", async () => {
  const pair = createInMemoryTransportPair();
  const client = createReinsClient(pair.client as never, binding);
  const sent: unknown[] = [];
  pair.server.onEvent((event) => {
    if (event.kind === "message") sent.push(event.message);
  });
  const handshake = client.initialize();
  pair.server.send({
    kind: "response",
    requestId: "cli1",
    result: {
      protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
      daemonGeneration: "ab12cd" as never,
    },
  });
  await handshake;

  expect(sent).toEqual([
    {
      kind: "request",
      requestId: "cli1",
      method: "initialize",
      params: {
        protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
        consumerContext: "alpha",
      },
    },
  ]);
  client.close();
});

test("静默 daemon 下握手按调用方时限结束而不拖满请求默认时限", async () => {
  vi.useFakeTimers();
  try {
    const pair = createInMemoryTransportPair();
    const client = createReinsClient(pair.client as never, binding);
    const handshake = client.initialize(1_000);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1_000);
    await expect(handshake).rejects.toThrow("daemon_timeout");
    client.close();
  } finally {
    vi.useRealTimers();
  }
});

test("版本不匹配的握手响应原样交出且不再发出领域请求", async () => {
  const pair = createInMemoryTransportPair();
  const client = createReinsClient(pair.client as never, binding);
  const sent: unknown[] = [];
  pair.server.onEvent((event) => {
    if (event.kind === "message") sent.push(event.message);
  });
  const handshake = client.initialize();
  pair.server.send({
    kind: "response",
    requestId: "cli1",
    error: {
      code: "protocol_version_mismatch" as never,
      requestedProtocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION + 1,
      supportedProtocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
    },
  });

  await expect(handshake).resolves.toMatchObject({
    error: { code: "protocol_version_mismatch" },
  });
  expect(sent).toHaveLength(1);
  client.close();
});

test("malformed inbound envelope rejects an outstanding request as invalid daemon response", async () => {
  const pair = createInMemoryTransportPair();
  const client = createReinsClient(pair.client as never, binding);
  const pending = client.request("capabilities", {});
  pair.server.send({ kind: "notification", method: "event", params: {} });
  await expect(pending).rejects.toThrow("invalid_daemon_response");
  client.close();
});

test("a schema-invalid response result rejects as invalid daemon response", async () => {
  const pair = createInMemoryTransportPair();
  const client = createReinsClient(pair.client as never, binding);
  const pending = client.request("capabilities", {});
  pair.server.send({ kind: "response", requestId: "cli1", result: {} });
  await expect(pending).rejects.toThrow("invalid_daemon_response");
  client.close();
});

test("invalid input terminates every lifecycle listener with the concrete reason", async () => {
  const pair = createInMemoryTransportPair();
  const client = createReinsClient(pair.client as never, binding);
  const reason = new Promise((resolve) => client.onClosed(resolve));
  pair.server.send({ kind: "notification", method: "event", params: {} });
  await expect(reason).resolves.toEqual({ code: "invalid_daemon_response" });
  client.close();
});

test("an invalid result terminates the client with invalid_daemon_response", async () => {
  const pair = createInMemoryTransportPair();
  const client = createReinsClient(pair.client as never, binding);
  const reason = new Promise((resolve) => client.onClosed(resolve));
  const pending = client.request("capabilities", {});
  pair.server.send({ kind: "response", requestId: "cli1", result: {} });
  await expect(pending).rejects.toThrow("invalid_daemon_response");
  await expect(reason).resolves.toEqual({ code: "invalid_daemon_response" });
  client.close();
});

test("a malformed notification after a valid response preserves invalid_daemon_response", async () => {
  const pair = createInMemoryTransportPair();
  const client = createReinsClient(pair.client as never, binding);
  const pending = client.request("attach", { sessionId: "prompt@g1" as never });
  pair.server.send({
    kind: "response",
    requestId: "cli1",
    result: { sessionId: "prompt@g1", replayed: 0 },
  });
  await expect(pending).resolves.toMatchObject({ kind: "response" });
  const reason = new Promise((resolve) => client.onClosed(resolve));
  pair.server.send({ kind: "notification", method: "event", params: {} });
  await expect(reason).resolves.toEqual({ code: "invalid_daemon_response" });
  client.close();
});

test("client close rejects a pending request without waiting for its timeout", async () => {
  const pair = createInMemoryTransportPair();
  const client = createReinsClient(pair.client as never, binding);
  const pending = client.request("capabilities", {}, 30_000);
  client.close();
  await expect(pending).rejects.toThrow("daemon_disconnected");
});

test("request timeout rejects with the distinct daemon_timeout machine error", async () => {
  const pair = createInMemoryTransportPair();
  const client = createReinsClient(pair.client as never, binding);
  await expect(client.request("capabilities", {}, 1)).rejects.toThrow(
    "daemon_timeout",
  );
  client.close();
});

test("a settled response removes its request timer", async () => {
  vi.useFakeTimers();
  try {
    const pair = createInMemoryTransportPair();
    const client = createReinsClient(pair.client as never, binding);
    const pending = client.request("capabilities", {}, 30_000);
    expect(vi.getTimerCount()).toBe(1);
    pair.server.send({
      kind: "response",
      requestId: "cli1",
      result: { capabilities: [], failures: [] },
    });
    await expect(pending).resolves.toMatchObject({ kind: "response" });
    expect(vi.getTimerCount()).toBe(0);
    client.close();
  } finally {
    vi.useRealTimers();
  }
});

test("a request made after close rejects without installing a timer", async () => {
  vi.useFakeTimers();
  try {
    const pair = createInMemoryTransportPair();
    const client = createReinsClient(pair.client as never, binding);
    client.close();
    await expect(client.request("capabilities", {})).rejects.toThrow(
      "daemon_disconnected",
    );
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
