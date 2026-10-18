import { basename, dirname, join } from "node:path";

import {
  consumerContextSchema,
  diagnosticIdSchema,
  diagnosticRecordSchema,
  makeDiagnosticId,
  sessionIdSchema,
  textEvidenceSchema,
  turnIdSchema,
  utcMillisecondTimestampSchema,
  type ConsumerContext,
  type DiagnosticRecord,
  type DiagnosticsParams,
  type DiagnosticsResult,
  type RuntimeScopeId,
} from "@reins/protocol";
import * as v from "valibot";

import {
  LeaseGuardedDiagnosticsFilesystem,
  type BeforeDiagnosticsFileOperation,
  type DiagnosticsFileOperation,
} from "./diagnostics-store-filesystem.ts";
import {
  acquireAdvisoryFileLease,
  AdvisoryLockUnavailableError,
  type AdvisoryFileLease,
  type AdvisoryFileLeaseOptions,
} from "./diagnostics-store-lock.ts";

export type { DiagnosticsFileOperation };

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_SEGMENT_BYTES = 4 * 1024 * 1024;
const MAX_RECORD_BYTES = 256 * 1024;
const ACTIVE_FILE = "active.ndjson";
const LOCK_TARGET = "writer-lease";
const BOOTSTRAP_LOCK_TARGET = "diagnostics-bootstrap-lease";
const SEGMENT_PATTERN = /^segment-(\d{12})\.ndjson$/;
const MIGRATION_TEMP_SUFFIX = ".transport-migration";
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

const legacyV1TransportEntries = {
  source: v.literal("daemon"),
  harness: v.optional(v.pipe(v.string(), v.minLength(1))),
  v: v.literal(1),
  diagnosticId: diagnosticIdSchema,
  recordedAt: utcMillisecondTimestampSchema,
  severity: v.literal("error"),
  kind: v.literal("transport_failure"),
  operation: v.picklist(["listen", "connect", "read", "write", "close"]),
  reason: v.picklist(["io_error", "timeout", "disconnected"]),
  message: textEvidenceSchema,
} as const;

const legacyV1TransportFailureRecordSchema = v.pipe(
  v.union([
    v.strictObject(legacyV1TransportEntries),
    v.strictObject({
      ...legacyV1TransportEntries,
      sessionId: sessionIdSchema,
      turnId: v.optional(turnIdSchema),
    }),
  ]),
  v.check((record) => {
    switch (record.operation) {
      case "listen":
        return record.reason === "io_error";
      case "connect":
        return record.reason === "io_error" || record.reason === "timeout";
      case "read":
      case "write":
      case "close":
        return true;
    }
  }),
);

export type DiagnosticsStoreHealth =
  | {
      status: "healthy";
      repairs: readonly TailRepair[];
    }
  | {
      status: "degraded";
      operation: "append" | "query";
      cause: string;
      repairs: readonly TailRepair[];
    };

export type TailRepair = {
  kind: "tail_repaired";
  affectedBytes: number;
};

export interface DiagnosticsStore {
  append(record: DiagnosticRecord, consumer?: ConsumerContext): Promise<void>;
  query(
    params: DiagnosticsParams,
    scope?: ConsumerContext,
  ): Promise<DiagnosticsResult>;
  health(): DiagnosticsStoreHealth;
  close(): Promise<void>;
}

export type DiagnosticsStoreErrorCode =
  | "diagnostic_not_found"
  | "diagnostics_unavailable"
  | "diagnostics_store_corrupt"
  | "diagnostics_store_locked"
  | "invalid_configuration";

export class DiagnosticsStoreError extends Error {
  readonly code: DiagnosticsStoreErrorCode;

  constructor(code: DiagnosticsStoreErrorCode, message: string) {
    super(message);
    this.name = "DiagnosticsStoreError";
    this.code = code;
  }
}

export type DiagnosticsStoreOptions = {
  directory: string;
  runtimeScopeId?: RuntimeScopeId;
  maxAgeMs?: number;
  maxBytes?: number;
};

type InternalOptions = DiagnosticsStoreOptions & {
  now?: () => Date;
  segmentBytes?: number;
  stderr?: (message: string) => void;
  failAppend?: () => Error | undefined;
  failQuery?: () => Error | undefined;
  beforeQueryRead?: () => Promise<void>;
  beforeFileOperation?: BeforeDiagnosticsFileOperation;
  lock?: AdvisoryFileLeaseOptions;
};

