import * as v from "valibot";
import { describe, expect, test } from "vitest";

import {
  attachEndedSchema,
  modelCatalogResultSchema,
  modelCatalogEntrySchema,
  domainEventSchema,
  harnessModelCatalogSchema,
  machineErrorSchema,
  protocolMessageSchema,
  protocolNotificationSchema,
  type ProtocolParams,
  protocolRequestSchema,
  protocolResponseSchema,
  protocolParamsSchemaFor,
  protocolResultSchemaFor,
  sessionIdSchema,
  turnIdSchema,
  turnCompletedSchema,
} from "../../src/index.ts";

const ok = (schema: v.GenericSchema, input: unknown): void => {
  expect(v.safeParse(schema, input).success).toBe(true);
};

const bad = (schema: v.GenericSchema, input: unknown): void => {
  expect(v.safeParse(schema, input).success).toBe(false);
};

test("failed 与其他终态严格区分，事件和 wait 共用失败事实", () => {
  const base = { sessionId: "failure@g1", turnId: "t1", finalReply: null };
  const failure = {
    failureCategory: "quota_exhausted",
    retryDisposition: "external_state_change",
  };
  for (const schema of [turnCompletedSchema, protocolResultSchemaFor("wait")]) {
    const value = (terminal: unknown) =>
      schema === turnCompletedSchema
        ? terminal
        : { status: "satisfied", completed: [terminal], pending: [] };
    ok(schema, value({ ...base, stopReason: "failed", failure }));
    bad(schema, value({ ...base, stopReason: "failed" }));
    bad(
      schema,
      value({
        ...base,
        stopReason: "failed",
        failure: { failureCategory: "quota_exhausted" },
      }),
    );
    for (const stopReason of ["end_turn", "cancelled", "killed"]) {
      ok(schema, value({ ...base, stopReason }));
      bad(schema, value({ ...base, stopReason, failure }));
    }
  }
  ok(domainEventSchema, {
    type: "turn.completed",
    ...base,
    stopReason: "failed",
    failure,
  });
  bad(domainEventSchema, {
    type: "turn.completed",
    ...base,
    stopReason: "end_turn",
    failure,
  });
});

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
      method: "modelCatalog",
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
      result: { sessionId: "reviewer@g7" },
    });
    ok(protocolResponseSchema, {
      kind: "response",
      requestId: "r1",
      error: { code: "session_not_found", sessionId: "reviewer@g7" },
    });
    bad(protocolResponseSchema, {
      kind: "response",
      requestId: "r1",
      result: { sessionId: "reviewer@g7" },
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
      params: {
        subscriptionId: "subscription-1",
        eventId: 1,
        event: { type: "turn.started", sessionId: "reviewer@g7", turnId: "t1" },
      },
    });
    ok(protocolNotificationSchema, {
      kind: "notification",
      method: "attach.ended",
      params: {
        subscriptionId: "subscription-1",
        target: { scope: "session", sessionId: "reviewer@g7" },
        lastEventId: null,
        sessionId: "reviewer@g7",
        reason: "end_turn",
      },
    });
    bad(protocolNotificationSchema, {
      kind: "notification",
      method: "mystery",
      params: {},
    });
    bad(protocolNotificationSchema, {
      kind: "notification",
      method: "event",
      params: { type: "unknown.event", sessionId: "reviewer@g7" },
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
      params: {
        subscriptionId: "subscription-1",
        target: { scope: "session", sessionId: "reviewer@g7" },
        lastEventId: null,
        sessionId: "reviewer@g7",
        reason: "cancelled",
      },
    });
    bad(protocolMessageSchema, { kind: "request" });
  });
});

