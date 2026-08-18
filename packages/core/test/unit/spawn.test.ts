import type { DomainEvent } from "@reins/protocol";
import { describe, expect, test } from "vitest";

import { createSessionMachine } from "#/session-machine";

import { createFakeDriver } from "./fake-driver.ts";

describe("spawn", () => {
  test("创建 busy 会话并发出 session.created 与 turn.started", () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({ driverFactory: fake.factory });
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));

    const sessionId = machine.spawn({
      harness: "codex",
      message: "审查这个 PR",
      cwd: "/tmp/demo",
      label: "审查",
    });

    expect(sessionId).toBe("s1");
    expect(events.map((event) => event.type)).toEqual([
      "session.created",
      "turn.started",
    ]);
    expect(machine.list()).toEqual([
      expect.objectContaining({
        sessionId: "s1",
        harness: "codex",
        state: "busy",
        model: null,
        reasoning: null,
        cwd: "/tmp/demo",
        label: "审查",
        turns: 0,
        lastStopReason: null,
      }),
    ]);
  });
});
