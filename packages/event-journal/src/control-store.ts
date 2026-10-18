import { chmod, mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

import {
  domainEventSchema,
  eventIdSchema,
  machineErrorSchema,
  sessionInfoSchema,
  spawnAckSchema,
  spawnParamsSchema,
  type ConsumerContext,
  type DaemonGeneration,
  type DomainEvent,
  type EventId,
  type MachineError,
  type SessionInfo,
  type SessionId,
  type SpawnAck,
  type SpawnParams,
} from "@reins/protocol";
import * as v from "valibot";

export type ControlOperationInput = {
  readonly operationKey: string;
  readonly runtimeScopeId: string;
  readonly consumer: ConsumerContext;
  readonly generation: DaemonGeneration;
  readonly request: SpawnParams;
};

export type ControlOperation = ControlOperationInput &
  (
    | { readonly status: "pending" }
    | { readonly status: "dispatched" }
    | { readonly status: "succeeded"; readonly result: SpawnAck }
    | { readonly status: "failed"; readonly error: MachineError }
  );

export type StoredSession = {
  readonly info: SessionInfo;
  readonly runtimeScopeId: string;
  readonly consumer: ConsumerContext;
  readonly generation: DaemonGeneration;
};

export type StoredCommittedEvent = {
  readonly event: DomainEvent;
  readonly eventId: EventId;
};

export type ControlStore = {
  registerSpawn(input: ControlOperationInput): {
    readonly created: boolean;
    readonly operation: ControlOperation;
  };
  markSpawnDispatched(operationKey: string): void;
  commitSpawn(input: {
    readonly operationKey: string;
    readonly result: SpawnAck;
    readonly session: StoredSession;
    readonly events: readonly DomainEvent[];
  }): readonly StoredCommittedEvent[];
  failSpawn(operationKey: string, error: MachineError): void;
  recordEvent(
    event: DomainEvent,
    session?: SessionInfo,
  ): StoredCommittedEvent;
  getOperation(operationKey: string): ControlOperation | undefined;
  getSession(sessionId: SessionId): StoredSession | undefined;
  listSessions(): readonly StoredSession[];
  sessionEvents(sessionId: SessionId): readonly StoredCommittedEvent[];
  eventWindow(sessionId: SessionId): {
    readonly head: EventId | null;
    readonly oldest: EventId | null;
  };
  health(): { readonly status: "available" | "unavailable" };
  close(): void;
};

type OperationRow = {
  operation_key: string;
  runtime_scope_id: string;
  consumer: string;
  generation: string;
  request_json: string;
  status: "pending" | "dispatched" | "succeeded" | "failed";
  result_json: string | null;
  error_json: string | null;
};

type SessionRow = {
  session_id: string;
  runtime_scope_id: string;
  consumer: string;
  generation: string;
  info_json: string;
};

type EventRow = { event_id: number; event_json: string };

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return (
      "{" +
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value) ?? "null";
}

function parseJson<T>(schema: v.GenericSchema, value: string): T {
  return v.parse(schema, JSON.parse(value)) as T;
}

function operationFromRow(row: OperationRow): ControlOperation {
  const common = {
    operationKey: row.operation_key,
    runtimeScopeId: row.runtime_scope_id,
    consumer: row.consumer as ConsumerContext,
    generation: row.generation as DaemonGeneration,
    request: parseJson<SpawnParams>(spawnParamsSchema, row.request_json),
  };
  switch (row.status) {
    case "pending":
      return { ...common, status: "pending" };
    case "dispatched":
      return { ...common, status: "dispatched" };
    case "succeeded":
      if (row.result_json === null) throw new Error("Stored spawn result missing");
      return {
        ...common,
        status: "succeeded",
        result: parseJson<SpawnAck>(spawnAckSchema, row.result_json),
      };
    case "failed":
      if (row.error_json === null) throw new Error("Stored spawn failure missing");
      return {
        ...common,
        status: "failed",
        error: parseJson<MachineError>(machineErrorSchema, row.error_json),
      };
  }
}

function sessionFromRow(row: SessionRow): StoredSession {
  return {
    info: parseJson<SessionInfo>(sessionInfoSchema, row.info_json),
    runtimeScopeId: row.runtime_scope_id,
    consumer: row.consumer as ConsumerContext,
    generation: row.generation as DaemonGeneration,
  };
}

