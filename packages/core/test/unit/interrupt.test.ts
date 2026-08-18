import type { DomainEvent } from "@reins/protocol";
import { describe, expect, test } from "vitest";

import { createSessionMachine } from "#/session-machine";

import { createFakeDriver } from "./fake-driver.ts";

describe("interrupt", () => {
  test("停止 busy 会话的当前回合，保留会话与部分产出", () => {
    const fake = createFakeDriver();
    fake.controls.setInterruptFinalReply("部分产出：入口在 main.ts");
    const machine = createSessionMachine({ driverFactory: fake.factory });
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));
    const id = machine.spawn({
      harness: "codex",
      message: "重构",
      cwd: "/tmp/demo",
    });

    const results = machine.interrupt({ ids: [id], message: "改用方案 B" });

    expect(results).toEqual([
      {
        sessionId: id,
        turnId: "s1:t1",
        stopReason: "cancelled",
        finalReply: "部分产出：入口在 main.ts",
        usage: {},
      },
    ]);
    expect(fake.controls.interrupted).toEqual([
      { sessionId: id, message: "改用方案 B" },
    ]);
    expect(events.at(-1)?.type).toBe("turn.completed");
    expect(machine.list()[0]).toEqual(
      expect.objectContaining({
        sessionId: id,
        state: "idle",
        turns: 1,
        lastStopReason: "cancelled",
      }),
    );
  });

  test("对 idle 会话幂等，不调用 driver", () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({ driverFactory: fake.factory });
    const id = machine.spawn({
      harness: "codex",
      message: "收尾",
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

    expect(machine.interrupt({ ids: [id] })).toEqual([]);
    expect(fake.controls.interrupted).toEqual([]);
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

    expect(() => machine.interrupt({ ids: [id] })).toThrowError(
      expect.objectContaining({ code: "session_killed" }),
    );
    expect(() => machine.interrupt({ ids: ["s999"] })).toThrowError(
      expect.objectContaining({ code: "session_not_found" }),
    );
  });
});
