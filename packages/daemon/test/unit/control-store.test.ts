import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openControlStore } from "@reins/event-journal";
import type { DomainEvent, SessionId, SpawnAck, SpawnParams } from "@reins/protocol";
import { describe, expect, test } from "vitest";

const runtimeScopeId = "7aa79020-74c9-4d80-92ca-3c4fe0ebfdbc";
const consumer = "test-consumer" as never;
const generation = "g1" as never;
const sessionId = "session:7aa79020-74c9-4d80-92ca-3c4fe0ebfdbc:g1:1" as SessionId;
const request: SpawnParams = {
  sessionLabel: "same-label-is-allowed",
  harness: "codex",
  message: "first request",
  cwd: "/tmp",
};

describe("SQLite control store", () => {
  test("commits operation result, session ownership and creation events atomically across reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-control-store-"));
    let store = await openControlStore({ directory });
    const operationKey = "operation-key-1";
    const identity = {
      operationKey,
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
    store.markSpawnDispatched(operationKey);
    expect(
      store.commitSpawn({ operationKey, result, session, events }),
    ).toEqual(events.map((event, index) => ({ event, eventId: index + 1 })));
    store.close();

    store = await openControlStore({ directory });
    expect(store.getOperation(operationKey)).toMatchObject({
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
    await rm(directory, { recursive: true, force: true });
  });

  test("rejects a repeated key with any changed request field", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-control-store-"));
    const store = await openControlStore({ directory });
    const identity = {
      operationKey: "operation-key-2",
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
});
