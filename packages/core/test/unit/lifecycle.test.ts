import type { DomainEvent } from "@reins/protocol";
import { describe, expect, test } from "vitest";

import { createSessionMachine } from "#/session-machine";

import { createFakeDriver } from "./fake-driver.ts";

function spawnBusy(machine: ReturnType<typeof createSessionMachine>) {
  const id = machine.spawn({
    harness: "codex",
    message: "分析",
    cwd: "/tmp/demo",
  });
  return id;
}

describe("回合生命周期", () => {
  test("事件按序推进到 end_turn，会话转 idle 并记录回合结果", () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({ driverFactory: fake.factory });
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));
    const id = spawnBusy(machine);

    fake.controls.emit({
      type: "text.delta",
      sessionId: id,
      turnId: "s1:t1",
      messageId: "m1",
      delta: "思考中",
    });
    fake.controls.emit({
      type: "tool.requested",
      sessionId: id,
      turnId: "s1:t1",
      toolCallId: "c1",
      name: "Read",
    });
    fake.controls.emit({
      type: "tool.completed",
      sessionId: id,
      turnId: "s1:t1",
      toolCallId: "c1",
      name: "Read",
      result: "app.ts",
      isError: false,
    });
    fake.controls.emit({
      type: "message",
      sessionId: id,
      turnId: "s1:t1",
      messageId: "m2",
      role: "worker",
      content: "结论",
    });
    fake.controls.emit({
      type: "turn.completed",
      sessionId: id,
      turnId: "s1:t1",
      stopReason: "end_turn",
      finalReply: "完成",
      usage: { durationMs: 1200 },
    });

    expect(events.map((event) => event.type)).toEqual([
      "session.created",
      "turn.started",
      "text.delta",
      "tool.requested",
      "tool.completed",
      "message",
      "turn.completed",
    ]);
    expect(machine.list()).toEqual([
      expect.objectContaining({
        sessionId: id,
        state: "idle",
        turns: 1,
        lastStopReason: "end_turn",
      }),
    ]);
  });

  test("wait 返回回合终态结果", async () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({ driverFactory: fake.factory });
    const id = spawnBusy(machine);

    const waiting = machine.wait({ ids: [id] });
    fake.controls.emit({
      type: "turn.completed",
      sessionId: id,
      turnId: "s1:t1",
      stopReason: "end_turn",
      finalReply: "完成",
      usage: { durationMs: 1200 },
    });

    await expect(waiting).resolves.toEqual({
      status: "completed",
      results: [
        {
          sessionId: id,
          status: "completed",
          turn: {
            sessionId: id,
            turnId: "s1:t1",
            stopReason: "end_turn",
            finalReply: "完成",
            usage: { durationMs: 1200 },
          },
        },
      ],
    });
  });
});