type Segment = {
  path: string;
  records: StoredDiagnostic[];
  bytes: number;
};

type ParsedRecords = {
  records: StoredDiagnostic[];
  migratedLegacy: boolean;
};

// consumer 是 store 内部的归属元数据：随记录持久化，但不属于公开
// DiagnosticRecord，也不出现在任何查询结果里。
type StoredDiagnostic = {
  readonly record: DiagnosticRecord;
  readonly consumer?: ConsumerContext;
};

export function openDiagnosticsStore(
  options: DiagnosticsStoreOptions,
): Promise<DiagnosticsStore> {
  return openDiagnosticsStoreInternal(options);
}

/** @internal 仅供 store contract tests 使用。 */
export async function openDiagnosticsStoreInternal(
  options: InternalOptions,
): Promise<DiagnosticsStore> {
  const maxAgeMs = positiveInteger(
    options.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
    "maxAgeMs",
  );
  const maxBytes = positiveInteger(
    options.maxBytes ?? DEFAULT_MAX_BYTES,
    "maxBytes",
  );
  const segmentBytes = Math.min(
    positiveInteger(
      options.segmentBytes ?? DEFAULT_SEGMENT_BYTES,
      "segmentBytes",
    ),
    maxBytes,
  );
  const now = options.now ?? (() => new Date());
  const stderr =
    options.stderr ??
    ((message: string) => process.stderr.write(message + "\n"));

  const filesystem = await acquireStoreFilesystem(
    options.directory,
    options.lock,
    options.beforeFileOperation,
  );
  try {
    await ensurePrivateDirectory(options.directory, filesystem);
    const loaded = await loadFiles(
      options.directory,
      stderr,
      filesystem,
      options.runtimeScopeId,
    );
    const store = new RollingDiagnosticsStore({
      ...options,
      maxAgeMs,
      maxBytes,
      segmentBytes,
      now,
      stderr,
      filesystem,
      ...loaded,
    });
    await store.initializeRetention();
    // 上次 rename 后的目录 sync 可能失败；成功 open 必须重新跨过持久化屏障。
    await filesystem.syncDirectory(options.directory);
    return store;
  } catch (error) {
    await filesystem.close().catch(() => undefined);
    throw error;
  }
}

