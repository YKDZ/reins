import type {
  DiagnosticInput,
  DomainEvent,
  PermissionId,
  SessionId,
  SessionName,
  TurnId,
} from "@reins/protocol";
import { describe, expect, test } from "vitest";

import { createCodexDriver } from "#/codex-driver";
import { createCodexTransport, type CodexChild } from "#/transport";

import { createFakeTransport } from "../helpers/fake-transport.ts";

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};
const sessionId = "reviewer@g1" as SessionId;
const firstTurnId = "t1" as TurnId;
const secondTurnId = "t2" as TurnId;
const permissionId = "p1" as PermissionId;
const sessionName = "reviewer" as SessionName;

function setup(
  authorizationMode: "interactive" | "allowAll" = "interactive",
  terminateTimeoutMs?: number,
): {
  events: DomainEvent[];
  diagnostics: DiagnosticInput[];
  fake: ReturnType<typeof createFakeTransport>;
  driver: ReturnType<ReturnType<typeof createCodexDriver>>;
} {
  const fake = createFakeTransport();
  const diagnostics: DiagnosticInput[] = [];
  const factory = createCodexDriver({
    transportFactory: () => fake.transport,
    ...(terminateTimeoutMs === undefined ? {} : { terminateTimeoutMs }),
  });
  const events: DomainEvent[] = [];
  const driver = factory({
    emit: (event) => events.push(event),
    diagnostics: async (input) => {
      diagnostics.push(input);
      return undefined;
    },
  });
  driver.start({
    sessionId,
    turnId: firstTurnId,
    sessionName,
    harness: "codex",
    message: "检查",
    cwd: "/tmp/demo",
    authorizationMode,
  });
  return { events, diagnostics, fake, driver };
}

function setupWithMalformedResponse(method: "turn/steer" | "thread/delete") {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const emitter = new EventEmitter();
  const child: CodexChild = {
    stdin,
    stdout,
    on: (event, listener) => emitter.on(event, listener),
    kill: () => {
      emitter.emit("exit");
      stdout.end();
      return true;
    },
  };
  let outbound = "";
  stdin.on("data", (chunk) => {
    outbound += String(chunk);
    for (;;) {
      const newline = outbound.indexOf("\n");
      if (newline < 0) break;
      const request = JSON.parse(outbound.slice(0, newline)) as {
        id?: number;
        method?: string;
      };
      outbound = outbound.slice(newline + 1);
      if (request.id === undefined) continue;
      const result =
        request.method === method
          ? null
          : request.method === "thread/start"
            ? { thread: { id: "thr1" } }
            : request.method === "turn/start"
              ? { turn: { id: "turn1" } }
              : {};
      queueMicrotask(() => {
        stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      });
    }
  });
  const diagnostics: DiagnosticInput[] = [];
  const events: DomainEvent[] = [];
  const factory = createCodexDriver({
    transportFactory: (options) =>
      createCodexTransport({ ...options, spawnChild: () => child }),
  });
  const driver = factory({
    emit: (event) => events.push(event),
    diagnostics: async (input) => {
      diagnostics.push(input);
      return undefined;
    },
  });
  driver.start({
    sessionId,
    turnId: firstTurnId,
    sessionName,
    harness: "codex",
    message: "检查",
    cwd: "/tmp/demo",
    authorizationMode: "interactive",
  });
  return { diagnostics, driver, events };
}

