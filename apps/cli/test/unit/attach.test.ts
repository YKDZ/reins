import { PassThrough } from "node:stream";

import type {
  MachineError,
  ProtocolMethod,
  ProtocolNotification,
  ProtocolParams,
} from "@reins/protocol";
import {
  messageIdSchema,
  permissionIdSchema,
  protocolNotificationSchema,
  requestIdSchema,
  sessionIdSchema,
  turnIdSchema,
} from "@reins/protocol";
import * as v from "valibot";
import { afterEach, expect, test, vi } from "vitest";

import { runAttach } from "../../src/attach.ts";
import type {
  NotificationListener,
  ProtocolResponseFor,
  ReinsClient,
} from "../../src/client.ts";

const sessionId = v.parse(sessionIdSchema, "prompt@g1");
const turnId = v.parse(turnIdSchema, "t1");
const requestId = v.parse(requestIdSchema, "test");
const messageId = v.parse(messageIdSchema, "m1");
const requested = (permissionId: "p1" | "p2"): ProtocolNotification =>
  v.parse(protocolNotificationSchema, {
    kind: "notification",
    method: "event",
    params: {
      type: "permission.requested",
      sessionId,
      turnId,
      permissionId: v.parse(permissionIdSchema, permissionId),
      kind: "tool:Bash",
      options: [
        { outcome: "allow", scope: "once" },
        { outcome: "deny", feedback: true },
      ],
    },
  });

const resolved = (permissionId: "p1" | "p2"): ProtocolNotification =>
  v.parse(protocolNotificationSchema, {
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

class ControlledClient implements ReinsClient {
  readonly resolutions: string[] = [];
  private readonly notifications = new Set<NotificationListener>();
  private readonly closed = new Set<(reason: MachineError) => void>();
  private attachResolve:
    | ((response: ProtocolResponseFor<"attach">) => void)
    | undefined;

  request<M extends ProtocolMethod>(
    method: M,
    params: ProtocolParams<M>,
  ): Promise<ProtocolResponseFor<M>> {
    if (method === "attach") {
      return new Promise((resolve) => {
        this.attachResolve = resolve;
      }) as Promise<ProtocolResponseFor<M>>;
    }
    let result: unknown = {};
    if (method === "resolvePermission") {
      const resolution = params as ProtocolParams<"resolvePermission">;
      this.resolutions.push(resolution.permissionId);
      result = {
        sessionId: resolution.sessionId,
        permissionId: resolution.permissionId,
      };
    }
    return Promise.resolve({
      kind: "response",
      requestId,
      result,
    }) as Promise<ProtocolResponseFor<M>>;
  }

  acceptAttach(): void {
    this.attachResolve?.({
      kind: "response",
      requestId,
      result: { sessionId, replayed: 0 },
    });
  }

  emit(notification: ProtocolNotification): void {
    for (const listener of this.notifications) listener(notification);
  }

  end(): void {
    this.emit({
      kind: "notification",
      method: "attach.ended",
      params: { sessionId, reason: "session_killed" },
    });
  }

  onNotification(listener: NotificationListener): () => void {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  onClosed(listener: (reason: MachineError) => void): () => void {
    this.closed.add(listener);
    return () => this.closed.delete(listener);
  }

  close(): void {}
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
    params: { sessionId },
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

test("pretty replay waits for attach acceptance and flushes a complete body once", async () => {
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const client = new ControlledClient();
  const attached = runAttach(client, { params: { sessionId }, mode: "pretty" });
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
    params: { sessionId },
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
  const attached = runAttach(client, { params: { sessionId }, mode: "pretty" });
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
    "worker: last replay\n[attach ended] prompt@g1: session_killed\n",
  );
});

test("JSON attach emits every notification without presenter projection", async () => {
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const client = new ControlledClient();
  const attached = runAttach(client, { params: { sessionId }, mode: "json" });
  const delta: ProtocolNotification = {
    kind: "notification",
    method: "event",
    params: { type: "text.delta", sessionId, turnId, messageId, delta: "same" },
  };
  const snapshot: ProtocolNotification = {
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
  expect(output.map((line) => JSON.parse(line) as unknown)).toEqual([
    delta,
    snapshot,
  ]);
  client.acceptAttach();
  client.end();
  await attached;
});

test("pending permissions drain once in FIFO order after attach acceptance", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const client = new ControlledClient();
  const input = new PassThrough();
  const attached = runAttach(client, {
    params: { sessionId },
    mode: "pretty",
    input,
  });
  client.emit(requested("p1"));
  client.emit(requested("p1"));
  client.emit(requested("p2"));
  client.acceptAttach();
  input.end("1\n1\n");
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
    params: { sessionId },
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
    params: { sessionId },
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
    params: { sessionId },
    mode: "pretty",
    input,
  });
  client.acceptAttach();
  client.emit(requested("p1"));
  input.end("2\n");
  await expect(attached).rejects.toEqual({
    code: "input_error",
    reason: "permission_feedback_eof",
  });
  expect(client.resolutions).toEqual([]);
});