class RollingDiagnosticsStore implements DiagnosticsStore {
  readonly #directory: string;
  readonly #activePath: string;
  readonly #maxAgeMs: number;
  readonly #maxBytes: number;
  readonly #segmentBytes: number;
  readonly #now: () => Date;
  readonly #stderr: (message: string) => void;
  readonly #filesystem: LeaseGuardedDiagnosticsFilesystem;
  readonly #repairs: TailRepair[];
  readonly #failAppend: (() => Error | undefined) | undefined;
  readonly #failQuery: (() => Error | undefined) | undefined;
  readonly #beforeQueryRead: (() => Promise<void>) | undefined;
  #segments: Segment[];
  #activeRecords: StoredDiagnostic[];
  #activeBytes: number;
  #nextSegment: number;
  #visibleRecords: StoredDiagnostic[];
  #degraded: { operation: "append" | "query"; cause: string } | undefined;
  #closing = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(
    options: InternalOptions & {
      maxAgeMs: number;
      maxBytes: number;
      segmentBytes: number;
      now: () => Date;
      stderr: (message: string) => void;
      filesystem: LeaseGuardedDiagnosticsFilesystem;
      segments: Segment[];
      activeRecords: StoredDiagnostic[];
      activeBytes: number;
      nextSegment: number;
      repairs: TailRepair[];
    },
  ) {
    this.#directory = options.directory;
    this.#activePath = join(options.directory, ACTIVE_FILE);
    this.#maxAgeMs = options.maxAgeMs;
    this.#maxBytes = options.maxBytes;
    this.#segmentBytes = options.segmentBytes;
    this.#now = options.now;
    this.#stderr = options.stderr;
    this.#filesystem = options.filesystem;
    this.#segments = options.segments;
    this.#activeRecords = options.activeRecords;
    this.#activeBytes = options.activeBytes;
    this.#nextSegment = options.nextSegment;
    this.#repairs = options.repairs;
    this.#visibleRecords = [
      ...options.segments.flatMap((segment) => segment.records),
      ...options.activeRecords,
    ];
    this.#failAppend = options.failAppend;
    this.#failQuery = options.failQuery;
    this.#beforeQueryRead = options.beforeQueryRead;
  }

  async initializeRetention(): Promise<void> {
    await this.#assertAvailable("append");
    if (
      this.#activeRecords.length > 0 &&
      (this.#activeBytes > this.#segmentBytes ||
        this.#shouldRotateForAgeOrDate())
    ) {
      await this.#rotate();
    }
    await this.#enforceRetention();
    this.#publishAcceptedRecords();
  }

  append(record: DiagnosticRecord, consumer?: ConsumerContext): Promise<void> {
    if (this.#closing || this.#closed)
      return Promise.reject(new Error("Diagnostics store is closed"));
    const operation = this.#writeTail.then(() =>
      this.#append(record, consumer),
    );
    this.#writeTail = operation.catch(() => undefined);
    return operation;
  }

  query(
    params: DiagnosticsParams,
    scope?: ConsumerContext,
  ): Promise<DiagnosticsResult> {
    const snapshot = this.#queryableRecords();
    return this.#querySnapshot(params, snapshot, scope);
  }

  async #querySnapshot(
    params: DiagnosticsParams,
    snapshot: StoredDiagnostic[],
    scope?: ConsumerContext,
  ): Promise<DiagnosticsResult> {
    await this.#assertAvailable("query");
    const injected = this.#failQuery?.();
    if (injected !== undefined) {
      this.#degrade("query", injected);
      throw unavailableError();
    }
    await this.#beforeQueryRead?.();
    // 消费者范围与其他过滤作用于同一接纳快照，先于 latest limit 与 truncated。
    // 无归属记录是 daemon 全局事实，对所有消费者可见；只排除其他消费者的记录。
    const visible =
      scope === undefined
        ? snapshot
        : snapshot.filter(
            (stored) =>
              stored.consumer === undefined || stored.consumer === scope,
          );
    if ("diagnosticId" in params) {
      const found = visible.find(
        (stored) => stored.record.diagnosticId === params.diagnosticId,
      );
      if (found === undefined) {
        throw new DiagnosticsStoreError(
          "diagnostic_not_found",
          "Diagnostic record was not found",
        );
      }
      return { record: found.record };
    }

    const matching = visible.filter((stored) => matches(stored.record, params));
    const limit = params.limit ?? 100;
    const start = Math.max(0, matching.length - limit);
    return {
      records: matching.slice(start).map((stored) => stored.record),
      truncated: start > 0,
    };
  }

  health(): DiagnosticsStoreHealth {
    const repairs = this.#repairs.map((repair) => ({ ...repair }));
    return this.#degraded === undefined
      ? { status: "healthy", repairs }
      : { status: "degraded", ...this.#degraded, repairs };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#closePromise !== undefined) return await this.#closePromise;
    this.#closing = true;
    const attempt = (async () => {
      await this.#writeTail;
      await this.#filesystem.close();
      this.#closed = true;
    })();
    this.#closePromise = attempt;
    try {
      await attempt;
    } finally {
      if (this.#closePromise === attempt) this.#closePromise = undefined;
    }
  }

  async #append(
    record: DiagnosticRecord,
    consumer?: ConsumerContext,
  ): Promise<void> {
    await this.#assertAvailable("append", true);
    const injected = this.#failAppend?.();
    if (injected !== undefined) {
      this.#degrade("append", injected);
      throw unavailableError();
    }
    const parsed = v.safeParse(diagnosticRecordSchema, record);
    if (!parsed.success) throw new Error("Invalid diagnostic record");
    const stored: StoredDiagnostic =
      consumer === undefined
        ? { record: parsed.output }
        : { record: parsed.output, consumer };
    const serialized = serializeEntry(stored);
    if (Buffer.byteLength(serialized) > MAX_RECORD_BYTES) {
      throw new Error("Diagnostic record exceeds 256 KiB");
    }
    const line = serialized + "\n";
    const bytes = Buffer.byteLength(line);
    if (bytes > this.#maxBytes) {
      this.#degrade(
        "append",
        new Error("Diagnostic record exceeds configured store capacity"),
      );
      throw unavailableError();
    }

    if (
      this.#activeRecords.length > 0 &&
      (this.#activeBytes + bytes > this.#segmentBytes ||
        utcDate(this.#activeRecords[0]!.record.recordedAt) !==
          utcDate(parsed.output.recordedAt) ||
        this.#shouldRotateForAgeOrDate())
    ) {
      await this.#rotate();
    }

    try {
      await this.#filesystem.appendFile(this.#activePath, line, 0o600);
      await verifyMode(
        this.#filesystem,
        this.#activePath,
        0o600,
        "diagnostics file",
      );
    } catch (error) {
      this.#degrade("append", asError(error));
      throw unavailableError();
    }
    this.#activeRecords.push(stored);
    this.#activeBytes += bytes;
    await this.#enforceRetention();
    this.#publishAcceptedRecords();
  }

  #shouldRotateForAgeOrDate(): boolean {
    const first = this.#activeRecords[0];
    if (first === undefined) return false;
    const now = this.#now();
    return (
      utcDate(first.record.recordedAt) !== utcDate(now.toISOString()) ||
      Date.parse(first.record.recordedAt) <= now.getTime() - this.#maxAgeMs
    );
  }

  async #rotate(): Promise<void> {
    if (this.#activeRecords.length === 0) return;
    const segmentPath = join(
      this.#directory,
      `segment-${String(this.#nextSegment).padStart(12, "0")}.ndjson`,
    );
    try {
      await this.#filesystem.rename(this.#activePath, segmentPath);
      await verifyMode(
        this.#filesystem,
        segmentPath,
        0o600,
        "diagnostics segment",
      );
      await this.#filesystem.touch(this.#activePath, 0o600);
      await this.#filesystem.chmod(this.#activePath, 0o600);
      await verifyMode(
        this.#filesystem,
        this.#activePath,
        0o600,
        "diagnostics file",
      );
    } catch (error) {
      this.#degrade("append", asError(error));
      throw unavailableError();
    }
    this.#segments.push({
      path: segmentPath,
      records: this.#activeRecords,
      bytes: this.#activeBytes,
    });
    this.#activeRecords = [];
    this.#activeBytes = 0;
    this.#nextSegment += 1;
  }

  async #enforceRetention(): Promise<void> {
    const cutoff = this.#now().getTime() - this.#maxAgeMs;
    while (this.#segments.length > 0) {
      const oldest = this.#segments[0]!;
      const hasExpired = oldest.records.some(
        (stored) => Date.parse(stored.record.recordedAt) <= cutoff,
      );
      const overBytes = this.#totalBytes() > this.#maxBytes;
      if (!hasExpired && !overBytes) break;
      try {
        await this.#filesystem.unlink(oldest.path);
      } catch (error) {
        this.#degrade("append", asError(error));
        throw unavailableError();
      }
      this.#segments.shift();
    }
  }

  #totalBytes(): number {
    return (
      this.#activeBytes +
      this.#segments.reduce((total, segment) => total + segment.bytes, 0)
    );
  }

  #queryableRecords(): StoredDiagnostic[] {
    const cutoff = this.#now().getTime() - this.#maxAgeMs;
    return this.#visibleRecords.filter(
      (stored) => Date.parse(stored.record.recordedAt) > cutoff,
    );
  }

  #publishAcceptedRecords(): void {
    this.#visibleRecords = [
      ...this.#segments.flatMap((segment) => segment.records),
      ...this.#activeRecords,
    ];
  }

  async #assertAvailable(
    operation: "append" | "query",
    acceptedBeforeClose = false,
  ): Promise<void> {
    if (this.#degraded !== undefined) throw unavailableError();
    if ((this.#closing && !acceptedBeforeClose) || this.#closed) {
      throw new Error("Diagnostics store is closed");
    }
    try {
      await this.#filesystem.assertHeld();
    } catch (error) {
      this.#degrade(operation, asError(error));
      throw unavailableError();
    }
  }

  #degrade(operation: "append" | "query", error: Error): void {
    if (this.#degraded !== undefined) return;
    const cause = boundedMessage(error.message);
    this.#degraded = { operation, cause };
    this.#stderr(
      boundedMessage(`Diagnostics store ${operation} failed: ${cause}`),
    );
  }
}

