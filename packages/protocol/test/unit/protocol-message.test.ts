import * as v from "valibot";
import { describe, expect, test } from "vitest";

import {
  attachEndedSchema,
  modelCatalogResultSchema,
  modelCatalogEntrySchema,
  domainEventSchema,
  operationKeyClaimsSchema,
  operationRecordSchemaFor,
  serializeOperationKey,
  consumerContextSchema,
  harnessModelCatalogSchema,
  machineErrorSchema,
  protocolMessageSchema,
  protocolNotificationSchema,
  type ProtocolParams,
  protocolRequestSchema,
  protocolResponseSchema,
  protocolParamsSchemaFor,
  protocolResultSchemaFor,
  runtimeScopeIdSchema,
  sessionIdSchema,
  daemonGenerationSchema,
  turnIdSchema,
  turnCompletedSchema,
  encodeResumeCursor,
} from "../../src/index.ts";

const ok = (schema: v.GenericSchema, input: unknown): void => {
  expect(v.safeParse(schema, input).success).toBe(true);
};

const bad = (schema: v.GenericSchema, input: unknown): void => {
  expect(v.safeParse(schema, input).success).toBe(false);
};

test("failed 与其他终态严格区分，事件和 wait 共用失败事实", () => {
  const base = {
    sessionId: "session:00000000-0000-4000-8000-000000000000:failure:1",
    turnId: "t1",
    finalReply: null,
  };
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

test("部分取消效果只属于 send 操作记录", () => {
  const baseClaims = {
    runtimeScopeId: v.parse(
      runtimeScopeIdSchema,
      "00000000-0000-4000-8000-000000000000",
    ),
    consumer: v.parse(consumerContextSchema, "protocol-test"),
    generation: v.parse(daemonGenerationSchema, "protocoltest"),
    nonce: "00000000-0000-4000-8000-000000000001",
  };
  const operationKey = serializeOperationKey(
    v.parse(operationKeyClaimsSchema, { ...baseClaims, kind: "send" }),
  );
  const record = {
    status: "partial_effect_uncommitted",
    operationKey,
    error: {
      code: "internal_error",
      effect: {
        kind: "execution_phase_cancelled",
        sessionId: v.parse(
          sessionIdSchema,
          "session:00000000-0000-4000-8000-000000000000:protocoltest:1",
        ),
        turnId: v.parse(turnIdSchema, "t1"),
      },
    },
    cause: { kind: "io", message: "record unavailable" },
  };
  ok(operationRecordSchemaFor("send"), record);
  bad(operationRecordSchemaFor("interrupt"), record);
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
      result: {
        sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
      },
    });
    ok(protocolResponseSchema, {
      kind: "response",
      requestId: "r1",
      error: {
        code: "session_not_found",
        sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
      },
    });
    bad(protocolResponseSchema, {
      kind: "response",
      requestId: "r1",
      result: {
        sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
      },
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
        event: {
          type: "turn.started",
          sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
          turnId: "t1",
        },
      },
    });
    ok(protocolNotificationSchema, {
      kind: "notification",
      method: "attach.ended",
      params: {
        subscriptionId: "subscription-1",
        target: {
          scope: "session",
          sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
        },
        lastEventId: null,
        sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
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
      params: {
        type: "unknown.event",
        sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
      },
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
        target: {
          scope: "session",
          sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
        },
        lastEventId: null,
        sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
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
      sessionLabel: "reviewer",
    });
    bad(protocolParamsSchemaFor("spawn"), {
      cwd: "/tmp",
      harness: "dsh",
      message: "hello",
      sessionLabel: "reviewer",
    });
    bad(protocolParamsSchemaFor("spawn"), { harness: "qoder" });
    ok(protocolParamsSchemaFor("send"), {
      placement: "new_turn",
      sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
      message: "x",
    });
    bad(protocolParamsSchemaFor("send"), {
      sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
    });
    ok(protocolParamsSchemaFor("wait"), {
      targets: [
        {
          sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
          turnId: "t1",
        },
      ],
      completion: "all",
      timeoutMs: 100,
    });
    ok(protocolParamsSchemaFor("interrupt"), {
      sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
      turnId: "t1",
    });
    const legacyInterruptParams: ProtocolParams<"interrupt"> = {
      sessionId: v.parse(
        sessionIdSchema,
        "session:00000000-0000-4000-8000-000000000000:reviewer:7",
      ),
      turnId: v.parse(turnIdSchema, "t1"),
      // @ts-expect-error interrupt 的硬迁移必须在编译期拒绝旧 message。
      message: "legacy explanation",
    };
    bad(protocolParamsSchemaFor("interrupt"), legacyInterruptParams);
    ok(protocolParamsSchemaFor("kill"), {
      sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
    });
    ok(protocolParamsSchemaFor("list"), { state: "busy" });
    bad(protocolParamsSchemaFor("list"), { state: "nope" });
    ok(protocolParamsSchemaFor("attach"), {
      sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
      scope: "session",
      start: { mode: "snapshot" },
    });
    const conflictingStart = {
      mode: "snapshot",
      cursor: encodeResumeCursor({
        target: {
          scope: "session",
          sessionId: v.parse(
            sessionIdSchema,
            "session:00000000-0000-4000-8000-000000000000:reviewer:7",
          ),
        },
        runtimeScopeId: v.parse(
          runtimeScopeIdSchema,
          "00000000-0000-4000-8000-000000000000",
        ),
        daemonGeneration: v.parse(daemonGenerationSchema, "test"),
        eventId: 0,
      }),
    };
    bad(protocolParamsSchemaFor("attach"), {
      sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
      scope: "session",
      start: conflictingStart,
    });
    ok(protocolParamsSchemaFor("resolvePermission"), {
      sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
      turnId: "t1",
      permissionId: "p1",
      resolution: { outcome: "allow", scope: "once" },
    });
    ok(protocolParamsSchemaFor("modelCatalog"), {});
  });

  test("每个方法都有对应的结果 schema 且按契约拒绝非法结果", () => {
    ok(protocolResultSchemaFor("spawn"), {
      sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
      turnId: "t1",
      cwd: "/tmp",
    });
    bad(protocolResultSchemaFor("spawn"), {});
    ok(protocolResultSchemaFor("send"), {
      sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
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
      pending: [
        {
          sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
          turnId: "t1",
        },
      ],
    });
    ok(protocolResultSchemaFor("interrupt"), {
      sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
      turnId: "t1",
    });
    ok(protocolResultSchemaFor("kill"), {
      sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
      status: "killed",
    });
    ok(protocolResultSchemaFor("list"), [
      {
        sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
        harness: "codex",
        state: "idle",
        model: null,
        reasoning: null,
        cwd: "/tmp",
        sessionLabel: "reviewer",
        spawnedAt: "2026-01-01T00:00:00.000Z",
        turns: 1,
        lastCompletedTurn: { turnId: "t1", stopReason: "end_turn" },
      },
    ]);
    const snapshot = {
      sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
      harness: "codex",
      model: null,
      reasoning: null,
      cwd: "/tmp",
      sessionLabel: "reviewer",
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
    const sessionId = v.parse(
      sessionIdSchema,
      "session:00000000-0000-4000-8000-000000000000:reviewer:7",
    );
    const target = { scope: "session" as const, sessionId };
    const cursor = encodeResumeCursor({
      target,
      runtimeScopeId: v.parse(
        runtimeScopeIdSchema,
        "00000000-0000-4000-8000-000000000000",
      ),
      daemonGeneration: v.parse(daemonGenerationSchema, "test"),
      eventId: 0,
    });
    ok(protocolResultSchemaFor("attach"), {
      subscriptionId: "subscription-1",
      initial: {
        mode: "history",
        target,
        cursor,
        window: { oldest: null, head: null, truncated: false },
        replayed: 0,
      },
    });
    bad(protocolResultSchemaFor("attach"), {
      subscriptionId: "subscription-1",
      initial: {
        mode: "history",
        target,
        cursor,
        window: { oldest: null, head: null, truncated: false },
        replayed: 0,
        replayPrefixes: [
          {
            turnId: "t1",
            messageId: "m1",
            prefix: "missing",
            sessionId,
          },
        ],
      },
    });
    ok(protocolResultSchemaFor("resolvePermission"), {
      sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
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
      target: {
        scope: "session",
        sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
      },
      lastEventId: null,
      sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
      reason: "end_turn",
    });
    ok(attachEndedSchema, {
      subscriptionId: "subscription-1",
      target: {
        scope: "session",
        sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
      },
      lastEventId: null,
      sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
      reason: "session_killed",
    });
    bad(attachEndedSchema, {
      sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
      reason: "detached",
    });
    bad(attachEndedSchema, { reason: "end_turn" });
  });
});