describe("codex driver", () => {
  test("spawn 走 initialize → thread/start → turn/start", async () => {
    const { fake } = setup();
    await flush();

    const methods = fake.controls.requests().map((request) => request.method);
    expect(methods).toEqual(["initialize", "thread/start", "turn/start"]);
    const threadStart = fake.controls.requests()[1];
    expect(threadStart?.params).toEqual({
      ephemeral: true,
      cwd: "/tmp/demo",
      approvalPolicy: "on-request",
    });
    const turnStart = fake.controls.requests()[2];
    expect(turnStart?.params).toEqual({
      threadId: "thr1",
      input: [{ type: "text", text: "检查", text_elements: [] }],
    });
  });

  test("allowAll 映射 approvalPolicy never + 沙箱全访问", async () => {
    const { fake } = setup("allowAll");
    await flush();

    const threadStart = fake.controls.requests()[1];
    expect(threadStart?.params).toEqual({
      ephemeral: true,
      cwd: "/tmp/demo",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  });

  test("agentMessage delta 与 completed、turn completed 映射事件流", async () => {
    const { events, fake } = setup();
    await flush();
    fake.controls.pushInbound({
      kind: "notification",
      method: "item/agentMessage/delta",
      params: {
        itemId: "m1",
        delta: "分析",
      },
    });
    fake.controls.pushInbound({
      kind: "notification",
      method: "item/completed",
      params: {
        item: { type: "agentMessage", id: "m1", text: "分析完成" },
      },
    });
    fake.controls.pushInbound({
      kind: "notification",
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    });
    await flush();

    expect(events.map((event) => event.type)).toEqual([
      "text.delta",
      "message",
      "turn.completed",
    ]);
    expect(events.at(-1)).toEqual({
      type: "turn.completed",
      sessionId,
      turnId: firstTurnId,
      stopReason: "end_turn",
      finalReply: "分析完成",
    });
  });

  test("工具 item 映射 tool.requested/tool.completed(isError)", async () => {
    const { events, fake } = setup();
    await flush();
    fake.controls.pushInbound({
      kind: "notification",
      method: "item/started",
      params: {
        item: {
          type: "commandExecution",
          id: "e1",
          status: "inProgress",
          output: null,
        },
      },
    });
    fake.controls.pushInbound({
      kind: "notification",
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: "e1",
          status: "failed",
          output: "not found",
        },
      },
    });
    await flush();

    expect(
      events.filter(
        (event) =>
          event.type === "tool.requested" || event.type === "tool.completed",
      ),
    ).toEqual([
      {
        type: "tool.requested",
        sessionId,
        turnId: firstTurnId,
        toolCallId: "c1",
        name: "commandExecution",
      },
      {
        type: "tool.completed",
        sessionId,
        turnId: firstTurnId,
        toolCallId: "c1",
        name: "commandExecution",
        result: "not found",
        isError: true,
      },
    ]);
  });

  test("审批请求转 permission.requested，决议翻译为决策应答", async () => {
    const { events, fake, driver } = setup();
    await flush();
    fake.controls.pushInbound({
      kind: "request",
      id: 7,
      method: "item/commandExecution/requestApproval",
      input: {
        threadId: "thr1",
        turnId: "turn1",
        itemId: "e1",
        command: "ls",
      },
      availableDecisions: ["accept", "acceptForSession", "decline"],
      requestedPermissions: {},
    });
    await flush();

    const requested = events.find(
      (event) => event.type === "permission.requested",
    );
    expect(requested).toEqual({
      type: "permission.requested",
      sessionId,
      turnId: firstTurnId,
      permissionId: "p1",
      kind: "tool:commandExecution",
      input: { threadId: "thr1", turnId: "turn1", itemId: "e1", command: "ls" },
      options: [
        { outcome: "allow", scope: "once" },
        { outcome: "allow", scope: "session" },
        { outcome: "deny", feedback: false },
      ],
    });

    driver.resolvePermission(sessionId, permissionId, {
      outcome: "allow",
      scope: "once",
    });
    expect(fake.controls.responded()).toEqual([
      { id: 7, result: { decision: "accept" } },
    ]);
  });

  test("不支持的入站请求归一化为 compatibility_gap，不泄漏请求对象", async () => {
    const { diagnostics, fake } = setup();
    await flush();
    fake.controls.pushInbound({
      kind: "request",
      id: 17,
      method: "unsupported",
      nativeMethod: "worker/unknownRequest",
    });
    await flush();

    expect(diagnostics).toEqual([
      expect.objectContaining({
        source: "adapter",
        harness: "codex",
        sessionId,
        turnId: firstTurnId,
        kind: "compatibility_gap",
        operation: "receive_worker_request",
        reason: "unsupported_request",
        message: expect.objectContaining({ text: "worker/unknownRequest" }),
      }),
    ]);
  });

  test("worker reported failure 只记录类型化 turn_failure", async () => {
    const { diagnostics, fake } = setup();
    await flush();
    fake.controls.pushInbound({
      kind: "notification",
      method: "turn/completed",
      params: { turn: { status: "failed" } },
    });
    await flush();

    expect(diagnostics).toEqual([
      expect.objectContaining({
        kind: "turn_failure",
        operation: "run_turn",
        reason: "worker_reported_failure",
        sessionId,
        turnId: firstTurnId,
      }),
    ]);
  });

  test("availableDecisions 只映射为菜单中的对应选项", async () => {
    const { events, fake } = setup();
    await flush();
    fake.controls.pushInbound({
      kind: "request",
      id: 9,
      method: "item/commandExecution/requestApproval",
      input: {
        threadId: "thr1",
        turnId: "turn1",
        itemId: "e2",
      },
      availableDecisions: ["accept"],
      requestedPermissions: {},
    });
    await flush();

    const requested = events.find(
      (event) => event.type === "permission.requested",
    );
    expect(
      requested?.type === "permission.requested" ? requested.options : [],
    ).toEqual([{ outcome: "allow", scope: "once" }]);
  });

  test("deny 映射 decline", async () => {
    const { fake, driver } = setup();
    await flush();
    fake.controls.pushInbound({
      kind: "request",
      id: 8,
      method: "item/fileChange/requestApproval",
      input: { threadId: "thr1", turnId: "turn1", itemId: "f1" },
      availableDecisions: ["accept", "acceptForSession", "decline"],
      requestedPermissions: {},
    });
    await flush();

    driver.resolvePermission(sessionId, permissionId, {
      outcome: "deny",
    });
    expect(fake.controls.responded()).toEqual([
      { id: 8, result: { decision: "decline" } },
    ]);
  });

  test("busy 时 deliver 走 steer，回合结束后走新 turn/start", async () => {
    const { fake, driver } = setup();
    await flush();

    driver.deliver(sessionId, firstTurnId, "继续");
    await flush();
    const steer = fake.controls.requests().at(-1);
    expect(steer?.method).toBe("turn/steer");
    expect(steer?.params).toEqual({
      threadId: "thr1",
      input: [{ type: "text", text: "继续", text_elements: [] }],
      expectedTurnId: "turn1",
    });

    fake.controls.pushInbound({
      kind: "notification",
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    });
    await flush();
    driver.deliver(sessionId, secondTurnId, "下一步");
    await flush();
    expect(fake.controls.requests().at(-1)?.method).toBe("turn/start");
  });

  test("真实 transport 已记录的 steer protocol error 不在 driver 重复记录", async () => {
    const { diagnostics, driver } = setupWithMalformedResponse("turn/steer");
    await flush();

    driver.deliver(sessionId, firstTurnId, "继续");
    await flush();

    expect(diagnostics).toEqual([
      expect.objectContaining({
        kind: "protocol_violation",
        operation: "validate_worker_response",
        reason: "invalid_shape",
      }),
    ]);
  });

  test("interrupt 走 turn/interrupt，interrupted 合成 cancelled", async () => {
    const { events, fake, driver } = setup();
    await flush();

    driver.interrupt(sessionId);
    await flush();
    expect(fake.controls.requests().at(-1)?.method).toBe("turn/interrupt");

    fake.controls.pushInbound({
      kind: "notification",
      method: "turn/completed",
      params: { turn: { status: "interrupted" } },
    });
    await flush();
    expect(events.at(-1)).toEqual({
      type: "turn.completed",
      sessionId,
      turnId: firstTurnId,
      stopReason: "cancelled",
      finalReply: null,
    });
  });

  test("terminate 走 thread/delete 并关闭传输，不补发 failed", async () => {
    const { events, fake, driver } = setup();
    await flush();

    driver.terminate(sessionId);
    await flush();
    expect(fake.controls.requests().at(-1)?.method).toBe("thread/delete");
    expect(fake.controls.closed()).toBe(true);
    expect(events.filter((event) => event.type === "turn.completed")).toEqual(
      [],
    );
  });

  test("terminate 的 delete 永不响应时有界关闭且只记录一条失败", async () => {
    const { diagnostics, fake, driver } = setup("interactive", 5);
    await flush();
    fake.controls.setResponse("thread/delete", new Promise(() => {}));

    driver.terminate(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fake.controls.closed()).toBe(true);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        kind: "request_failure",
        operation: "kill",
        stage: "terminate",
        reason: "timeout",
      }),
    ]);
  });

  test("terminate 的 delete 拒绝映射 upstream_error，close 仍执行", async () => {
    const { diagnostics, fake, driver } = setup();
    await flush();
    fake.controls.setResponse(
      "thread/delete",
      Promise.reject(new Error("delete rejected")),
    );

    driver.terminate(sessionId);
    await flush();

    expect(fake.controls.closed()).toBe(true);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        kind: "request_failure",
        operation: "kill",
        stage: "terminate",
        reason: "upstream_error",
      }),
    ]);
  });

  test("thread/delete 成功但 close 拒绝时也只记录一条 terminate 失败", async () => {
    const { diagnostics, fake, driver } = setup();
    await flush();
    fake.controls.setCloseError(new Error("close rejected"));

    driver.terminate(sessionId);
    await flush();

    expect(diagnostics).toEqual([
      expect.objectContaining({
        kind: "request_failure",
        operation: "kill",
        stage: "terminate",
        reason: "upstream_error",
        message: expect.objectContaining({ text: "Error: close rejected" }),
      }),
    ]);
  });

  test("真实 transport 已记录的 thread/delete protocol error 不在 terminate 重复记录", async () => {
    const { diagnostics, driver } = setupWithMalformedResponse("thread/delete");
    await flush();

    driver.terminate(sessionId);
    await flush();

    expect(diagnostics).toEqual([
      expect.objectContaining({
        kind: "protocol_violation",
        operation: "validate_worker_response",
        reason: "invalid_shape",
      }),
    ]);
  });

  test("transport 关闭后 deliver 补发 failed 而不是挂死", async () => {
    const { events, fake, driver } = setup();
    await flush();

    // 第一轮正常结束，随后传输关闭（等价于 codex 子进程退出）。
    fake.controls.pushInbound({
      kind: "notification",
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    });
    await flush();
    fake.controls.end();

    driver.deliver(sessionId, secondTurnId, "继续");
    await flush();

    expect(
      events.filter(
        (event) =>
          event.type === "turn.completed" && event.turnId === secondTurnId,
      ),
    ).toEqual([
      {
        type: "turn.completed",
        sessionId,
        turnId: secondTurnId,
        stopReason: "failed",
        finalReply: null,
      },
    ]);
  });

  test("worker stream 读取异常只记录 read_error", async () => {
    const { diagnostics, events, fake } = setup();
    await flush();

    fake.controls.fail(new Error("stdout read failed"));
    await flush();

    expect(diagnostics).toEqual([
      expect.objectContaining({
        kind: "stream_failure",
        operation: "receive_worker_stream",
        reason: "read_error",
      }),
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "turn.completed",
      stopReason: "failed",
    });
  });

  test("worker stream 自然 EOF 只记录 closed_unexpectedly", async () => {
    const { diagnostics, events, fake } = setup();
    await flush();

    fake.controls.end();
    await flush();

    expect(diagnostics).toEqual([
      expect.objectContaining({
        kind: "stream_failure",
        operation: "receive_worker_stream",
        reason: "closed_unexpectedly",
      }),
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "turn.completed",
      stopReason: "failed",
    });
  });
});
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