function matches(
  record: DiagnosticRecord,
  filters: Exclude<DiagnosticsParams, { diagnosticId: unknown }>,
): boolean {
  const severity = ["debug", "info", "warning", "error"] as const;
  const sessionId = "sessionId" in record ? record.sessionId : undefined;
  const turnId = "turnId" in record ? record.turnId : undefined;
  const harness = "harness" in record ? record.harness : undefined;
  return (
    (filters.sessionId === undefined || sessionId === filters.sessionId) &&
    (filters.turnId === undefined || turnId === filters.turnId) &&
    (filters.harness === undefined || harness === filters.harness) &&
    (filters.sources === undefined ||
      filters.sources.includes(record.source)) &&
    (filters.kinds === undefined || filters.kinds.includes(record.kind)) &&
    (filters.minSeverity === undefined ||
      severity.indexOf(record.severity) >=
        severity.indexOf(filters.minSeverity)) &&
    (filters.since === undefined || record.recordedAt >= filters.since) &&
    (filters.until === undefined || record.recordedAt <= filters.until)
  );
}

async function loadFiles(
  directory: string,
  stderr: (message: string) => void,
  filesystem: LeaseGuardedDiagnosticsFilesystem,
  runtimeScopeId: RuntimeScopeId | undefined,
): Promise<{
  segments: Segment[];
  activeRecords: StoredDiagnostic[];
  activeBytes: number;
  nextSegment: number;
  repairs: TailRepair[];
}> {
  const entries = await filesystem.readdir(directory);
  const segmentNames = entries
    .filter((name) => SEGMENT_PATTERN.test(name))
    .sort();
  const segments: Segment[] = [];
  const migrations: Array<{
    path: string;
    records: StoredDiagnostic[];
  }> = [];
  let nextSegment = 0;
  for (const name of segmentNames) {
    const path = join(directory, name);
    await filesystem.chmod(path, 0o600);
    await verifyMode(filesystem, path, 0o600, "diagnostics segment");
    const bytes = await filesystem.readFile(path);
    if (bytes.length > 0 && bytes.at(-1) !== 0x0a)
      corrupt("Immutable segment has an incomplete line");
    const parsed = parseCompleteLines(bytes, name, runtimeScopeId);
    segments.push({
      path,
      records: parsed.records,
      bytes: bytes.length,
    });
    if (parsed.migratedLegacy) {
      migrations.push({ path, records: parsed.records });
    }
    const match = SEGMENT_PATTERN.exec(name)!;
    nextSegment = Math.max(nextSegment, Number(match[1]) + 1);
  }

  const activePath = join(directory, ACTIVE_FILE);
  await filesystem.touch(activePath, 0o600);
  await filesystem.chmod(activePath, 0o600);
  await verifyMode(filesystem, activePath, 0o600, "diagnostics file");
  let activeBytes = await filesystem.readFile(activePath);
  const repairs: TailRepair[] = [];
  if (activeBytes.length > 0 && activeBytes.at(-1) !== 0x0a) {
    const lastNewline = activeBytes.lastIndexOf(0x0a);
    const tailStart = lastNewline + 1;
    const tail = activeBytes.subarray(tailStart);
    let complete: unknown;
    try {
      complete = JSON.parse(strictUtf8.decode(tail));
    } catch {
      await filesystem.truncate(activePath, tailStart);
      const repair = {
        kind: "tail_repaired",
        affectedBytes: tail.length,
      } as const;
      repairs.push(repair);
      stderr(
        boundedMessage(
          `Diagnostics active tail truncated (${tail.length} bytes)`,
        ),
      );
      activeBytes = activeBytes.subarray(0, tailStart);
    }
    if (complete !== undefined) {
      parseRecord(complete, runtimeScopeId);
      await filesystem.appendFile(activePath, "\n", 0o600);
      repairs.push({ kind: "tail_repaired", affectedBytes: 0 });
      stderr("Diagnostics active record missing newline; newline restored");
      activeBytes = Buffer.concat([activeBytes, Buffer.from("\n")]);
    }
  }
  const parsedActive = parseCompleteLines(
    activeBytes,
    ACTIVE_FILE,
    runtimeScopeId,
  );
  if (parsedActive.migratedLegacy) {
    migrations.push({ path: activePath, records: parsedActive.records });
  }
  for (const migration of migrations) {
    const bytes = serializeRecords(migration.records);
    await filesystem.replaceFileAtomically(
      migration.path,
      migration.path + MIGRATION_TEMP_SUFFIX,
      bytes,
      0o600,
    );
    await verifyMode(
      filesystem,
      migration.path,
      0o600,
      migration.path === activePath
        ? "diagnostics file"
        : "diagnostics segment",
    );
    const segment = segments.find(
      (candidate) => candidate.path === migration.path,
    );
    if (segment !== undefined) segment.bytes = bytes.length;
    if (migration.path === activePath) activeBytes = bytes;
  }
  return {
    segments,
    activeRecords: parsedActive.records,
    activeBytes: activeBytes.length,
    nextSegment,
    repairs,
  };
}

