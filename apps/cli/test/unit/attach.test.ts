import { PassThrough } from "node:stream";

import { createReinsClient, type ReinsClient } from "@reins/client";
import type {
  DomainEvent,
  ProtocolMessage,
  ProtocolRequest,
} from "@reins/protocol";
import {
  messageIdSchema,
  permissionIdSchema,
  consumerContextSchema,
  subscriptionIdSchema,
  eventIdSchema,
  sessionIdSchema,
  turnIdSchema,
} from "@reins/protocol";
import type { TransportConnection, TransportEvent } from "@reins/transport";
import * as v from "valibot";
import { afterEach, expect, test, vi } from "vitest";

import { runAttach } from "../../src/attach.ts";

type LegacyNotification =
  | { kind: "notification"; method: "event"; params: DomainEvent }
  | {
      kind: "notification";
      method: "attach.ended";
      params: {
        sessionId: import("@reins/protocol").SessionId;
        reason: "session_killed";
      };
    };
const legacyNotification = (value: LegacyNotification): LegacyNotification =>
  value;
const sessionId = v.parse(sessionIdSchema, "prompt@g1");
const turnId = v.parse(turnIdSchema, "t1");
const secondTurnId = v.parse(turnIdSchema, "t2");
const messageId = v.parse(messageIdSchema, "m1");
const requested = (
  permissionId: "p1" | "p2" | "p3",
  targetTurnId = turnId,
): LegacyNotification =>
  legacyNotification({
    kind: "notification",
    method: "event",
    params: {
      type: "permission.requested",
      sessionId,
      turnId: targetTurnId,
      permissionId: v.parse(permissionIdSchema, permissionId),
      kind: "tool:Bash",
      options: [
        { outcome: "allow", scope: "once" },
        { outcome: "deny", feedback: true },
      ],
    },
  });

const resolved = (permissionId: "p1" | "p2"): LegacyNotification =>
  legacyNotification({
    kind: "notification",
    method: "event",
    params: {
      type: "permission.resolved",
      sessionId,
      turnId,
      permissionId: v.parse(permissionIdSchema, permissionId),
      resolution: { outcome: "allow", scope: "once" },
    },
  });

const completed = (targetTurnId = turnId): LegacyNotification => ({
  kind: "notification",
  method: "event",
  params: {
    type: "turn.completed",
    sessionId,
    turnId: targetTurnId,
    stopReason: "end_turn",
    finalReply: null,
  },
});

