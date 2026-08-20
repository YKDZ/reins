import * as v from "valibot";
import { describe, expect, test } from "vitest";

import {
  attachEndedSchema,
  capabilitiesResultSchema,
  capabilityModelSchema,
  domainEventSchema,
  harnessCapabilitySchema,
  machineErrorSchema,
  protocolMessageSchema,
  protocolNotificationSchema,
  type ProtocolParams,
  protocolRequestSchema,
  protocolResponseSchema,
  protocolParamsSchemaFor,
  protocolResultSchemaFor,
} from "../../src/index.ts";

const ok = (schema: v.GenericSchema, input: unknown): void => {
  expect(v.safeParse(schema, input).success).toBe(true);
};

const bad = (schema: v.GenericSchema, input: unknown): void => {
  expect(v.safeParse(schema, input).success).toBe(false);
};

describe("协议 envelope", () => {
  test("request 必须携带 kind/requestId/method/params，未知方法被拒绝", () => {
    ok(protocolRequestSchema, {
      kind: "request",
      requestId: "r1",
      method: "spawn",
      params: { harness: "codex", message: "hi" },
    });
    ok(protocolRequestSchema, {
      kind: "request",
      requestId: "r1",
      method: "capabilities",
      params: {},
    });
    bad(protocolRequestSchema, {
      kind: "request",
      requestId: "r1",
      method: "launch",
      params: {},
    });
    bad(protocolRequestSchema, {
      kind: "request",
      method: "spawn",
      params: {},
    });
    bad(protocolRequestSchema, {
      kind: "request",
      requestId: "r1",
      method: "spawn",
    });
    bad(protocolRequestSchema, {
      kind: "request",
      requestId: "r1",
      method: "spawn",
      params: {},
      extra: true,
    });
  });

  test("response 要么带 result 要么带 error，不能兼有或都没有", () => {
    ok(protocolResponseSchema, {
      kind: "response",
      requestId: "r1",
      result: { sessionId: "s1" },
    });
    ok(protocolResponseSchema, {
      kind: "response",
      requestId: "r1",
      error: { code: "session_not_found" },
    });
    bad(protocolResponseSchema, {
      kind: "response",
      requestId: "r1",
      result: { sessionId: "s1" },
      error: { code: "session_not_found" },
    });
    bad(protocolResponseSchema, {
      kind: "response",
      requestId: "r1",
    });
    bad(protocolResponseSchema, {
      kind: "response",
      requestId: "r1",
      error: { code: "unknown_code" },
    });
  });

  test("notification 只有 event 与 attach.ended 两种方法，params 严格匹配", () => {
    ok(protocolNotificationSchema, {
      kind: "notification",
      method: "event",
      params: { type: "turn.started", sessionId: "s1", turnId: "s1:t1" },
    });
    ok(protocolNotificationSchema, {
      kind: "notification",
      method: "attach.ended",
      params: { sessionId: "s1", reason: "end_turn" },
    });
    bad(protocolNotificationSchema, {
      kind: "notification",
      method: "mystery",
      params: {},
    });
    bad(protocolNotificationSchema, {
      kind: "notification",
      method: "event",
      params: { type: "unknown.event", sessionId: "s1" },
    });
  });

  test("envelope 整体按 kind 判别，消息类型可复用为完整协议消息", () => {
    ok(protocolMessageSchema, {
      kind: "request",
      requestId: "r1",
      method: "list",
      params: {},
    });
    ok(protocolMessageSchema, {
      kind: "response",
      requestId: "r1",
      result: [],
    });
    ok(protocolMessageSchema, {
      kind: "notification",
      method: "attach.ended",
      params: { sessionId: "s1", reason: "cancelled" },
    });
    bad(protocolMessageSchema, { kind: "request" });
  });
});

