import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  domainEventSchema,
  eventIdSchema,
  machineErrorSchema,
  consumerContextSchema,
  daemonGenerationSchema,
  operationKeySchema,
  parseOperationKey,
  runtimeScopeIdSchema,
  sendAckSchema,
  newTurnSendParamsSchema,
  sessionIdSchema,
  sessionInfoSchema,
  spawnAckSchema,
  spawnParamsSchema,
  turnIdSchema,
  type ConsumerContext,
  type DaemonGeneration,
  type DomainEvent,
  type EventId,
  type MachineError,
  type RuntimeScopeId,
  type SendAck,
  type NewTurnSendParams,
  type SessionInfo,
  type SessionId,
  type SpawnAck,
  type SpawnParams,
  type TurnId,
} from "@reins/protocol";
import * as v from "valibot";

type StoredOperationKey = v.InferOutput<typeof operationKeySchema>;

type ControlOperationOwner = {
  readonly operationKey: StoredOperationKey;
  readonly runtimeScopeId: RuntimeScopeId;
  readonly consumer: ConsumerContext;
  readonly generation: DaemonGeneration;
};

export type ControlOperationInput = ControlOperationOwner & {
  readonly request: SpawnParams;
};

export type SendControlOperationInput = ControlOperationOwner & {
  readonly request: NewTurnSendParams;
};

type ControlOperationStatus<Result> =
  | { readonly status: "pending" }
  | { readonly status: "dispatched" }
  | {
      readonly status: "outcome_unknown";
      readonly error: Extract<
        MachineError,
        { code: "operation_outcome_unknown" }
      >;
    }
  | { readonly status: "succeeded"; readonly result: Result }
  | { readonly status: "failed"; readonly error: MachineError };

export type ControlOperation =
  | (ControlOperationInput &
      ControlOperationStatus<SpawnAck> & { readonly kind: "spawn" })
  | (SendControlOperationInput &
      ControlOperationStatus<SendAck> & { readonly kind: "send" });

export type StoredSession = {
  readonly info: SessionInfo;
  readonly runtimeScopeId: RuntimeScopeId;
  readonly consumer: ConsumerContext;
  readonly generation: DaemonGeneration;
};

export type StoredCommittedEvent = {
  readonly event: DomainEvent;
  readonly eventId: EventId;
};

export type SessionEventsPageInput = {
  readonly sessionId: SessionId;
  readonly afterEventId: number;
  readonly throughEventId?: EventId | null;
  readonly limit: number;
  readonly turnId?: TurnId;
};

export type SessionEventsPage = {
  readonly entries: readonly StoredCommittedEvent[];
  readonly nextAfter: number;
  readonly throughEventId: EventId | null;
  readonly head: EventId | null;
  readonly oldest: EventId | null;
  readonly total: number;
  readonly hasMore: boolean;
};

export type ControlStore = {
  registerSpawn(input: ControlOperationInput): {
    readonly created: boolean;
    readonly operation: ControlOperation;
  };
  markSpawnDispatched(operationKey: StoredOperationKey): void;
  commitSpawn(input: {
    readonly operationKey: StoredOperationKey;
    readonly result: SpawnAck;
    readonly session: StoredSession;
    readonly events: readonly DomainEvent[];
  }): readonly StoredCommittedEvent[];
  failSpawn(operationKey: StoredOperationKey, error: MachineError): void;
  recordSpawnOutcomeUnknown(
    operationKey: StoredOperationKey,
    error: Extract<MachineError, { code: "operation_outcome_unknown" }>,
  ): void;
  registerSend(input: SendControlOperationInput): {
    readonly created: boolean;
    readonly operation: Extract<ControlOperation, { kind: "send" }>;
  };
  markSendDispatched(operationKey: StoredOperationKey): void;
  commitSend(input: {
    readonly operationKey: StoredOperationKey;
    readonly result: SendAck;
    readonly session: StoredSession;
    readonly events: readonly DomainEvent[];
  }): readonly StoredCommittedEvent[];
  failSend(operationKey: StoredOperationKey, error: MachineError): void;
  recordSendOutcomeUnknown(
    operationKey: StoredOperationKey,
    error: Extract<MachineError, { code: "operation_outcome_unknown" }>,
  ): void;
  recordEvent(event: DomainEvent, session?: SessionInfo): StoredCommittedEvent;
  getOperation(operationKey: StoredOperationKey): ControlOperation | undefined;
  getSession(sessionId: SessionId): StoredSession | undefined;
  listSessions(): readonly StoredSession[];
  sessionEvents(sessionId: SessionId): readonly StoredCommittedEvent[];
  sessionEventsPage(input: SessionEventsPageInput): SessionEventsPage;
  eventWindow(sessionId: SessionId): {
    readonly head: EventId | null;
    readonly oldest: EventId | null;
  };
  health(): { readonly status: "available" | "unavailable" };
  close(): void;
};

