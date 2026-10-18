import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { openControlStore } from "@reins/event-journal";
import {
  consumerContextSchema,
  daemonGenerationSchema,
  makeErrorCause,
  operationKeyClaimsSchema,
  runtimeScopeIdSchema,
  serializeOperationKey,
  sessionIdSchema,
  type DomainEvent,
  type SendAck,
  type SpawnAck,
  type SpawnParams,
} from "@reins/protocol";
import * as v from "valibot";
import { describe, expect, test } from "vitest";

const runtimeScopeId = v.parse(
  runtimeScopeIdSchema,
  "7aa79020-74c9-4d80-92ca-3c4fe0ebfdbc",
);
const consumer = v.parse(consumerContextSchema, "test-consumer");
const generation = v.parse(daemonGenerationSchema, "g1");
const sessionId = v.parse(
  sessionIdSchema,
  "session:7aa79020-74c9-4d80-92ca-3c4fe0ebfdbc:g1:1",
);
const request: SpawnParams = {
  sessionLabel: "same-label-is-allowed",
  harness: "codex",
  message: "first request",
  cwd: "/tmp",
};

function operationKey(kind: "spawn" | "send" = "spawn") {
  return serializeOperationKey(
    v.parse(operationKeyClaimsSchema, {
      runtimeScopeId,
      consumer,
      kind,
      generation,
      nonce: randomUUID(),
    }),
  );
}

