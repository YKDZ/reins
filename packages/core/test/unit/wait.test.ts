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
    const { sessionId: id } = await machine.spawn({
      sessionName: ids.sessionName("fixture-22"),
      harness: "codex",
      message: "跑很久的任务",
      cwd: "/tmp/demo",
    });

    const waiting = machine.wait({
      targets: [{ sessionId: id, turnId: ids.turn("t1") }],
      completion: "any",
      timeoutMs: 500,
    });
    await vi.advanceTimersByTimeAsync(500);

    await expect(waiting).resolves.toEqual({
      status: "timeout",
      completed: [],
      pending: [{ sessionId: id, turnId: ids.turn("t1") }],
    });
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
    const { sessionId: a } = await machine.spawn({
      sessionName: ids.sessionName("fixture-23"),
      harness: "codex",
      message: "甲",
      cwd: "/tmp/demo",
    });
    const { sessionId: b } = await machine.spawn({
      sessionName: ids.sessionName("fixture-24"),
      harness: "qoder",
      message: "乙",
      cwd: "/tmp/demo",
    });

    const waiting = machine.wait({
      targets: [
        { sessionId: a, turnId: ids.turn("t1") },
        { sessionId: b, turnId: ids.turn("t2") },
      ],
      completion: "any",
    });
    fake.controls.emit({
      type: "turn.completed",
      sessionId: b,
      turnId: ids.turn("t2"),
      stopReason: "end_turn",
      finalReply: "乙完成",
      usage: {},
    });

    await expect(waiting).resolves.toEqual({
      status: "satisfied",
      pending: [{ sessionId: a, turnId: ids.turn("t1") }],
      completed: [
        {
          sessionId: b,
          turnId: ids.turn("t2"),
          stopReason: "end_turn",
          finalReply: "乙完成",
          usage: {},
        },
      ],
    });
    expect(machine.list().find((s) => s.sessionId === a)?.state).toBe("busy");
  });

  test("对已 kill 的精确回合返回真实 killed 终态而不是错误", async () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({
      driverFactory: fake.factory,
      identity: testIdentity,
      diagnostics: testDiagnostics,
    });
    const { sessionId: id } = await machine.spawn({
      sessionName: ids.sessionName("fixture-25"),
      harness: "dsh",
      message: "临时任务",
      cwd: "/tmp/demo",
    });

    await expect(machine.kill({ sessionId: id })).resolves.toEqual({
      sessionId: id,
      status: "killed",
    });
    await expect(
      machine.wait({
        targets: [{ sessionId: id, turnId: ids.turn("t1") }],
        completion: "all",
      }),
    ).resolves.toEqual({
      status: "satisfied",
      completed: [
        {
          sessionId: id,
          turnId: ids.turn("t1"),
          stopReason: "killed",
          finalReply: null,
        },
      ],
      pending: [],
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
      machine.wait({
        targets: [
          { sessionId: ids.session("missing@gtest"), turnId: ids.turn("t1") },
        ],
        completion: "any",
      }),
    ).rejects.toEqual({
      code: "session_not_found",
      sessionId: ids.session("missing@gtest"),
    });
  });
});

test("长显式领域期限跨过单次计时上限后才超时且不停止任务", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const fake = createFakeDriver();
  const machine = createSessionMachine({
    driverFactory: fake.factory,
    identity: testIdentity,
    diagnostics: testDiagnostics,
  });
  const { sessionId, turnId } = await machine.spawn({
    sessionName: ids.sessionName("long-budget"),
    harness: "codex",
    message: "caller long task",
    cwd: "/tmp/demo",
  });
  let settled = false;
  const waiting = machine
    .wait({
      targets: [{ sessionId, turnId }],
      completion: "all",
      timeoutMs: 2_147_483_747,
    })
    .then((reply) => {
      settled = true;
      return reply;
    });
  await vi.advanceTimersByTimeAsync(2_147_483_647);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(100);
  await expect(waiting).resolves.toEqual({
    status: "timeout",
    completed: [],
    pending: [{ sessionId, turnId }],
  });
  expect(machine.list()[0]?.state).toBe("busy");
});