type OperationRow = Record<string, unknown>;

type SessionRow = Record<string, unknown>;

type EventRow = Record<string, unknown>;

const operationStatusSchema = v.picklist([
  "pending",
  "dispatched",
  "succeeded",
  "failed",
]);

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

function parseJson<TSchema extends v.GenericSchema>(
  schema: TSchema,
  value: unknown,
): v.InferOutput<TSchema> {
  return v.parse(schema, JSON.parse(v.parse(v.string(), value)));
}

function operationFromRow(row: OperationRow): ControlOperation {
  const operationKey = v.parse(operationKeySchema, row.operation_key);
  const claims = parseOperationKey(operationKey);
  if (claims.kind !== "spawn" && claims.kind !== "send")
    throw new Error(
      "Stored operation kind is not supported by this control store",
    );
  const runtimeScopeId = v.parse(runtimeScopeIdSchema, row.runtime_scope_id);
  const consumer = v.parse(consumerContextSchema, row.consumer);
  const generation = v.parse(daemonGenerationSchema, row.generation);
  if (
    claims.runtimeScopeId !== runtimeScopeId ||
    claims.consumer !== consumer ||
    claims.generation !== generation
  )
    throw new Error("Stored operation ownership does not match its key");
  const status = v.parse(operationStatusSchema, row.status);
  const resultJson =
    row.result_json === null ? null : v.parse(v.string(), row.result_json);
  const errorJson =
    row.error_json === null ? null : v.parse(v.string(), row.error_json);
  if (resultJson !== null && status !== "succeeded")
    throw new Error("Stored spawn operation has inconsistent result fields");
  const owner = {
    operationKey,
    runtimeScopeId,
    consumer,
    generation,
  };
  const error =
    errorJson === null ? undefined : parseJson(machineErrorSchema, errorJson);
  const statusFields = <Result>(resultSchema: v.GenericSchema) => {
    switch (status) {
      case "pending":
        if (resultJson !== null || error !== undefined)
          throw new Error(
            "Stored pending operation has result or error fields",
          );
        return { status: "pending" as const };
      case "dispatched":
        if (resultJson !== null)
          throw new Error("Stored dispatched operation has a result");
        if (error === undefined) return { status: "dispatched" as const };
        if (error.code !== "operation_outcome_unknown")
          throw new Error("Stored dispatched operation has an invalid error");
        return { status: "outcome_unknown" as const, error };
      case "succeeded":
        if (resultJson === null || error !== undefined)
          throw new Error(
            "Stored successful operation has inconsistent fields",
          );
        return {
          status: "succeeded" as const,
          result: parseJson(resultSchema, resultJson) as Result,
        };
      case "failed":
        if (resultJson !== null || error === undefined)
          throw new Error("Stored failed operation has inconsistent fields");
        return { status: "failed" as const, error };
    }
  };
  if (claims.kind === "spawn")
    return {
      ...owner,
      kind: "spawn",
      request: parseJson(spawnParamsSchema, row.request_json),
      ...statusFields<SpawnAck>(spawnAckSchema),
    };
  return {
    ...owner,
    kind: "send",
    request: parseJson(newTurnSendParamsSchema, row.request_json),
    ...statusFields<SendAck>(sendAckSchema),
  };
}