class ControlledClient implements ReinsClient {
  readonly resolutions: string[] = [];
  readonly request: ReinsClient["request"];
  readonly retry: ReinsClient["retry"];
  readonly subscribe: ReinsClient["subscribe"];
  readonly onNotification: ReinsClient["onNotification"];
  readonly onClosed: ReinsClient["onClosed"];
  readonly initialize: ReinsClient["initialize"];
  readonly close: ReinsClient["close"];
  private readonly listeners = new Set<
    (event: TransportEvent<ProtocolMessage>) => void
  >();
  private attachRequest: ProtocolRequest | undefined;
  private position = 0;
  constructor() {
    const connection: TransportConnection<ProtocolMessage> = {
      send: (message) => {
        if (message.kind === "control") {
          this.end();
          return;
        }
        if (message.kind !== "request") return;
        if (message.method === "attach") {
          this.attachRequest = message;
          return;
        }
        const params =
          message.params as import("@reins/protocol").ResolvePermissionParams;
        const result =
          message.method === "initialize"
            ? { protocolMajorVersion: 1, daemonGeneration: "gunit" }
            : {
                sessionId: params.sessionId,
                turnId: params.turnId,
                permissionId: params.permissionId,
              };
        if (message.method === "resolvePermission")
          this.resolutions.push(params.permissionId);
        this.deliver({
          kind: "response",
          requestId: message.requestId,
          result,
        });
      },
      onEvent: (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
      close: () => {},
    };
    const client = createReinsClient(connection, {
      consumerContext: v.parse(consumerContextSchema, "unit"),
    });
    this.request = client.request.bind(client);
    this.retry = client.retry.bind(client);
    this.subscribe = client.subscribe.bind(client);
    this.onNotification = client.onNotification.bind(client);
    this.onClosed = client.onClosed.bind(client);
    this.initialize = client.initialize.bind(client);
    this.close = client.close.bind(client);
    void client.initialize();
  }
  private deliver(message: ProtocolMessage): void {
    for (const listener of this.listeners)
      listener({ kind: "message", message });
  }
  acceptAttach(): void {
    if (this.attachRequest === undefined)
      throw new Error("Missing attach request");
    this.deliver({
      kind: "response",
      requestId: this.attachRequest.requestId,
      result: {
        sessionId,
        subscriptionId: "subscription-unit",
        target: { scope: "session", sessionId },
        window: { oldest: null, head: null },
        replayed: 0,
      },
    });
  }
  emit(notification: LegacyNotification): void {
    const subscriptionId = v.parse(subscriptionIdSchema, "subscription-unit");
    if (notification.method === "event")
      this.deliver({
        kind: "notification",
        method: "event",
        params: {
          subscriptionId,
          eventId: v.parse(eventIdSchema, ++this.position),
          event: notification.params,
        },
      });
    else
      this.deliver({
        kind: "notification",
        method: "attach.ended",
        params: {
          ...notification.params,
          subscriptionId,
          target: { scope: "session", sessionId },
          lastEventId:
            this.position === 0 ? null : v.parse(eventIdSchema, this.position),
        },
      });
  }
  end(): void {
    this.emit({
      kind: "notification",
      method: "attach.ended",
      params: { sessionId, reason: "session_killed" },
    });
  }
}

const tick = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

afterEach(() => vi.restoreAllMocks());

test("replayed request followed by resolution never opens a prompt", async () => {
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const client = new ControlledClient();
  const input = new PassThrough();
  const attached = runAttach(client, {
    params: { scope: "session", sessionId, replay: { mode: "available" } },
    mode: "pretty",
    input,
  });
  client.emit(requested("p1"));
  client.emit(resolved("p1"));
  client.acceptAttach();
  await tick();
  expect(output.join("")).not.toContain("Permission requested:");
  client.end();
  await expect(attached).resolves.toMatchObject({ reason: "session_killed" });
});

test("a replayed terminal clears its pending permission before attach acceptance", async () => {
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const client = new ControlledClient();
  const input = new PassThrough();
  const attached = runAttach(client, {
    params: { scope: "session", sessionId, replay: { mode: "available" } },
    mode: "pretty",
    input,
  });
  client.emit(requested("p1"));
  client.emit(completed());
  client.acceptAttach();
  await tick();

  expect(output.join("")).not.toContain("Permission requested:");
  expect(client.resolutions).toEqual([]);
  client.end();
  await expect(attached).resolves.toMatchObject({ reason: "session_killed" });
});

test("a live turn terminal aborts its active permission without resolving it", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const client = new ControlledClient();
  const input = new PassThrough();
  const attached = runAttach(client, {
    params: { scope: "session", sessionId, replay: { mode: "available" } },
    mode: "pretty",
    input,
  });
  client.acceptAttach();
  client.emit(requested("p1"));
  await tick();
  client.emit(completed());
  input.end("1\n");
  await tick();

  expect(client.resolutions).toEqual([]);
  client.end();
  await attached;
});

test("a late answer after terminal abort cannot authorize the next turn", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const client = new ControlledClient();
  const input = new PassThrough();
  const attached = runAttach(client, {
    params: { scope: "session", sessionId, replay: { mode: "available" } },
    mode: "pretty",
    input,
  });
  client.acceptAttach();
  client.emit(requested("p1", turnId));
  await tick();
  client.emit(completed(turnId));
  await tick();
  input.write("1\n");
  await tick();
  client.emit(requested("p2", secondTurnId));
  await tick();

  expect(client.resolutions).toEqual([]);
  input.write("1\n");
  await tick();
  await tick();
  expect(client.resolutions).toEqual(["p2"]);
  client.end();
  await attached;
});

test("a late answer after external resolution cannot authorize the next permission", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const client = new ControlledClient();
  const input = new PassThrough();
  const attached = runAttach(client, {
    params: { scope: "session", sessionId, replay: { mode: "available" } },
    mode: "pretty",
    input,
  });
  client.acceptAttach();
  client.emit(requested("p1", turnId));
  await tick();
  client.emit(resolved("p1"));
  await tick();
  input.write("1\n");
  await tick();
  client.emit(requested("p2", secondTurnId));
  await tick();

  expect(client.resolutions).toEqual([]);
  input.write("1\n");
  await tick();
  await tick();
  expect(client.resolutions).toEqual(["p2"]);
  client.end();
  await attached;
});

