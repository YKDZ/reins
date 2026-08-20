import type { DomainEvent } from "@reins/protocol";
import { describe, expect, test } from "vitest";

import { createSessionMachine } from "#/session-machine";

import { createFakeDriver } from "./fake-driver.ts";
import { ids } from "./ids.ts";

describe("spawn", () => {
  test("创建 busy 会话并发出 session.created 与 turn.started", () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({ driverFactory: fake.factory });
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));

    const sessionId = machine.spawn({
      sessionName: ids.sessionName("fixture-21"),
      harness: "codex",
      message: "审查这个 PR",
      cwd: "/tmp/demo",
    });

    expect(sessionId).toBe("fixture-21@g0");
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

  test("同一 generation 拒绝重复 sessionName，且不启动第二个 worker", () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({ driverFactory: fake.factory });
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));
    const params = {
      sessionName: ids.sessionName("duplicate-name"),
      harness: "codex",
      message: "first",
      cwd: "/tmp/demo",
    };

    machine.spawn(params);
    expect(() => machine.spawn({ ...params, message: "second" })).toThrowError(
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
});
