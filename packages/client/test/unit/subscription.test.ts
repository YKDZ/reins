import {
  domainEventSchema,
  eventIdSchema,
  type ProtocolMessage,
  type ProtocolRequest,
} from "@reins/protocol";
import { createInMemoryTransportPair } from "@reins/transport";
import * as v from "valibot";
import { afterEach, expect, test, vi } from "vitest";

import { createReinsClient, type AgentEvent } from "../../src/index.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  vi.useRealTimers();
});
async function fixture(autoAck = true) {
  const pair = createInMemoryTransportPair<ProtocolMessage>();
  const client = createReinsClient(pair.client, {
    consumerContext: "projection-test" as never,
  });
  cleanup.push(() => client.close());
  let attach: ProtocolRequest | undefined;
  const ack = (): void => {
    if (attach === undefined) throw new Error("Missing attach request");
    pair.server.send({
      kind: "response",
      requestId: attach.requestId,
      result: {
        sessionId: "readable@g1",
        subscriptionId: "subscription-1",
        target: { scope: "session", sessionId: "readable@g1" },
        window: { oldest: null, head: null, truncated: false },
        replayed: 0,
      },
    });
  };
  pair.server.onEvent((event) => {
    if (event.kind !== "message" || event.message.kind !== "request") return;
    const request = event.message;
    if (request.method === "initialize")
      pair.server.send({
        kind: "response",
        requestId: request.requestId,
        result: { protocolMajorVersion: 1, daemonGeneration: "gtest" },
      });
    else if (request.method === "attach") {
      attach = request;
      if (autoAck) ack();
    }
  });
  await client.initialize();
  let position = 0;
  const emit = (event: object): void =>
    pair.server.send({
      kind: "notification",
      method: "event",
      params: {
        subscriptionId: "subscription-1" as never,
        eventId: v.parse(eventIdSchema, ++position),
        event: v.parse(domainEventSchema, {
          sessionId: "readable@g1",
          turnId: "t1",
          ...event,
        }),
      },
    });
  return { client, ack, emit };
}
const params = {
  scope: "session",
  sessionId: "readable@g1",
  replay: { mode: "none" },
} as const;
const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

test("shared subscriptions merge deltas with full snapshots and pair tool completions", async () => {
  const f = await fixture();
  const subscription = await f.client.subscribe(params as never);
  const events: AgentEvent[] = [];
  subscription.onEvent((event) => events.push(event));
  f.emit({ type: "text.delta", messageId: "m1", delta: "hel" });
  f.emit({ type: "text.delta", messageId: "m1", delta: "lo" });
  f.emit({
    type: "message",
    messageId: "m1",
    role: "worker",
    content: "hello world",
  });
  f.emit({ type: "text.delta", messageId: "m1", delta: "late duplicate" });
  f.emit({
    type: "message",
    messageId: "m1",
    role: "worker",
    content: "hello world",
  });
  f.emit({
    type: "message",
    messageId: "m2",
    role: "worker",
    content: "hello world",
  });
  f.emit({ type: "tool.requested", toolCallId: "call-1", name: "Read" });
  f.emit({
    type: "tool.completed",
    toolCallId: "call-1",
    name: "native-name",
    result: "contents",
    isError: false,
  });
  await flush();
  expect(
    events
      .filter((event) => event.type === "text")
      .map((event) => event.content),
  ).toEqual(["hel", "lo", " world", "hello world"]);
  expect(events.find((event) => event.type === "tool.completed")).toMatchObject(
    { name: "Read", result: "contents" },
  );
  for (const event of events)
    for (const key of [
      "messageId",
      "toolCallId",
      "subscriptionId",
      "permissionId",
      "turnId",
      "sessionId",
    ])
      expect(event).not.toHaveProperty(key);
});

test("a snapshot received before deltas is emitted once; an incompatible snapshot carries an explicit replacement", async () => {
  const f = await fixture();
  const subscription = await f.client.subscribe(params as never);
  const events: AgentEvent[] = [];
  subscription.onEvent((event) => events.push(event));
  f.emit({
    type: "message",
    messageId: "m1",
    role: "worker",
    content: "complete",
  });
  f.emit({ type: "text.delta", messageId: "m1", delta: "complete" });
  f.emit({ type: "text.delta", messageId: "m2", delta: "draft" });
  f.emit({
    type: "message",
    messageId: "m2",
    role: "worker",
    content: "corrected",
  });
  await flush();
  expect(
    events
      .filter((event) => event.type === "text")
      .map((event) => ({ content: event.content, operation: event.operation })),
  ).toEqual([
    { content: "complete", operation: "append" },
    { content: "draft", operation: "append" },
    { content: "corrected", operation: "replace" },
  ]);
});

test("attach establishment has no inherited thirty-second request deadline", async () => {
  const f = await fixture(false);
  vi.useFakeTimers();
  let settled = false;
  const subscription = f.client.subscribe(params as never).then((value) => {
    settled = true;
    return value;
  });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(settled).toBe(false);
  f.ack();
  await vi.advanceTimersByTimeAsync(0);
  expect(await subscription).toHaveProperty("establishment");
});
