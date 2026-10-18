import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  domainEventSchema,
  eventIdSchema,
  interruptAckSchema,
  interruptParamsSchema,
  machineErrorSchema,
  consumerContextSchema,
  daemonGenerationSchema,
  killParamsSchema,
  killResultSchema,
  operationKeySchema,
  parseOperationKey,
  permissionResolutionSchemaFor,
  runtimeScopeIdSchema,
  resolvePermissionAckSchema,
  resolvePermissionParamsSchema,
  sendAckSchema,
  sendParamsSchema,
  sessionIdSchema,
  sessionInfoSchema,
  spawnAckSchema,
  spawnParamsSchema,
  turnIdSchema,
  type ConsumerContext,
  type DaemonGeneration,
  type DomainEvent,
  type EventId,
  type KillParams,
  type KillResult,
  type InterruptAck,
  type InterruptParams,
  type MachineError,
  type RuntimeScopeId,
  type ResolvePermissionAck,
  type ResolvePermissionParams,
  type SendAck,
  type SendParams,
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
  readonly request: SendParams;
};

export type InterruptControlOperationInput = ControlOperationOwner & {
  readonly request: InterruptParams;
};

export type ResolvePermissionControlOperationInput = ControlOperationOwner & {
  readonly request: ResolvePermissionParams;
};

export type KillControlOperationInput = ControlOperationOwner & {
  readonly request: KillParams;
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
      ControlOperationStatus<SendAck> & { readonly kind: "send" })
  | (InterruptControlOperationInput &
      ControlOperationStatus<InterruptAck> & { readonly kind: "interrupt" })
  | (ResolvePermissionControlOperationInput &
      ControlOperationStatus<ResolvePermissionAck> & {
        readonly kind: "resolvePermission";
      })
  | (KillControlOperationInput &
      ControlOperationStatus<KillResult> & { readonly kind: "kill" });

export type StoredSession = {
  readonly info: SessionInfo;
  readonly runtimeScopeId: RuntimeScopeId;
  readonly consumer: ConsumerContext;
  readonly generation: DaemonGeneration;
};

export type DeletedSession = {
  readonly sessionId: SessionId;
  readonly runtimeScopeId: RuntimeScopeId;
  readonly consumer: ConsumerContext;
  readonly generation: DaemonGeneration;
};

export type DeleteSessionRecordsInput = {
  readonly sessionId: SessionId;
  readonly runtimeScopeId: RuntimeScopeId;
  readonly consumer: ConsumerContext;
  readonly currentGeneration: DaemonGeneration;
  readonly unreachable: boolean;
  readonly knownOperationKeys?: readonly StoredOperationKey[];
};

