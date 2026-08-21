import { basename, dirname, join } from "node:path";

import {
  diagnosticRecordSchema,
  type DiagnosticRecord,
  type DiagnosticsParams,
  type DiagnosticsResult,
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
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

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
  append(record: DiagnosticRecord): Promise<void>;
  query(params: DiagnosticsParams): Promise<DiagnosticsResult>;
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
  records: DiagnosticRecord[];
  bytes: number;
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
    const loaded = await loadFiles(options.directory, stderr, filesystem);
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
  #activeRecords: DiagnosticRecord[];
  #activeBytes: number;
  #nextSegment: number;
  #visibleRecords: DiagnosticRecord[];
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
      activeRecords: DiagnosticRecord[];
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

  append(record: DiagnosticRecord): Promise<void> {
    if (this.#closing || this.#closed)
      return Promise.reject(new Error("Diagnostics store is closed"));
    const operation = this.#writeTail.then(() => this.#append(record));
    this.#writeTail = operation.catch(() => undefined);
    return operation;
  }

  query(params: DiagnosticsParams): Promise<DiagnosticsResult> {
    const snapshot = this.#queryableRecords();
    return this.#querySnapshot(params, snapshot);
  }

  async #querySnapshot(
    params: DiagnosticsParams,
    snapshot: DiagnosticRecord[],
  ): Promise<DiagnosticsResult> {
    await this.#assertAvailable("query");
    const injected = this.#failQuery?.();
    if (injected !== undefined) {
      this.#degrade("query", injected);
      throw unavailableError();
    }
    await this.#beforeQueryRead?.();
    if ("diagnosticId" in params) {
      const found = snapshot.find(
        (record) => record.diagnosticId === params.diagnosticId,
      );
      if (found === undefined) {
        throw new DiagnosticsStoreError(
          "diagnostic_not_found",
          "Diagnostic record was not found",
        );
      }
      return { record: found };
    }

    const matching = snapshot.filter((record) => matches(record, params));
    const limit = params.limit ?? 100;
    const start = Math.max(0, matching.length - limit);
    return {
      records: matching.slice(start),
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

  async #append(record: DiagnosticRecord): Promise<void> {
    await this.#assertAvailable("append", true);
    const injected = this.#failAppend?.();
    if (injected !== undefined) {
      this.#degrade("append", injected);
      throw unavailableError();
    }
    const parsed = v.safeParse(diagnosticRecordSchema, record);
    if (!parsed.success) throw new Error("Invalid diagnostic record");
    const serialized = JSON.stringify(parsed.output);
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
        utcDate(this.#activeRecords[0]!.recordedAt) !==
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
    this.#activeRecords.push(parsed.output);
    this.#activeBytes += bytes;
    await this.#enforceRetention();
    this.#publishAcceptedRecords();
  }

  #shouldRotateForAgeOrDate(): boolean {
    const first = this.#activeRecords[0];
    if (first === undefined) return false;
    const now = this.#now();
    return (
      utcDate(first.recordedAt) !== utcDate(now.toISOString()) ||
      Date.parse(first.recordedAt) <= now.getTime() - this.#maxAgeMs
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
        (record) => Date.parse(record.recordedAt) <= cutoff,
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

  #queryableRecords(): DiagnosticRecord[] {
    const cutoff = this.#now().getTime() - this.#maxAgeMs;
    return this.#visibleRecords.filter(
      (record) => Date.parse(record.recordedAt) > cutoff,
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
): Promise<{
  segments: Segment[];
  activeRecords: DiagnosticRecord[];
  activeBytes: number;
  nextSegment: number;
  repairs: TailRepair[];
}> {
  const entries = await filesystem.readdir(directory);
  const segmentNames = entries
    .filter((name) => SEGMENT_PATTERN.test(name))
    .sort();
  const segments: Segment[] = [];
  let nextSegment = 0;
  for (const name of segmentNames) {
    const path = join(directory, name);
    await filesystem.chmod(path, 0o600);
    await verifyMode(filesystem, path, 0o600, "diagnostics segment");
    const bytes = await filesystem.readFile(path);
    if (bytes.length > 0 && bytes.at(-1) !== 0x0a)
      corrupt("Immutable segment has an incomplete line");
    segments.push({
      path,
      records: parseCompleteLines(bytes, name),
      bytes: bytes.length,
    });
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
      parseRecord(complete);
      await filesystem.appendFile(activePath, "\n", 0o600);
      repairs.push({ kind: "tail_repaired", affectedBytes: 0 });
      stderr("Diagnostics active record missing newline; newline restored");
      activeBytes = Buffer.concat([activeBytes, Buffer.from("\n")]);
    }
  }
  return {
    segments,
    activeRecords: parseCompleteLines(activeBytes, ACTIVE_FILE),
    activeBytes: activeBytes.length,
    nextSegment,
    repairs,
  };
}

function parseCompleteLines(bytes: Buffer, file: string): DiagnosticRecord[] {
  let text: string;
  try {
    text = strictUtf8.decode(bytes);
  } catch {
    corrupt(`Invalid UTF-8 in ${file}`);
  }
  if (text.length === 0) return [];
  const lines = text.endsWith("\n")
    ? text.slice(0, -1).split("\n")
    : text.split("\n");
  return lines.map((line) => {
    try {
      return parseRecord(JSON.parse(line));
    } catch (error) {
      if (error instanceof DiagnosticsStoreError) throw error;
      corrupt(`Invalid diagnostic record in ${file}`);
    }
  });
}

function parseRecord(input: unknown): DiagnosticRecord {
  if (typeof input !== "object" || input === null || !("v" in input)) {
    corrupt("Diagnostic record has no schema version");
  }
  switch (input.v) {
    case 1:
      break;
    default:
      corrupt("Diagnostic record has an unknown schema version");
  }
  const parsed = v.safeParse(diagnosticRecordSchema, input);
  if (!parsed.success) corrupt("Diagnostic record does not match schema v1");
  return parsed.output;
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
