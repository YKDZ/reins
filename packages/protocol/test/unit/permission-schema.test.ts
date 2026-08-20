import * as v from "valibot";
import { describe, expect, test } from "vitest";

import {
  domainEventSchema,
  permissionOptionSchema,
  permissionResolutionSchemaFor,
  permissionResolutionSchema,
  resolvePermissionParamsSchema,
  spawnParamsSchema,
} from "../../src/index.ts";

const ok = (schema: v.GenericSchema, input: unknown): void => {
  expect(v.safeParse(schema, input).success).toBe(true);
};

const bad = (schema: v.GenericSchema, input: unknown): void => {
  expect(v.safeParse(schema, input).success).toBe(false);
};

describe("决议 schema", () => {
  test("allow 必须携带 once 或 session 生效范围", () => {
    ok(permissionResolutionSchema, { outcome: "allow", scope: "once" });
    ok(permissionResolutionSchema, { outcome: "allow", scope: "session" });
    bad(permissionResolutionSchema, { outcome: "allow" });
    bad(permissionResolutionSchema, { outcome: "allow", scope: "forever" });
  });

  test("deny 可携带可选的反馈文本", () => {
    ok(permissionResolutionSchema, { outcome: "deny" });
    ok(permissionResolutionSchema, {
      outcome: "deny",
      feedback: "请改用 npm 而不是 sudo",
    });
    bad(permissionResolutionSchema, { outcome: "deny", feedback: 42 });
  });

  test("scope 只属于 allow，未知 outcome 被拒绝", () => {
    bad(permissionResolutionSchema, { outcome: "deny", scope: "once" });
    bad(permissionResolutionSchema, { outcome: "maybe" });
  });
});

describe("选项 schema", () => {
  test("allow 选项携带生效范围，deny 选项携带反馈开关", () => {
    ok(permissionOptionSchema, { outcome: "allow", scope: "once" });
    ok(permissionOptionSchema, { outcome: "allow", scope: "session" });
    ok(permissionOptionSchema, { outcome: "deny", feedback: false });
    ok(permissionOptionSchema, { outcome: "deny", feedback: true });
    bad(permissionOptionSchema, { outcome: "allow" });
    bad(permissionOptionSchema, { outcome: "deny" });
    bad(permissionOptionSchema, {
      outcome: "allow",
      scope: "session",
      feedback: false,
    });
  });
});

describe("决议菜单 schema", () => {
  test("决议必须落在菜单的某个选项内", () => {
    const menu = permissionResolutionSchemaFor([
      { outcome: "allow", scope: "once" },
      { outcome: "deny", feedback: false },
    ]);

    ok(menu, { outcome: "allow", scope: "once" });
    bad(menu, { outcome: "allow", scope: "session" });
    ok(menu, { outcome: "deny" });
    bad(menu, { outcome: "deny", feedback: "换个命令" });
  });

  test("带反馈开关的 deny 选项必须携带文本，无开关则不得携带", () => {
    const menu = permissionResolutionSchemaFor([
      { outcome: "deny", feedback: true },
    ]);

    ok(menu, { outcome: "deny", feedback: "不要用 sudo" });
    bad(menu, { outcome: "deny" });

    const plain = permissionResolutionSchemaFor([
      { outcome: "deny", feedback: false },
    ]);
    ok(plain, { outcome: "deny" });
    bad(plain, { outcome: "deny", feedback: "不要用 sudo" });
  });

  test("空菜单拒绝一切决议", () => {
    const menu = permissionResolutionSchemaFor([]);

    bad(menu, { outcome: "allow", scope: "once" });
    bad(menu, { outcome: "deny" });
  });
});

describe("权限事件", () => {
  const base = {
    sessionId: "reviewer@g7",
    turnId: "t1",
    permissionId: "p1",
    kind: "tool:Bash",
  };

  test("permission.requested 必须携带选项菜单，input 可选", () => {
    ok(domainEventSchema, {
      type: "permission.requested",
      ...base,
      options: [
        { outcome: "allow", scope: "once" },
        { outcome: "deny", feedback: false },
      ],
    });
    ok(domainEventSchema, {
      type: "permission.requested",
      ...base,
      input: { command: "npm test" },
      options: [{ outcome: "allow", scope: "session" }],
    });
    bad(domainEventSchema, { type: "permission.requested", ...base });
    bad(domainEventSchema, {
      type: "permission.requested",
      ...base,
      options: [{ outcome: "allow" }],
    });
  });

  test("permission.resolved 携带决议而非二值 decision", () => {
    const resolvedBase = {
      sessionId: base.sessionId,
      turnId: base.turnId,
      permissionId: base.permissionId,
    };
    ok(domainEventSchema, {
      type: "permission.resolved",
      ...resolvedBase,
      resolution: { outcome: "allow", scope: "session" },
    });
    ok(domainEventSchema, {
      type: "permission.resolved",
      ...resolvedBase,
      resolution: { outcome: "deny", feedback: "不要用 sudo" },
    });
    bad(domainEventSchema, {
      type: "permission.resolved",
      ...resolvedBase,
      decision: "allow",
    });
    bad(domainEventSchema, {
      type: "permission.resolved",
      ...resolvedBase,
      resolution: { outcome: "allow" },
    });
  });
});

describe("工具生命周期事件", () => {
  const base = {
    sessionId: "reviewer@g7",
    turnId: "t1",
    toolCallId: "c1",
    name: "Bash",
  };

  test("tool.requested 取代 tool.started，tool.completed 必须携带 isError", () => {
    ok(domainEventSchema, { type: "tool.requested", ...base });
    bad(domainEventSchema, { type: "tool.started", ...base });
    ok(domainEventSchema, {
      type: "tool.completed",
      ...base,
      result: null,
      isError: false,
    });
    bad(domainEventSchema, {
      type: "tool.completed",
      ...base,
      result: null,
    });
  });
});

describe("授权模式与决议命令", () => {
  test("spawn 接受 authorizationMode，拒绝已移除的 permissionMode", () => {
    ok(spawnParamsSchema, {
      harness: "codex",
      message: "x",
      sessionName: "reviewer",
      authorizationMode: "interactive",
    });
    ok(spawnParamsSchema, {
      harness: "codex",
      message: "x",
      sessionName: "reviewer",
      authorizationMode: "allowAll",
    });
    bad(spawnParamsSchema, {
      harness: "codex",
      message: "x",
      authorizationMode: "yolo",
    });
    bad(spawnParamsSchema, {
      harness: "codex",
      message: "x",
      permissionMode: "yolo",
    });
  });

  test("resolvePermission 参数必须携带完整决议", () => {
    ok(resolvePermissionParamsSchema, {
      sessionId: "reviewer@g7",
      permissionId: "p1",
      resolution: { outcome: "allow", scope: "once" },
    });
    bad(resolvePermissionParamsSchema, {
      sessionId: "reviewer@g7",
      permissionId: "p1",
    });
    bad(resolvePermissionParamsSchema, {
      sessionId: "reviewer@g7",
      permissionId: "p1",
      resolution: { outcome: "allow" },
    });
  });
});
