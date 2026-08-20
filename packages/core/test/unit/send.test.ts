import {
  makeDiagnosticId,
  type DiagnosticInput,
  type DomainEvent,
} from "@reins/protocol";
import { describe, expect, test, vi } from "vitest";

import { createSessionMachine } from "#/session-machine";

import { createFakeDriver } from "./fake-driver.ts";
import { ids, testDiagnostics, testIdentity } from "./ids.ts";

describe("send", () => {
  test("busy boundary delivery failure records send/steer once", async () => {
    const fake = createFakeDriver({
      deliver: () => {
        throw new Error("steer failed");
      },
    });
    const diagnostics: DiagnosticInput[] = [];
    const machine = createSessionMachine({
      driverFactory: fake.factory,
      identity: testIdentity,
      diagnostics: {
        async record(input) {
          diagnostics.push(input);
          return undefined;
        },
      },
    });
    const id = await machine.spawn({
      sessionName: ids.sessionName("steer-failure"),
      harness: "codex",
      message: "work",
      cwd: "/tmp/demo",
    });
    await machine.send({ sessionId: id, message: "steer" });

    fake.controls.emit({
      type: "tool.completed",
      sessionId: id,
      turnId: ids.turn("t1"),
      toolCallId: ids.toolCall("c1"),
      name: "Read",
      result: "x",
      isError: false,
    });
    await vi.waitFor(() => expect(diagnostics).toHaveLength(1));
    expect(diagnostics).toEqual([
      expect.objectContaining({
        source: "core",
        sessionId: id,
        turnId: ids.turn("t1"),
        kind: "request_failure",
        operation: "send",
        stage: "steer",
      }),
    ]);
  });

  test("boundary retry removes only items whose delivery transaction committed", async () => {
    const attempts: string[] = [];
    let failFirst = true;
    const fake = createFakeDriver({
      deliver: (_sessionId, _turnId, message) => {
        attempts.push(message);
        if (failFirst) {
          failFirst = false;
          throw new Error("first steer failed");
        }
      },
    });
    const machine = createSessionMachine({
      driverFactory: fake.factory,
      identity: testIdentity,
      diagnostics: testDiagnostics,
    });
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));
    const id = await machine.spawn({
      sessionName: ids.sessionName("steer-retry"),
      harness: "codex",
      message: "work",
      cwd: "/tmp/demo",
    });
    await machine.send({ sessionId: id, message: "first" });
    await machine.send({ sessionId: id, message: "second" });

    fake.controls.emit({
      type: "tool.completed",
      sessionId: id,
      turnId: ids.turn("t1"),
      toolCallId: ids.toolCall("c7"),
      name: "Read",
      result: "boundary one",
      isError: false,
    });
    expect(attempts).toEqual(["first"]);
    expect(
      events.filter(
        (event) => event.type === "message" && event.role === "caller",
      ),
    ).toEqual([]);

    fake.controls.emit({
      type: "tool.completed",
      sessionId: id,
      turnId: ids.turn("t1"),
      toolCallId: ids.toolCall("c8"),
      name: "Read",
      result: "boundary two",
      isError: false,
    });
    expect(attempts).toEqual(["first", "first", "second"]);
    expect(
      events
        .filter((event) => event.type === "message" && event.role === "caller")
        .map((event) => (event.type === "message" ? event.content : "")),
    ).toEqual(["first", "second"]);
  });

  test("boundary failure carrying a diagnostic id is not recorded again", async () => {
    const diagnosticId = makeDiagnosticId("test", "steer");
    const fake = createFakeDriver({
      deliver: () => {
        throw {
          code: "internal_error",
          diagnosticId,
          cause: { kind: "exception", message: "already recorded" },
        };
      },
    });
    const record = vi.fn(async () => undefined);
    const machine = createSessionMachine({
      driverFactory: fake.factory,
      identity: testIdentity,
      diagnostics: { record },
    });
    const id = await machine.spawn({
      sessionName: ids.sessionName("steer-recorded"),
      harness: "codex",
      message: "work",
      cwd: "/tmp/demo",
    });
    await machine.send({ sessionId: id, message: "steer" });
    fake.controls.emit({
      type: "tool.completed",
      sessionId: id,
      turnId: ids.turn("t1"),
      toolCallId: ids.toolCall("c6"),
      name: "Read",
      result: "boundary",
      isError: false,
    });
    await Promise.resolve();
    expect(record).not.toHaveBeenCalled();
  });

  test("对 idle 会话触发新回合，ack deliveryPoint=new_turn", async () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({
      driverFactory: fake.factory,
      identity: testIdentity,
      diagnostics: testDiagnostics,
    });
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));
    const id = await machine.spawn({
      sessionName: ids.sessionName("fixture-17"),
      harness: "codex",
      message: "第一步",
      cwd: "/tmp/demo",
    });
    fake.controls.emit({
      type: "turn.completed",
      sessionId: id,
      turnId: ids.turn("t1"),
      stopReason: "end_turn",
      finalReply: "完成",
      usage: {},
    });

    await expect(
      machine.send({ sessionId: id, message: "继续" }),
    ).resolves.toEqual({
      sessionId: id,
      turnId: ids.turn("t2"),
      messageId: ids.message("m1"),
      deliveryPoint: "new_turn",
    });
    expect(fake.controls.delivered).toEqual([
      { sessionId: id, turnId: ids.turn("t2"), message: "继续" },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "session.created",
      "turn.started",
      "turn.completed",
      "turn.started",
      "message",
    ]);
  });

  test("对 busy 会话暂存消息，在下一个消息边界注入同一回合", async () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({
      driverFactory: fake.factory,
      identity: testIdentity,
      diagnostics: testDiagnostics,
    });
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));
    const id = await machine.spawn({
      sessionName: ids.sessionName("fixture-18"),
      harness: "codex",
      message: "进行中",
      cwd: "/tmp/demo",
    });

    await expect(
      machine.send({ sessionId: id, message: "改用方案 B" }),
    ).resolves.toEqual({
      sessionId: id,
      turnId: ids.turn("t1"),
      messageId: ids.message("m1"),
      deliveryPoint: "boundary",
    });
    expect(fake.controls.delivered).toEqual([]);

    fake.controls.emit({
      type: "tool.completed",
      sessionId: id,
      turnId: ids.turn("t1"),
      toolCallId: ids.toolCall("c1"),
      name: "Read",
      result: "app.ts",
      isError: false,
    });

    expect(fake.controls.delivered).toEqual([
      { sessionId: id, turnId: ids.turn("t1"), message: "改用方案 B" },
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

  test("多条暂存消息在同一边界按序一起注入", async () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({
      driverFactory: fake.factory,
      identity: testIdentity,
      diagnostics: testDiagnostics,
    });
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));
    const id = await machine.spawn({
      sessionName: ids.sessionName("fixture-19"),
      harness: "qoder",
      message: "进行中",
      cwd: "/tmp/demo",
    });

    await machine.send({ sessionId: id, message: "第一条" });
    await machine.send({ sessionId: id, message: "第二条" });
    fake.controls.emit({
      type: "message",
      sessionId: id,
      turnId: ids.turn("t1"),
      messageId: ids.message("m-agent"),
      role: "worker",
      content: "阶段小结",
    });

    expect(fake.controls.delivered).toEqual([
      { sessionId: id, turnId: ids.turn("t1"), message: "第一条" },
      { sessionId: id, turnId: ids.turn("t1"), message: "第二条" },
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
        .filter((event) => event.type === "message" && event.role === "caller")
        .map((event) => ({
          messageId: event.type === "message" ? event.messageId : "",
          content: event.type === "message" ? event.content : "",
        })),
    ).toEqual([
      { messageId: ids.message("m1"), content: "第一条" },
      { messageId: ids.message("m2"), content: "第二条" },
    ]);
  });

  test("对 killed 会话抛 session_killed，对不存在 id 抛 session_not_found", async () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({
      driverFactory: fake.factory,
      identity: testIdentity,
      diagnostics: testDiagnostics,
    });
    const id = await machine.spawn({
      sessionName: ids.sessionName("fixture-20"),
      harness: "dsh",
      message: "临时",
      cwd: "/tmp/demo",
    });
    await machine.kill({ ids: [id] });

    await expect(
      machine.send({ sessionId: id, message: "hi" }),
    ).rejects.toEqual(expect.objectContaining({ code: "session_killed" }));
    await expect(
      machine.send({ sessionId: ids.session("missing@gtest"), message: "hi" }),
    ).rejects.toEqual(expect.objectContaining({ code: "session_not_found" }));
  });
});