function eventFromRow(row: EventRow): StoredCommittedEvent {
  return {
    event: parseJson<DomainEvent>(domainEventSchema, row.event_json),
    eventId: v.parse(eventIdSchema, row.event_id),
  };
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

function initializeDatabase(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS operations (
      operation_key TEXT PRIMARY KEY,
      runtime_scope_id TEXT NOT NULL,
      consumer TEXT NOT NULL,
      generation TEXT NOT NULL,
      request_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'dispatched', 'succeeded', 'failed')),
      result_json TEXT,
      error_json TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      runtime_scope_id TEXT NOT NULL,
      consumer TEXT NOT NULL,
      generation TEXT NOT NULL,
      info_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS session_heads (
      session_id TEXT PRIMARY KEY,
      head INTEGER NOT NULL CHECK(head >= 0)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS session_events (
      session_id TEXT NOT NULL,
      event_id INTEGER NOT NULL CHECK(event_id > 0),
      event_json TEXT NOT NULL,
      PRIMARY KEY(session_id, event_id),
      FOREIGN KEY(session_id) REFERENCES sessions(session_id)
    ) STRICT;
  `);
}

export async function openControlStore(options: {
  readonly directory: string;
}): Promise<ControlStore> {
  await ensurePrivateDirectory(options.directory);
  const databasePath = join(options.directory, "control.sqlite");
  const database = new DatabaseSync(databasePath);
  await chmod(databasePath, 0o600);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = FULL");
  initializeDatabase(database);
  return createControlStore(database);
}

export function createInMemoryControlStore(): ControlStore {
  const database = new DatabaseSync(":memory:");
  initializeDatabase(database);
  return createControlStore(database);
}

function createControlStore(database: DatabaseSync): ControlStore {
  let closed = false;
  let writeUnavailable = false;

  function assertOpen(): void {
    if (closed) throw new Error("Control store is closed");
  }

  function assertWritable(): void {
    assertOpen();
    if (writeUnavailable) throw new Error("Control store is unavailable");
  }

  function transaction<T>(run: () => T): T {
    assertWritable();
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // A failed write is not a durable rejection signal. Keep the store
        // closed to new effects until its owner can recover the control log.
      }
      writeUnavailable = true;
      throw error;
    }
  }

  function readOperation(operationKey: string): ControlOperation | undefined {
    assertOpen();
    const row = database
      .prepare("SELECT * FROM operations WHERE operation_key = ?")
      .get(operationKey) as OperationRow | undefined;
    return row === undefined ? undefined : operationFromRow(row);
  }

  function appendEvent(event: DomainEvent): StoredCommittedEvent {
    const current = database
      .prepare("SELECT head FROM session_heads WHERE session_id = ?")
      .get(event.sessionId) as { head: number } | undefined;
    const next = (current?.head ?? 0) + 1;
    const eventId = v.parse(eventIdSchema, next);
    database
      .prepare(
        "INSERT INTO session_heads(session_id, head) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET head = excluded.head",
      )
      .run(event.sessionId, next);
    database
      .prepare(
        "INSERT INTO session_events(session_id, event_id, event_json) VALUES (?, ?, ?)",
      )
      .run(event.sessionId, eventId, stableJson(event));
    return { event, eventId };
  }

  function commitSessionProjection(
    sessionId: SessionId,
    info: SessionInfo,
  ): void {
    database
      .prepare("UPDATE sessions SET info_json = ? WHERE session_id = ?")
      .run(stableJson(info), sessionId);
  }

  return {
    registerSpawn(input) {
      const parsedRequest = v.parse(spawnParamsSchema, input.request);
      const requestJson = stableJson(parsedRequest);
      const current = readOperation(input.operationKey);
      if (current !== undefined) {
        const row = database
          .prepare("SELECT request_json FROM operations WHERE operation_key = ?")
          .get(input.operationKey) as { request_json: string };
        if (
          current.runtimeScopeId !== input.runtimeScopeId ||
          current.consumer !== input.consumer ||
          current.generation !== input.generation ||
          row.request_json !== requestJson
        )
          throw { code: "operation_key_conflict" };
        return { created: false, operation: current };
      }
      transaction(() => {
        database
          .prepare(
            "INSERT INTO operations(operation_key, runtime_scope_id, consumer, generation, request_json, status) VALUES (?, ?, ?, ?, ?, 'pending')",
          )
          .run(
            input.operationKey,
            input.runtimeScopeId,
            input.consumer,
            input.generation,
            requestJson,
          );
      });
      const operation = readOperation(input.operationKey);
      if (operation === undefined) throw new Error("Spawn registration disappeared");
      return { created: true, operation };
    },
    markSpawnDispatched(operationKey) {
      transaction(() => {
        const result = database
          .prepare(
            "UPDATE operations SET status = 'dispatched' WHERE operation_key = ? AND status = 'pending'",
          )
          .run(operationKey);
        if (Number(result.changes) !== 1)
          throw new Error("Spawn operation is not awaiting dispatch");
      });
    },
    commitSpawn(input) {
      const parsedResult = v.parse(spawnAckSchema, input.result);
      const parsedSession = v.parse(sessionInfoSchema, input.session.info);
      if (parsedSession.sessionId !== parsedResult.sessionId)
        throw new Error("Spawn session does not match its result");
      const events = input.events.map((event) => v.parse(domainEventSchema, event));
      if (
        events.length < 2 ||
        events[0]?.type !== "session.created" ||
        events[0].sessionId !== parsedResult.sessionId ||
        events[1]?.type !== "turn.started" ||
        events[1].sessionId !== parsedResult.sessionId ||
        events[1].turnId !== parsedResult.turnId ||
        events.some((event) => event.sessionId !== parsedResult.sessionId)
      )
        throw new Error("Spawn events do not form the initial session batch");
      const committed = transaction(() => {
        const operation = readOperation(input.operationKey);
        if (operation === undefined || operation.status !== "dispatched")
          throw new Error("Spawn operation was not marked dispatched");
        if (
          operation.runtimeScopeId !== input.session.runtimeScopeId ||
          operation.consumer !== input.session.consumer ||
          operation.generation !== input.session.generation
        )
          throw new Error("Spawn operation ownership does not match its session");
        database
          .prepare(
            "INSERT INTO sessions(session_id, runtime_scope_id, consumer, generation, info_json) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            parsedSession.sessionId,
            input.session.runtimeScopeId,
            input.session.consumer,
            input.session.generation,
            stableJson(parsedSession),
          );
        database
          .prepare("INSERT INTO session_heads(session_id, head) VALUES (?, 0)")
          .run(parsedSession.sessionId);
        const entries = events.map(appendEvent);
        database
          .prepare(
            "UPDATE operations SET status = 'succeeded', result_json = ? WHERE operation_key = ? AND status = 'dispatched'",
          )
          .run(stableJson(parsedResult), input.operationKey);
        return entries;
      });
      return committed;
    },
    failSpawn(operationKey, error) {
      const parsedError = v.parse(machineErrorSchema, error);
      transaction(() => {
        const result = database
          .prepare(
            "UPDATE operations SET status = 'failed', error_json = ? WHERE operation_key = ? AND status IN ('pending', 'dispatched')",
          )
          .run(stableJson(parsedError), operationKey);
        if (Number(result.changes) !== 1)
          throw new Error("Spawn operation is not pending");
      });
    },
    recordEvent(event, session) {
      const parsedEvent = v.parse(domainEventSchema, event);
      return transaction(() => {
        const entry = appendEvent(parsedEvent);
        if (session !== undefined) {
          const parsedSession = v.parse(sessionInfoSchema, session);
          if (parsedSession.sessionId !== parsedEvent.sessionId)
            throw new Error("Event session does not match its projection");
          commitSessionProjection(parsedEvent.sessionId, parsedSession);
        }
        return entry;
      });
    },
    getOperation(operationKey) {
      return readOperation(operationKey);
    },
    getSession(sessionId) {
      assertOpen();
      const row = database
        .prepare("SELECT * FROM sessions WHERE session_id = ?")
        .get(sessionId) as SessionRow | undefined;
      return row === undefined ? undefined : sessionFromRow(row);
    },
    listSessions() {
      assertOpen();
      return (database.prepare("SELECT * FROM sessions").all() as SessionRow[])
        .map(sessionFromRow)
        .sort((left, right) =>
          left.info.spawnedAt.localeCompare(right.info.spawnedAt),
        );
    },
    sessionEvents(sessionId) {
      assertOpen();
      const rows = database
        .prepare(
          "SELECT event_id, event_json FROM session_events WHERE session_id = ? ORDER BY event_id",
        )
        .all(sessionId) as EventRow[];
      return rows.map(eventFromRow);
    },
    eventWindow(sessionId) {
      assertOpen();
      const row = database
        .prepare(
          "SELECT head, (SELECT min(event_id) FROM session_events WHERE session_id = ?) AS oldest FROM session_heads WHERE session_id = ?",
        )
        .get(sessionId, sessionId) as
        | { head: number; oldest: number | null }
        | undefined;
      return {
        head:
          row === undefined || row.head === 0
            ? null
            : v.parse(eventIdSchema, row.head),
        oldest:
          row?.oldest == null ? null : v.parse(eventIdSchema, row.oldest),
      };
    },
    health() {
      return {
        status: closed || writeUnavailable ? "unavailable" : "available",
      };
    },
    close() {
      if (closed) return;
      database.close();
      closed = true;
    },
  };
}
