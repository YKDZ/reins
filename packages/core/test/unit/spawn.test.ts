import type { DiagnosticInput, DomainEvent, SessionId } from "@reins/protocol";
import { describe, expect, test } from "vitest";

import { createSessionMachine } from "#/session-machine";

import { createFakeDriver } from "./fake-driver.ts";
import { ids, testDiagnostics, testIdentity } from "./ids.ts";

describe("spawn", () => {
  test("创建 busy 会话并发出 session.created 与 turn.started", async () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({
      driverFactory: fake.factory,
      identity: testIdentity,
      diagnostics: testDiagnostics,
    });
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));

    const sessionId = await machine.spawn({
      sessionName: ids.sessionName("fixture-21"),
      harness: "codex",
      message: "审查这个 PR",
      cwd: "/tmp/demo",
    });

    expect(sessionId).toBe("fixture-21@gtest");
    expect(events.map((event) => event.type)).toEqual([
      "session.created",
      "turn.started",
    ]);
    expect(machine.list()).toEqual([
      expect.objectContaining({
        sessionId,
        harness: "codex",
        state: "busy",
        model: null,
        reasoning: null,
        cwd: "/tmp/demo",
        turns: 0,
        lastStopReason: null,
      }),
    ]);
  });

  test("同一 generation 拒绝重复 sessionName，且不启动第二个 worker", async () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({
      driverFactory: fake.factory,
      identity: testIdentity,
      diagnostics: testDiagnostics,
    });
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));
    const params = {
      sessionName: ids.sessionName("duplicate-name"),
      harness: "codex",
      message: "first",
      cwd: "/tmp/demo",
    };

    await machine.spawn(params);
    await expect(
      machine.spawn({ ...params, message: "second" }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "session_name_conflict",
        sessionName: params.sessionName,
      }),
    );
    expect(fake.controls.started).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "session.created"),
    ).toHaveLength(1);
  });

  test("failed start permanently reserves the caller-authored session name", async () => {
    const fake = createFakeDriver({
      start: () => {
        throw new Error("start failed");
      },
    });
    const machine = createSessionMachine({
      driverFactory: fake.factory,
      identity: testIdentity,
      diagnostics: testDiagnostics,
    });
    const params = {
      sessionName: ids.sessionName("failed-name"),
      harness: "codex",
      message: "first",
      cwd: "/tmp/demo",
    };

    await expect(machine.spawn(params)).rejects.toMatchObject({
      code: "internal_error",
    });
    await expect(machine.spawn(params)).rejects.toEqual({
      code: "session_name_conflict",
      sessionName: params.sessionName,
    });
    expect(machine.list()).toEqual([]);
  });

  test("keeps reentrant spawn ingress isolated by session", async () => {
    let machine: ReturnType<typeof createSessionMachine>;
    let nestedSpawn: Promise<SessionId> | undefined;
    const diagnostics: DiagnosticInput[] = [];
    const fake = createFakeDriver({
      start: (spec) => {
        if (spec.sessionName === ids.sessionName("outer")) {
          nestedSpawn = machine.spawn({
            sessionName: ids.sessionName("inner"),
            harness: "codex",
            message: "inner",
            cwd: "/tmp/demo",
          });
          fake.controls.emit({
            type: "text.delta",
            sessionId: spec.sessionId,
            turnId: spec.turnId,
            messageId: ids.message("m1"),
            delta: "outer still current",
          });
        }
      },
    });
    machine = createSessionMachine({
      driverFactory: fake.factory,
      identity: testIdentity,
      diagnostics: {
        async record(input) {
          diagnostics.push(input);
          return undefined;
        },
      },
    });
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));

    const outer = await machine.spawn({
      sessionName: ids.sessionName("outer"),
      harness: "codex",
      message: "outer",
      cwd: "/tmp/demo",
    });
    const inner = await nestedSpawn;

    expect(machine.list().map((session) => session.sessionId)).toEqual([
      inner,
      outer,
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "text.delta",
        sessionId: outer,
        delta: "outer still current",
      }),
    );
    expect(diagnostics).toEqual([]);
  });
});
