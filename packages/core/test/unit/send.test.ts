import {
  makeDiagnosticId,
  type CoreDiagnosticFact,
  type DomainEvent,
} from "@reins/protocol";
import { describe, expect, test, vi } from "vitest";

import { createSessionMachine } from "#/session-machine";

import { createFakeDriver } from "./fake-driver.ts";
import { ids, testDiagnostics, testIdentity } from "./ids.ts";

describe("send", () => {
  test("active delivery failure records send/steer once", async () => {
    const fake = createFakeDriver({
      deliver: () => {
        throw new Error("steer failed");
      },
    });
    const diagnostics: CoreDiagnosticFact[] = [];
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
    const { sessionId: id } = await machine.spawn({
      sessionName: ids.sessionName("steer-failure"),
      harness: "codex",
      message: "work",
      cwd: "/tmp/demo",
    });
    await expect(
      machine.send({
        placement: "active_turn",
        sessionId: id,
        turnId: ids.turn("t1"),
        message: "steer",
      }),
    ).rejects.toMatchObject({ code: "internal_error" });

    await vi.waitFor(() => expect(diagnostics).toHaveLength(1));
    expect(diagnostics).toEqual([
      expect.objectContaining({
        sessionId: id,
        turnId: ids.turn("t1"),
        kind: "request_failure",
        operation: "send",
        stage: "steer",
      }),
    ]);
  });

  test("active failure carrying a diagnostic id is not recorded again", async () => {
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
    const { sessionId: id } = await machine.spawn({
      sessionName: ids.sessionName("steer-recorded"),
      harness: "codex",
      message: "work",
      cwd: "/tmp/demo",
    });
    await expect(
      machine.send({
        placement: "active_turn",
        sessionId: id,
        turnId: ids.turn("t1"),
        message: "steer",
      }),
    ).rejects.toMatchObject({ code: "internal_error" });
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
    const { sessionId: id } = await machine.spawn({
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
      machine.send({ placement: "new_turn", sessionId: id, message: "继续" }),
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

  test("对 killed 会话抛 session_killed，对不存在 id 抛 session_not_found", async () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({
      driverFactory: fake.factory,
      identity: testIdentity,
      diagnostics: testDiagnostics,
    });
    const { sessionId: id } = await machine.spawn({
      sessionName: ids.sessionName("fixture-20"),
      harness: "codex",
      message: "临时",
      cwd: "/tmp/demo",
    });
    await machine.kill({ sessionId: id });

    await expect(
      machine.send({ placement: "new_turn", sessionId: id, message: "hi" }),
    ).rejects.toEqual(expect.objectContaining({ code: "session_killed" }));
    await expect(
      machine.send({
        placement: "new_turn",
        sessionId: ids.session("missing@gtest"),
        message: "hi",
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "session_not_found" }));
  });
});
