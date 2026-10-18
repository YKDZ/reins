import type {
  CoreDiagnosticFact,
  DomainEvent,
  SpawnParams,
  SessionId,
} from "@reins/protocol";
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

    const { sessionId } = await machine.spawn({
      sessionLabel: ids.sessionLabel("fixture-21"),
      harness: "codex",
      message: "审查这个 PR",
      cwd: "/tmp/demo",
    });

    expect(sessionId).toMatch(/^session:gtest:\d+$/u);
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
        activeTurnId: events.find((event) => event.type === "turn.started")
          ?.turnId,
      }),
    ]);
  });

  test("相同会话标签创建独立的机器身份", async () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({
      driverFactory: fake.factory,
      identity: testIdentity,
      diagnostics: testDiagnostics,
    });
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));
    const params = {
      sessionLabel: ids.sessionLabel("root"),
      harness: "codex",
      message: "first",
      cwd: "/tmp/demo",
    } satisfies SpawnParams;

    const first = await machine.spawn(params);
    const second = await machine.spawn({ ...params, message: "second" });
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(fake.controls.started).toHaveLength(2);
    expect(
      events.filter((event) => event.type === "session.created"),
    ).toHaveLength(2);
    expect(machine.list().map((session) => session.sessionLabel)).toEqual([
      params.sessionLabel,
      params.sessionLabel,
    ]);
  });

  test("keeps reentrant spawn ingress isolated by session", async () => {
    let machine: ReturnType<typeof createSessionMachine>;
    let nestedSpawn: Promise<SessionId> | undefined;
    const diagnostics: CoreDiagnosticFact[] = [];
    const fake = createFakeDriver({
      start: (spec) => {
        if (spec.message === "outer") {
          nestedSpawn = machine
            .spawn({
              sessionLabel: ids.sessionLabel("inner"),
              harness: "codex",
              message: "inner",
              cwd: "/tmp/demo",
            })
            .then((ack) => ack.sessionId);
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

    const { sessionId: outer } = await machine.spawn({
      sessionLabel: ids.sessionLabel("outer"),
      harness: "codex",
      message: "outer",
      cwd: "/tmp/demo",
    });
    const inner = await nestedSpawn;
    if (inner === undefined) throw new Error("nested spawn did not start");

    expect(
      machine
        .list()
        .map((session) => session.sessionId)
        .sort(),
    ).toEqual([inner, outer].sort());
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