test("surplus lines for one permission cannot pre-authorize the next", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const client = new ControlledClient();
  const input = new PassThrough();
  const attached = runAttach(client, {
    params: { scope: "session", sessionId, replay: { mode: "available" } },
    mode: "pretty",
    input,
  });
  client.acceptAttach();
  client.emit(requested("p1", turnId));
  await tick();
  input.write("1\n1\n");
  await tick();
  await tick();
  expect(client.resolutions).toEqual(["p1"]);

  client.emit(requested("p2", secondTurnId));
  await tick();
  expect(client.resolutions).toEqual(["p1"]);
  input.write("1\n");
  await tick();
  await tick();
  expect(client.resolutions).toEqual(["p1", "p2"]);
  client.end();
  await attached;
});

test("allow with surplus input and EOF resolves only its active permission", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const client = new ControlledClient();
  const input = new PassThrough();
  const attached = runAttach(client, {
    params: { scope: "session", sessionId, replay: { mode: "available" } },
    mode: "pretty",
    input,
  });
  client.acceptAttach();
  client.emit(requested("p1", turnId));
  await tick();
  input.end("1\n1\n");
  await tick();
  await tick();
  expect(client.resolutions).toEqual(["p1"]);

  client.emit(requested("p2", secondTurnId));
  await expect(attached).rejects.toEqual({
    code: "input_error",
    reason: "permission_choice_eof",
  });
  expect(client.resolutions).toEqual(["p1"]);
});

test("a terminal clears its turn while a later turn keeps FIFO progress", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const client = new ControlledClient();
  const input = new PassThrough();
  const attached = runAttach(client, {
    params: { scope: "session", sessionId, replay: { mode: "available" } },
    mode: "pretty",
    input,
  });
  client.emit(requested("p1", turnId));
  client.emit(completed(turnId));
  client.emit(requested("p2", secondTurnId));
  client.emit(requested("p3", secondTurnId));
  client.acceptAttach();
  await tick();
  input.write("1\n");
  await tick();
  input.write("1\n");
  await tick();
  await tick();

  expect(client.resolutions).toEqual(["p2", "p3"]);
  client.end();
  await attached;
});

test("pretty replay waits for attach acceptance and flushes a complete body once", async () => {
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const client = new ControlledClient();
  const attached = runAttach(client, {
    params: { scope: "session", sessionId, replay: { mode: "available" } },
    mode: "pretty",
  });
  client.emit({
    kind: "notification",
    method: "event",
    params: {
      type: "text.delta",
      sessionId,
      turnId,
      messageId,
      delta: "hello",
    },
  });
  client.emit({
    kind: "notification",
    method: "event",
    params: {
      type: "message",
      sessionId,
      turnId,
      messageId,
      role: "worker",
      content: "hello",
    },
  });
  expect(output.join("")).toBe("");
  client.acceptAttach();
  await tick();
  expect(output.join("")).toBe("hello\n");
  client.end();
  await attached;
});

test("a coherent replay body is rendered before its permission menu starts", async () => {
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const client = new ControlledClient();
  const input = new PassThrough();
  const attached = runAttach(client, {
    params: { scope: "session", sessionId, replay: { mode: "available" } },
    mode: "pretty",
    input,
  });
  client.emit({
    kind: "notification",
    method: "event",
    params: {
      type: "text.delta",
      sessionId,
      turnId,
      messageId,
      delta: "hello",
    },
  });
  client.emit(requested("p1"));
  client.acceptAttach();
  await tick();
  expect(output.join("")).toMatch(/^helloPermission requested: tool:Bash/u);
  input.end("1\n");
  await tick();
  await tick();
  expect(client.resolutions).toEqual(["p1"]);
  client.end();
  await attached;
});

test("an end received before the attach ACK flushes its initial batch before resolving", async () => {
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const client = new ControlledClient();
  let resolvedEarly = false;
  const attached = runAttach(client, {
    params: { scope: "session", sessionId, replay: { mode: "available" } },
    mode: "pretty",
  });
  void attached.then(() => {
    resolvedEarly = true;
  });
  client.emit({
    kind: "notification",
    method: "event",
    params: {
      type: "message",
      sessionId,
      turnId,
      messageId,
      role: "worker",
      content: "last replay",
    },
  });
  client.end();
  await tick();
  expect(resolvedEarly).toBe(false);
  expect(output.join("")).toBe("");
  client.acceptAttach();
  await expect(attached).resolves.toMatchObject({ reason: "session_killed" });
  expect(output.join("")).toBe(
    "worker: last replay\n[attach ended] session_killed\n",
  );
});