function parseCompleteLines(
  bytes: Buffer,
  file: string,
  runtimeScopeId: RuntimeScopeId | undefined,
): ParsedRecords {
  let text: string;
  try {
    text = strictUtf8.decode(bytes);
  } catch {
    corrupt(`Invalid UTF-8 in ${file}`);
  }
  if (text.length === 0) return { records: [], migratedLegacy: false };
  const lines = text.endsWith("\n")
    ? text.slice(0, -1).split("\n")
    : text.split("\n");
  let migratedLegacy = false;
  const records = lines.map((line) => {
    try {
      const parsed = parseRecordWithMigration(JSON.parse(line), runtimeScopeId);
      migratedLegacy ||= parsed.migratedLegacy;
      return parsed.record;
    } catch (error) {
      if (error instanceof DiagnosticsStoreError) throw error;
      corrupt(`Invalid diagnostic record in ${file}`);
    }
  });
  return { records, migratedLegacy };
}

function parseRecord(
  input: unknown,
  runtimeScopeId: RuntimeScopeId | undefined,
): StoredDiagnostic {
  return parseRecordWithMigration(input, runtimeScopeId).record;
}

// store 内部的归属键：从持久化行里剥离，不进入公开 DiagnosticRecord。
function splitOwnership(input: unknown): {
  payload: unknown;
  consumer?: ConsumerContext;
} {
  if (typeof input !== "object" || input === null) return { payload: input };
  if (!("consumer" in input)) return { payload: input };
  const { consumer, ...rest } = input as Record<string, unknown>;
  const parsed = v.safeParse(consumerContextSchema, consumer);
  if (!parsed.success) {
    corrupt("Diagnostic record has an invalid consumer binding");
  }
  return { payload: rest, consumer: parsed.output };
}

