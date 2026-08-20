import type {
  CoreDiagnosticFact,
  DomainEvent,
  PermissionOption,
  SessionId,
} from "@reins/protocol";
import { describe, expect, test } from "vitest";

import { createSessionMachine } from "#/session-machine";

import { createFakeDriver } from "./fake-driver.ts";
import { ids, testDiagnostics, testIdentity } from "./ids.ts";

async function spawnInteractive(): Promise<{
  machine: ReturnType<typeof createSessionMachine>;
  fake: ReturnType<typeof createFakeDriver>;
  events: DomainEvent[];
  sessionId: SessionId;
}> {
  const fake = createFakeDriver();
  const machine = createSessionMachine({
    driverFactory: fake.factory,
    identity: testIdentity,
    diagnostics: testDiagnostics,
  });
  const events: DomainEvent[] = [];
  machine.subscribe((event) => events.push(event));
  const sessionId = await machine.spawn({
    sessionName: ids.sessionName("fixture-13"),
    harness: "codex",
    message: "审查这个 PR",
    cwd: "/tmp/demo",
    authorizationMode: "interactive",
  });
  return { machine, fake, events, sessionId };
}

function request(
  fake: ReturnType<typeof createFakeDriver>,
  sessionId: SessionId,
  options: PermissionOption[],
): void {
  fake.controls.emit({
    type: "permission.requested",
    sessionId,
    turnId: ids.turn("t1"),
    permissionId: ids.permission("p1"),
    kind: "tool:Bash",
    options,
  });
}

describe("spawn 与授权模式", () => {
  test("未指定 authorizationMode 时缺省补全为 allowAll 并透传 spec", async () => {
    const fake = createFakeDriver();
    const machine = createSessionMachine({
      driverFactory: fake.factory,
      identity: testIdentity,
      diagnostics: testDiagnostics,
    });

    await machine.spawn({
      sessionName: ids.sessionName("fixture-inline-6"),
      harness: "codex",
      message: "a",
      cwd: "/tmp/demo",
    });
    await machine.spawn({
      sessionName: ids.sessionName("fixture-14"),
      harness: "qoder",
      message: "b",
      cwd: "/tmp/demo",
      authorizationMode: "interactive",
    });

    expect(fake.controls.started.map((spec) => spec.authorizationMode)).toEqual(
      ["allowAll", "interactive"],
    );
  });
});

