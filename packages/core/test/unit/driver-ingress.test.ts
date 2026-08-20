import type { DiagnosticInput, DomainEvent } from "@reins/protocol";
import { describe, expect, test, vi } from "vitest";

import { createSessionMachine } from "#/session-machine";

import { createFakeDriver } from "./fake-driver.ts";
import { ids, testIdentity } from "./ids.ts";

describe("driver event ingress ownership", () => {
  test("validates synchronous idle delivery against the projected new turn", async () => {
    const diagnostics: DiagnosticInput[] = [];
    const fake = createFakeDriver({
      deliver: (sessionId, turnId) => {
        fake.controls.emit({
          type: "text.delta",
          sessionId,
          turnId,
          messageId: ids.message("msync"),
          delta: "synchronous",
        });
      },
    });
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
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));
    const sessionId = await machine.spawn({
      sessionName: ids.sessionName("projected-turn"),
      harness: "codex",
      message: "one",
      cwd: "/tmp/demo",
    });
    fake.controls.emit({
      type: "turn.completed",
      sessionId,
      turnId: ids.turn("t1"),
      stopReason: "end_turn",
      finalReply: null,
      usage: {},
    });
    events.length = 0;

    await machine.send({ sessionId, message: "next" });

    expect(events.map((event) => event.type)).toEqual([
      "turn.started",
      "message",
      "text.delta",
    ]);
    expect(diagnostics).toEqual([]);
  });

  test("rolls back action-local ownership when boundary delivery throws", async () => {
    let attempts = 0;
    const diagnostics: DiagnosticInput[] = [];
    const fake = createFakeDriver({
      deliver: (sessionId, turnId) => {
        attempts += 1;
        fake.controls.emit({
          type: "text.delta",
          sessionId,
          turnId,
          messageId: ids.message("mretry"),
          delta: `attempt ${attempts}`,
        });
        fake.controls.emit({
          type: "message",
          sessionId,
          turnId,
          messageId: ids.message("mretry"),
          role: "worker",
          content: `complete ${attempts}`,
        });
        fake.controls.emit({
          type: "tool.requested",
          sessionId,
          turnId,
          toolCallId: ids.toolCall("cretry"),
          name: "Read",
        });
        fake.controls.emit({
          type: "tool.completed",
          sessionId,
          turnId,
          toolCallId: ids.toolCall("cretry"),
          name: "Read",
          result: `complete ${attempts}`,
          isError: false,
        });
        fake.controls.emit({
          type: "permission.requested",
          sessionId,
          turnId,
          permissionId: ids.permission("pretry"),
          kind: "tool:Bash",
          options: [{ outcome: "allow", scope: "once" }],
        });
        if (attempts === 1) throw new Error("retry boundary");
      },
    });
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
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));
    const sessionId = await machine.spawn({
      sessionName: ids.sessionName("rollback-scope"),
      harness: "codex",
      message: "one",
      cwd: "/tmp/demo",
    });
    await machine.send({ sessionId, message: "queued" });

    fake.controls.emit({
      type: "tool.completed",
      sessionId,
      turnId: ids.turn("t1"),
      toolCallId: ids.toolCall("cboundary1"),
      name: "Read",
      result: "first boundary",
      isError: false,
    });
    fake.controls.emit({
      type: "tool.completed",
      sessionId,
      turnId: ids.turn("t1"),
      toolCallId: ids.toolCall("cboundary2"),
      name: "Read",
      result: "retry boundary",
      isError: false,
    });

    await vi.waitFor(() =>
      expect(
        diagnostics.filter((input) => input.kind === "request_failure"),
      ).toHaveLength(1),
    );
    expect(
      diagnostics.filter((input) => input.kind === "protocol_violation"),
    ).toEqual([]);
    expect(
      events.filter(
        (event) =>
          event.type === "text.delta" &&
          event.messageId === ids.message("mretry"),
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.type === "message" && event.messageId === ids.message("mretry"),
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.type === "tool.requested" &&
          event.toolCallId === ids.toolCall("cretry"),
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.type === "tool.completed" &&
          event.toolCallId === ids.toolCall("cretry"),
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.type === "permission.requested" &&
          event.permissionId === ids.permission("pretry"),
      ),
    ).toHaveLength(1);
    await machine.resolvePermission({
      sessionId,
      permissionId: ids.permission("pretry"),
      resolution: { outcome: "allow", scope: "once" },
    });
  });

  test("scopes worker ids to their protocol parent and rejects only local conflicts", async () => {
    const fake = createFakeDriver();
    const diagnostics: DiagnosticInput[] = [];
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
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));
    const first = await machine.spawn({
      sessionName: ids.sessionName("ingress-one"),
      harness: "codex",
      message: "one",
      cwd: "/tmp/demo",
    });
    const second = await machine.spawn({
      sessionName: ids.sessionName("ingress-two"),
      harness: "codex",
      message: "two",
      cwd: "/tmp/demo",
    });

    fake.controls.emit({
      type: "text.delta",
      sessionId: first,
      turnId: ids.turn("t1"),
      messageId: ids.message("m9"),
      delta: "accepted",
    });
    fake.controls.emit({
      type: "text.delta",
      sessionId: second,
      turnId: ids.turn("t2"),
      messageId: ids.message("m9"),
      delta: "same local message in another session",
    });
    fake.controls.emit({
      type: "message",
      sessionId: first,
      turnId: ids.turn("t1"),
      messageId: ids.message("m9"),
      role: "worker",
      content: "complete",
    });
    fake.controls.emit({
      type: "message",
      sessionId: first,
      turnId: ids.turn("t1"),
      messageId: ids.message("m9"),
      role: "worker",
      content: "duplicate complete",
    });
    fake.controls.emit({
      type: "tool.requested",
      sessionId: first,
      turnId: ids.turn("t1"),
      toolCallId: ids.toolCall("c9"),
      name: "Read",
    });
    fake.controls.emit({
      type: "tool.requested",
      sessionId: second,
      turnId: ids.turn("t2"),
      toolCallId: ids.toolCall("c9"),
      name: "Read",
    });
    fake.controls.emit({
      type: "permission.requested",
      sessionId: first,
      turnId: ids.turn("t1"),
      permissionId: ids.permission("p9"),
      kind: "tool:Bash",
      options: [{ outcome: "allow", scope: "once" }],
    });
    fake.controls.emit({
      type: "permission.requested",
      sessionId: second,
      turnId: ids.turn("t2"),
      permissionId: ids.permission("p9"),
      kind: "tool:Bash",
      options: [{ outcome: "allow", scope: "once" }],
    });
    fake.controls.emit({
      type: "permission.requested",
      sessionId: second,
      turnId: ids.turn("t2"),
      permissionId: ids.permission("p9"),
      kind: "tool:Bash",
      options: [{ outcome: "allow", scope: "once" }],
    });
    fake.controls.emit({
      type: "tool.requested",
      sessionId: first,
      turnId: ids.turn("t1"),
      toolCallId: ids.toolCall("c9"),
      name: "Read",
    });
    fake.controls.emit({
      type: "message",
      sessionId: first,
      turnId: ids.turn("t99"),
      messageId: ids.message("m8"),
      role: "worker",
      content: "stale turn",
    });
    fake.controls.emit({
      type: "session.killed",
      sessionId: ids.session("missing@gtest"),
    });

    await vi.waitFor(() => expect(diagnostics).toHaveLength(5));
    expect(
      events.filter(
        (event) =>
          (event.type === "permission.requested" &&
            event.sessionId === second &&
            events
              .filter(
                (candidate) =>
                  candidate.type === "permission.requested" &&
                  candidate.sessionId === second,
              )
              .indexOf(event) > 0) ||
          (event.type === "message" &&
            event.content === "duplicate complete") ||
          (event.type === "message" && event.content === "stale turn") ||
          event.sessionId === ids.session("missing@gtest"),
      ),
    ).toEqual([]);
    expect(diagnostics).toEqual(
      Array.from({ length: 5 }, () =>
        expect.objectContaining({
          source: "core",
          kind: "protocol_violation",
          operation: "validate_worker_event",
          reason: "unexpected_message",
        }),
      ),
    );
    expect(JSON.stringify(diagnostics)).not.toContain("m9");
    expect(JSON.stringify(diagnostics)).not.toContain("c9");
    expect(JSON.stringify(diagnostics)).not.toContain("p9");
    expect(
      events.filter(
        (event) => event.type === "tool.requested" && event.sessionId === first,
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.type === "permission.requested" && event.sessionId === second,
      ),
    ).toHaveLength(1);
    await machine.resolvePermission({
      sessionId: second,
      permissionId: ids.permission("p9"),
      resolution: { outcome: "allow", scope: "once" },
    });
    expect(machine.list()).toEqual([
      expect.objectContaining({ sessionId: first, state: "busy", turns: 0 }),
      expect.objectContaining({ sessionId: second, state: "busy", turns: 0 }),
    ]);
  });

  test("releases turn-local message and tool ids when each turn terminates", async () => {
    const fake = createFakeDriver();
    const diagnostics: DiagnosticInput[] = [];
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
    const sessionId = await machine.spawn({
      sessionName: ids.sessionName("bounded-turn-scopes"),
      harness: "codex",
      message: "one",
      cwd: "/tmp/demo",
    });

    for (let index = 1; index <= 30; index += 1) {
      const turnId = ids.turn(`t${index}`);
      fake.controls.emit({
        type: "message",
        sessionId,
        turnId,
        messageId: ids.message("mworker"),
        role: "worker",
        content: `reply ${index}`,
      });
      fake.controls.emit({
        type: "tool.requested",
        sessionId,
        turnId,
        toolCallId: ids.toolCall("c1"),
        name: "Read",
      });
      fake.controls.emit({
        type: "turn.completed",
        sessionId,
        turnId,
        stopReason: "end_turn",
        finalReply: null,
        usage: {},
      });
      if (index < 30) {
        const ack = await machine.send({ sessionId, message: `next ${index}` });
        expect(ack.turnId).toBe(ids.turn(`t${index + 1}`));
      }
    }

    expect(diagnostics).toEqual([]);
    expect(machine.list()).toEqual([
      expect.objectContaining({ sessionId, state: "idle", turns: 30 }),
    ]);
  });

  test("keeps permission ids session-local across turn boundaries", async () => {
    const fake = createFakeDriver();
    const diagnostics: DiagnosticInput[] = [];
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
    const sessionId = await machine.spawn({
      sessionName: ids.sessionName("permission-scope"),
      harness: "codex",
      message: "one",
      cwd: "/tmp/demo",
    });
    const request: Omit<
      Extract<DomainEvent, { type: "permission.requested" }>,
      "turnId"
    > = {
      type: "permission.requested",
      sessionId,
      permissionId: ids.permission("p1"),
      kind: "tool:Bash",
      options: [{ outcome: "allow", scope: "once" }],
    };
    fake.controls.emit({ ...request, turnId: ids.turn("t1") });
    await machine.resolvePermission({
      sessionId,
      permissionId: request.permissionId,
      resolution: { outcome: "allow", scope: "once" },
    });
    fake.controls.emit({
      type: "turn.completed",
      sessionId,
      turnId: ids.turn("t1"),
      stopReason: "end_turn",
      finalReply: null,
      usage: {},
    });
    const next = await machine.send({ sessionId, message: "next" });
    fake.controls.emit({ ...request, turnId: next.turnId });

    await vi.waitFor(() => expect(diagnostics).toHaveLength(1));
    expect(diagnostics[0]).toEqual(
      expect.objectContaining({ kind: "protocol_violation" }),
    );
  });
});