function parseRecordWithMigration(
  input: unknown,
  runtimeScopeId: RuntimeScopeId | undefined,
): {
  record: StoredDiagnostic;
  migratedLegacy: boolean;
} {
  const { payload, consumer } = splitOwnership(input);
  if (typeof payload !== "object" || payload === null || !("v" in payload)) {
    corrupt("Diagnostic record has no schema version");
  }
  switch (payload.v) {
    case 1:
      break;
    default:
      corrupt("Diagnostic record has an unknown schema version");
  }
  const migratedIdentity = rewriteLegacyDiagnosticId(payload, runtimeScopeId);
  const parsed = v.safeParse(diagnosticRecordSchema, migratedIdentity.payload);
  if (parsed.success) {
    return {
      record:
        consumer === undefined
          ? { record: parsed.output }
          : { record: parsed.output, consumer },
      migratedLegacy: migratedIdentity.migrated,
    };
  }
  const legacy = v.safeParse(
    legacyV1TransportFailureRecordSchema,
    migratedIdentity.payload,
  );
  if (!legacy.success) corrupt("Diagnostic record does not match schema v1");
  const migrated = { ...legacy.output };
  Reflect.deleteProperty(migrated, "message");
  const current = v.safeParse(diagnosticRecordSchema, migrated);
  if (!current.success) corrupt("Diagnostic record does not match schema v1");
  return {
    record:
      consumer === undefined
        ? { record: current.output }
        : { record: current.output, consumer },
    migratedLegacy: true,
  };
}

function rewriteLegacyDiagnosticId(
  payload: object,
  runtimeScopeId: RuntimeScopeId | undefined,
): { payload: object; migrated: boolean } {
  if (!("diagnosticId" in payload) || typeof payload.diagnosticId !== "string")
    return { payload, migrated: false };
  const match = /^diagnostic:([a-z0-9]+):([1-9a-z][0-9a-z]*)$/u.exec(
    payload.diagnosticId,
  );
  if (match === null) return { payload, migrated: false };
  if (runtimeScopeId === undefined) {
    corrupt("Legacy diagnostic identity has no runtime scope");
  }
  const [, generation, counter] = match;
  return {
    payload: {
      ...payload,
      diagnosticId: makeDiagnosticId(runtimeScopeId, generation!, counter!),
    },
    migrated: true,
  };
}

