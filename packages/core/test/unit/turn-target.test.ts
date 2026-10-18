import { expect, test } from "vitest";

import { createSessionMachine } from "#/session-machine";

import { createFakeDriver } from "./fake-driver.ts";
import { ids, testDiagnostics, testIdentity } from "./ids.ts";

test("turn targets retain their original parent across active and completed turns", async () => {
  const fake = createFakeDriver();
  const machine = createSessionMachine({
    driverFactory: fake.factory,
    identity: testIdentity,
    diagnostics: testDiagnostics,
  });
  const first = await machine.spawn({
    sessionLabel: ids.sessionLabel("first-parent"),
    harness: "codex",
    cwd: "/tmp",
    message: "first",
  });
  const second = await machine.spawn({
    sessionLabel: ids.sessionLabel("second-parent"),
    harness: "codex",
    cwd: "/tmp",
    message: "second",
  });
  expect(() =>
    machine.assertTurnTarget({
      sessionId: first.sessionId,
      turnId: second.turnId,
    }),
  ).toThrow(expect.objectContaining({ code: "invalid_params" }));
  expect(() =>
    machine.assertTurnTarget({
      sessionId: first.sessionId,
      turnId: first.turnId,
    }),
  ).not.toThrow();
  fake.controls.emit({
    type: "turn.completed",
    sessionId: first.sessionId,
    turnId: first.turnId,
    stopReason: "end_turn",
    finalReply: "done",
  });
  expect(() =>
    machine.assertTurnTarget({
      sessionId: first.sessionId,
      turnId: first.turnId,
    }),
  ).not.toThrow();
  expect(() =>
    machine.assertTurnTarget({
      sessionId: second.sessionId,
      turnId: first.turnId,
    }),
  ).toThrow(expect.objectContaining({ code: "invalid_params" }));
  expect(() =>
    machine.assertTurnTarget({
      sessionId: ids.session("session:absent:1"),
      turnId: first.turnId,
    }),
  ).toThrow(expect.objectContaining({ code: "session_not_found" }));
  expect(fake.controls.delivered).toEqual([]);
});

test("spawn returns its accepted first turn even when the driver completes it synchronously", async () => {
  const fake = createFakeDriver({
    start(spec) {
      fake.controls.emit({
        type: "turn.completed",
        sessionId: spec.sessionId,
        turnId: spec.turnId,
        stopReason: "end_turn",
        finalReply: "done",
      });
    },
  });
  const machine = createSessionMachine({
    driverFactory: fake.factory,
    identity: testIdentity,
    diagnostics: testDiagnostics,
  });
  const accepted = await machine.spawn({
    sessionLabel: ids.sessionLabel("instant"),
    harness: "codex",
    cwd: "/tmp",
    message: "finish",
  });
  expect(accepted).toMatchObject({
    sessionId: accepted.sessionId,
    turnId: "t1",
    cwd: "/tmp",
  });
  expect(machine.list({ sessionId: accepted.sessionId })).toMatchObject([
    {
      state: "idle",
      lastCompletedTurn: { turnId: accepted.turnId, stopReason: "end_turn" },
    },
  ]);
});