describe("message 事件 role", () => {
  test("role 只能是 caller 或 worker，旧 driver 值被拒绝", () => {
    const base = {
      type: "message",
      sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
      turnId: "t1",
      messageId: "m1",
      content: "hi",
    } as const;
    ok(domainEventSchema, { ...base, role: "caller" });
    ok(domainEventSchema, { ...base, role: "worker" });
    bad(domainEventSchema, { ...base, role: "driver" });
    bad(domainEventSchema, { ...base, role: "user" });
  });

  test("message 正文接受规范文本与多模态部分并校验文本字节范围", () => {
    const base = {
      type: "message",
      sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
      turnId: "t1",
      messageId: "m1",
      role: "caller",
    } as const;
    ok(domainEventSchema, { ...base, content: "纯文本" });
    ok(domainEventSchema, {
      ...base,
      content: [
        {
          type: "text",
          text: "检查",
          textElements: [
            { byteRange: { start: 0, end: 6 }, placeholder: null },
          ],
        },
        {
          type: "image",
          source: "bytes",
          data: "AAEC",
          mediaType: "image/png",
          detail: "high",
        },
        { type: "audio", source: "url", url: "https://example.test/a.wav" },
        {
          type: "thinking",
          text: "保留的正文部分",
          signature: "原生公开签名",
        },
        { type: "redacted_thinking", data: "opaque-redacted-body" },
      ],
    });
    bad(domainEventSchema, {
      ...base,
      content: [
        {
          type: "text",
          text: "检查",
          textElements: [
            { byteRange: { start: 6, end: 2 }, placeholder: null },
          ],
        },
      ],
    });
    bad(domainEventSchema, {
      ...base,
      content: [{ type: "image", source: "local", path: "/tmp/image.png" }],
    });
  });

  test("领域事件拒绝未知 SDK 字段", () => {
    bad(domainEventSchema, {
      type: "message",
      sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:7",
      turnId: "t1",
      messageId: "m1",
      role: "worker",
      content: "hi",
      sdkEvent: "thread/item/completed",
    });
  });
});