function serializeEntry(stored: StoredDiagnostic): string {
  return JSON.stringify(
    stored.consumer === undefined
      ? stored.record
      : { ...stored.record, consumer: stored.consumer },
  );
}

function serializeRecords(records: readonly StoredDiagnostic[]): Buffer {
  if (records.length === 0) return Buffer.alloc(0);
  return Buffer.from(
    `${records.map((stored) => serializeEntry(stored)).join("\n")}\n`,
  );
}

async function ensurePrivateDirectory(
  directory: string,
  filesystem: LeaseGuardedDiagnosticsFilesystem,
): Promise<void> {
  await filesystem.mkdir(directory, 0o700);
  await filesystem.chmod(directory, 0o700);
  await verifyMode(filesystem, directory, 0o700, "diagnostics directory");
}

async function acquireLock(
  directory: string,
  options: AdvisoryFileLeaseOptions | undefined,
): Promise<AdvisoryFileLease> {
  return await acquireNamedLock(join(directory, LOCK_TARGET), options);
}

async function acquireStoreFilesystem(
  directory: string,
  options: AdvisoryFileLeaseOptions | undefined,
  beforeOperation: BeforeDiagnosticsFileOperation | undefined,
): Promise<LeaseGuardedDiagnosticsFilesystem> {
  const bootstrapLease = await acquireNamedLock(
    join(
      dirname(directory),
      `.${basename(directory)}.${BOOTSTRAP_LOCK_TARGET}`,
    ),
    withoutAcquisitionHook(options),
  );
  const bootstrapFilesystem = new LeaseGuardedDiagnosticsFilesystem(
    bootstrapLease,
    beforeOperation,
  );
  let writerLease: AdvisoryFileLease | undefined;
  try {
    await bootstrapFilesystem.mkdir(directory, 0o700);
    writerLease = await acquireLock(directory, options);
    await bootstrapFilesystem.assertHeld();
    await bootstrapFilesystem.close();
    return new LeaseGuardedDiagnosticsFilesystem(writerLease, beforeOperation);
  } catch (error) {
    await writerLease?.close().catch(() => undefined);
    await bootstrapFilesystem.close().catch(() => undefined);
    throw error;
  }
}

function withoutAcquisitionHook(
  options: AdvisoryFileLeaseOptions | undefined,
): AdvisoryFileLeaseOptions | undefined {
  if (options?.afterLockAcquired === undefined) return options;
  const { afterLockAcquired: _afterLockAcquired, ...bootstrapOptions } =
    options;
  return bootstrapOptions;
}

async function acquireNamedLock(
  path: string,
  options: AdvisoryFileLeaseOptions | undefined,
): Promise<AdvisoryFileLease> {
  try {
    return await acquireAdvisoryFileLease(path, options);
  } catch (error) {
    if (error instanceof AdvisoryLockUnavailableError) {
      throw new DiagnosticsStoreError(
        "diagnostics_store_locked",
        "Diagnostics store already has a writer",
      );
    }
    throw error;
  }
}

async function verifyMode(
  filesystem: LeaseGuardedDiagnosticsFilesystem,
  path: string,
  expected: number,
  label: string,
): Promise<void> {
  const mode = (await filesystem.mode(path)) & 0o777;
  if (mode !== expected)
    throw new Error(`${label} must have mode ${expected.toString(8)}`);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DiagnosticsStoreError(
      "invalid_configuration",
      `${name} must be a positive integer`,
    );
  }
  return value;
}

function utcDate(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function boundedMessage(message: string): string {
  const bytes = Buffer.from(message);
  if (bytes.length <= 4096) return message;
  for (let end = 4096; end > 0; end -= 1) {
    try {
      return strictUtf8.decode(bytes.subarray(0, end));
    } catch {
      // 仅回退到前一个完整 UTF-8 边界。
    }
  }
  return "";
}

function unavailableError(): DiagnosticsStoreError {
  return new DiagnosticsStoreError(
    "diagnostics_unavailable",
    "Diagnostics store is unavailable",
  );
}

function corrupt(message: string): never {
  throw new DiagnosticsStoreError("diagnostics_store_corrupt", message);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