describe("per-method 参数与结果 schema", () => {
  test("每个方法都有对应的参数 schema 且按契约拒绝非法输入", () => {
    ok(protocolParamsSchemaFor("initialize"), {
      protocolMajorVersion: 1,
      consumerContext: "alpha",
    });
    ok(protocolParamsSchemaFor("initialize"), {
      protocolMajorVersion: 1,
      consumerContext: "alpha",
      runtimeScopeId: "00000000-0000-4000-8000-000000000000",
    });
    bad(protocolParamsSchemaFor("initialize"), {});
    bad(protocolParamsSchemaFor("initialize"), { protocolMajorVersion: 1 });
    bad(protocolParamsSchemaFor("initialize"), { consumerContext: "alpha" });
    ok(protocolResultSchemaFor("initialize"), {
      protocolMajorVersion: 1,
      daemonGeneration: "ab12cd",
      runtimeScopeId: "00000000-0000-4000-8000-000000000000",
    });
    bad(protocolResultSchemaFor("initialize"), {});
    bad(protocolResultSchemaFor("initialize"), { protocolMajorVersion: 1 });
    ok(protocolParamsSchemaFor("spawn"), {
      cwd: "/tmp",
      harness: "qoder",
      message: "hello",
      sessionName: "reviewer",
    });
    bad(protocolParamsSchemaFor("spawn"), {
      cwd: "/tmp",
      harness: "dsh",
      message: "hello",
      sessionName: "reviewer",
    });
    bad(protocolParamsSchemaFor("spawn"), { harness: "qoder" });
    ok(protocolParamsSchemaFor("send"), {
      placement: "new_turn",
      sessionId: "reviewer@g7",
      message: "x",
    });
    bad(protocolParamsSchemaFor("send"), { sessionId: "reviewer@g7" });
    ok(protocolParamsSchemaFor("wait"), {
      targets: [{ sessionId: "reviewer@g7", turnId: "t1" }],
      completion: "all",
      timeoutMs: 100,
    });
    ok(protocolParamsSchemaFor("interrupt"), {
      sessionId: "reviewer@g7",
      turnId: "t1",
    });
    const legacyInterruptParams: ProtocolParams<"interrupt"> = {
      sessionId: v.parse(sessionIdSchema, "reviewer@g7"),
      turnId: v.parse(turnIdSchema, "t1"),
      // @ts-expect-error interrupt 的硬迁移必须在编译期拒绝旧 message。
      message: "legacy explanation",
    };
    bad(protocolParamsSchemaFor("interrupt"), legacyInterruptParams);
    ok(protocolParamsSchemaFor("kill"), { sessionId: "reviewer@g7" });
    ok(protocolParamsSchemaFor("list"), { state: "busy" });
    bad(protocolParamsSchemaFor("list"), { state: "nope" });
    ok(protocolParamsSchemaFor("attach"), {
      sessionId: "reviewer@g7",
      scope: "session",
      replay: { mode: "none" },
    });
    ok(protocolParamsSchemaFor("resolvePermission"), {
      sessionId: "reviewer@g7",
      turnId: "t1",
      permissionId: "p1",
      resolution: { outcome: "allow", scope: "once" },
    });
    ok(protocolParamsSchemaFor("modelCatalog"), {});
  });

  test("每个方法都有对应的结果 schema 且按契约拒绝非法结果", () => {
    ok(protocolResultSchemaFor("spawn"), {
      sessionId: "reviewer@g7",
      turnId: "t1",
      cwd: "/tmp",
    });
    bad(protocolResultSchemaFor("spawn"), {});
    ok(protocolResultSchemaFor("send"), {
      sessionId: "reviewer@g7",
      turnId: "t1",
      messageId: "m1",
      deliveryPoint: "new_turn",
    });
    bad(protocolResultSchemaFor("send"), {
      messageId: "m1",
      deliveryPoint: "new_turn",
    });
    ok(protocolResultSchemaFor("wait"), {
      status: "timeout",
      completed: [],
      pending: [{ sessionId: "reviewer@g7", turnId: "t1" }],
    });
    ok(protocolResultSchemaFor("interrupt"), {
      sessionId: "reviewer@g7",
      turnId: "t1",
    });
    ok(protocolResultSchemaFor("kill"), {
      sessionId: "reviewer@g7",
      status: "killed",
    });
    ok(protocolResultSchemaFor("list"), [
      {
        sessionId: "reviewer@g7",
        harness: "codex",
        state: "idle",
        model: null,
        reasoning: null,
        cwd: "/tmp",
        sessionName: "reviewer",
        spawnedAt: "2026-01-01T00:00:00.000Z",
        turns: 1,
        lastCompletedTurn: { turnId: "t1", stopReason: "end_turn" },
      },
    ]);
    const snapshot = {
      sessionId: "reviewer@g7",
      harness: "codex",
      model: null,
      reasoning: null,
      cwd: "/tmp",
      sessionName: "reviewer",
      spawnedAt: "2026-01-01T00:00:00.000Z",
      turns: 1,
    };
    ok(protocolResultSchemaFor("list"), [
      { ...snapshot, state: "busy", activeTurnId: "t1" },
    ]);
    bad(protocolResultSchemaFor("list"), [{ ...snapshot, state: "busy" }]);
    bad(protocolResultSchemaFor("list"), [{ ...snapshot, state: "idle" }]);
    bad(protocolResultSchemaFor("list"), [
      {
        ...snapshot,
        state: "idle",
        activeTurnId: "t1",
        lastCompletedTurn: { turnId: "t1", stopReason: "end_turn" },
      },
    ]);
    bad(protocolResultSchemaFor("list"), [
      { ...snapshot, state: "killed", activeTurnId: "t1" },
    ]);
    ok(protocolResultSchemaFor("attach"), {
      sessionId: "reviewer@g7",
      subscriptionId: "subscription-1",
      target: { scope: "session", sessionId: "reviewer@g7" },
      window: { oldest: null, head: null, truncated: false },
      replayed: 0,
    });
    bad(protocolResultSchemaFor("attach"), {
      sessionId: "reviewer@g7",
      subscriptionId: "subscription-1",
      target: { scope: "session", sessionId: "reviewer@g7" },
      window: { oldest: null, head: null, truncated: false },
      replayed: 0,
      replayPrefixes: [
        {
          turnId: "t1",
          messageId: "m1",
          prefix: "missing",
          sessionId: "reviewer@g7",
        },
      ],
    });
    ok(protocolResultSchemaFor("resolvePermission"), {
      sessionId: "reviewer@g7",
      turnId: "t1",
      permissionId: "p1",
    });
    bad(protocolResultSchemaFor("resolvePermission"), {});
    ok(protocolResultSchemaFor("modelCatalog"), {
      catalogs: [],
      failures: [],
    });
  });
});

