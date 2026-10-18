import {
  domainEventSchema,
  eventIdSchema,
  decodeResumeCursor,
  type ProtocolMessage,
  type ProtocolRequest,
} from "@reins/protocol";
import { createInMemoryTransportPair } from "@reins/transport";
import * as v from "valibot";
import { afterEach, expect, test, vi } from "vitest";

import { AgentSubscriptionError } from "../../src/control.ts";
import { createReinsClient } from "../../src/index.ts";
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
  let resolveAttachRequested!: () => void;
  const attachRequested = new Promise<void>((resolve) => {
    resolveAttachRequested = resolve;
  });
  const controls: { method: string; subscriptionId: string }[] = [];
  const requestMethods: string[] = [];
  const ack = (): void => {
    if (attach === undefined) throw new Error("Missing attach request");
    pair.server.send({
      kind: "response",
      requestId: attach.requestId,
      result: {
        sessionId: "session:readable:1",
        subscriptionId: "subscription-1",
        target: { scope: "session", sessionId: "session:readable:1" },
        window: { oldest: null, head: null, truncated: false },
        replayed: 0,
      },
    });
  };
  pair.server.onEvent((event) => {
    if (event.kind !== "message" || event.message.kind !== "request") return;
    const request = event.message;
    requestMethods.push(request.method);
    if (request.method === "initialize")
      pair.server.send({
        kind: "response",
        requestId: request.requestId,
        result: { protocolMajorVersion: 1, daemonGeneration: "gtest" },
      });
    else if (request.method === "attach") {
      attach = request;
      resolveAttachRequested();
      if (autoAck) ack();
    }
  });
  pair.server.onEvent((event) => {
    if (
      event.kind === "message" &&
      event.message.kind === "control" &&
      event.message.method === "subscription.close"
    )
      controls.push({
        method: event.message.method,
        subscriptionId: event.message.subscriptionId,
      });
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
          sessionId: "session:readable:1",
          turnId: "t1",
          ...event,
        }),
      },
    });
  return { client, ack, emit, attachRequested, controls, requestMethods };
}
const params = {
  scope: "session",
  sessionId: "session:readable:1",
  replay: { mode: "none" },
} as const;
const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

test("fact subscriptions retain permission history and expose only domain associations", async () => {
  const f = await fixture();
  const subscription = await f.client.subscribeFacts(params as never);
  const requested = subscription.next();
  f.emit({
    type: "permission.requested",
    permissionId: "permission-1",
    kind: "shell",
    options: [{ outcome: "allow", scope: "once" }],
  });
  const first = await requested;
  f.emit({
    type: "permission.resolved",
    permissionId: "permission-1",
    resolution: { outcome: "allow", scope: "once" },
  });
  const second = await subscription.next();

  expect(first.value).toMatchObject({
    type: "permission.requested",
    kind: "shell",
  });
  expect(second.value).toMatchObject({ type: "permission.resolved" });
  expect(first.value?.factId).not.toBe(second.value?.factId);
  for (const fact of [first.value, second.value])
    for (const key of [
      "permissionId",
      "subscriptionId",
      "sessionId",
      "turnId",
      "eventId",
    ])
      expect(fact).not.toHaveProperty(key);
  expect(subscription.checkpoint).toBeTruthy();
  subscription.close();
});

test("a disconnect cursor stops at the last fact delivered to the iterator", async () => {
  const f = await fixture();
  const subscription = await f.client.subscribeFacts(params as never);
  f.emit({ type: "text.delta", messageId: "m1", delta: "delivered" });
  const delivered = await subscription.next();
  f.emit({ type: "text.delta", messageId: "m2", delta: "queued" });
  f.client.close();
  const error = await subscription.done.catch((reason: unknown) => reason);

  expect(delivered.value).toMatchObject({
    type: "text.delta",
    delta: "delivered",
  });
  expect(error).toBeInstanceOf(AgentSubscriptionError);
  expect(error).toMatchObject({ failure: { code: "daemon_disconnected" } });
  expect(
    decodeResumeCursor((error as AgentSubscriptionError).resumeCursor!).eventId,
  ).toBe(1);
});

test("a disconnect error cursor advances only as queued facts reach the iterator", async () => {
  const f = await fixture();
  const subscription = await f.client.subscribeFacts(params as never);
  f.emit({ type: "text.delta", messageId: "m1", delta: "first" });
  f.emit({ type: "text.delta", messageId: "m2", delta: "second" });
  await flush();

  f.client.close();
  const doneFailure = await subscription.done.catch(
    (reason: unknown) => reason as AgentSubscriptionError,
  );
  const first = await subscription.next();
  const second = await subscription.next();
  const iteratorFailure = await subscription
    .next()
    .catch((reason: unknown) => reason as AgentSubscriptionError);

  expect(first.value).toMatchObject({ type: "text.delta", delta: "first" });
  expect(second.value).toMatchObject({ type: "text.delta", delta: "second" });
  expect(doneFailure).toBeInstanceOf(AgentSubscriptionError);
  expect(iteratorFailure).toBeInstanceOf(AgentSubscriptionError);
  expect(decodeResumeCursor(doneFailure.resumeCursor!).eventId).toBe(0);
  expect(decodeResumeCursor(subscription.checkpoint).eventId).toBe(2);
  expect(decodeResumeCursor(iteratorFailure.resumeCursor!).eventId).toBe(2);
});

test("an abort during attach establishment rejects promptly and closes a late subscription", async () => {
  const f = await fixture(false);
  const controller = new AbortController();
  const establishing = f.client.subscribeFacts(
    params as never,
    controller.signal,
  );
  await f.attachRequested;

  controller.abort();
  const failure = await establishing.catch((reason: unknown) => reason);
  expect(failure).toMatchObject({ name: "AbortError" });
  f.ack();
  await flush();

  expect(f.controls).toEqual([
    { method: "subscription.close", subscriptionId: "subscription-1" },
  ]);
  expect(f.requestMethods).toEqual(["initialize", "attach"]);
});

test("an abort after attach establishment closes only the observation", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const subscription = await f.client.subscribeFacts(
    params as never,
    controller.signal,
  );

  controller.abort();
  await expect(subscription.next()).resolves.toEqual({
    value: undefined,
    done: true,
  });
  await expect(subscription.done).resolves.toMatchObject({ reason: "closed" });

  expect(f.controls).toEqual([
    { method: "subscription.close", subscriptionId: "subscription-1" },
  ]);
  expect(f.requestMethods).toEqual(["initialize", "attach"]);
});

test("attach establishment has no inherited thirty-second request deadline", async () => {
  const f = await fixture(false);
  vi.useFakeTimers();
  let settled = false;
  const subscription = f.client
    .subscribeFacts(params as never)
    .then((value) => {
      settled = true;
      return value;
    });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(settled).toBe(false);
  f.ack();
  await vi.advanceTimersByTimeAsync(0);
  const established = await subscription;
  expect(established).toHaveProperty("establishment");
  established.close();
});