function sessionFromRow(row: SessionRow): StoredSession {
  const rowSessionId = v.parse(sessionIdSchema, row.session_id);
  const runtimeScopeId = v.parse(runtimeScopeIdSchema, row.runtime_scope_id);
  const consumer = v.parse(consumerContextSchema, row.consumer);
  const generation = v.parse(daemonGenerationSchema, row.generation);
  const [, sessionScopeId, sessionGeneration] = rowSessionId.split(":");
  if (sessionScopeId !== runtimeScopeId || sessionGeneration !== generation)
    throw new Error("Stored session ownership does not match its identity");
  const info = parseJson(sessionInfoSchema, row.info_json);
  if (info.sessionId !== rowSessionId)
    throw new Error("Stored session info does not match its identity");
  return {
    info,
    runtimeScopeId,
    consumer,
    generation,
  };
}

function eventFromRow(row: EventRow): StoredCommittedEvent {
  return {
    event: parseJson(domainEventSchema, row.event_json),
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

  function validatedOperationKey(
    value: StoredOperationKey,
    expectedKind?: "spawn" | "send",
  ): StoredOperationKey {
    const operationKey = v.parse(operationKeySchema, value);
    const claims = parseOperationKey(operationKey);
    if (
      (claims.kind !== "spawn" && claims.kind !== "send") ||
      (expectedKind !== undefined && claims.kind !== expectedKind)
    )
      throw new Error("OperationKey kind does not match the stored operation");
    return operationKey;
  }

  function validateOperationOwnership(
    operationKey: StoredOperationKey,
    expectedKind: "spawn" | "send",
    runtimeScopeId: RuntimeScopeId,
    consumer: ConsumerContext,
    generation: DaemonGeneration,
  ): void {
    const claims = parseOperationKey(operationKey, expectedKind);
    if (
      claims.runtimeScopeId !== runtimeScopeId ||
      claims.consumer !== consumer ||
      claims.generation !== generation
    )
      throw new Error("Operation ownership does not match its key");
  }

  function validateSessionIdentity(session: StoredSession): StoredSession {
    const info = v.parse(sessionInfoSchema, session.info);
    const sessionId = v.parse(sessionIdSchema, info.sessionId);
    const runtimeScopeId = v.parse(
      runtimeScopeIdSchema,
      session.runtimeScopeId,
    );
    const consumer = v.parse(consumerContextSchema, session.consumer);
    const generation = v.parse(daemonGenerationSchema, session.generation);
    const [, sessionScopeId, sessionGeneration] = sessionId.split(":");
    if (sessionScopeId !== runtimeScopeId || sessionGeneration !== generation)
      throw new Error("Session ownership does not match its identity");
    return { info, runtimeScopeId, consumer, generation };
  }

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

  function readOperation(
    operationKey: StoredOperationKey,
  ): ControlOperation | undefined {
    assertOpen();
    operationKey = validatedOperationKey(operationKey);
    const row = database
      .prepare("SELECT * FROM operations WHERE operation_key = ?")
      .get(operationKey) as OperationRow | undefined;
    if (row === undefined) return undefined;
    const operation = operationFromRow(row);
    if (operation.status === "succeeded") {
      const sessionRow = database
        .prepare("SELECT * FROM sessions WHERE session_id = ?")
        .get(operation.result.sessionId) as SessionRow | undefined;
      if (sessionRow === undefined)
        throw new Error("Stored operation result has no session record");
      const session = sessionFromRow(sessionRow);
      if (
        session.runtimeScopeId !== operation.runtimeScopeId ||
        session.consumer !== operation.consumer ||
        session.generation !== operation.generation
      )
        throw new Error("Stored operation result and session ownership differ");
    }
    return operation;
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

  function readSession(sessionId: SessionId): StoredSession | undefined {
    assertOpen();
    sessionId = v.parse(sessionIdSchema, sessionId);
    const row = database
      .prepare("SELECT * FROM sessions WHERE session_id = ?")
      .get(sessionId) as SessionRow | undefined;
    return row === undefined ? undefined : sessionFromRow(row);
  }

  function readEventWindow(sessionId: SessionId): {
    readonly head: EventId | null;
    readonly oldest: EventId | null;
  } {
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
      oldest: row?.oldest == null ? null : v.parse(eventIdSchema, row.oldest),
    };
  }

  function readSessionEventsPage(
    input: SessionEventsPageInput,
  ): SessionEventsPage {
    assertOpen();
    const sessionId = v.parse(sessionIdSchema, input.sessionId);
    if (!Number.isSafeInteger(input.afterEventId) || input.afterEventId < 0)
      throw new Error("Event page cursor must be a non-negative integer");
    if (!Number.isSafeInteger(input.limit) || input.limit < 1)
      throw new Error("Event page limit must be a positive integer");
    const turnId =
      input.turnId === undefined
        ? undefined
        : v.parse(turnIdSchema, input.turnId);
    const window = readEventWindow(sessionId);
    const pinnedThrough =
      input.throughEventId === undefined
        ? undefined
        : input.throughEventId === null
          ? 0
          : v.parse(eventIdSchema, input.throughEventId);
    if (pinnedThrough !== undefined && pinnedThrough > (window.head ?? 0))
      throw new Error("Event page boundary is ahead of the stored history");
    const through = pinnedThrough ?? window.head ?? 0;
    if (input.afterEventId > through)
      throw new Error("Event page cursor is ahead of its history boundary");
    const turnFilter =
      turnId === undefined
        ? ""
        : " AND json_extract(event_json, '$.turnId') = ?";
    const rangeParams: (string | number)[] = [
      sessionId,
      input.afterEventId,
      through,
      ...(turnId === undefined ? [] : [turnId]),
    ];
    const countRow = database
      .prepare(
        `SELECT COUNT(*) AS total FROM session_events WHERE session_id = ? AND event_id > ? AND event_id <= ?${turnFilter}`,
      )
      .get(...rangeParams) as { total: number };
    const rows = database
      .prepare(
        `SELECT event_id, event_json FROM session_events WHERE session_id = ? AND event_id > ? AND event_id <= ?${turnFilter} ORDER BY event_id LIMIT ?`,
      )
      .all(...rangeParams, input.limit) as EventRow[];
    const entries = rows.map((row) => {
      const entry = eventFromRow(row);
      if (entry.event.sessionId !== sessionId)
        throw new Error("Stored event does not match its session");
      return entry;
    });
    const total = Number(countRow.total);
    const hasMore = total > entries.length;
    const nextAfter = hasMore
      ? (entries.at(-1)?.eventId ?? input.afterEventId)
      : through;
    return {
      entries,
      nextAfter,
      throughEventId: through === 0 ? null : v.parse(eventIdSchema, through),
      head: window.head,
      oldest: window.oldest,
      total,
      hasMore,
    };
  }

  return {
    registerSpawn(input) {
      const operationKey = validatedOperationKey(input.operationKey, "spawn");
      const runtimeScopeId = v.parse(
        runtimeScopeIdSchema,
        input.runtimeScopeId,
      );
      const consumer = v.parse(consumerContextSchema, input.consumer);
      const generation = v.parse(daemonGenerationSchema, input.generation);
      validateOperationOwnership(
        operationKey,
        "spawn",
        runtimeScopeId,
        consumer,
        generation,
      );
      const parsedRequest = v.parse(spawnParamsSchema, input.request);
      const requestJson = stableJson(parsedRequest);
      const current = readOperation(operationKey);
      if (current !== undefined) {
        const row = database
          .prepare(
            "SELECT request_json FROM operations WHERE operation_key = ?",
          )
          .get(operationKey) as Record<string, unknown> | undefined;
        const storedRequestJson =
          row === undefined ? undefined : v.parse(v.string(), row.request_json);
        if (
          storedRequestJson === undefined ||
          current.runtimeScopeId !== runtimeScopeId ||
          current.consumer !== consumer ||
          current.generation !== generation ||
          storedRequestJson !== requestJson
        )
          throw { code: "operation_key_conflict" };
        return { created: false, operation: current };
      }
      transaction(() => {
        database
          .prepare(
            "INSERT INTO operations(operation_key, runtime_scope_id, consumer, generation, request_json, status) VALUES (?, ?, ?, ?, ?, 'pending')",
          )
          .run(operationKey, runtimeScopeId, consumer, generation, requestJson);
      });
      const operation = readOperation(operationKey);
      if (operation === undefined)
        throw new Error("Spawn registration disappeared");
      return { created: true, operation };
    },
    registerSend(input) {
      const operationKey = validatedOperationKey(input.operationKey, "send");
      const runtimeScopeId = v.parse(
        runtimeScopeIdSchema,
        input.runtimeScopeId,
      );
      const consumer = v.parse(consumerContextSchema, input.consumer);
      const generation = v.parse(daemonGenerationSchema, input.generation);
      validateOperationOwnership(
        operationKey,
        "send",
        runtimeScopeId,
        consumer,
        generation,
      );
      const parsedRequest = v.parse(newTurnSendParamsSchema, input.request);
      const requestJson = stableJson(parsedRequest);
      const current = readOperation(operationKey);
      if (current !== undefined) {
        const row = database
          .prepare(
            "SELECT request_json FROM operations WHERE operation_key = ?",
          )
          .get(operationKey) as Record<string, unknown> | undefined;
        const storedRequestJson =
          row === undefined ? undefined : v.parse(v.string(), row.request_json);
        if (
          current.kind !== "send" ||
          storedRequestJson === undefined ||
          current.runtimeScopeId !== runtimeScopeId ||
          current.consumer !== consumer ||
          current.generation !== generation ||
          storedRequestJson !== requestJson
        )
          throw { code: "operation_key_conflict" };
        return { created: false, operation: current };
      }
      transaction(() => {
        database
          .prepare(
            "INSERT INTO operations(operation_key, runtime_scope_id, consumer, generation, request_json, status) VALUES (?, ?, ?, ?, ?, 'pending')",
          )
          .run(operationKey, runtimeScopeId, consumer, generation, requestJson);
      });
      const operation = readOperation(operationKey);
      if (operation === undefined || operation.kind !== "send")
        throw new Error("Send registration disappeared");
      return { created: true, operation };
    },
    markSpawnDispatched(operationKey) {
      operationKey = validatedOperationKey(operationKey, "spawn");
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
      const operationKey = validatedOperationKey(input.operationKey, "spawn");
      const sessionInput = validateSessionIdentity(input.session);
      validateOperationOwnership(
        operationKey,
        "spawn",
        sessionInput.runtimeScopeId,
        sessionInput.consumer,
        sessionInput.generation,
      );
      const parsedResult = v.parse(spawnAckSchema, input.result);
      const parsedSession = sessionInput.info;
      if (parsedSession.sessionId !== parsedResult.sessionId)
        throw new Error("Spawn session does not match its result");
      const events = input.events.map((event) =>
        v.parse(domainEventSchema, event),
      );
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
        const operation = readOperation(operationKey);
        if (operation === undefined || operation.status !== "dispatched")
          throw new Error("Spawn operation was not marked dispatched");
        if (
          operation.runtimeScopeId !== sessionInput.runtimeScopeId ||
          operation.consumer !== sessionInput.consumer ||
          operation.generation !== sessionInput.generation
        )
          throw new Error(
            "Spawn operation ownership does not match its session",
          );
        database
          .prepare(
            "INSERT INTO sessions(session_id, runtime_scope_id, consumer, generation, info_json) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            parsedSession.sessionId,
            sessionInput.runtimeScopeId,
            sessionInput.consumer,
            sessionInput.generation,
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
          .run(stableJson(parsedResult), operationKey);
        return entries;
      });
      return committed;
    },
    markSendDispatched(operationKey) {
      operationKey = validatedOperationKey(operationKey, "send");
      transaction(() => {
        const result = database
          .prepare(
            "UPDATE operations SET status = 'dispatched' WHERE operation_key = ? AND status = 'pending'",
          )
          .run(operationKey);
        if (Number(result.changes) !== 1)
          throw new Error("Send operation is not awaiting dispatch");
      });
    },
    commitSend(input) {
      const operationKey = validatedOperationKey(input.operationKey, "send");
      const sessionInput = validateSessionIdentity(input.session);
      validateOperationOwnership(
        operationKey,
        "send",
        sessionInput.runtimeScopeId,
        sessionInput.consumer,
        sessionInput.generation,
      );
      const parsedResult = v.parse(sendAckSchema, input.result);
      const parsedSession = sessionInput.info;
      const events = input.events.map((event) =>
        v.parse(domainEventSchema, event),
      );
      const operation = readOperation(operationKey);
      if (operation?.kind !== "send")
        throw new Error("Send operation record is missing");
      const caller = events[1];
      if (
        operation.request.placement !== "new_turn" ||
        parsedResult.deliveryPoint !== "new_turn" ||
        parsedResult.sessionId !== operation.request.sessionId ||
        parsedSession.sessionId !== parsedResult.sessionId ||
        events.length < 2 ||
        events[0]?.type !== "turn.started" ||
        events[0].sessionId !== parsedResult.sessionId ||
        events[0].turnId !== parsedResult.turnId ||
        caller?.type !== "message" ||
        caller.sessionId !== parsedResult.sessionId ||
        caller.turnId !== parsedResult.turnId ||
        caller.messageId !== parsedResult.messageId ||
        caller.role !== "caller" ||
        (typeof caller.content === "string" &&
          caller.content !== operation.request.message) ||
        events.some(
          (event, index) =>
            event.sessionId !== parsedResult.sessionId ||
            (index > 1 &&
              (event.type === "turn.started" ||
                event.type === "session.created" ||
                event.type === "session.killed" ||
                !("turnId" in event) ||
                event.turnId !== parsedResult.turnId ||
                (event.type === "message" && event.role === "caller"))),
        )
      )
        throw new Error("Send events do not match the accepted new turn");
      const terminalEvents = events.filter(
        (event) => event.type === "turn.completed",
      );
      if (
        terminalEvents.length > 1 ||
        (terminalEvents.length === 1 && events.at(-1) !== terminalEvents[0])
      )
        throw new Error("Send event batch has an invalid turn completion");

      return transaction(() => {
        const currentOperation = readOperation(operationKey);
        if (
          currentOperation?.kind !== "send" ||
          currentOperation.status !== "dispatched"
        )
          throw new Error("Send operation was not marked dispatched");
        if (
          currentOperation.runtimeScopeId !== sessionInput.runtimeScopeId ||
          currentOperation.consumer !== sessionInput.consumer ||
          currentOperation.generation !== sessionInput.generation
        )
          throw new Error(
            "Send operation ownership does not match its session",
          );
        const existingSession = readSession(parsedResult.sessionId);
        if (
          existingSession === undefined ||
          existingSession.runtimeScopeId !== sessionInput.runtimeScopeId ||
          existingSession.consumer !== sessionInput.consumer ||
          existingSession.generation !== sessionInput.generation ||
          existingSession.info.state !== "idle"
        )
          throw new Error("Send target is not the recorded idle session");
        const lastCompletedTurn = existingSession.info.lastCompletedTurn;
        if (
          currentOperation.request.ifLastCompletedTurn !== undefined &&
          (currentOperation.request.ifLastCompletedTurn.sessionId !==
            parsedResult.sessionId ||
            currentOperation.request.ifLastCompletedTurn.turnId !==
              lastCompletedTurn?.turnId)
        )
          throw new Error("Send precondition no longer matches the session");
        const terminal = terminalEvents[0];
        if (
          parsedSession.turns !==
            existingSession.info.turns + (terminal === undefined ? 0 : 1) ||
          (terminal === undefined &&
            (parsedSession.state !== "busy" ||
              parsedSession.activeTurnId !== parsedResult.turnId)) ||
          (terminal !== undefined &&
            (parsedSession.state !== "idle" ||
              parsedSession.lastCompletedTurn?.turnId !== terminal.turnId ||
              parsedSession.lastCompletedTurn.stopReason !==
                terminal.stopReason))
        )
          throw new Error("Send session projection does not match its events");
        commitSessionProjection(parsedResult.sessionId, parsedSession);
        const entries = events.map(appendEvent);
        database
          .prepare(
            "UPDATE operations SET status = 'succeeded', result_json = ? WHERE operation_key = ? AND status = 'dispatched'",
          )
          .run(stableJson(parsedResult), operationKey);
        return entries;
      });
    },
    failSpawn(operationKey, error) {
      operationKey = validatedOperationKey(operationKey, "spawn");
      const parsedError = v.parse(machineErrorSchema, error);
      transaction(() => {
        const result = database
          .prepare(
            "UPDATE operations SET status = 'failed', error_json = ? WHERE operation_key = ? AND status IN ('pending', 'dispatched') AND error_json IS NULL",
          )
          .run(stableJson(parsedError), operationKey);
        if (Number(result.changes) !== 1)
          throw new Error("Spawn operation is not pending");
      });
    },
    recordSpawnOutcomeUnknown(operationKey, error) {
      operationKey = validatedOperationKey(operationKey, "spawn");
      const parsedError = v.parse(machineErrorSchema, error);
      if (parsedError.code !== "operation_outcome_unknown")
        throw new Error("Spawn outcome error has the wrong code");
      transaction(() => {
        const result = database
          .prepare(
            "UPDATE operations SET error_json = ? WHERE operation_key = ? AND status = 'dispatched' AND error_json IS NULL",
          )
          .run(stableJson(parsedError), operationKey);
        if (Number(result.changes) !== 1) {
          const operation = readOperation(operationKey);
          if (
            operation?.status === "outcome_unknown" &&
            stableJson(operation.error) === stableJson(parsedError)
          )
            return;
          throw new Error("Spawn operation is not awaiting an unknown outcome");
        }
      });
    },
    failSend(operationKey, error) {
      operationKey = validatedOperationKey(operationKey, "send");
      const parsedError = v.parse(machineErrorSchema, error);
      transaction(() => {
        const result = database
          .prepare(
            "UPDATE operations SET status = 'failed', error_json = ? WHERE operation_key = ? AND status IN ('pending', 'dispatched') AND error_json IS NULL",
          )
          .run(stableJson(parsedError), operationKey);
        if (Number(result.changes) !== 1)
          throw new Error("Send operation is not pending");
      });
    },
    recordSendOutcomeUnknown(operationKey, error) {
      operationKey = validatedOperationKey(operationKey, "send");
      const parsedError = v.parse(machineErrorSchema, error);
      if (parsedError.code !== "operation_outcome_unknown")
        throw new Error("Send outcome error has the wrong code");
      transaction(() => {
        const result = database
          .prepare(
            "UPDATE operations SET error_json = ? WHERE operation_key = ? AND status = 'dispatched' AND error_json IS NULL",
          )
          .run(stableJson(parsedError), operationKey);
        if (Number(result.changes) !== 1) {
          const operation = readOperation(operationKey);
          if (
            operation?.status === "outcome_unknown" &&
            stableJson(operation.error) === stableJson(parsedError)
          )
            return;
          throw new Error("Send operation is not awaiting an unknown outcome");
        }
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
      return readSession(sessionId);
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
      sessionId = v.parse(sessionIdSchema, sessionId);
      const rows = database
        .prepare(
          "SELECT event_id, event_json FROM session_events WHERE session_id = ? ORDER BY event_id",
        )
        .all(sessionId) as EventRow[];
      return rows.map((row) => {
        const entry = eventFromRow(row);
        if (entry.event.sessionId !== sessionId)
          throw new Error("Stored event does not match its session");
        return entry;
      });
    },
    sessionEventsPage(input) {
      return readSessionEventsPage(input);
    },
    eventWindow(sessionId) {
      sessionId = v.parse(sessionIdSchema, sessionId);
      return readEventWindow(sessionId);
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