describe("resolvePermission", () => {
  test("合法决议发出 permission.resolved 并转交 driver", async () => {
    const { machine, fake, events, sessionId } = await spawnInteractive();
    request(fake, sessionId, [
      { outcome: "allow", scope: "once" },
      { outcome: "deny", feedback: true },
    ]);

    await machine.resolvePermission({
      sessionId,
      permissionId: ids.permission("p1"),
      resolution: { outcome: "allow", scope: "once" },
    });

    expect(
      events.filter((event) => event.type === "permission.resolved"),
    ).toEqual([
      {
        type: "permission.resolved",
        sessionId,
        turnId: ids.turn("t1"),
        permissionId: ids.permission("p1"),
        resolution: { outcome: "allow", scope: "once" },
      },
    ]);
    expect(fake.controls.resolved).toEqual([
      {
        sessionId,
        permissionId: ids.permission("p1"),
        resolution: { outcome: "allow", scope: "once" },
      },
    ]);
  });

  test("决议必须落在请求的选项菜单内，越界抛 mismatch", async () => {
    const { machine, fake, events, sessionId } = await spawnInteractive();
    request(fake, sessionId, [
      { outcome: "allow", scope: "once" },
      { outcome: "deny", feedback: false },
    ]);

    await expect(
      machine.resolvePermission({
        sessionId,
        permissionId: ids.permission("p1"),
        resolution: { outcome: "allow", scope: "session" },
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "permission_resolution_mismatch" }),
    );
    await expect(
      machine.resolvePermission({
        sessionId,
        permissionId: ids.permission("p1"),
        resolution: { outcome: "deny", feedback: "换个命令" },
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "permission_resolution_mismatch" }),
    );
    expect(fake.controls.resolved).toEqual([]);
    expect(events.some((event) => event.type === "permission.resolved")).toBe(
      false,
    );
  });

  test("deny 带反馈开关的选项要求决议携带反馈文本", async () => {
    const { machine, fake, sessionId } = await spawnInteractive();

    request(fake, sessionId, [{ outcome: "deny", feedback: true }]);
    await expect(
      machine.resolvePermission({
        sessionId,
        permissionId: ids.permission("p1"),
        resolution: { outcome: "deny" },
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "permission_resolution_mismatch" }),
    );
    await machine.resolvePermission({
      sessionId,
      permissionId: ids.permission("p1"),
      resolution: { outcome: "deny", feedback: "不要用 sudo" },
    });
    expect(fake.controls.resolved[0]?.resolution).toEqual({
      outcome: "deny",
      feedback: "不要用 sudo",
    });
  });

  test("回合终态作废未决请求，此后再决议抛 not_pending", async () => {
    const { machine, fake, events, sessionId } = await spawnInteractive();
    request(fake, sessionId, [{ outcome: "allow", scope: "once" }]);

    await machine.interrupt({ ids: [sessionId] });
    fake.controls.emit({
      type: "turn.completed",
      sessionId,
      turnId: ids.turn("t1"),
      stopReason: "cancelled",
      finalReply: null,
      usage: {},
    });

    await expect(
      machine.resolvePermission({
        sessionId,
        permissionId: ids.permission("p1"),
        resolution: { outcome: "allow", scope: "once" },
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "permission_not_pending" }),
    );
    expect(events.some((event) => event.type === "permission.resolved")).toBe(
      false,
    );
  });

  test("未知会话与已清理会话分别抛 session_not_found 与 session_killed", async () => {
    const { machine, fake, sessionId } = await spawnInteractive();

    await expect(
      machine.resolvePermission({
        sessionId: ids.session("missing@gtest"),
        permissionId: ids.permission("p1"),
        resolution: { outcome: "allow", scope: "once" },
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "session_not_found" }));

    await machine.kill({ ids: [sessionId] });
    await expect(
      machine.resolvePermission({
        sessionId,
        permissionId: ids.permission("p1"),
        resolution: { outcome: "allow", scope: "once" },
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "session_killed" }));
    expect(fake.controls.resolved).toEqual([]);
  });

  test("决议参数非法时抛 invalid_params", async () => {
    const { machine, sessionId } = await spawnInteractive();

    await expect(
      machine.resolvePermission({
        sessionId,
        permissionId: ids.permission("p1"),
        // @ts-expect-error 故意传缺字段的决议，验证运行时校验
        resolution: { outcome: "allow" },
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "invalid_params" }));
  });

  test("driver 转交失败时不回写 resolved，未决请求保留可重试", async () => {
    let calls = 0;
    const fake = createFakeDriver({
      resolvePermission: () => {
        calls += 1;
        if (calls === 1) throw new Error("adapter 复验失败");
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
    const sessionId = await machine.spawn({
      sessionName: ids.sessionName("fixture-15"),
      harness: "codex",
      message: "审查这个 PR",
      cwd: "/tmp/demo",
      authorizationMode: "interactive",
    });
    request(fake, sessionId, [{ outcome: "allow", scope: "once" }]);

    await expect(
      machine.resolvePermission({
        sessionId,
        permissionId: ids.permission("p1"),
        resolution: { outcome: "allow", scope: "once" },
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "internal_error",
        cause: { kind: "exception", message: "adapter 复验失败" },
      }),
    );
    expect(events.some((event) => event.type === "permission.resolved")).toBe(
      false,
    );
    expect(inputs).toEqual([
      expect.objectContaining({
        sessionId,
        turnId: ids.turn("t1"),
        permissionId: ids.permission("p1"),
        kind: "authorization_failure",
        operation: "resolve_permission",
        stage: "deliver",
        reason: "upstream_rejected",
      }),
    ]);

    await machine.resolvePermission({
      sessionId,
      permissionId: ids.permission("p1"),
      resolution: { outcome: "allow", scope: "once" },
    });
    expect(
      events.filter((event) => event.type === "permission.resolved"),
    ).toHaveLength(1);
  });

  test("driver 同步发出的内容事件排在 resolved 之后", async () => {
    const fake = createFakeDriver({
      resolvePermission: () => {
        fake.controls.emit({
          type: "text.delta",
          sessionId: ids.session("fixture-16@gtest"),
          turnId: ids.turn("t1"),
          messageId: ids.message("m1"),
          delta: "收到",
        });
      },
    });
    const machine = createSessionMachine({
      driverFactory: fake.factory,
      identity: testIdentity,
      diagnostics: testDiagnostics,
    });
    const events: DomainEvent[] = [];
    machine.subscribe((event) => events.push(event));
    const sessionId = await machine.spawn({
      sessionName: ids.sessionName("fixture-16"),
      harness: "codex",
      message: "审查这个 PR",
      cwd: "/tmp/demo",
      authorizationMode: "interactive",
    });
    request(fake, sessionId, [{ outcome: "allow", scope: "once" }]);

    await machine.resolvePermission({
      sessionId,
      permissionId: ids.permission("p1"),
      resolution: { outcome: "allow", scope: "once" },
    });

    expect(events.map((event) => event.type)).toEqual([
      "session.created",
      "turn.started",
      "permission.requested",
      "permission.resolved",
      "text.delta",
    ]);
  });
});
