import type {
  DomainEvent,
  PermissionId,
  SessionId,
  SessionName,
  TurnId,
} from "@reins/protocol";
import { describe, expect, test } from "vitest";

import { createCodexDriver } from "#/codex-driver";

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

function setup(authorizationMode: "interactive" | "allowAll" = "interactive"): {
  events: DomainEvent[];
  transcript: Array<[string, unknown]>;
  fake: ReturnType<typeof createFakeTransport>;
  driver: ReturnType<ReturnType<typeof createCodexDriver>>;
} {
  const fake = createFakeTransport();
  const transcript: Array<[string, unknown]> = [];
  const factory = createCodexDriver({
    transportFactory: () => fake.transport,
    transcript: (kind, payload) => transcript.push([kind, payload]),
  });
  const events: DomainEvent[] = [];
  const driver = factory((event) => events.push(event));
  driver.start({
    sessionId,
    turnId: firstTurnId,
    sessionName,
    harness: "codex",
    message: "检查",
    cwd: "/tmp/demo",
    authorizationMode,
  });
  return { events, transcript, fake, driver };
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
        threadId: "thr1",
        turnId: "turn1",
        itemId: "m1",
        delta: "分析",
      },
    });
    fake.controls.pushInbound({
      kind: "notification",
      method: "item/completed",
      params: {
        threadId: "thr1",
        turnId: "turn1",
        item: { type: "agentMessage", id: "m1", text: "分析完成" },
      },
    });
    fake.controls.pushInbound({
      kind: "notification",
      method: "turn/completed",
      params: { threadId: "thr1", turn: { id: "turn1", status: "completed" } },
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
        threadId: "thr1",
        turnId: "turn1",
        item: {
          type: "commandExecution",
          id: "e1",
          status: "inProgress",
          aggregatedOutput: null,
        },
      },
    });
    fake.controls.pushInbound({
      kind: "notification",
      method: "item/completed",
      params: {
        threadId: "thr1",
        turnId: "turn1",
        item: {
          type: "commandExecution",
          id: "e1",
          status: "failed",
          aggregatedOutput: "not found",
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
      params: {
        threadId: "thr1",
        turnId: "turn1",
        itemId: "e1",
        command: "ls",
      },
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

  test("availableDecisions 只映射为菜单中的对应选项", async () => {
    const { events, fake } = setup();
    await flush();
    fake.controls.pushInbound({
      kind: "request",
      id: 9,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thr1",
        turnId: "turn1",
        itemId: "e2",
        availableDecisions: ["accept", "cancel"],
      },
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
      params: { threadId: "thr1", turnId: "turn1", itemId: "f1" },
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
      params: { threadId: "thr1", turn: { id: "turn1", status: "completed" } },
    });
    await flush();
    driver.deliver(sessionId, secondTurnId, "下一步");
    await flush();
    expect(fake.controls.requests().at(-1)?.method).toBe("turn/start");
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
      params: {
        threadId: "thr1",
        turn: { id: "turn1", status: "interrupted" },
      },
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

  test("transport 关闭后 deliver 补发 failed 而不是挂死", async () => {
    const { events, fake, driver } = setup();
    await flush();

    // 第一轮正常结束，随后传输关闭（等价于 codex 子进程退出）。
    fake.controls.pushInbound({
      kind: "notification",
      method: "turn/completed",
      params: { threadId: "thr1", turn: { id: "turn1", status: "completed" } },
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
});
