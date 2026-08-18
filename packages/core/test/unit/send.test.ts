import type { DomainEvent } from "@reins/protocol";
import { describe, expect, test } from "vitest";

import { createSessionMachine } from "#/session-machine";

import { createFakeDriver } from "./fake-driver.ts";

describe("send", () => {
  test("对 idle 会话触发新回合，ack deliveryPoint=new_turn", () => {
    const fake = createFakeDriver();
    fake.controls.setDeliverStartsTurn(true);
    const machine = createSessionMachine({ driverFactory: fake.factory });
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));
    const id = machine.spawn({
      harness: "codex",
      message: "第一步",
      cwd: "/tmp/demo",
    });
    fake.controls.emit({
      type: "turn.completed",
      sessionId: id,
      turnId: "s1:t1",
      stopReason: "end_turn",
      finalReply: "完成",
      usage: {},
    });

    expect(machine.send({ sessionId: id, message: "继续" })).toEqual({
      messageId: "m1",
      deliveryPoint: "new_turn",
    });
    expect(fake.controls.delivered).toEqual([
      { sessionId: id, message: "继续" },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "session.created",
      "turn.started",
      "turn.completed",
      "turn.started",
      "message",
    ]);
  });

  test("对 busy 会话暂存消息，在下一个消息边界注入同一回合", () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({ driverFactory: fake.factory });
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));
    const id = machine.spawn({
      harness: "codex",
      message: "进行中",
      cwd: "/tmp/demo",
    });

    expect(machine.send({ sessionId: id, message: "改用方案 B" })).toEqual({
      messageId: "m1",
      deliveryPoint: "boundary",
    });
    expect(fake.controls.delivered).toEqual([]);

    fake.controls.emit({
      type: "tool.completed",
      sessionId: id,
      turnId: "s1:t1",
      toolCallId: "c1",
      name: "Read",
      result: "app.ts",
    });

    expect(fake.controls.delivered).toEqual([
      { sessionId: id, message: "改用方案 B" },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "session.created",
      "turn.started",
      "tool.completed",
      "message",
    ]);
    expect(machine.list()[0]).toEqual(
      expect.objectContaining({ sessionId: id, state: "busy", turns: 0 }),
    );
  });

  test("多条暂存消息在同一边界按序一起注入", () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({ driverFactory: fake.factory });
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));
    const id = machine.spawn({
      harness: "qoder",
      message: "进行中",
      cwd: "/tmp/demo",
    });

    machine.send({ sessionId: id, message: "第一条" });
    machine.send({ sessionId: id, message: "第二条" });
    fake.controls.emit({
      type: "message",
      sessionId: id,
      turnId: "s1:t1",
      messageId: "m-agent",
      role: "worker",
      content: "阶段小结",
    });

    expect(fake.controls.delivered).toEqual([
      { sessionId: id, message: "第一条" },
      { sessionId: id, message: "第二条" },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "session.created",
      "turn.started",
      "message",
      "message",
      "message",
    ]);
    expect(
      events
        .filter((event) => event.type === "message" && event.role === "driver")
        .map((event) => ({
          messageId: event.type === "message" ? event.messageId : "",
          content: event.type === "message" ? event.content : "",
        })),
    ).toEqual([
      { messageId: "m1", content: "第一条" },
      { messageId: "m2", content: "第二条" },
    ]);
  });

  test("对 killed 会话抛 session_killed，对不存在 id 抛 session_not_found", () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({ driverFactory: fake.factory });
    const id = machine.spawn({
      harness: "dsh",
      message: "临时",
      cwd: "/tmp/demo",
    });
    machine.kill({ ids: [id] });

    expect(() => machine.send({ sessionId: id, message: "hi" })).toThrowError(
      expect.objectContaining({ code: "session_killed" }),
    );
    expect(() =>
      machine.send({ sessionId: "s999", message: "hi" }),
    ).toThrowError(expect.objectContaining({ code: "session_not_found" }));
  });
});
