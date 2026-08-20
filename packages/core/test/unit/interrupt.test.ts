import type { CoreDiagnosticFact, DomainEvent } from "@reins/protocol";
import { describe, expect, test } from "vitest";

import { createSessionMachine } from "#/session-machine";

import { createFakeDriver } from "./fake-driver.ts";
import { ids, testDiagnostics, testIdentity } from "./ids.ts";

describe("interrupt", () => {
  test("driver interrupt failure records its nearest request failure", async () => {
    const fake = createFakeDriver({
      interrupt: () => {
        throw new Error("interrupt failed");
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
    const id = await machine.spawn({
      sessionName: ids.sessionName("interrupt-failure"),
      harness: "codex",
      message: "work",
      cwd: "/tmp/demo",
    });

    await expect(machine.interrupt({ ids: [id] })).rejects.toEqual(
      expect.objectContaining({ code: "internal_error" }),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        sessionId: id,
        turnId: ids.turn("t1"),
        kind: "request_failure",
        operation: "interrupt",
        stage: "interrupt",
      }),
    );
  });

  test("停止 busy 会话的当前回合，保留会话与部分产出", async () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({
      driverFactory: fake.factory,
      identity: testIdentity,
      diagnostics: testDiagnostics,
    });
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));
    const id = await machine.spawn({
      sessionName: ids.sessionName("fixture-4"),
      harness: "codex",
      message: "重构",
      cwd: "/tmp/demo",
    });

    const ack = await machine.interrupt({ ids: [id] });

    expect(ack).toEqual([
      { sessionId: id, status: "requested", turnId: ids.turn("t1") },
    ]);
    expect(fake.controls.interrupted).toEqual([{ sessionId: id }]);

    fake.controls.emit({
      type: "turn.completed",
      sessionId: id,
      turnId: ids.turn("t1"),
      stopReason: "cancelled",
      finalReply: "部分产出：入口在 main.ts",
      usage: {},
    });

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

  test("对 idle 会话幂等，不调用 driver", async () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({
      driverFactory: fake.factory,
      identity: testIdentity,
      diagnostics: testDiagnostics,
    });
    const id = await machine.spawn({
      sessionName: ids.sessionName("fixture-5"),
      harness: "codex",
      message: "收尾",
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

    await expect(machine.interrupt({ ids: [id] })).resolves.toEqual([
      { sessionId: id, status: "idle" },
    ]);
    expect(fake.controls.interrupted).toEqual([]);
  });

  test("对 killed 会话抛 session_killed，对不存在 id 抛 session_not_found", async () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({
      driverFactory: fake.factory,
      identity: testIdentity,
      diagnostics: testDiagnostics,
    });
    const id = await machine.spawn({
      sessionName: ids.sessionName("fixture-6"),
      harness: "dsh",
      message: "临时",
      cwd: "/tmp/demo",
    });
    await machine.kill({ ids: [id] });

    await expect(machine.interrupt({ ids: [id] })).rejects.toEqual(
      expect.objectContaining({ code: "session_killed" }),
    );
    await expect(
      machine.interrupt({ ids: [ids.session("missing@gtest")] }),
    ).rejects.toEqual(expect.objectContaining({ code: "session_not_found" }));
  });
});
