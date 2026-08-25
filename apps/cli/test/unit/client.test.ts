import { createInMemoryTransportPair } from "@reins/transport";
import { expect, test, vi } from "vitest";

import { createReinsClient } from "../../src/client.ts";

test("malformed inbound envelope rejects an outstanding request as invalid daemon response", async () => {
  const pair = createInMemoryTransportPair();
  const client = createReinsClient(pair.client as never);
  const pending = client.request("capabilities", {});
  pair.server.send({ kind: "notification", method: "event", params: {} });
  await expect(pending).rejects.toThrow("invalid_daemon_response");
  client.close();
});

test("a schema-invalid response result rejects as invalid daemon response", async () => {
  const pair = createInMemoryTransportPair();
  const client = createReinsClient(pair.client as never);
  const pending = client.request("capabilities", {});
  pair.server.send({ kind: "response", requestId: "cli1", result: {} });
  await expect(pending).rejects.toThrow("invalid_daemon_response");
  client.close();
});

test("invalid input terminates every lifecycle listener with the concrete reason", async () => {
  const pair = createInMemoryTransportPair();
  const client = createReinsClient(pair.client as never);
  const reason = new Promise((resolve) => client.onClosed(resolve));
  pair.server.send({ kind: "notification", method: "event", params: {} });
  await expect(reason).resolves.toEqual({ code: "invalid_daemon_response" });
  client.close();
});

test("an invalid result terminates the client with invalid_daemon_response", async () => {
  const pair = createInMemoryTransportPair();
  const client = createReinsClient(pair.client as never);
  const reason = new Promise((resolve) => client.onClosed(resolve));
  const pending = client.request("capabilities", {});
  pair.server.send({ kind: "response", requestId: "cli1", result: {} });
  await expect(pending).rejects.toThrow("invalid_daemon_response");
  await expect(reason).resolves.toEqual({ code: "invalid_daemon_response" });
  client.close();
});

test("a malformed notification after a valid response preserves invalid_daemon_response", async () => {
  const pair = createInMemoryTransportPair();
  const client = createReinsClient(pair.client as never);
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
  const client = createReinsClient(pair.client as never);
  const pending = client.request("capabilities", {}, 30_000);
  client.close();
  await expect(pending).rejects.toThrow("daemon_disconnected");
});

test("request timeout rejects with the distinct daemon_timeout machine error", async () => {
  const pair = createInMemoryTransportPair();
  const client = createReinsClient(pair.client as never);
  await expect(client.request("capabilities", {}, 1)).rejects.toThrow(
    "daemon_timeout",
  );
  client.close();
});

test("a settled response removes its request timer", async () => {
  vi.useFakeTimers();
  try {
    const pair = createInMemoryTransportPair();
    const client = createReinsClient(pair.client as never);
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
    const client = createReinsClient(pair.client as never);
    client.close();
    await expect(client.request("capabilities", {})).rejects.toThrow(
      "daemon_disconnected",
    );
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