describe("per-method 参数与结果 schema", () => {
  test("每个方法都有对应的参数 schema 且按契约拒绝非法输入", () => {
    ok(protocolParamsSchemaFor("initialize"), {});
    ok(protocolParamsSchemaFor("spawn"), {
      harness: "qoder",
      message: "hello",
    });
    bad(protocolParamsSchemaFor("spawn"), { harness: "qoder" });
    ok(protocolParamsSchemaFor("send"), { sessionId: "s1", message: "x" });
    bad(protocolParamsSchemaFor("send"), { sessionId: "s1" });
    ok(protocolParamsSchemaFor("wait"), { ids: ["s1"], timeoutMs: 100 });
    ok(protocolParamsSchemaFor("interrupt"), { ids: ["s1"] });
    const legacyInterruptParams: ProtocolParams<"interrupt"> = {
      ids: ["s1"],
      // @ts-expect-error interrupt 的硬迁移必须在编译期拒绝旧 message。
      message: "legacy explanation",
    };
    bad(protocolParamsSchemaFor("interrupt"), legacyInterruptParams);
    ok(protocolParamsSchemaFor("kill"), { ids: ["s1"] });
    ok(protocolParamsSchemaFor("list"), { state: "busy" });
    bad(protocolParamsSchemaFor("list"), { state: "nope" });
    ok(protocolParamsSchemaFor("attach"), {
      sessionId: "s1",
      exitOn: ["end_turn"],
    });
    ok(protocolParamsSchemaFor("resolvePermission"), {
      sessionId: "s1",
      permissionId: "p1",
      resolution: { outcome: "allow", scope: "once" },
    });
    ok(protocolParamsSchemaFor("capabilities"), {});
  });

  test("每个方法都有对应的结果 schema 且按契约拒绝非法结果", () => {
    ok(protocolResultSchemaFor("spawn"), { sessionId: "s1" });
    bad(protocolResultSchemaFor("spawn"), {});
    ok(protocolResultSchemaFor("send"), {
      messageId: "m1",
      deliveryPoint: "new_turn",
    });
    ok(protocolResultSchemaFor("wait"), {
      status: "timeout",
      results: [],
    });
    ok(protocolResultSchemaFor("interrupt"), [
      { sessionId: "s1", status: "requested", turnId: "s1:t1" },
    ]);
    ok(protocolResultSchemaFor("kill"), [
      { sessionId: "s1", status: "killed" },
    ]);
    ok(protocolResultSchemaFor("list"), [
      {
        sessionId: "s1",
        harness: "codex",
        state: "idle",
        model: null,
        reasoning: null,
        cwd: "/tmp",
        label: null,
        spawnedAt: "2026-01-01T00:00:00.000Z",
        turns: 1,
        lastStopReason: "end_turn",
      },
    ]);
    ok(protocolResultSchemaFor("attach"), { sessionId: "s1", replayed: 0 });
    ok(protocolResultSchemaFor("capabilities"), {
      capabilities: [],
      failures: [],
    });
  });
});

describe("capabilities 矩阵", () => {
  const model = {
    id: "gpt-5.3-codex-spark",
    displayName: "GPT-5.3 Codex Spark",
    reasoningEfforts: ["low", "high"],
  };

  test("模型条目携带 id/displayName/推理强度列表", () => {
    ok(capabilityModelSchema, model);
    bad(capabilityModelSchema, { displayName: "x", reasoningEfforts: [] });
    bad(capabilityModelSchema, { id: "x", displayName: "x" });
    bad(capabilityModelSchema, { ...model, reasoningEfforts: "high" });
  });

  test("默认模型 / 默认推理强度不进矩阵（最小干扰原则）", () => {
    bad(capabilityModelSchema, { ...model, isDefault: true });
    bad(capabilityModelSchema, {
      ...model,
      defaultReasoningEffort: "high",
    });
  });

  test("harness 条目与整体结果支持失败面，单点失败不拖垮整体", () => {
    ok(harnessCapabilitySchema, { harness: "codex", models: [model] });
    bad(harnessCapabilitySchema, { models: [model] });
    ok(capabilitiesResultSchema, {
      capabilities: [{ harness: "qoder", models: [] }],
      failures: [
        { harness: "codex", code: "capability_query_failed", message: "x" },
      ],
    });
    bad(capabilitiesResultSchema, {
      capabilities: [],
      failures: [{ harness: "codex", code: "session_not_found" }],
    });
  });
});

describe("错误码扩展", () => {
  test("协议层错误码可被 machineError 携带", () => {
    for (const code of [
      "unknown_harness",
      "method_not_found",
      "protocol_error",
      "capability_query_failed",
      "internal_error",
    ]) {
      ok(machineErrorSchema, { code });
    }
  });
});

describe("attach.ended 载荷", () => {
  test("reason 只能是终态或 session_killed", () => {
    ok(attachEndedSchema, { sessionId: "s1", reason: "end_turn" });
    ok(attachEndedSchema, { sessionId: "s1", reason: "session_killed" });
    bad(attachEndedSchema, { sessionId: "s1", reason: "detached" });
    bad(attachEndedSchema, { reason: "end_turn" });
  });
});

describe("message 事件 role", () => {
  test("role 只能是 caller 或 worker，旧 driver 值被拒绝", () => {
    const base = {
      type: "message",
      sessionId: "s1",
      turnId: "s1:t1",
      messageId: "m1",
      content: "hi",
    } as const;
    ok(domainEventSchema, { ...base, role: "caller" });
    ok(domainEventSchema, { ...base, role: "worker" });
    bad(domainEventSchema, { ...base, role: "driver" });
    bad(domainEventSchema, { ...base, role: "user" });
  });
});