test("JSON attach waits for ACK and emits merged readable text", async () => {
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const client = new ControlledClient();
  const attached = runAttach(client, {
    params: { scope: "session", sessionId, replay: { mode: "available" } },
    mode: "json",
  });
  const delta: LegacyNotification = {
    kind: "notification",
    method: "event",
    params: { type: "text.delta", sessionId, turnId, messageId, delta: "same" },
  };
  const snapshot: LegacyNotification = {
    kind: "notification",
    method: "event",
    params: {
      type: "message",
      sessionId,
      turnId,
      messageId,
      role: "worker",
      content: "same",
    },
  };
  client.emit(delta);
  client.emit(snapshot);
  expect(output).toEqual([]);
  client.acceptAttach();
  client.end();
  await attached;
  const events = output
    .map((line) => JSON.parse(line))
    .filter((event) => event.type === "text");
  expect(events.map((event) => event.content).join("")).toBe("same");
  expect(events.every((event) => !("messageId" in event))).toBe(true);
});

test("pending permissions drain once in FIFO order after attach acceptance", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const client = new ControlledClient();
  const input = new PassThrough();
  const attached = runAttach(client, {
    params: { scope: "session", sessionId, replay: { mode: "available" } },
    mode: "pretty",
    input,
  });
  client.emit(requested("p1"));
  client.emit(requested("p1"));
  client.emit(requested("p2"));
  client.acceptAttach();
  await tick();
  input.write("1\n");
  await tick();
  input.write("1\n");
  await tick();
  await tick();
  expect(client.resolutions).toEqual(["p1", "p2"]);
  client.end();
  await attached;
});

test("a live external resolution cancels the active prompt without replying", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const client = new ControlledClient();
  const input = new PassThrough();
  const attached = runAttach(client, {
    params: { scope: "session", sessionId, replay: { mode: "available" } },
    mode: "pretty",
    input,
  });
  client.acceptAttach();
  client.emit(requested("p1"));
  await tick();
  client.emit(resolved("p1"));
  input.end("1\n");
  await tick();
  expect(client.resolutions).toEqual([]);
  client.end();
  await attached;
});

test("stdin EOF is a typed terminal error instead of a silent wait", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const client = new ControlledClient();
  const input = new PassThrough();
  const attached = runAttach(client, {
    params: { scope: "session", sessionId, replay: { mode: "available" } },
    mode: "pretty",
    input,
  });
  client.acceptAttach();
  client.emit(requested("p1"));
  input.end();
  await expect(attached).rejects.toEqual({
    code: "input_error",
    reason: "permission_choice_eof",
  });
  expect(client.resolutions).toEqual([]);
});

test("feedback EOF has its own typed recovery reason", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const client = new ControlledClient();
  const input = new PassThrough();
  const attached = runAttach(client, {
    params: { scope: "session", sessionId, replay: { mode: "available" } },
    mode: "pretty",
    input,
  });
  client.acceptAttach();
  client.emit(requested("p1"));
  await tick();
  input.end("2\n");
  await expect(attached).rejects.toEqual({
    code: "input_error",
    reason: "permission_feedback_eof",
  });
  expect(client.resolutions).toEqual([]);
});

test("same-tick natural close preserves queued feedback for its owner", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const client = new ControlledClient();
  const input = new PassThrough();
  const attached = runAttach(client, {
    params: { scope: "session", sessionId, replay: { mode: "available" } },
    mode: "pretty",
    input,
  });
  client.acceptAttach();
  client.emit(requested("p1"));
  await tick();
  input.write("2\nnot safe\n");
  input.emit("end");
  await tick();
  await tick();

  expect(client.resolutions).toEqual(["p1"]);
  client.end();
  await attached;
});

test("input end with choice and feedback resolves the same permission", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const client = new ControlledClient();
  const input = new PassThrough();
  const attached = runAttach(client, {
    params: { scope: "session", sessionId, replay: { mode: "available" } },
    mode: "pretty",
    input,
  });
  client.acceptAttach();
  client.emit(requested("p1"));
  await tick();
  input.end("2\nnot safe\n");
  await tick();
  await tick();

  expect(client.resolutions).toEqual(["p1"]);
  client.end();
  await attached;
});