describe("模型目录矩阵", () => {
  const model = {
    id: "gpt-5.3-codex-spark",
    displayName: "GPT-5.3 Codex Spark",
    reasoningEfforts: ["low", "high"],
  };

  test("模型条目携带 id/displayName/推理强度列表", () => {
    ok(modelCatalogEntrySchema, model);
    bad(modelCatalogEntrySchema, { displayName: "x", reasoningEfforts: [] });
    bad(modelCatalogEntrySchema, { id: "x", displayName: "x" });
    bad(modelCatalogEntrySchema, { ...model, reasoningEfforts: "high" });
  });

  test("默认模型 / 默认推理强度不进矩阵（最小干扰原则）", () => {
    bad(modelCatalogEntrySchema, { ...model, isDefault: true });
    bad(modelCatalogEntrySchema, {
      ...model,
      defaultReasoningEffort: "high",
    });
  });

  test("harness 条目与整体结果支持失败面，单点失败不拖垮整体", () => {
    ok(harnessModelCatalogSchema, { harness: "codex", models: [model] });
    bad(harnessModelCatalogSchema, { models: [model] });
    ok(modelCatalogResultSchema, {
      catalogs: [{ harness: "qoder", models: [] }],
      failures: [
        {
          harness: "codex",
          code: "model_catalog_query_failed",
          failure: {
            failureCategory: "unclassified",
            retryDisposition: "unknown",
          },
        },
      ],
    });
    bad(modelCatalogResultSchema, {
      catalogs: [],
      failures: [{ harness: "codex", code: "session_not_found" }],
    });
  });
});

describe("错误码扩展", () => {
  test("协议层错误码可被 machineError 携带", () => {
    ok(machineErrorSchema, {
      code: "unknown_harness",
      harness: "codex",
      availableHarnesses: [],
    });
    ok(machineErrorSchema, { code: "method_not_found", method: "x" });
    ok(machineErrorSchema, { code: "protocol_error" });
    ok(machineErrorSchema, {
      code: "protocol_version_mismatch",
      requestedProtocolMajorVersion: 2,
      supportedProtocolMajorVersion: 1,
    });
    bad(machineErrorSchema, { code: "protocol_version_mismatch" });
    ok(machineErrorSchema, { code: "consumer_context_required" });
    bad(machineErrorSchema, {
      code: "consumer_context_required",
      consumerContext: "alpha",
    });
    ok(machineErrorSchema, { code: "model_catalog_query_failed" });
    ok(machineErrorSchema, { code: "internal_error" });
  });
});

describe("attach.ended 载荷", () => {
  test("reason 只能是终态或 session_killed", () => {
    ok(attachEndedSchema, {
      subscriptionId: "subscription-1",
      target: { scope: "session", sessionId: "reviewer@g7" },
      lastEventId: null,
      sessionId: "reviewer@g7",
      reason: "end_turn",
    });
    ok(attachEndedSchema, {
      subscriptionId: "subscription-1",
      target: { scope: "session", sessionId: "reviewer@g7" },
      lastEventId: null,
      sessionId: "reviewer@g7",
      reason: "session_killed",
    });
    bad(attachEndedSchema, { sessionId: "reviewer@g7", reason: "detached" });
    bad(attachEndedSchema, { reason: "end_turn" });
  });
});

describe("message 事件 role", () => {
  test("role 只能是 caller 或 worker，旧 driver 值被拒绝", () => {
    const base = {
      type: "message",
      sessionId: "reviewer@g7",
      turnId: "t1",
      messageId: "m1",
      content: "hi",
    } as const;
    ok(domainEventSchema, { ...base, role: "caller" });
    ok(domainEventSchema, { ...base, role: "worker" });
    bad(domainEventSchema, { ...base, role: "driver" });
    bad(domainEventSchema, { ...base, role: "user" });
  });

  test("领域事件拒绝未知 SDK 字段", () => {
    bad(domainEventSchema, {
      type: "message",
      sessionId: "reviewer@g7",
      turnId: "t1",
      messageId: "m1",
      role: "worker",
      content: "hi",
      sdkEvent: "thread/item/completed",
    });
  });
});