export type DeleteSessionRecordsResult =
  | { readonly status: "not_found" }
  | { readonly status: "live" }
  | {
      readonly status: "deleted";
      readonly session: DeletedSession;
      readonly operationKeys: readonly StoredOperationKey[];
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
  registerInterrupt(input: InterruptControlOperationInput): {
    readonly created: boolean;
    readonly operation: Extract<ControlOperation, { kind: "interrupt" }>;
  };
  markInterruptDispatched(operationKey: StoredOperationKey): void;
  commitInterrupt(input: {
    readonly operationKey: StoredOperationKey;
    readonly result: InterruptAck;
  }): void;
  failInterrupt(operationKey: StoredOperationKey, error: MachineError): void;
  recordInterruptOutcomeUnknown(
    operationKey: StoredOperationKey,
    error: Extract<MachineError, { code: "operation_outcome_unknown" }>,
  ): void;
  registerResolvePermission(input: ResolvePermissionControlOperationInput): {
    readonly created: boolean;
    readonly operation: Extract<
      ControlOperation,
      { kind: "resolvePermission" }
    >;
  };
  markResolvePermissionDispatched(operationKey: StoredOperationKey): void;
  commitResolvePermission(input: {
    readonly operationKey: StoredOperationKey;
    readonly result: ResolvePermissionAck;
    readonly event: DomainEvent;
  }): StoredCommittedEvent;
  failResolvePermission(
    operationKey: StoredOperationKey,
    error: MachineError,
  ): void;
  recordResolvePermissionOutcomeUnknown(
    operationKey: StoredOperationKey,
    error: Extract<MachineError, { code: "operation_outcome_unknown" }>,
  ): void;
  registerKill(input: KillControlOperationInput): {
    readonly created: boolean;
    readonly operation: Extract<ControlOperation, { kind: "kill" }>;
  };
  markKillDispatched(operationKey: StoredOperationKey): void;
  commitKill(input: {
    readonly operationKey: StoredOperationKey;
    readonly result: KillResult;
    readonly session?: StoredSession;
    readonly events: readonly DomainEvent[];
  }): readonly StoredCommittedEvent[];
  failKill(operationKey: StoredOperationKey, error: MachineError): void;
  recordKillOutcomeUnknown(
    operationKey: StoredOperationKey,
    error: Extract<MachineError, { code: "operation_outcome_unknown" }>,
  ): void;
  recordEvent(event: DomainEvent, session?: SessionInfo): StoredCommittedEvent;
  getOperation(operationKey: StoredOperationKey): ControlOperation | undefined;
  isOperationDeleted(operationKey: StoredOperationKey): boolean;
  getSession(sessionId: SessionId): StoredSession | undefined;
  getDeletedSession(sessionId: SessionId): DeletedSession | undefined;
  getSessionOwner(sessionId: SessionId): ConsumerContext | undefined;
  listSessions(): readonly StoredSession[];
  deleteSessionRecords(
    input: DeleteSessionRecordsInput,
  ): DeleteSessionRecordsResult;
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
  if (
    claims.kind !== "spawn" &&
    claims.kind !== "send" &&
    claims.kind !== "interrupt" &&
    claims.kind !== "resolvePermission" &&
    claims.kind !== "kill"
  )
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
  if (claims.kind === "send")
    return {
      ...owner,
      kind: "send",
      request: parseJson(sendParamsSchema, row.request_json),
      ...statusFields<SendAck>(sendAckSchema),
    };
  if (claims.kind === "interrupt")
    return {
      ...owner,
      kind: "interrupt",
      request: parseJson(interruptParamsSchema, row.request_json),
      ...statusFields<InterruptAck>(interruptAckSchema),
    };
  if (claims.kind === "resolvePermission")
    return {
      ...owner,
      kind: "resolvePermission",
      request: parseJson(resolvePermissionParamsSchema, row.request_json),
      ...statusFields<ResolvePermissionAck>(resolvePermissionAckSchema),
    };
  return {
    ...owner,
    kind: "kill",
    request: parseJson(killParamsSchema, row.request_json),
    ...statusFields<KillResult>(killResultSchema),
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
    CREATE TABLE IF NOT EXISTS deleted_sessions (
      session_id TEXT PRIMARY KEY,
      runtime_scope_id TEXT NOT NULL,
      consumer TEXT NOT NULL,
      generation TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS deleted_operations (
      operation_key TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
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
    expectedKind?: ControlOperation["kind"],
  ): StoredOperationKey {
    const operationKey = v.parse(operationKeySchema, value);
    const claims = parseOperationKey(operationKey);
    if (
      (claims.kind !== "spawn" &&
        claims.kind !== "send" &&
        claims.kind !== "interrupt" &&
        claims.kind !== "resolvePermission" &&
        claims.kind !== "kill") ||
      (expectedKind !== undefined && claims.kind !== expectedKind)
    )
      throw new Error("OperationKey kind does not match the stored operation");
    return operationKey;
  }

  function validateOperationOwnership(
    operationKey: StoredOperationKey,
    expectedKind: ControlOperation["kind"],
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
    if (
      operation.status === "succeeded" &&
      !(operation.kind === "kill" && operation.result.status === "not_found")
    ) {
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

  function readDeletedSession(
    sessionId: SessionId,
  ): DeletedSession | undefined {
    assertOpen();
    sessionId = v.parse(sessionIdSchema, sessionId);
    const row = database
      .prepare("SELECT * FROM deleted_sessions WHERE session_id = ?")
      .get(sessionId) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    const deleted: DeletedSession = {
      sessionId: v.parse(sessionIdSchema, row.session_id),
      runtimeScopeId: v.parse(runtimeScopeIdSchema, row.runtime_scope_id),
      consumer: v.parse(consumerContextSchema, row.consumer),
      generation: v.parse(daemonGenerationSchema, row.generation),
    };
    const [, sessionScopeId, sessionGeneration] = deleted.sessionId.split(":");
    if (
      sessionScopeId !== deleted.runtimeScopeId ||
      sessionGeneration !== deleted.generation
    )
      throw new Error("Deleted session ownership does not match its identity");
    return deleted;
  }

  function assertSessionRecordsAvailable(sessionId: SessionId): void {
    if (readDeletedSession(sessionId) !== undefined)
      throw {
        code: "event_history_unavailable",
        sessionId,
      } satisfies MachineError;
  }

  function assertOperationNotDeleted(operationKey: StoredOperationKey): void {
    assertOpen();
    const row = database
      .prepare(
        "SELECT operation_key FROM deleted_operations WHERE operation_key = ?",
      )
      .get(operationKey);
    if (row !== undefined) throw { code: "operation_key_conflict" };
  }

  function permissionStillPending(
    request: ResolvePermissionParams,
    runtimeScopeId: RuntimeScopeId,
    consumer: ConsumerContext,
    generation: DaemonGeneration,
  ): MachineError | undefined {
    const session = readSession(request.sessionId);
    if (
      session === undefined ||
      session.runtimeScopeId !== runtimeScopeId ||
      session.consumer !== consumer ||
      session.generation !== generation
    )
      return { code: "permission_not_pending", ...requestTarget(request) };

    const rows = database
      .prepare(
        "SELECT event_id, event_json FROM session_events WHERE session_id = ? ORDER BY event_id",
      )
      .all(request.sessionId) as EventRow[];
    const entries = rows.map(eventFromRow);
    let requestIndex = -1;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const event = entries[index]!.event;
      if (
        event.type === "permission.requested" &&
        event.permissionId === request.permissionId
      ) {
        requestIndex = index;
        break;
      }
    }
    if (requestIndex < 0)
      return { code: "permission_not_pending", ...requestTarget(request) };

    const requested = entries[requestIndex]!.event;
    if (requested.type !== "permission.requested")
      throw new Error("Permission history has an invalid request event");
    if (requested.turnId !== request.turnId)
      return {
        code: "invalid_params",
        issues: [{ issue: "invalid_value", path: "turnId" }],
      };
    if (
      !v.safeParse(
        permissionResolutionSchemaFor(requested.options),
        request.resolution,
      ).success
    )
      return {
        code: "permission_resolution_mismatch",
        ...requestTarget(request),
      };

    const expired = entries.slice(requestIndex + 1).some(({ event }) => {
      if (event.type === "permission.resolved")
        return event.permissionId === request.permissionId;
      if (event.type === "turn.completed")
        return event.turnId === request.turnId;
      return event.type === "session.killed";
    });
    return expired
      ? { code: "permission_not_pending", ...requestTarget(request) }
      : undefined;
  }

  function requestTarget(request: ResolvePermissionParams): {
    sessionId: SessionId;
    permissionId: ResolvePermissionParams["permissionId"];
  } {
    return {
      sessionId: request.sessionId,
      permissionId: request.permissionId,
    };
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
    sessionId = v.parse(sessionIdSchema, sessionId);
    assertSessionRecordsAvailable(sessionId);
    const row = database
      .prepare(
        "SELECT (SELECT head FROM session_heads WHERE session_id = ?) AS head, (SELECT min(event_id) FROM session_events WHERE session_id = ?) AS oldest, (SELECT max(event_id) FROM session_events WHERE session_id = ?) AS latest, (SELECT count(*) FROM session_events WHERE session_id = ?) AS count",
      )
      .get(sessionId, sessionId, sessionId, sessionId) as {
      head: number | null;
      oldest: number | null;
      latest: number | null;
      count: number;
    };
    if (
      row.head === null
        ? row.count !== 0
        : row.head !== row.count ||
          (row.head > 0 && (row.oldest !== 1 || row.latest !== row.head))
    )
      throw new Error("Session event history is incomplete");
    return {
      head:
        row.head === null || row.head === 0
          ? null
          : v.parse(eventIdSchema, row.head),
      oldest: row.oldest == null ? null : v.parse(eventIdSchema, row.oldest),
    };
  }

  function readSessionEventsPage(
    input: SessionEventsPageInput,
  ): SessionEventsPage {
    assertOpen();
    const sessionId = v.parse(sessionIdSchema, input.sessionId);
    assertSessionRecordsAvailable(sessionId);
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

  function readDeletedOperationKeys(
    sessionId: SessionId,
  ): StoredOperationKey[] {
    const rows = database
      .prepare(
        "SELECT operation_key FROM deleted_operations WHERE session_id = ? ORDER BY operation_key",
      )
      .all(sessionId) as Record<string, unknown>[];
    return rows.map((row) => v.parse(operationKeySchema, row.operation_key));
  }

  function sessionOperationPredicate(): string {
    return "runtime_scope_id = ? AND consumer = ? AND (json_extract(request_json, '$.sessionId') = ? OR json_extract(result_json, '$.sessionId') = ? OR json_extract(error_json, '$.sessionId') = ? OR json_extract(error_json, '$.acceptedResult.sessionId') = ? OR json_extract(error_json, '$.effect.sessionId') = ? OR json_extract(error_json, '$.cleanupSessionId') = ?)";
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
      assertOperationNotDeleted(operationKey);
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
      assertOperationNotDeleted(operationKey);
      const parsedRequest = v.parse(sendParamsSchema, input.request);
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
    registerInterrupt(input) {
      const operationKey = validatedOperationKey(
        input.operationKey,
        "interrupt",
      );
      const runtimeScopeId = v.parse(
        runtimeScopeIdSchema,
        input.runtimeScopeId,
      );
      const consumer = v.parse(consumerContextSchema, input.consumer);
      const generation = v.parse(daemonGenerationSchema, input.generation);
      validateOperationOwnership(
        operationKey,
        "interrupt",
        runtimeScopeId,
        consumer,
        generation,
      );
      assertOperationNotDeleted(operationKey);
      const parsedRequest = v.parse(interruptParamsSchema, input.request);
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
          current.kind !== "interrupt" ||
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
      if (operation === undefined || operation.kind !== "interrupt")
        throw new Error("Interrupt registration disappeared");
      return { created: true, operation };
    },
    registerResolvePermission(input) {
      const operationKey = validatedOperationKey(
        input.operationKey,
        "resolvePermission",
      );
      const runtimeScopeId = v.parse(
        runtimeScopeIdSchema,
        input.runtimeScopeId,
      );
      const consumer = v.parse(consumerContextSchema, input.consumer);
      const generation = v.parse(daemonGenerationSchema, input.generation);
      validateOperationOwnership(
        operationKey,
        "resolvePermission",
        runtimeScopeId,
        consumer,
        generation,
      );
      assertOperationNotDeleted(operationKey);
      const request = v.parse(resolvePermissionParamsSchema, input.request);
      const requestJson = stableJson(request);
      const registration = transaction(() => {
        const current = readOperation(operationKey);
        if (current !== undefined) {
          const row = database
            .prepare(
              "SELECT request_json FROM operations WHERE operation_key = ?",
            )
            .get(operationKey) as Record<string, unknown> | undefined;
          const storedRequestJson =
            row === undefined
              ? undefined
              : v.parse(v.string(), row.request_json);
          if (
            current.kind !== "resolvePermission" ||
            storedRequestJson !== requestJson ||
            current.runtimeScopeId !== runtimeScopeId ||
            current.consumer !== consumer ||
            current.generation !== generation
          )
            return {
              state: "rejected" as const,
              error: { code: "operation_key_conflict" } as const,
            };
          return { state: "existing" as const, operation: current };
        }

        let registrationError = permissionStillPending(
          request,
          runtimeScopeId,
          consumer,
          generation,
        );
        if (registrationError === undefined) {
          const rows = database
            .prepare(
              "SELECT * FROM operations WHERE runtime_scope_id = ? AND consumer = ? AND generation = ?",
            )
            .all(runtimeScopeId, consumer, generation) as OperationRow[];
          for (const row of rows) {
            const candidate = operationFromRow(row);
            if (
              candidate.kind !== "resolvePermission" ||
              candidate.request.sessionId !== request.sessionId ||
              candidate.request.permissionId !== request.permissionId
            )
              continue;
            if (
              candidate.status === "pending" ||
              candidate.status === "dispatched"
            ) {
              registrationError = {
                code: "operation_pending",
                operationKey: candidate.operationKey,
              };
              break;
            }
            if (candidate.status === "outcome_unknown") {
              registrationError = candidate.error;
              break;
            }
          }
        }

        database
          .prepare(
            "INSERT INTO operations(operation_key, runtime_scope_id, consumer, generation, request_json, status, error_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            operationKey,
            runtimeScopeId,
            consumer,
            generation,
            requestJson,
            registrationError === undefined ? "pending" : "failed",
            registrationError === undefined
              ? null
              : stableJson(registrationError),
          );
        return { state: "created" as const };
      });
      if (registration.state === "rejected") throw registration.error;
      if (registration.state === "existing")
        return { created: false, operation: registration.operation };
      const operation = readOperation(operationKey);
      if (operation?.kind !== "resolvePermission")
        throw new Error("Permission resolution registration disappeared");
      return { created: true, operation };
    },
    registerKill(input) {
      const operationKey = validatedOperationKey(input.operationKey, "kill");
      const runtimeScopeId = v.parse(
        runtimeScopeIdSchema,
        input.runtimeScopeId,
      );
      const consumer = v.parse(consumerContextSchema, input.consumer);
      const generation = v.parse(daemonGenerationSchema, input.generation);
      validateOperationOwnership(
        operationKey,
        "kill",
        runtimeScopeId,
        consumer,
        generation,
      );
      assertOperationNotDeleted(operationKey);
      const parsedRequest = v.parse(killParamsSchema, input.request);
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
          current.kind !== "kill" ||
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
      if (operation === undefined || operation.kind !== "kill")
        throw new Error("Kill registration disappeared");
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
    markInterruptDispatched(operationKey) {
      operationKey = validatedOperationKey(operationKey, "interrupt");
      transaction(() => {
        const result = database
          .prepare(
            "UPDATE operations SET status = 'dispatched' WHERE operation_key = ? AND status = 'pending'",
          )
          .run(operationKey);
        if (Number(result.changes) !== 1)
          throw new Error("Interrupt operation is not awaiting dispatch");
      });
    },
    markResolvePermissionDispatched(operationKey) {
      operationKey = validatedOperationKey(operationKey, "resolvePermission");
      const pendingError = transaction(() => {
        const operation = readOperation(operationKey);
        if (
          operation?.kind !== "resolvePermission" ||
          operation.status !== "pending"
        )
          throw new Error(
            "Permission resolution operation is not awaiting dispatch",
          );
        const error = permissionStillPending(
          operation.request,
          operation.runtimeScopeId,
          operation.consumer,
          operation.generation,
        );
        if (error !== undefined) return error;
        const result = database
          .prepare(
            "UPDATE operations SET status = 'dispatched' WHERE operation_key = ? AND status = 'pending'",
          )
          .run(operationKey);
        if (Number(result.changes) !== 1)
          throw new Error(
            "Permission resolution operation is not awaiting dispatch",
          );
        return undefined;
      });
      if (pendingError !== undefined) throw pendingError;
    },
    markKillDispatched(operationKey) {
      operationKey = validatedOperationKey(operationKey, "kill");
      transaction(() => {
        const result = database
          .prepare(
            "UPDATE operations SET status = 'dispatched' WHERE operation_key = ? AND status = 'pending'",
          )
          .run(operationKey);
        if (Number(result.changes) !== 1)
          throw new Error("Kill operation is not awaiting dispatch");
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
      const request = operation.request;
      if (
        parsedResult.deliveryPoint !== request.placement ||
        parsedResult.sessionId !== request.sessionId ||
        parsedSession.sessionId !== parsedResult.sessionId
      )
        throw new Error("Send result does not match its request");

      if (request.placement === "new_turn") {
        const caller = events[1];
        if (
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
            caller.content !== request.message) ||
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
      } else {
        const caller = events[0];
        if (
          parsedResult.turnId !== request.turnId ||
          events.length !== 1 ||
          caller?.type !== "message" ||
          caller.sessionId !== parsedResult.sessionId ||
          caller.turnId !== parsedResult.turnId ||
          caller.messageId !== parsedResult.messageId ||
          caller.role !== "caller" ||
          (typeof caller.content === "string" &&
            caller.content !== request.message)
        )
          throw new Error("Send events do not match the accepted active turn");
      }
      const terminalEvents =
        request.placement === "new_turn"
          ? events.filter((event) => event.type === "turn.completed")
          : [];
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
          existingSession.generation !== sessionInput.generation
        )
          throw new Error("Send target is not the recorded session");
        if (request.placement === "new_turn") {
          if (existingSession.info.state !== "idle")
            throw new Error("Send target is not the recorded idle session");
          const lastCompletedTurn = existingSession.info.lastCompletedTurn;
          if (
            request.ifLastCompletedTurn !== undefined &&
            (request.ifLastCompletedTurn.sessionId !== parsedResult.sessionId ||
              request.ifLastCompletedTurn.turnId !== lastCompletedTurn?.turnId)
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
            throw new Error(
              "Send session projection does not match its events",
            );
          commitSessionProjection(parsedResult.sessionId, parsedSession);
        } else if (
          existingSession.info.state !== "busy" ||
          existingSession.info.activeTurnId !== request.turnId ||
          stableJson(parsedSession) !== stableJson(existingSession.info)
        ) {
          throw new Error("Active send target is not the recorded active turn");
        }
        const entries = events.map(appendEvent);
        database
          .prepare(
            "UPDATE operations SET status = 'succeeded', result_json = ? WHERE operation_key = ? AND status = 'dispatched'",
          )
          .run(stableJson(parsedResult), operationKey);
        return entries;
      });
    },
    commitInterrupt(input) {
      const operationKey = validatedOperationKey(
        input.operationKey,
        "interrupt",
      );
      const parsedResult = v.parse(interruptAckSchema, input.result);
      return transaction(() => {
        const operation = readOperation(operationKey);
        if (
          operation?.kind !== "interrupt" ||
          operation.status !== "dispatched"
        )
          throw new Error("Interrupt operation was not marked dispatched");
        if (
          operation.request.sessionId !== parsedResult.sessionId ||
          operation.request.turnId !== parsedResult.turnId
        )
          throw new Error("Interrupt result does not match its target");
        const session = readSession(parsedResult.sessionId);
        if (
          session === undefined ||
          session.runtimeScopeId !== operation.runtimeScopeId ||
          session.consumer !== operation.consumer ||
          session.generation !== operation.generation
        )
          throw new Error("Interrupt target is not the recorded session");
        database
          .prepare(
            "UPDATE operations SET status = 'succeeded', result_json = ? WHERE operation_key = ? AND status = 'dispatched'",
          )
          .run(stableJson(parsedResult), operationKey);
      });
    },
    commitResolvePermission(input) {
      const operationKey = validatedOperationKey(
        input.operationKey,
        "resolvePermission",
      );
      const result = v.parse(resolvePermissionAckSchema, input.result);
      const event = v.parse(domainEventSchema, input.event);
      const committed = transaction(() => {
        const operation = readOperation(operationKey);
        if (
          operation?.kind !== "resolvePermission" ||
          operation.status !== "dispatched"
        )
          throw new Error(
            "Permission resolution operation was not marked dispatched",
          );
        if (
          operation.request.sessionId !== result.sessionId ||
          operation.request.turnId !== result.turnId ||
          operation.request.permissionId !== result.permissionId ||
          event.type !== "permission.resolved" ||
          event.sessionId !== result.sessionId ||
          event.turnId !== result.turnId ||
          event.permissionId !== result.permissionId ||
          stableJson(event.resolution) !==
            stableJson(operation.request.resolution)
        )
          throw new Error(
            "Permission resolution result does not match its request",
          );

        const pendingError = permissionStillPending(
          operation.request,
          operation.runtimeScopeId,
          operation.consumer,
          operation.generation,
        );
        if (pendingError !== undefined) return { pendingError };

        const entry = appendEvent(event);
        const update = database
          .prepare(
            "UPDATE operations SET status = 'succeeded', result_json = ? WHERE operation_key = ? AND status = 'dispatched'",
          )
          .run(stableJson(result), operationKey);
        if (Number(update.changes) !== 1)
          throw new Error(
            "Permission resolution operation is not awaiting commit",
          );
        return { entry };
      });
      if ("pendingError" in committed) throw committed.pendingError;
      return committed.entry;
    },
    commitKill(input) {
      const operationKey = validatedOperationKey(input.operationKey, "kill");
      const parsedResult = v.parse(killResultSchema, input.result);
      const events = input.events.map((event) =>
        v.parse(domainEventSchema, event),
      );
      const sessionInput =
        input.session === undefined
          ? undefined
          : validateSessionIdentity(input.session);
      if (events.some((event) => event.sessionId !== parsedResult.sessionId))
        throw new Error("Kill events do not match their result");
      if (parsedResult.status === "not_found") {
        if (sessionInput !== undefined || events.length !== 0)
          throw new Error("A not-found kill cannot commit session facts");
      } else {
        if (
          sessionInput === undefined ||
          sessionInput.info.sessionId !== parsedResult.sessionId ||
          sessionInput.info.state !== "killed"
        )
          throw new Error("A killed result requires its terminal session");
      }
      return transaction(() => {
        const operation = readOperation(operationKey);
        if (
          operation?.kind !== "kill" ||
          operation.status !== "dispatched" ||
          operation.request.sessionId !== parsedResult.sessionId
        )
          throw new Error("Kill operation was not dispatched for its target");
        if (sessionInput !== undefined) {
          validateOperationOwnership(
            operationKey,
            "kill",
            sessionInput.runtimeScopeId,
            sessionInput.consumer,
            sessionInput.generation,
          );
          const existingSession = readSession(parsedResult.sessionId);
          if (
            existingSession === undefined ||
            existingSession.runtimeScopeId !== sessionInput.runtimeScopeId ||
            existingSession.consumer !== sessionInput.consumer ||
            existingSession.generation !== sessionInput.generation
          )
            throw new Error("Kill target is not the recorded session");
          const previous = existingSession.info;
          if (previous.state === "killed") {
            if (
              events.length !== 0 ||
              stableJson(previous) !== stableJson(sessionInput.info)
            )
              throw new Error("Already-killed session facts must be unchanged");
          } else {
            const sessionKilledEvents = events.filter(
              (event) => event.type === "session.killed",
            );
            if (
              events.at(-1)?.type !== "session.killed" ||
              sessionKilledEvents.length !== 1
            )
              throw new Error(
                "Kill events do not end with the session terminal",
              );
            const terminalEvents = events.filter(
              (event) => event.type === "turn.completed",
            );
            const terminal = terminalEvents[0];
            const expectedTerminalCount = previous.state === "busy" ? 1 : 0;
            if (
              terminalEvents.length !== expectedTerminalCount ||
              (previous.state === "busy" &&
                (terminal?.type !== "turn.completed" ||
                  terminal.turnId !== previous.activeTurnId ||
                  terminal.stopReason !== "killed" ||
                  terminal.finalReply !== null))
            )
              throw new Error(
                "Kill turn completion does not match its session",
              );
            if (
              previous.state === "busy" &&
              (sessionInput.info.turns !== previous.turns + 1 ||
                sessionInput.info.lastCompletedTurn?.turnId !==
                  terminal?.turnId ||
                sessionInput.info.lastCompletedTurn?.stopReason !== "killed")
            )
              throw new Error("Killed session projection lost its active turn");
            if (
              previous.state === "idle" &&
              (sessionInput.info.turns !== previous.turns ||
                stableJson(sessionInput.info.lastCompletedTurn) !==
                  stableJson(previous.lastCompletedTurn))
            )
              throw new Error(
                "Killed session projection changed its last turn",
              );
          }
        }
        const currentOperation = readOperation(operationKey);
        if (
          currentOperation?.kind !== "kill" ||
          currentOperation.status !== "dispatched" ||
          currentOperation.request.sessionId !== parsedResult.sessionId
        )
          throw new Error("Kill operation is no longer awaiting commit");
        const currentSession = readSession(parsedResult.sessionId);
        if (sessionInput === undefined) {
          if (parsedResult.status !== "not_found")
            throw new Error("A killed result has no session projection");
        } else if (
          currentSession === undefined ||
          currentSession.runtimeScopeId !== sessionInput.runtimeScopeId ||
          currentSession.consumer !== sessionInput.consumer ||
          currentSession.generation !== sessionInput.generation
        ) {
          throw new Error("Kill session changed before commit");
        }
        if (sessionInput !== undefined)
          commitSessionProjection(parsedResult.sessionId, sessionInput.info);
        const entries = events.map(appendEvent);
        const updated = database
          .prepare(
            "UPDATE operations SET status = 'succeeded', result_json = ? WHERE operation_key = ? AND status = 'dispatched' AND error_json IS NULL",
          )
          .run(stableJson(parsedResult), operationKey);
        if (Number(updated.changes) !== 1)
          throw new Error("Kill operation is no longer awaiting commit");
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
    failInterrupt(operationKey, error) {
      operationKey = validatedOperationKey(operationKey, "interrupt");
      const parsedError = v.parse(machineErrorSchema, error);
      transaction(() => {
        const result = database
          .prepare(
            "UPDATE operations SET status = 'failed', error_json = ? WHERE operation_key = ? AND status IN ('pending', 'dispatched') AND error_json IS NULL",
          )
          .run(stableJson(parsedError), operationKey);
        if (Number(result.changes) !== 1)
          throw new Error("Interrupt operation is not pending");
      });
    },
    recordInterruptOutcomeUnknown(operationKey, error) {
      operationKey = validatedOperationKey(operationKey, "interrupt");
      const parsedError = v.parse(machineErrorSchema, error);
      if (parsedError.code !== "operation_outcome_unknown")
        throw new Error("Interrupt outcome error has the wrong code");
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
          throw new Error(
            "Interrupt operation is not awaiting an unknown outcome",
          );
        }
      });
    },
    failResolvePermission(operationKey, error) {
      operationKey = validatedOperationKey(operationKey, "resolvePermission");
      const parsedError = v.parse(machineErrorSchema, error);
      transaction(() => {
        const result = database
          .prepare(
            "UPDATE operations SET status = 'failed', error_json = ? WHERE operation_key = ? AND status IN ('pending', 'dispatched') AND error_json IS NULL",
          )
          .run(stableJson(parsedError), operationKey);
        if (Number(result.changes) !== 1)
          throw new Error("Permission resolution operation is not pending");
      });
    },
    recordResolvePermissionOutcomeUnknown(operationKey, error) {
      operationKey = validatedOperationKey(operationKey, "resolvePermission");
      const parsedError = v.parse(machineErrorSchema, error);
      if (parsedError.code !== "operation_outcome_unknown")
        throw new Error(
          "Permission resolution outcome error has the wrong code",
        );
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
          throw new Error(
            "Permission resolution operation is not awaiting an unknown outcome",
          );
        }
      });
    },
    failKill(operationKey, error) {
      operationKey = validatedOperationKey(operationKey, "kill");
      const parsedError = v.parse(machineErrorSchema, error);
      transaction(() => {
        const result = database
          .prepare(
            "UPDATE operations SET status = 'failed', error_json = ? WHERE operation_key = ? AND status IN ('pending', 'dispatched') AND error_json IS NULL",
          )
          .run(stableJson(parsedError), operationKey);
        if (Number(result.changes) !== 1)
          throw new Error("Kill operation is not pending");
      });
    },
    recordKillOutcomeUnknown(operationKey, error) {
      operationKey = validatedOperationKey(operationKey, "kill");
      const parsedError = v.parse(machineErrorSchema, error);
      if (parsedError.code !== "operation_outcome_unknown")
        throw new Error("Kill outcome error has the wrong code");
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
          throw new Error("Kill operation is not awaiting an unknown outcome");
        }
      });
    },
    recordEvent(event, session) {
      const parsedEvent = v.parse(domainEventSchema, event);
      assertSessionRecordsAvailable(parsedEvent.sessionId);
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
    isOperationDeleted(operationKey) {
      assertOpen();
      operationKey = validatedOperationKey(operationKey);
      return (
        database
          .prepare(
            "SELECT operation_key FROM deleted_operations WHERE operation_key = ?",
          )
          .get(operationKey) !== undefined
      );
    },
    getSession(sessionId) {
      return readSession(sessionId);
    },
    getDeletedSession(sessionId) {
      return readDeletedSession(sessionId);
    },
    getSessionOwner(sessionId) {
      return (
        readSession(sessionId)?.consumer ??
        readDeletedSession(sessionId)?.consumer
      );
    },
    listSessions() {
      assertOpen();
      return (database.prepare("SELECT * FROM sessions").all() as SessionRow[])
        .map(sessionFromRow)
        .sort((left, right) =>
          left.info.spawnedAt.localeCompare(right.info.spawnedAt),
        );
    },
    deleteSessionRecords(input) {
      assertOpen();
      const sessionId = v.parse(sessionIdSchema, input.sessionId);
      const runtimeScopeId = v.parse(
        runtimeScopeIdSchema,
        input.runtimeScopeId,
      );
      const consumer = v.parse(consumerContextSchema, input.consumer);
      const currentGeneration = v.parse(
        daemonGenerationSchema,
        input.currentGeneration,
      );
      const knownOperationKeys = Array.from(
        new Set(
          (input.knownOperationKeys ?? []).map((value) =>
            validatedOperationKey(value),
          ),
        ),
      );
      for (const operationKey of knownOperationKeys) {
        const claims = parseOperationKey(operationKey);
        if (
          claims.runtimeScopeId !== runtimeScopeId ||
          claims.consumer !== consumer
        )
          throw new Error(
            "Deleted operation does not belong to its session owner",
          );
      }
      const existingTombstone = readDeletedSession(sessionId);
      if (existingTombstone !== undefined) {
        if (
          existingTombstone.runtimeScopeId !== runtimeScopeId ||
          existingTombstone.consumer !== consumer
        )
          return { status: "not_found" as const };
        return {
          status: "deleted" as const,
          session: existingTombstone,
          operationKeys: readDeletedOperationKeys(sessionId),
        };
      }

      return transaction(() => {
        const row = database
          .prepare("SELECT * FROM sessions WHERE session_id = ?")
          .get(sessionId) as SessionRow | undefined;
        if (row === undefined) return { status: "not_found" as const };
        const stored = sessionFromRow(row);
        if (
          stored.runtimeScopeId !== runtimeScopeId ||
          stored.consumer !== consumer
        )
          return { status: "not_found" as const };
        if (
          stored.info.state !== "killed" &&
          !input.unreachable &&
          stored.generation === currentGeneration
        )
          return { status: "live" as const };

        const deletedSession: DeletedSession = {
          sessionId,
          runtimeScopeId: stored.runtimeScopeId,
          consumer: stored.consumer,
          generation: stored.generation,
        };
        database
          .prepare(
            "INSERT INTO deleted_sessions(session_id, runtime_scope_id, consumer, generation) VALUES (?, ?, ?, ?)",
          )
          .run(
            deletedSession.sessionId,
            deletedSession.runtimeScopeId,
            deletedSession.consumer,
            deletedSession.generation,
          );

        const predicate = sessionOperationPredicate();
        const predicateValues = [
          runtimeScopeId,
          consumer,
          sessionId,
          sessionId,
          sessionId,
          sessionId,
          sessionId,
          sessionId,
        ];
        const operations = database
          .prepare(`SELECT operation_key FROM operations WHERE ${predicate}`)
          .all(...predicateValues) as Record<string, unknown>[];
        const operationKeys = operations.map((operationRow) =>
          v.parse(operationKeySchema, operationRow.operation_key),
        );
        for (const operationKey of knownOperationKeys)
          if (!operationKeys.includes(operationKey))
            operationKeys.push(operationKey);
        const insertDeletedOperation = database.prepare(
          "INSERT INTO deleted_operations(operation_key, session_id) VALUES (?, ?)",
        );
        for (const operationKey of operationKeys) {
          const existing = database
            .prepare(
              "SELECT session_id FROM deleted_operations WHERE operation_key = ?",
            )
            .get(operationKey) as { session_id: unknown } | undefined;
          if (existing !== undefined) {
            if (existing.session_id !== sessionId)
              throw new Error("Deleted operation belongs to another session");
            continue;
          }
          insertDeletedOperation.run(operationKey, sessionId);
        }

        database
          .prepare("DELETE FROM operations WHERE " + predicate)
          .run(...predicateValues);
        database
          .prepare("DELETE FROM session_events WHERE session_id = ?")
          .run(sessionId);
        database
          .prepare("DELETE FROM session_heads WHERE session_id = ?")
          .run(sessionId);
        database
          .prepare("DELETE FROM sessions WHERE session_id = ?")
          .run(sessionId);
        return {
          status: "deleted" as const,
          session: deletedSession,
          operationKeys,
        };
      });
    },
    sessionEvents(sessionId) {
      assertOpen();
      sessionId = v.parse(sessionIdSchema, sessionId);
      assertSessionRecordsAvailable(sessionId);
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
