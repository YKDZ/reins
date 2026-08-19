import type { DomainEvent } from "@reins/protocol";
import { describe, expect, test } from "vitest";

import { createSessionMachine } from "#/session-machine";

import { createFakeDriver } from "./fake-driver.ts";

describe("driver 抛错时动作整体回滚", () => {
  test("spawn：driver.start 抛错则不产生会话、事件与孤儿状态", () => {
    const fake = createFakeDriver({
      start: () => {
        throw new Error("启动失败");
      },
    });
    const machine = createSessionMachine({ driverFactory: fake.factory });
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));

    expect(() =>
      machine.spawn({
        harness: "codex",
        message: "开始",
        cwd: "/tmp/demo",
      }),
    ).toThrow("启动失败");

    expect(events).toEqual([]);
    expect(machine.list()).toEqual([]);
  });

  test("send：driver.deliver 抛错则不开启新回合，会话保持 idle", () => {
    const fake = createFakeDriver({
      deliver: () => {
        throw new Error("投递失败");
      },
    });
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
      finalReply: null,
      usage: {},
    });

    expect(() => machine.send({ sessionId: id, message: "继续" })).toThrow(
      "投递失败",
    );

    expect(
      events.filter((event) => event.type === "turn.started"),
    ).toHaveLength(1);
    expect(machine.list()[0]).toEqual(
      expect.objectContaining({ sessionId: id, state: "idle" }),
    );
  });

  test("kill：driver.terminate 抛错则不产生 session.killed，会话保持原状", () => {
    const fake = createFakeDriver({
      terminate: () => {
        throw new Error("终止失败");
      },
    });
    const machine = createSessionMachine({ driverFactory: fake.factory });
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));
    const id = machine.spawn({
      harness: "codex",
      message: "进行中",
      cwd: "/tmp/demo",
    });

    expect(() => machine.kill({ ids: [id] })).toThrow("终止失败");

    expect(events.some((event) => event.type === "session.killed")).toBe(false);
    expect(machine.list()[0]).toEqual(
      expect.objectContaining({ sessionId: id, state: "busy" }),
    );
  });
});
