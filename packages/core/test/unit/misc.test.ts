import type { DomainEvent } from "@reins/protocol";
import { describe, expect, test } from "vitest";

import { createSessionMachine } from "#/session-machine";

import { createFakeDriver } from "./fake-driver.ts";

describe("权限与事件", () => {
  test("权限请求与决议按序透传，期间会话保持 busy", () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({ driverFactory: fake.factory });
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));
    const id = machine.spawn({
      harness: "codex",
      message: "跑测试",
      cwd: "/tmp/demo",
    });

    fake.controls.emit({
      type: "permission.requested",
      sessionId: id,
      turnId: "s1:t1",
      permissionId: "p1",
      kind: "Bash(npm test)",
    });
    expect(machine.list()[0]?.state).toBe("busy");

    fake.controls.emit({
      type: "permission.resolved",
      sessionId: id,
      turnId: "s1:t1",
      permissionId: "p1",
      decision: "allow",
    });

    expect(
      events
        .map((event) => event.type)
        .filter(
          (type) =>
            type === "permission.requested" || type === "permission.resolved",
        ),
    ).toEqual(["permission.requested", "permission.resolved"]);
  });

  test("回合终态作废未决权限请求，不产生合成的 permission.resolved", () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({ driverFactory: fake.factory });
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));
    const id = machine.spawn({
      harness: "codex",
      message: "跑测试",
      cwd: "/tmp/demo",
    });
    fake.controls.emit({
      type: "permission.requested",
      sessionId: id,
      turnId: "s1:t1",
      permissionId: "p1",
      kind: "Bash(npm test)",
    });

    machine.interrupt({ ids: [id] });
    fake.controls.emit({
      type: "turn.completed",
      sessionId: id,
      turnId: "s1:t1",
      stopReason: "cancelled",
      finalReply: null,
      usage: {},
    });

    expect(events.map((event) => event.type)).toEqual([
      "session.created",
      "turn.started",
      "permission.requested",
      "turn.completed",
    ]);
  });

  test("driver 报告失败时记录 stopReason=failed", async () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({ driverFactory: fake.factory });
    const id = machine.spawn({
      harness: "dsh",
      message: "跑构建",
      cwd: "/tmp/demo",
    });

    fake.controls.emit({
      type: "turn.completed",
      sessionId: id,
      turnId: "s1:t1",
      stopReason: "failed",
      finalReply: "构建失败",
      usage: {},
    });

    expect(machine.list()[0]).toEqual(
      expect.objectContaining({ state: "idle", lastStopReason: "failed" }),
    );
    await expect(machine.wait({ ids: [id] })).resolves.toEqual({
      status: "completed",
      results: [
        {
          sessionId: id,
          status: "completed",
          turn: {
            sessionId: id,
            turnId: "s1:t1",
            stopReason: "failed",
            finalReply: "构建失败",
            usage: {},
          },
        },
      ],
    });
  });

  test("退订后不再收到事件", () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({ driverFactory: fake.factory });
    const events: DomainEvent[] = [];
    const unsubscribe = machine.subscribe((event) => events.push(event));
    const id = machine.spawn({
      harness: "codex",
      message: "开始",
      cwd: "/tmp/demo",
    });
    expect(events).toHaveLength(2);

    unsubscribe();
    fake.controls.emit({
      type: "text.delta",
      sessionId: id,
      turnId: "s1:t1",
      messageId: "m1",
      delta: "继续",
    });

    expect(events).toHaveLength(2);
  });
});

describe("list 过滤与参数校验", () => {
  test("按 harness 过滤会话", () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({ driverFactory: fake.factory });
    machine.spawn({ harness: "codex", message: "a", cwd: "/tmp/demo" });
    machine.spawn({ harness: "qoder", message: "b", cwd: "/tmp/demo" });
    machine.spawn({ harness: "dsh", message: "c", cwd: "/tmp/demo" });

    expect(machine.list({ harness: "qoder" })).toEqual([
      expect.objectContaining({ sessionId: "s2", harness: "qoder" }),
    ]);
  });

  test("spawn 参数非法抛 invalid_params", () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({ driverFactory: fake.factory });

    expect(() =>
      machine.spawn({ harness: "", message: "x", cwd: "/tmp/demo" }),
    ).toThrowError(expect.objectContaining({ code: "invalid_params" }));
    expect(() =>
      // @ts-expect-error 故意省略必填字段，验证运行时校验
      machine.spawn({ harness: "codex" }),
    ).toThrowError(expect.objectContaining({ code: "invalid_params" }));
  });
});
