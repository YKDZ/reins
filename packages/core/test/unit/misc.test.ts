import type { DomainEvent } from "@reins/protocol";
import { describe, expect, test } from "vitest";

import { createSessionMachine } from "#/session-machine";

import { createFakeDriver } from "./fake-driver.ts";
import { ids } from "./ids.ts";

describe("权限与事件", () => {
  test("权限请求与决议按序透传，期间会话保持 busy", () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({ driverFactory: fake.factory });
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));
    const id = machine.spawn({
      sessionName: ids.sessionName("fixture-8"),
      harness: "codex",
      message: "跑测试",
      cwd: "/tmp/demo",
    });

    fake.controls.emit({
      type: "permission.requested",
      sessionId: id,
      turnId: ids.turn("t1"),
      permissionId: ids.permission("p1"),
      kind: "Bash(npm test)",
      options: [{ outcome: "allow", scope: "once" }],
    });
    expect(machine.list()[0]?.state).toBe("busy");

    machine.resolvePermission({
      sessionId: id,
      permissionId: ids.permission("p1"),
      resolution: { outcome: "allow", scope: "once" },
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
      sessionName: ids.sessionName("fixture-9"),
      harness: "codex",
      message: "跑测试",
      cwd: "/tmp/demo",
    });
    fake.controls.emit({
      type: "permission.requested",
      sessionId: id,
      turnId: ids.turn("t1"),
      permissionId: ids.permission("p1"),
      kind: "Bash(npm test)",
      options: [{ outcome: "allow", scope: "once" }],
    });

    machine.interrupt({ ids: [id] });
    fake.controls.emit({
      type: "turn.completed",
      sessionId: id,
      turnId: ids.turn("t1"),
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
      sessionName: ids.sessionName("fixture-10"),
      harness: "dsh",
      message: "跑构建",
      cwd: "/tmp/demo",
    });

    fake.controls.emit({
      type: "turn.completed",
      sessionId: id,
      turnId: ids.turn("t1"),
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
            turnId: ids.turn("t1"),
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
      sessionName: ids.sessionName("fixture-11"),
      harness: "codex",
      message: "开始",
      cwd: "/tmp/demo",
    });
    expect(events).toHaveLength(2);

    unsubscribe();
    fake.controls.emit({
      type: "text.delta",
      sessionId: id,
      turnId: ids.turn("t1"),
      messageId: ids.message("m1"),
      delta: "继续",
    });

    expect(events).toHaveLength(2);
  });

  test("订阅者抛错经 onListenerError 上报，不打断机器", () => {
    const fake = createFakeDriver();
    const sink: Array<{ error: unknown; event: DomainEvent }> = [];
    const machine = createSessionMachine({
      driverFactory: fake.factory,
      onListenerError: (error, event) => sink.push({ error, event }),
    });
    machine.subscribe(() => {
      throw new Error("bad listener");
    });

    const id = machine.spawn({
      sessionName: ids.sessionName("fixture-12"),
      harness: "codex",
      message: "开始",
      cwd: "/tmp/demo",
    });

    expect(sink).toHaveLength(2);
    expect(machine.list()[0]?.sessionId).toBe(id);
  });
});

describe("list 过滤与参数校验", () => {
  test("按 harness 过滤会话", () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({ driverFactory: fake.factory });
    machine.spawn({
      sessionName: ids.sessionName("fixture-inline-1"),
      harness: "codex",
      message: "a",
      cwd: "/tmp/demo",
    });
    machine.spawn({
      sessionName: ids.sessionName("fixture-inline-2"),
      harness: "qoder",
      message: "b",
      cwd: "/tmp/demo",
    });
    machine.spawn({
      sessionName: ids.sessionName("fixture-inline-3"),
      harness: "dsh",
      message: "c",
      cwd: "/tmp/demo",
    });

    expect(machine.list({ harness: "qoder" })).toEqual([
      expect.objectContaining({
        sessionId: ids.session("fixture-inline-2@g0"),
        harness: "qoder",
      }),
    ]);
  });

  test("spawn 参数非法抛 invalid_params", () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({ driverFactory: fake.factory });

    try {
      machine.spawn({
        sessionName: ids.sessionName("fixture-inline-4"),
        harness: "",
        message: "x",
        cwd: "/tmp/demo",
      });
      throw new Error("Expected invalid_params");
    } catch (error) {
      expect(error).toEqual({
        code: "invalid_params",
        issues: [{ issue: "invalid_value", path: "harness" }],
      });
    }
    expect(() =>
      // @ts-expect-error 故意省略必填字段，验证运行时校验
      machine.spawn({
        sessionName: ids.sessionName("fixture-inline-5"),
        harness: "codex",
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_params" }));
  });
});
