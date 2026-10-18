import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { openControlStore } from "@reins/event-journal";
import {
  consumerContextSchema,
  daemonGenerationSchema,
  killParamsSchema,
  makeErrorCause,
  operationKeyClaimsSchema,
  runtimeScopeIdSchema,
  serializeOperationKey,
  sessionIdSchema,
  type DomainEvent,
  type KillResult,
  type InterruptAck,
  type ResolvePermissionAck,
  type ResolvePermissionParams,
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

function operationKey(
  kind: "spawn" | "send" | "interrupt" | "resolvePermission" | "kill" = "spawn",
) {
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
  test("授权决议将请求、结果与事实原子持久化并阻止新键重复决议", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-control-store-"));
    let store = await openControlStore({ directory });
    const spawnKey = operationKey();
    const turnId = "permission-turn" as never;
    const spawnResult: SpawnAck = { sessionId, turnId, cwd: "/tmp" };
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
        activeTurnId: turnId,
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
        spawnedAt: session.info.spawnedAt,
      },
      { type: "turn.started", sessionId, turnId },
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
      session,
      events: spawnEvents,
    });
    const requested: DomainEvent = {
      type: "permission.requested",
      sessionId,
      turnId,
      permissionId: "permission-1" as never,
      kind: "tool:Bash",
      options: [{ outcome: "allow", scope: "once" }],
    };
    store.recordEvent(requested);
    const resolveRequest: ResolvePermissionParams = {
      sessionId,
      turnId,
      permissionId: "permission-1" as never,
      resolution: { outcome: "allow", scope: "once" },
    };
    const resolveKey = operationKey("resolvePermission");
    const registrationInput = {
      operationKey: resolveKey,
      runtimeScopeId,
      consumer,
      generation,
      request: resolveRequest,
    };
    expect(store.registerResolvePermission(registrationInput)).toMatchObject({
      created: true,
      operation: { kind: "resolvePermission", status: "pending" },
    });
    expect(
      store.registerResolvePermission({
        ...registrationInput,
        operationKey: operationKey("resolvePermission"),
      }),
    ).toMatchObject({
      created: true,
      operation: {
        status: "failed",
        error: { code: "operation_pending", operationKey: resolveKey },
      },
    });
    store.markResolvePermissionDispatched(resolveKey);
    const result: ResolvePermissionAck = {
      sessionId,
      turnId,
      permissionId: resolveRequest.permissionId,
    };
    const resolved: DomainEvent = {
      type: "permission.resolved",
      ...resolveRequest,
    };
    expect(
      store.commitResolvePermission({
        operationKey: resolveKey,
        result,
        event: resolved,
      }),
    ).toEqual({ event: resolved, eventId: 4 });
    expect(store.registerResolvePermission(registrationInput)).toMatchObject({
      created: false,
      operation: { status: "succeeded", request: resolveRequest, result },
    });
    expect(() =>
      store.registerResolvePermission({
        ...registrationInput,
        request: {
          ...resolveRequest,
          resolution: { outcome: "deny", feedback: "different decision" },
        },
      }),
    ).toThrow(expect.objectContaining({ code: "operation_key_conflict" }));
    expect(
      store.registerResolvePermission({
        ...registrationInput,
        operationKey: operationKey("resolvePermission"),
      }),
    ).toMatchObject({
      created: true,
      operation: {
        status: "failed",
        error: { code: "permission_not_pending" },
      },
    });
    store.close();

    store = await openControlStore({ directory });
    expect(store.getOperation(resolveKey)).toMatchObject({
      kind: "resolvePermission",
      status: "succeeded",
      request: resolveRequest,
      result,
    });
    expect(store.sessionEvents(sessionId).at(-1)).toEqual({
      event: resolved,
      eventId: 4,
    });
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

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
      {
        type: "message",
        sessionId,
        turnId: result.turnId,
        messageId: "caller-1" as never,
        role: "caller",
        content: "完整首条输入",
      },
      {
        type: "tool.requested",
        sessionId,
        turnId: result.turnId,
        toolCallId: "tool-1" as never,
        name: "read-file",
        input: { path: "report.json", options: { raw: true } },
      },
      {
        type: "tool.completed",
        sessionId,
        turnId: result.turnId,
        toolCallId: "tool-1" as never,
        name: "read-file",
        result: { content: "完整工具输出", metadata: { bytes: 18 } },
        isError: false,
      },
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
    expect(store.sessionEvents(sessionId)).toHaveLength(5);
    expect(store.eventWindow(sessionId)).toEqual({ head: 5, oldest: 1 });
    const firstPage = store.sessionEventsPage({
      sessionId,
      afterEventId: 0,
      limit: 2,
      turnId: result.turnId,
    });
    expect(firstPage).toEqual({
      entries: events.slice(1, 3).map((event, index) => ({
        event,
        eventId: index + 2,
      })),
      nextAfter: 3,
      throughEventId: 5,
      head: 5,
      oldest: 1,
      total: 4,
      hasMore: true,
    });
    const secondPage = store.sessionEventsPage({
      sessionId,
      afterEventId: firstPage.nextAfter,
      throughEventId: firstPage.throughEventId,
      limit: 2,
      turnId: result.turnId,
    });
    expect(secondPage).toEqual({
      entries: events.slice(3).map((event, index) => ({
        event,
        eventId: index + 4,
      })),
      nextAfter: 5,
      throughEventId: 5,
      head: 5,
      oldest: 1,
      total: 2,
      hasMore: false,
    });
    expect(secondPage.entries[1]?.event).toMatchObject({
      type: "tool.completed",
      result: { content: "完整工具输出", metadata: { bytes: 18 } },
    });
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

    const missingEventDatabase = new DatabaseSync(
      join(directory, "control.sqlite"),
    );
    missingEventDatabase
      .prepare(
        "DELETE FROM session_events WHERE session_id = ? AND event_id = ?",
      )
      .run(sessionId, 3);
    missingEventDatabase.close();
    const missingHistory = await openControlStore({ directory });
    expect(() => missingHistory.eventWindow(sessionId)).toThrow(
      "Session event history is incomplete",
    );
    expect(() =>
      missingHistory.sessionEventsPage({
        sessionId,
        afterEventId: 0,
        limit: 1,
      }),
    ).toThrow("Session event history is incomplete");
    missingHistory.close();
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
        content: [
          { type: "text", text: sendRequest.message, textElements: [] },
          {
            type: "image",
            source: "url",
            url: "https://example.invalid/accepted.png",
            detail: "high",
          },
        ],
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
    const caller = sendEvents[1];
    const terminal = sendEvents[2];
    if (caller?.type !== "message" || terminal?.type !== "turn.completed")
      throw new Error("Expected the accepted caller and turn completion");
    expect(() =>
      store.commitSend({
        operationKey: sendKey,
        result: sendResult,
        session: sendSession,
        events: [
          sendEvents[0]!,
          { ...caller, messageId: "wrong-message" as never },
          terminal,
        ],
      }),
    ).toThrow("Send events do not match the accepted new turn");
    expect(() =>
      store.commitSend({
        operationKey: sendKey,
        result: sendResult,
        session: sendSession,
        events: [sendEvents[0]!, caller, caller, terminal],
      }),
    ).toThrow("Send events do not match the accepted new turn");
    expect(() =>
      store.commitSend({
        operationKey: sendKey,
        result: sendResult,
        session: sendSession,
        events: [
          sendEvents[0]!,
          caller,
          { ...terminal, turnId: "other-turn" as never },
        ],
      }),
    ).toThrow("Send events do not match the accepted new turn");
    expect(() =>
      store.commitSend({
        operationKey: sendKey,
        result: sendResult,
        session: sendSession,
        events: [
          sendEvents[0]!,
          { ...caller, content: "different caller" },
          terminal,
        ],
      }),
    ).toThrow("Send events do not match the accepted new turn");
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

  test("kill 结果、会话终态和关闭事实作为同一操作重开", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-control-store-"));
    let store = await openControlStore({ directory });
    const spawnKey = operationKey();
    const spawnResult: SpawnAck = {
      sessionId,
      turnId: "t1" as never,
      cwd: "/tmp",
    };
    const activeSession = {
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
      session: activeSession,
      events: [
        {
          type: "session.created",
          sessionId,
          sessionLabel: request.sessionLabel,
          harness: request.harness,
          model: null,
          reasoning: null,
          cwd: request.cwd,
          spawnedAt: activeSession.info.spawnedAt,
        },
        { type: "turn.started", sessionId, turnId: spawnResult.turnId },
      ],
    });

    const killKey = operationKey("kill");
    const killRequest = v.parse(killParamsSchema, { sessionId });
    store.registerKill({
      operationKey: killKey,
      runtimeScopeId,
      consumer,
      generation,
      request: killRequest,
    });
    store.markKillDispatched(killKey);
    const { activeTurnId: _activeTurnId, ...killedFields } = activeSession.info;
    const killedSession = {
      ...activeSession,
      info: {
        ...killedFields,
        turns: 1,
        state: "killed" as const,
        lastCompletedTurn: {
          turnId: spawnResult.turnId,
          stopReason: "killed" as const,
        },
      },
    };
    const killResult: KillResult = { sessionId, status: "killed" };
    const killEvents: DomainEvent[] = [
      {
        type: "turn.completed",
        sessionId,
        turnId: spawnResult.turnId,
        stopReason: "killed",
        finalReply: null,
      },
      { type: "session.killed", sessionId },
    ];
    expect(
      store.commitKill({
        operationKey: killKey,
        result: killResult,
        session: killedSession,
        events: killEvents,
      }),
    ).toEqual(
      killEvents.map((event, index) => ({ event, eventId: index + 3 })),
    );

    const alreadyKilledKey = operationKey("kill");
    store.registerKill({
      operationKey: alreadyKilledKey,
      runtimeScopeId,
      consumer,
      generation,
      request: killRequest,
    });
    store.markKillDispatched(alreadyKilledKey);
    expect(
      store.commitKill({
        operationKey: alreadyKilledKey,
        result: killResult,
        session: killedSession,
        events: [],
      }),
    ).toEqual([]);

    const missingSessionId = v.parse(
      sessionIdSchema,
      "session:7aa79020-74c9-4d80-92ca-3c4fe0ebfdbc:g1:2",
    );
    const notFoundKey = operationKey("kill");
    store.registerKill({
      operationKey: notFoundKey,
      runtimeScopeId,
      consumer,
      generation,
      request: { sessionId: missingSessionId },
    });
    store.markKillDispatched(notFoundKey);
    store.commitKill({
      operationKey: notFoundKey,
      result: { sessionId: missingSessionId, status: "not_found" },
      events: [],
    });
    store.close();

    store = await openControlStore({ directory });
    expect(store.getOperation(killKey)).toMatchObject({
      kind: "kill",
      status: "succeeded",
      request: killRequest,
      result: killResult,
    });
    expect(store.getOperation(notFoundKey)).toMatchObject({
      kind: "kill",
      status: "succeeded",
      request: { sessionId: missingSessionId },
      result: { sessionId: missingSessionId, status: "not_found" },
    });
    expect(store.getOperation(alreadyKilledKey)).toMatchObject({
      kind: "kill",
      status: "succeeded",
      result: killResult,
    });
    expect(store.getSession(sessionId)).toEqual(killedSession);
    expect(store.sessionEvents(sessionId).slice(-2)).toEqual(
      killEvents.map((event, index) => ({ event, eventId: index + 3 })),
    );
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  test("活动回合发送和中断结果复用同一持久操作台账", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-control-store-"));
    let store = await openControlStore({ directory });
    const spawnKey = operationKey();
    const turnId = "t1" as never;
    const spawnResult: SpawnAck = { sessionId, turnId, cwd: "/tmp" };
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
        activeTurnId: turnId,
      },
      runtimeScopeId,
      consumer,
      generation,
    };
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
      session,
      events: [
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
        { type: "turn.started", sessionId, turnId },
      ],
    });

    const sendKey = operationKey("send");
    const sendRequest = {
      placement: "active_turn" as const,
      sessionId,
      turnId,
      message: "precise active input",
    };
    expect(
      store.registerSend({
        operationKey: sendKey,
        runtimeScopeId,
        consumer,
        generation,
        request: sendRequest,
      }),
    ).toMatchObject({ created: true, operation: { status: "pending" } });
    store.markSendDispatched(sendKey);
    const sendResult: SendAck = {
      sessionId,
      turnId,
      messageId: "m2" as never,
      deliveryPoint: "active_turn",
    };
    const caller: DomainEvent = {
      type: "message",
      sessionId,
      turnId,
      messageId: sendResult.messageId,
      role: "caller",
      content: sendRequest.message,
    };
    store.commitSend({
      operationKey: sendKey,
      result: sendResult,
      session,
      events: [caller],
    });
    expect(store.getSession(sessionId)).toEqual(session);
    expect(
      store.registerSend({
        operationKey: sendKey,
        runtimeScopeId,
        consumer,
        generation,
        request: sendRequest,
      }),
    ).toMatchObject({
      created: false,
      operation: {
        status: "succeeded",
        request: sendRequest,
        result: sendResult,
      },
    });
    expect(() =>
      store.registerSend({
        operationKey: sendKey,
        runtimeScopeId,
        consumer,
        generation,
        request: {
          placement: "new_turn",
          sessionId,
          message: sendRequest.message,
        },
      }),
    ).toThrow(expect.objectContaining({ code: "operation_key_conflict" }));

    const interruptKey = operationKey("interrupt");
    const interruptRequest = { sessionId, turnId };
    store.registerInterrupt({
      operationKey: interruptKey,
      runtimeScopeId,
      consumer,
      generation,
      request: interruptRequest,
    });
    store.markInterruptDispatched(interruptKey);
    const interruptResult: InterruptAck = { sessionId, turnId };
    store.commitInterrupt({
      operationKey: interruptKey,
      result: interruptResult,
    });
    expect(store.getSession(sessionId)).toEqual(session);
    expect(store.sessionEvents(sessionId).map(({ event }) => event)).toEqual([
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
      { type: "turn.started", sessionId, turnId },
      caller,
    ]);
    store.close();

    store = await openControlStore({ directory });
    expect(store.getOperation(sendKey)).toMatchObject({
      kind: "send",
      status: "succeeded",
      request: sendRequest,
      result: sendResult,
    });
    expect(store.getOperation(interruptKey)).toMatchObject({
      kind: "interrupt",
      status: "succeeded",
      request: interruptRequest,
      result: interruptResult,
    });
    expect(store.getSession(sessionId)).toEqual(session);
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
