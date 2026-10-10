import {
  WORKER_EVENT_REJECTION_REASONS,
  type CoreDiagnosticFact,
  type DomainEvent,
  type WorkerEventRejection,
} from "@reins/protocol";
import { describe, expect, test, vi } from "vitest";

import { createSessionMachine } from "#/session-machine";

import { createFakeDriver } from "./fake-driver.ts";
import { ids, testIdentity } from "./ids.ts";

describe("driver event ingress ownership", () => {
  test("registers best-effort diagnostics immediately and isolates recorder failures", async () => {
    let recordCalls = 0;
    const fake = createFakeDriver();
    const machine = createSessionMachine({
      driverFactory: fake.factory,
      identity: testIdentity,
      diagnostics: {
        record() {
          recordCalls += 1;
          if (recordCalls === 1)
            throw new Error("synchronous recorder failure");
          return Promise.reject(new Error("asynchronous recorder failure"));
        },
      },
    });
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));
    const { sessionId } = await machine.spawn({
      sessionName: ids.sessionName("best-effort-registration"),
      harness: "codex",
      message: "start",
      cwd: "/tmp/demo",
    });
    const publishedBeforeRejections = events.length;

    expect(() =>
      fake.controls.emit({ type: "session.killed", sessionId }),
    ).not.toThrow();
    expect(recordCalls).toBe(1);
    expect(() =>
      fake.controls.emit({
        type: "turn.started",
        sessionId,
        turnId: ids.turn("t99"),
      }),
    ).not.toThrow();
    expect(recordCalls).toBe(2);
    await Promise.resolve();

    expect(events).toHaveLength(publishedBeforeRejections);
    expect(machine.list()).toEqual([
      expect.objectContaining({ sessionId, state: "busy", turns: 0 }),
    ]);
  });

  test("treats synchronous spawn completion as terminal for later ingress", async () => {
    const diagnostics: CoreDiagnosticFact[] = [];
    const fake = createFakeDriver({
      start: (spec) => {
        fake.controls.emit({
          type: "turn.completed",
          sessionId: spec.sessionId,
          turnId: spec.turnId,
          stopReason: "end_turn",
          finalReply: "completed during spawn",
          usage: {},
        });
        fake.controls.emit({
          type: "text.delta",
          sessionId: spec.sessionId,
          turnId: spec.turnId,
          messageId: ids.message("m-after-spawn-completion"),
          delta: "must be rejected",
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

    const { sessionId } = await machine.spawn({
      sessionName: ids.sessionName("spawn-terminal-projection"),
      harness: "codex",
      message: "one",
      cwd: "/tmp/demo",
    });

    await vi.waitFor(() => expect(diagnostics).toHaveLength(1));
    expect(diagnostics[0]).toMatchObject({
      kind: "protocol_violation",
      operation: "validate_worker_event",
      reason: "event_after_turn_completed",
    });
    expect(events.map(({ type }) => type)).toEqual([
      "session.created",
      "turn.started",
      "turn.completed",
    ]);
    expect(machine.list()).toEqual([
      expect.objectContaining({ sessionId, state: "idle", turns: 1 }),
    ]);
  });

  test("reports each worker lifecycle rejection from its causal event sequence", async () => {
    const fake = createFakeDriver();
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
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));
    const spawn = async (name: string) =>
      (
        await machine.spawn({
          sessionName: ids.sessionName(name),
          harness: "codex",
          message: "start",
          cwd: "/tmp/demo",
        })
      ).sessionId;
    const active = await spawn("typed-active");

    fake.controls.emit({
      type: "session.created",
      sessionId: active,
      harness: "codex",
      model: null,
      reasoning: null,
      cwd: "/secret/cwd",
      sessionName: ids.sessionName("forged"),
      spawnedAt: "secret-time",
    });
    fake.controls.emit({
      type: "turn.started",
      sessionId: active,
      turnId: ids.turn("t99"),
    });
    fake.controls.emit({ type: "session.killed", sessionId: active });
    fake.controls.emit({
      type: "message",
      sessionId: active,
      turnId: ids.turn("t99"),
      messageId: ids.message("m-mismatch"),
      role: "worker",
      content: "secret-mismatch",
    });
    fake.controls.emit({
      type: "message",
      sessionId: active,
      turnId: ids.turn("t1"),
      messageId: ids.message("m1"),
      role: "worker",
      content: "secret-message",
    });
    fake.controls.emit({
      type: "message",
      sessionId: active,
      turnId: ids.turn("t1"),
      messageId: ids.message("m1"),
      role: "worker",
      content: "secret-duplicate",
    });
    fake.controls.emit({
      type: "tool.requested",
      sessionId: active,
      turnId: ids.turn("t1"),
      toolCallId: ids.toolCall("c1"),
      name: "secret-tool",
    });
    fake.controls.emit({
      type: "tool.requested",
      sessionId: active,
      turnId: ids.turn("t1"),
      toolCallId: ids.toolCall("c1"),
      name: "secret-duplicate-tool",
    });
    fake.controls.emit({
      type: "tool.completed",
      sessionId: active,
      turnId: ids.turn("t1"),
      toolCallId: ids.toolCall("c2"),
      name: "secret-tool",
      result: "secret-result",
      isError: false,
    });
    fake.controls.emit({
      type: "tool.completed",
      sessionId: active,
      turnId: ids.turn("t1"),
      toolCallId: ids.toolCall("c2"),
      name: "secret-tool",
      result: "secret-duplicate-result",
      isError: false,
    });
    fake.controls.emit({
      type: "permission.requested",
      sessionId: active,
      turnId: ids.turn("t1"),
      permissionId: ids.permission("p1"),
      kind: "secret-kind",
      input: { secret: "permission-input" },
      options: [{ outcome: "allow", scope: "once" }],
    });
    fake.controls.emit({
      type: "permission.resolved",
      sessionId: active,
      turnId: ids.turn("t99"),
      permissionId: ids.permission("p1"),
      resolution: { outcome: "deny", feedback: "secret-feedback" },
    });
    fake.controls.emit({
      type: "permission.resolved",
      sessionId: active,
      turnId: ids.turn("t1"),
      permissionId: ids.permission("missing"),
      resolution: { outcome: "deny", feedback: "secret-feedback" },
    });
    fake.controls.emit({
      type: "permission.resolved",
      sessionId: active,
      turnId: ids.turn("t1"),
      permissionId: ids.permission("p1"),
      resolution: { outcome: "allow", scope: "once" },
    });
    fake.controls.emit({
      type: "permission.requested",
      sessionId: active,
      turnId: ids.turn("t1"),
      permissionId: ids.permission("p1"),
      kind: "secret-reused",
      input: { secret: true },
      options: [{ outcome: "allow", scope: "once" }],
    });

    const idle = await spawn("typed-idle");
    fake.controls.emit({
      type: "turn.completed",
      sessionId: idle,
      turnId: ids.turn("t2"),
      stopReason: "end_turn",
      finalReply: "secret-final",
      usage: { secret: "usage" },
    });
    fake.controls.emit({
      type: "text.delta",
      sessionId: idle,
      turnId: ids.turn("t2"),
      messageId: ids.message("m-after"),
      delta: "secret-delta",
    });
    fake.controls.emit({
      type: "message",
      sessionId: idle,
      turnId: ids.turn("t77"),
      messageId: ids.message("m-idle"),
      role: "worker",
      content: "secret-idle",
    });

    const killed = await spawn("typed-killed");
    await machine.kill({ sessionId: killed });
    fake.controls.emit({
      type: "message",
      sessionId: killed,
      turnId: ids.turn("t3"),
      messageId: ids.message("m-killed"),
      role: "worker",
      content: "secret-killed",
    });
    fake.controls.emit({
      type: "message",
      sessionId: ids.session("unknown@gtest"),
      turnId: ids.turn("t1"),
      messageId: ids.message("m-unknown"),
      role: "worker",
      content: "secret-unknown",
    });

    await vi.waitFor(() => expect(diagnostics).toHaveLength(14));
    const violations = diagnostics.filter(
      (input) => input.kind === "protocol_violation",
    );
    const reasonCounts = Object.fromEntries(
      violations.map(({ reason }) => [reason, 0]),
    ) as Record<string, number>;
    for (const { reason } of violations)
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    expect(new Set(Object.keys(reasonCounts))).toEqual(
      new Set(WORKER_EVENT_REJECTION_REASONS),
    );
    expect(reasonCounts).toEqual({
      unknown_session: 1,
      session_killed: 1,
      driver_event_forbidden: 3,
      turn_not_active: 1,
      turn_mismatch: 1,
      event_after_turn_completed: 1,
      message_already_completed: 1,
      tool_already_requested: 1,
      tool_already_completed: 1,
      permission_id_reused: 1,
      permission_not_pending: 1,
      permission_turn_mismatch: 1,
    } satisfies Record<WorkerEventRejection["reason"], number>);
    expect(violations).toMatchObject([
      {
        reason: "driver_event_forbidden",
        eventType: "session.created",
        sessionState: "busy",
      },
      {
        reason: "driver_event_forbidden",
        eventType: "turn.started",
        sessionState: "busy",
      },
      {
        reason: "driver_event_forbidden",
        eventType: "session.killed",
        sessionState: "busy",
      },
      {
        reason: "turn_mismatch",
        eventTurnId: ids.turn("t99"),
        activeTurnId: ids.turn("t1"),
      },
      { reason: "message_already_completed", messageId: ids.message("m1") },
      { reason: "tool_already_requested", toolCallId: ids.toolCall("c1") },
      { reason: "tool_already_completed", toolCallId: ids.toolCall("c2") },
      {
        reason: "permission_turn_mismatch",
        permissionId: ids.permission("p1"),
        eventTurnId: ids.turn("t99"),
        activeTurnId: ids.turn("t1"),
      },
      {
        reason: "permission_not_pending",
        permissionId: ids.permission("missing"),
      },
      {
        reason: "permission_id_reused",
        permissionId: ids.permission("p1"),
      },
      {
        reason: "event_after_turn_completed",
        eventTurnId: ids.turn("t2"),
        sessionState: "idle",
      },
      {
        reason: "turn_not_active",
        eventTurnId: ids.turn("t77"),
        sessionState: "idle",
      },
      {
        reason: "session_killed",
        eventTurnId: ids.turn("t3"),
        sessionState: "killed",
      },
      {
        reason: "unknown_session",
        eventTurnId: ids.turn("t1"),
        sessionState: "unknown",
      },
    ]);
    expect(
      events.some(
        (event) =>
          "content" in event &&
          event.content.startsWith("secret-") &&
          event.content !== "secret-message",
      ),
    ).toBe(false);
    const serialized = JSON.stringify(violations);
    for (const secret of [
      "secret-content",
      "secret-duplicate",
      "secret-result",
      "permission-input",
      "secret-final",
      "secret-delta",
      "secret-feedback",
      "usage",
      "nativePayload",
    ])
      expect(serialized).not.toContain(secret);
  });

  test("validates synchronous idle delivery against the projected new turn", async () => {
    const diagnostics: CoreDiagnosticFact[] = [];
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
    const { sessionId } = await machine.spawn({
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

  test("makes synchronous completion terminal for ingress and rolls its projection back on action failure", async () => {
    let attempt = 0;
    const diagnostics: CoreDiagnosticFact[] = [];
    const fake = createFakeDriver({
      deliver: (sessionId, turnId) => {
        attempt += 1;
        if (attempt === 1) {
          fake.controls.emit({
            type: "turn.completed",
            sessionId,
            turnId,
            stopReason: "end_turn",
            finalReply: "secret-final-reply",
            usage: { secret: "usage" },
          });
          fake.controls.emit({
            type: "text.delta",
            sessionId,
            turnId,
            messageId: ids.message("m-after-sync-completion"),
            delta: "secret-after-completion",
          });
          throw new Error("delivery failed after synchronous completion");
        }
        fake.controls.emit({
          type: "text.delta",
          sessionId,
          turnId,
          messageId: ids.message("m-retry-after-rollback"),
          delta: "accepted retry",
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
    const { sessionId } = await machine.spawn({
      sessionName: ids.sessionName("terminal-projection"),
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

    await expect(
      machine.send({ sessionId, message: "fails" }),
    ).rejects.toMatchObject({
      code: "internal_error",
    });
    await vi.waitFor(() =>
      expect(
        diagnostics.some(
          (input) =>
            input.kind === "protocol_violation" &&
            input.reason === "event_after_turn_completed",
        ),
      ).toBe(true),
    );
    expect(events).toEqual([]);
    expect(machine.list()).toEqual([
      expect.objectContaining({ sessionId, state: "idle", turns: 1 }),
    ]);

    await machine.send({ sessionId, message: "retry" });
    expect(events.some((event) => event.type === "text.delta")).toBe(true);
  });

  test("prioritizes completed-turn ownership over permission lifecycle checks", async () => {
    const diagnostics: CoreDiagnosticFact[] = [];
    const fake = createFakeDriver();
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
    const { sessionId } = await machine.spawn({
      sessionName: ids.sessionName("completed-turn-ownership"),
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
    await machine.send({ sessionId, message: "two" });
    fake.controls.emit({
      type: "permission.requested",
      sessionId,
      turnId: ids.turn("t2"),
      permissionId: ids.permission("p-active"),
      kind: "tool:Bash",
      options: [{ outcome: "allow", scope: "once" }],
    });
    const publishedBeforeRejectedEvents = events.length;

    fake.controls.emit({
      type: "permission.resolved",
      sessionId,
      turnId: ids.turn("t1"),
      permissionId: ids.permission("p-old-nonpending"),
      resolution: { outcome: "deny" },
    });
    fake.controls.emit({
      type: "permission.resolved",
      sessionId,
      turnId: ids.turn("t1"),
      permissionId: ids.permission("p-active"),
      resolution: { outcome: "deny" },
    });
    fake.controls.emit({
      type: "turn.completed",
      sessionId,
      turnId: ids.turn("t2"),
      stopReason: "end_turn",
      finalReply: null,
      usage: {},
    });
    fake.controls.emit({
      type: "permission.resolved",
      sessionId,
      turnId: ids.turn("t1"),
      permissionId: ids.permission("p-old-idle"),
      resolution: { outcome: "deny" },
    });

    await vi.waitFor(() => expect(diagnostics).toHaveLength(3));
    expect(diagnostics).toEqual([
      expect.objectContaining({
        kind: "protocol_violation",
        operation: "validate_worker_event",
        eventType: "permission.resolved",
        eventTurnId: ids.turn("t1"),
        activeTurnId: ids.turn("t2"),
        reason: "event_after_turn_completed",
        sessionState: "busy",
      }),
      expect.objectContaining({
        kind: "protocol_violation",
        operation: "validate_worker_event",
        eventType: "permission.resolved",
        eventTurnId: ids.turn("t1"),
        activeTurnId: ids.turn("t2"),
        reason: "event_after_turn_completed",
        sessionState: "busy",
      }),
      expect.objectContaining({
        kind: "protocol_violation",
        operation: "validate_worker_event",
        eventType: "permission.resolved",
        eventTurnId: ids.turn("t1"),
        reason: "event_after_turn_completed",
        sessionState: "idle",
      }),
    ]);
    expect("activeTurnId" in diagnostics[2]!).toBe(false);
    expect(
      events.slice(publishedBeforeRejectedEvents).map(({ type }) => type),
    ).toEqual(["turn.completed"]);
    expect(machine.list()).toEqual([
      expect.objectContaining({ sessionId, state: "idle", turns: 2 }),
    ]);
  });

  test("rolls back action-local ownership when boundary delivery throws", async () => {
    let attempts = 0;
    const diagnostics: CoreDiagnosticFact[] = [];
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
    const { sessionId } = await machine.spawn({
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
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));
    const { sessionId: first } = await machine.spawn({
      sessionName: ids.sessionName("ingress-one"),
      harness: "codex",
      message: "one",
      cwd: "/tmp/demo",
    });
    const { sessionId: second } = await machine.spawn({
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
    expect(diagnostics.map((input) => input.reason)).toEqual([
      "message_already_completed",
      "permission_id_reused",
      "tool_already_requested",
      "turn_mismatch",
      "unknown_session",
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("duplicate complete");
    expect(JSON.stringify(diagnostics)).not.toContain("stale turn");
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
    const { sessionId } = await machine.spawn({
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
    const { sessionId } = await machine.spawn({
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
