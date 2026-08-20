import {
  makeDiagnosticId,
  type CoreDiagnosticFact,
  type DomainEvent,
} from "@reins/protocol";
import { describe, expect, test, vi } from "vitest";

import type { DiagnosticEmitter } from "#/diagnostic-emitter";
import { createSessionMachine } from "#/session-machine";

import { createFakeDriver } from "./fake-driver.ts";
import { ids, testIdentity } from "./ids.ts";

describe("driver 抛错时动作整体回滚", () => {
  test("rejects a microtask orphan after failed start before awaiting diagnostics", async () => {
    let releaseFailure!: () => void;
    const failureAccepted = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    const diagnostics: CoreDiagnosticFact[] = [];
    const fake = createFakeDriver({
      start: (spec) => {
        queueMicrotask(() => {
          fake.controls.emit({
            type: "text.delta",
            sessionId: spec.sessionId,
            turnId: spec.turnId,
            messageId: ids.message("m1"),
            delta: "orphan",
          });
        });
        throw new Error("driver failed");
      },
    });
    const machine = createSessionMachine({
      driverFactory: fake.factory,
      identity: testIdentity,
      diagnostics: {
        async record(input) {
          diagnostics.push(input);
          if (input.kind === "request_failure") await failureAccepted;
          return undefined;
        },
      },
    });
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));

    const failure = machine.spawn({
      sessionName: ids.sessionName("microtask-orphan"),
      harness: "codex",
      message: "start",
      cwd: "/tmp/demo",
    });
    await vi.waitFor(() =>
      expect(diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "protocol_violation" }),
        ]),
      ),
    );
    expect(events).toEqual([]);
    expect(machine.list()).toEqual([]);
    expect(
      diagnostics.filter((input) => input.kind === "protocol_violation"),
    ).toHaveLength(1);

    releaseFailure();
    await expect(failure).rejects.toMatchObject({ code: "internal_error" });
  });

  test("failure waits for an accepted diagnostic before exposing its id", async () => {
    const diagnosticId = makeDiagnosticId("test", "accepted");
    let accept!: (id: typeof diagnosticId) => void;
    const accepted = new Promise<typeof diagnosticId>((resolve) => {
      accept = resolve;
    });
    const fake = createFakeDriver({
      start: () => {
        throw new Error("driver failed");
      },
    });
    const machine = createSessionMachine({
      driverFactory: fake.factory,
      identity: testIdentity,
      diagnostics: { record: async () => await accepted },
    });
    const failure = machine.spawn({
      sessionName: ids.sessionName("accepted-diagnostic"),
      harness: "codex",
      message: "start",
      cwd: "/tmp/demo",
    });
    let settled = false;
    void failure.catch(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    accept(diagnosticId);
    await expect(failure).rejects.toEqual(
      expect.objectContaining({ diagnosticId }),
    );
  });

  test("诊断 emitter 抛错不改变 driver failure 的控制流", async () => {
    const fake = createFakeDriver({
      start: () => {
        throw new Error("driver failed");
      },
    });
    const diagnostics: DiagnosticEmitter = {
      record: () => {
        throw new Error("recorder failed");
      },
    };
    const machine = createSessionMachine({
      driverFactory: fake.factory,
      identity: testIdentity,
      diagnostics,
    });

    await expect(
      machine.spawn({
        sessionName: ids.sessionName("emitter-isolated"),
        harness: "codex",
        message: "start",
        cwd: "/tmp/demo",
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "internal_error",
        cause: { kind: "exception", message: "driver failed" },
      }),
    );
    expect(machine.list()).toEqual([]);
  });

  test("already-recorded MachineError is propagated without a duplicate diagnostic", async () => {
    const diagnosticId = makeDiagnosticId("test", "recorded");
    const fake = createFakeDriver({
      start: () => {
        throw {
          code: "internal_error",
          diagnosticId,
          cause: { kind: "exception", message: "recorded" },
        };
      },
    });
    const record = vi.fn(async () => diagnosticId);
    const machine = createSessionMachine({
      driverFactory: fake.factory,
      identity: testIdentity,
      diagnostics: { record },
    });

    await expect(
      machine.spawn({
        sessionName: ids.sessionName("already-recorded"),
        harness: "codex",
        message: "start",
        cwd: "/tmp/demo",
      }),
    ).rejects.toEqual(expect.objectContaining({ diagnosticId }));
    expect(record).not.toHaveBeenCalled();
  });

  test("spawn：driver.start 抛错则不产生会话、事件与孤儿状态", async () => {
    const fake = createFakeDriver({
      start: () => {
        throw new Error("启动失败");
      },
    });
    const diagnosticId = makeDiagnosticId("test", "1");
    const record = vi.fn(async () => diagnosticId);
    const diagnostics: DiagnosticEmitter = {
      record,
    };
    const machine = createSessionMachine({
      driverFactory: fake.factory,
      identity: testIdentity,
      diagnostics,
    });
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));

    await expect(
      machine.spawn({
        sessionName: ids.sessionName("fixture-1"),
        harness: "codex",
        message: "开始",
        cwd: "/tmp/demo",
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "internal_error",
        diagnosticId,
        cause: { kind: "exception", message: "启动失败" },
      }),
    );

    expect(events).toEqual([]);
    expect(machine.list()).toEqual([]);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: ids.session("fixture-1@gtest"),
        turnId: ids.turn("t1"),
        kind: "request_failure",
        operation: "spawn",
        stage: "start_session",
        reason: "upstream_error",
      }),
    );
  });

  test("send：driver.deliver 抛错则不开启新回合，会话保持 idle", async () => {
    const fake = createFakeDriver({
      deliver: () => {
        throw new Error("投递失败");
      },
    });
    const inputs: CoreDiagnosticFact[] = [];
    const machine = createSessionMachine({
      driverFactory: fake.factory,
      identity: testIdentity,
      diagnostics: {
        async record(input) {
          inputs.push(input);
          return undefined;
        },
      },
    });
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));
    const id = await machine.spawn({
      sessionName: ids.sessionName("fixture-2"),
      harness: "codex",
      message: "第一步",
      cwd: "/tmp/demo",
    });
    fake.controls.emit({
      type: "turn.completed",
      sessionId: id,
      turnId: ids.turn("t1"),
      stopReason: "end_turn",
      finalReply: null,
      usage: {},
    });

    await expect(
      machine.send({ sessionId: id, message: "继续" }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "internal_error",
        cause: { kind: "exception", message: "投递失败" },
      }),
    );

    expect(
      events.filter((event) => event.type === "turn.started"),
    ).toHaveLength(1);
    expect(machine.list()[0]).toEqual(
      expect.objectContaining({ sessionId: id, state: "idle" }),
    );
    expect(inputs).toEqual([
      expect.objectContaining({
        sessionId: id,
        turnId: ids.turn("t2"),
        kind: "request_failure",
        operation: "send",
        stage: "deliver",
      }),
    ]);
  });

  test("kill：driver.terminate 异步失败则不产生 session.killed，会话保持原状", async () => {
    const fake = createFakeDriver({
      terminate: async () => {
        await Promise.resolve();
        throw new Error("终止失败");
      },
    });
    const inputs: CoreDiagnosticFact[] = [];
    const machine = createSessionMachine({
      driverFactory: fake.factory,
      identity: testIdentity,
      diagnostics: {
        record: async (input) => {
          inputs.push(input);
          return undefined;
        },
      },
    });
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));
    const id = await machine.spawn({
      sessionName: ids.sessionName("fixture-3"),
      harness: "codex",
      message: "进行中",
      cwd: "/tmp/demo",
    });

    await expect(machine.kill({ ids: [id] })).rejects.toEqual(
      expect.objectContaining({
        code: "internal_error",
        cause: { kind: "exception", message: "终止失败" },
      }),
    );

    expect(events.some((event) => event.type === "session.killed")).toBe(false);
    expect(machine.list()[0]).toEqual(
      expect.objectContaining({ sessionId: id, state: "busy" }),
    );
    expect(inputs).toEqual([
      expect.objectContaining({
        sessionId: id,
        turnId: ids.turn("t1"),
        kind: "request_failure",
        operation: "kill",
        stage: "terminate",
        reason: "upstream_error",
      }),
    ]);
  });

  test("并发 kill 共享 termination，期间动作严格拒绝且只提交一次 killed", async () => {
    let releaseTermination!: () => void;
    const termination = new Promise<void>((resolve) => {
      releaseTermination = resolve;
    });
    let terminateCalls = 0;
    const fake = createFakeDriver({
      terminate: async () => {
        terminateCalls += 1;
        await termination;
      },
    });
    const machine = createSessionMachine({
      driverFactory: fake.factory,
      identity: testIdentity,
      diagnostics: { record: async () => undefined },
    });
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));
    const sessionId = await machine.spawn({
      sessionName: ids.sessionName("concurrent-kill"),
      harness: "codex",
      message: "start",
      cwd: "/tmp/demo",
    });

    const first = machine.kill({ ids: [sessionId] });
    await vi.waitFor(() => expect(terminateCalls).toBe(1));
    const second = machine.kill({ ids: [sessionId] });
    await expect(
      machine.send({ sessionId, message: "must not enter driver" }),
    ).rejects.toEqual({ code: "session_terminating", sessionId });
    await expect(machine.interrupt({ ids: [sessionId] })).rejects.toEqual({
      code: "session_terminating",
      sessionId,
    });
    expect(fake.controls.delivered).toEqual([]);
    expect(fake.controls.interrupted).toEqual([]);

    releaseTermination();
    await expect(Promise.all([first, second])).resolves.toEqual([
      [{ sessionId, status: "killed" }],
      [{ sessionId, status: "killed" }],
    ]);
    expect(terminateCalls).toBe(1);
    expect(
      events.filter((event) => event.type === "session.killed"),
    ).toHaveLength(1);
  });

  test("routing 已验证的 diagnosticId 由 core 复用且不重复记录", async () => {
    const diagnosticId = makeDiagnosticId("core", "1");
    const fake = createFakeDriver({
      terminate: async () => {
        throw {
          code: "internal_error",
          cause: { kind: "upstream", message: "verified failure" },
          diagnosticId,
        };
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
    const sessionId = await machine.spawn({
      sessionName: ids.sessionName("verified-failure"),
      harness: "codex",
      message: "start",
      cwd: "/tmp/demo",
    });

    await expect(machine.kill({ ids: [sessionId] })).rejects.toMatchObject({
      code: "internal_error",
      diagnosticId,
    });
    expect(diagnostics).toEqual([]);
  });
});
