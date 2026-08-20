import { afterEach, describe, expect, test, vi } from "vitest";

import { createSessionMachine } from "#/session-machine";

import { createFakeDriver } from "./fake-driver.ts";
import { ids, testDiagnostics, testIdentity } from "./ids.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("wait", () => {
  test("超时返回 timeout 且会话仍在运行", async () => {
    vi.useFakeTimers();
    const fake = createFakeDriver();
    const machine = createSessionMachine({
      driverFactory: fake.factory,
      identity: testIdentity,
      diagnostics: testDiagnostics,
    });
    const id = await machine.spawn({
      sessionName: ids.sessionName("fixture-22"),
      harness: "codex",
      message: "跑很久的任务",
      cwd: "/tmp/demo",
    });

    const waiting = machine.wait({ ids: [id], timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(500);

    await expect(waiting).resolves.toEqual({ status: "timeout", results: [] });
    expect(machine.list()[0]).toEqual(
      expect.objectContaining({ sessionId: id, state: "busy" }),
    );
  });

  test("waitAny 在任一会话到达终态时返回", async () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({
      driverFactory: fake.factory,
      identity: testIdentity,
      diagnostics: testDiagnostics,
    });
    const a = await machine.spawn({
      sessionName: ids.sessionName("fixture-23"),
      harness: "codex",
      message: "甲",
      cwd: "/tmp/demo",
    });
    const b = await machine.spawn({
      sessionName: ids.sessionName("fixture-24"),
      harness: "qoder",
      message: "乙",
      cwd: "/tmp/demo",
    });

    const waiting = machine.wait({ ids: [a, b] });
    fake.controls.emit({
      type: "turn.completed",
      sessionId: b,
      turnId: ids.turn("t2"),
      stopReason: "end_turn",
      finalReply: "乙完成",
      usage: {},
    });

    await expect(waiting).resolves.toEqual({
      status: "completed",
      results: [
        {
          sessionId: b,
          status: "completed",
          turn: {
            sessionId: b,
            turnId: ids.turn("t2"),
            stopReason: "end_turn",
            finalReply: "乙完成",
            usage: {},
          },
        },
      ],
    });
    expect(machine.list().find((s) => s.sessionId === a)?.state).toBe("busy");
  });

  test("对已 kill 的会话返回 per-id killed 状态而不是错误", async () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({
      driverFactory: fake.factory,
      identity: testIdentity,
      diagnostics: testDiagnostics,
    });
    const id = await machine.spawn({
      sessionName: ids.sessionName("fixture-25"),
      harness: "dsh",
      message: "临时任务",
      cwd: "/tmp/demo",
    });

    await expect(machine.kill({ ids: [id] })).resolves.toEqual([
      { sessionId: id, status: "killed" },
    ]);
    await expect(machine.wait({ ids: [id] })).resolves.toEqual({
      status: "completed",
      results: [{ sessionId: id, status: "killed" }],
    });
  });

  test("对不存在的 id 抛 session_not_found", async () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({
      driverFactory: fake.factory,
      identity: testIdentity,
      diagnostics: testDiagnostics,
    });

    await expect(
      machine.wait({ ids: [ids.session("missing@gtest")] }),
    ).rejects.toEqual({
      code: "session_not_found",
      sessionId: ids.session("missing@gtest"),
    });
  });
});