describe("SQLite控制存储", () => {
  test("重开后仍原子读取操作结果、会话归属与创建事件", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-control-store-"));
    let store = await openControlStore({ directory });
    const key = operationKey();
    const identity = {
      operationKey: key,
      runtimeScopeId,
      consumer,
      generation,
      request,
    };
    const registration = store.registerSpawn(identity);
    expect(registration).toMatchObject({
      created: true,
      operation: { status: "pending", request },
    });

    const result: SpawnAck = { sessionId, turnId: "t1" as never, cwd: "/tmp" };
    const session = {
      info: {
        sessionId,
        sessionLabel: request.sessionLabel,
        harness: request.harness,
        model: null,
        reasoning: null,
        cwd: request.cwd,
        spawnedAt: "2026-10-18T00:00:00.000Z",
        turns: 0,
        state: "busy" as const,
        activeTurnId: result.turnId,
      },
      runtimeScopeId,
      consumer,
      generation,
    };
    const events: DomainEvent[] = [
      {
        type: "session.created",
        sessionId,
        sessionLabel: request.sessionLabel,
        harness: request.harness,
        model: null,
        reasoning: null,
        cwd: request.cwd,
        spawnedAt: session.info.spawnedAt,
      },
      { type: "turn.started", sessionId, turnId: result.turnId },
    ];
    store.markSpawnDispatched(key);
    expect(
      store.commitSpawn({ operationKey: key, result, session, events }),
    ).toEqual(events.map((event, index) => ({ event, eventId: index + 1 })));
    store.close();

    store = await openControlStore({ directory });
    expect(store.getOperation(key)).toMatchObject({
      status: "succeeded",
      request,
      result,
    });
    expect(store.getSession(sessionId)).toEqual(session);
    expect(store.sessionEvents(sessionId)).toHaveLength(2);
    expect(store.eventWindow(sessionId)).toEqual({ head: 2, oldest: 1 });
    expect(store.registerSpawn(identity)).toMatchObject({
      created: false,
      operation: { status: "succeeded", result },
    });
    store.close();

    const database = new DatabaseSync(join(directory, "control.sqlite"));
    database
      .prepare("UPDATE sessions SET runtime_scope_id = ? WHERE session_id = ?")
      .run("00000000-0000-4000-8000-000000000001", sessionId);
    database.close();
    const corrupted = await openControlStore({ directory });
    expect(() => corrupted.getSession(sessionId)).toThrow(
      "Stored session ownership does not match its identity",
    );
    corrupted.close();
    await rm(directory, { recursive: true, force: true });
  });

  test("新回合的已接受结果、会话投影和事实批次原子重开", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-control-store-"));
    let store = await openControlStore({ directory });
    const spawnKey = operationKey();
    const spawnResult: SpawnAck = {
      sessionId,
      turnId: "t1" as never,
      cwd: "/tmp",
    };
    const spawnSession = {
      info: {
        sessionId,
        sessionLabel: request.sessionLabel,
        harness: request.harness,
        model: null,
        reasoning: null,
        cwd: request.cwd,
        spawnedAt: "2026-10-18T00:00:00.000Z",
        turns: 0,
        state: "busy" as const,
        activeTurnId: spawnResult.turnId,
      },
      runtimeScopeId,
      consumer,
      generation,
    };
    const spawnEvents: DomainEvent[] = [
      {
        type: "session.created",
        sessionId,
        sessionLabel: request.sessionLabel,
        harness: request.harness,
        model: null,
        reasoning: null,
        cwd: request.cwd,
        spawnedAt: spawnSession.info.spawnedAt,
      },
      { type: "turn.started", sessionId, turnId: spawnResult.turnId },
    ];
    store.registerSpawn({
      operationKey: spawnKey,
      runtimeScopeId,
      consumer,
      generation,
      request,
    });
    store.markSpawnDispatched(spawnKey);
    store.commitSpawn({
      operationKey: spawnKey,
      result: spawnResult,
      session: spawnSession,
      events: spawnEvents,
    });

    const { activeTurnId: _activeTurnId, ...completedFields } =
      spawnSession.info;
    const firstCompleted = {
      ...completedFields,
      state: "idle" as const,
      turns: 1,
      lastCompletedTurn: {
        turnId: spawnResult.turnId,
        stopReason: "end_turn" as const,
      },
    };
    store.recordEvent(
      {
        type: "turn.completed",
        sessionId,
        turnId: spawnResult.turnId,
        stopReason: "end_turn",
        finalReply: null,
      },
      firstCompleted,
    );

    const sendKey = operationKey("send");
    const sendRequest = {
      placement: "new_turn" as const,
      sessionId,
      ifLastCompletedTurn: { sessionId, turnId: spawnResult.turnId },
      message: "second caller fact",
    };
    store.registerSend({
      operationKey: sendKey,
      runtimeScopeId,
      consumer,
      generation,
      request: sendRequest,
    });
    store.markSendDispatched(sendKey);
    const sendResult: SendAck = {
      sessionId,
      turnId: "t2" as never,
      messageId: "m2" as never,
      deliveryPoint: "new_turn",
    };
    const sendEvents: DomainEvent[] = [
      { type: "turn.started", sessionId, turnId: sendResult.turnId },
      {
        type: "message",
        sessionId,
        turnId: sendResult.turnId,
        messageId: sendResult.messageId,
        role: "caller",
        content: sendRequest.message,
      },
      {
        type: "turn.completed",
        sessionId,
        turnId: sendResult.turnId,
        stopReason: "end_turn",
        finalReply: "done",
      },
    ];
    const sendSession = {
      ...spawnSession,
      info: {
        ...firstCompleted,
        turns: 2,
        lastCompletedTurn: {
          turnId: sendResult.turnId,
          stopReason: "end_turn" as const,
        },
      },
    };
    expect(
      store.commitSend({
        operationKey: sendKey,
        result: sendResult,
        session: sendSession,
        events: sendEvents,
      }),
    ).toEqual(
      sendEvents.map((event, index) => ({ event, eventId: index + 4 })),
    );
    store.close();

    store = await openControlStore({ directory });
    expect(store.getOperation(sendKey)).toMatchObject({
      kind: "send",
      status: "succeeded",
      request: sendRequest,
      result: sendResult,
    });
    expect(store.getSession(sessionId)).toEqual(sendSession);
    expect(store.sessionEvents(sessionId).slice(-3)).toEqual(
      sendEvents.map((event, index) => ({ event, eventId: index + 4 })),
    );
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  test("同一键绑定不同请求时拒绝登记", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-control-store-"));
    const store = await openControlStore({ directory });
    const identity = {
      operationKey: operationKey(),
      runtimeScopeId,
      consumer,
      generation,
      request,
    };
    store.registerSpawn(identity);

    expect(() =>
      store.registerSpawn({
        ...identity,
        request: { ...request, sessionLabel: "changed-label" },
      }),
    ).toThrow(expect.objectContaining({ code: "operation_key_conflict" }));

    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  test("重开后保留接受结果未知的主因和停止次因", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-control-store-"));
    const store = await openControlStore({ directory });
    const key = operationKey();
    store.registerSpawn({
      operationKey: key,
      runtimeScopeId,
      consumer,
      generation,
      request,
    });
    store.markSpawnDispatched(key);
    const error = {
      code: "operation_outcome_unknown" as const,
      operationKey: key,
      cause: makeErrorCause("io", "queue receipt was lost"),
      cleanupCause: makeErrorCause("closed", "close confirmation failed"),
    };
    store.recordSpawnOutcomeUnknown(key, error);
    store.close();

    const reopened = await openControlStore({ directory });
    expect(reopened.getOperation(key)).toMatchObject({
      status: "outcome_unknown",
      error,
    });
    expect(
      reopened.registerSpawn({
        operationKey: key,
        runtimeScopeId,
        consumer,
        generation,
        request,
      }),
    ).toMatchObject({
      created: false,
      operation: { status: "outcome_unknown", error },
    });
    reopened.close();
    await rm(directory, { recursive: true, force: true });
  });

  test("读取时拒绝OperationKey归属或状态损坏", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-control-store-"));
    const store = await openControlStore({ directory });
    const key = operationKey();
    store.registerSpawn({
      operationKey: key,
      runtimeScopeId,
      consumer,
      generation,
      request,
    });
    store.close();

    const database = new DatabaseSync(join(directory, "control.sqlite"));
    database
      .prepare(
        "UPDATE operations SET runtime_scope_id = ? WHERE operation_key = ?",
      )
      .run("00000000-0000-4000-8000-000000000000", key);
    database.close();

    const reopened = await openControlStore({ directory });
    expect(() => reopened.getOperation(key)).toThrow(
      "Stored operation ownership does not match its key",
    );
    reopened.close();

    const repairedDatabase = new DatabaseSync(
      join(directory, "control.sqlite"),
    );
    repairedDatabase.exec("PRAGMA ignore_check_constraints = ON");
    repairedDatabase
      .prepare(
        "UPDATE operations SET runtime_scope_id = ?, status = ? WHERE operation_key = ?",
      )
      .run(runtimeScopeId, "unknown-status", key);
    repairedDatabase.close();
    const statusCorrupted = await openControlStore({ directory });
    expect(() => statusCorrupted.getOperation(key)).toThrow();
    statusCorrupted.close();
    await rm(directory, { recursive: true, force: true });
  });
});
