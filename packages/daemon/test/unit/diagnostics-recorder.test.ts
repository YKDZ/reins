import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  DiagnosticRecord,
  DiagnosticsParams,
  DiagnosticsResult,
  SessionName,
} from "@reins/protocol";
import {
  diagnosticRecordSchema,
  makeDiagnosticId,
  sessionNameSchema,
} from "@reins/protocol";
import * as v from "valibot";
import { afterEach, describe, expect, test } from "vitest";

import { openDiagnosticsRuntimeForTest } from "../../src/diagnostics-recorder.testing.ts";
import type { DiagnosticsRuntime } from "../../src/diagnostics-recorder.ts";
import { openDiagnosticsStoreForTest } from "../../src/diagnostics-store.testing.ts";
import type {
  DiagnosticsStore,
  DiagnosticsStoreHealth,
} from "../../src/diagnostics-store.ts";
import { DiagnosticsStoreError } from "../../src/diagnostics-store.ts";
import { openDiagnosticsStore } from "../../src/diagnostics-store.ts";
import { daemonGenerationSchema } from "../../src/generation.ts";
import type { DaemonState } from "../../src/state.ts";

const state: DaemonState = {
  directory: "/state",
  diagnosticsDirectory: "/state/diagnostics",
  durable: true,
  retention: { maxAgeMs: 1, maxBytes: 1 },
};
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reins-recorder-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function input() {
  return {
    source: "daemon",
    kind: "lifecycle",
    operation: "daemon",
    reason: "started",
  } as const;
}

class MemoryStore implements DiagnosticsStore {
  records: DiagnosticRecord[] = [];
  closed = 0;
  appendError: Error | undefined;
  queryError: Error | undefined;
  closeError: Error | undefined;
  appendGate: Promise<void> | undefined;
  readonly repairs: DiagnosticsStoreHealth["repairs"];

  constructor(repairs: DiagnosticsStoreHealth["repairs"] = []) {
    this.repairs = repairs;
  }

  async append(record: DiagnosticRecord): Promise<void> {
    if (this.appendError !== undefined) throw this.appendError;
    await this.appendGate;
    this.records.push(record);
  }

  async query(params: DiagnosticsParams): Promise<DiagnosticsResult> {
    if (this.queryError !== undefined) throw this.queryError;
    if ("diagnosticId" in params) {
      const record = this.records.find(
        (candidate) => candidate.diagnosticId === params.diagnosticId,
      );
      if (record === undefined) {
        throw new DiagnosticsStoreError(
          "diagnostic_not_found",
          "Diagnostic record was not found",
        );
      }
      return { record };
    }
    return { records: this.records, truncated: false };
  }

  health(): DiagnosticsStoreHealth {
    return { status: "healthy", repairs: this.repairs };
  }

  async close(): Promise<void> {
    this.closed += 1;
    if (this.closeError !== undefined) throw this.closeError;
  }
}

async function openRuntime(
  store: DiagnosticsStore = new MemoryStore(),
): Promise<DiagnosticsRuntime> {
  return await openDiagnosticsRuntimeForTest({
    resolveState: async () => state,
    openStore: async () => store,
    allocateGeneration: async () => v.parse(daemonGenerationSchema, "a"),
    now: () => new Date("2026-08-20T00:00:00.000Z"),
    stderr: () => {},
  });
}

describe("DiagnosticsRuntime", () => {
  test("accepts a normalized fact only after it is immediately queryable", async () => {
    const runtime = await openRuntime();

    const diagnosticId = await runtime.record(input());

    expect(diagnosticId).toBeDefined();
    const result = await runtime.query({ diagnosticId: diagnosticId! });
    expect("record" in result && result.record).toMatchObject({
      v: 1,
      diagnosticId,
      recordedAt: "2026-08-20T00:00:00.000Z",
      severity: "info",
      ...input(),
    });
    expect(
      v.safeParse(
        diagnosticRecordSchema,
        "record" in result ? result.record : undefined,
      ).success,
    ).toBe(true);
    await runtime.close();
  });

  test("close commits one diagnostics store closed record before releasing storage", async () => {
    const store = new MemoryStore();
    const runtime = await openRuntime(store);

    await runtime.close();

    expect(store.records).toEqual([
      expect.objectContaining({
        severity: "info",
        source: "daemon",
        kind: "lifecycle",
        operation: "diagnostics_store",
        reason: "closed",
      }),
    ]);
    expect(store.closed).toBe(1);
    await expect(runtime.record(input())).resolves.toBeUndefined();
  });

  test("close rejects new records and flushes already accepted work before closed", async () => {
    const store = new MemoryStore();
    let releaseAppend!: () => void;
    store.appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const runtime = await openRuntime(store);

    const accepted = runtime.record(input());
    await Promise.resolve();
    const closing = runtime.close();
    await expect(runtime.record(input())).resolves.toBeUndefined();
    expect(store.records).toEqual([]);

    releaseAppend();
    await expect(accepted).resolves.toBeDefined();
    await expect(closing).resolves.toBeUndefined();
    expect(store.records.map((record) => record.reason)).toEqual([
      "started",
      "closed",
    ]);
  });

  test("close failure before the logical commit does not pre-report closed", async () => {
    const store = new MemoryStore();
    store.appendError = new Error("closed append failed");
    const runtime = await openRuntime(store);

    await expect(runtime.close()).rejects.toThrow(
      "Diagnostics store close lifecycle was not accepted",
    );
    expect(store.records).toEqual([]);
    expect(store.closed).toBe(0);
  });

  test("close retry releases storage without duplicating the logical closed commit", async () => {
    const store = new MemoryStore();
    store.closeError = new Error("lease release failed");
    const runtime = await openRuntime(store);

    await expect(runtime.close()).rejects.toThrow("lease release failed");
    expect(
      store.records.filter((record) => record.reason === "closed"),
    ).toHaveLength(1);
    store.closeError = undefined;
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(
      store.records.filter((record) => record.reason === "closed"),
    ).toHaveLength(1);
    expect(store.closed).toBe(2);
  });

  test.skipIf(process.platform !== "linux")(
    "close retries a real writer lease without duplicating the logical closed commit",
    async () => {
      const directory = await temporaryDirectory();
      const store = await openDiagnosticsStoreForTest({ directory });
      const runtime = await openRuntime(store);
      const blocker = join(directory, "writer-lease.lock", "blocks-rmdir");
      await appendFile(blocker, "failure");

      await expect(runtime.close()).rejects.toMatchObject({
        code: "LOCK_SYSTEM_ERROR",
      });
      await rm(blocker);
      await expect(runtime.close()).resolves.toBeUndefined();
      await expect(runtime.close()).resolves.toBeUndefined();

      const reopened = await openDiagnosticsStoreForTest({ directory });
      const result = await reopened.query({
        sources: ["daemon"],
        kinds: ["lifecycle"],
      });
      expect("records" in result ? result.records : []).toEqual([
        expect.objectContaining({
          operation: "diagnostics_store",
          reason: "closed",
        }),
      ]);
      await reopened.close();
    },
  );

  test("keeps diagnostic counter monotonic across rejected records", async () => {
    const store = new MemoryStore();
    const runtime = await openRuntime(store);

    expect(
      await Reflect.apply(runtime.record.bind(runtime), undefined, [
        { source: "daemon" },
      ]),
    ).toBeUndefined();
    const diagnosticId = await runtime.record(input());

    expect(diagnosticId).toMatch(/^da-2/);
    await runtime.close();
  });

  test("reports each schema rejection once without degrading healthy storage", async () => {
    const store = new MemoryStore();
    const stderr: string[] = [];
    let validEnvelope = false;
    const runtime = await openDiagnosticsRuntimeForTest({
      resolveState: async () => state,
      openStore: async () => store,
      allocateGeneration: async () => v.parse(daemonGenerationSchema, "a"),
      now: () =>
        validEnvelope
          ? new Date("2026-08-20T00:00:00.000Z")
          : ({ toISOString: () => "not-a-timestamp" } as Date),
      stderr: (message) => stderr.push(message),
    });

    expect(
      await Reflect.apply(runtime.record.bind(runtime), undefined, [
        { source: "daemon" },
      ]),
    ).toBeUndefined();
    expect(
      await Reflect.apply(runtime.record.bind(runtime), undefined, [
        { source: "daemon" },
      ]),
    ).toBeUndefined();
    expect(await runtime.record(input())).toBeUndefined();
    expect(await runtime.record(input())).toBeUndefined();
    validEnvelope = true;
    await expect(runtime.record(input())).resolves.toBeDefined();

    expect(stderr).toEqual([
      "Diagnostics recorder rejected invalid diagnostic input",
      "Diagnostics recorder rejected invalid diagnostic record",
    ]);
    expect(stderr.every((message) => Buffer.byteLength(message) <= 4096)).toBe(
      true,
    );
    expect(store.records).toHaveLength(1);
    expect(runtime.health()).toEqual({ status: "healthy", repairs: [] });
    await runtime.close();
  });

  test("schema reporting failure is isolated from recorder control flow", async () => {
    const store = new MemoryStore();
    const runtime = await openDiagnosticsRuntimeForTest({
      resolveState: async () => state,
      openStore: async () => store,
      allocateGeneration: async () => v.parse(daemonGenerationSchema, "a"),
      stderr: () => {
        throw new Error("stderr unavailable");
      },
    });

    await expect(
      Reflect.apply(runtime.record.bind(runtime), undefined, [
        { source: "daemon" },
      ]),
    ).resolves.toBeUndefined();
    await expect(runtime.record(input())).resolves.toBeDefined();
    expect(runtime.health()).toEqual({ status: "healthy", repairs: [] });
    expect(store.records).toHaveLength(1);
    await runtime.close();
  });

  test("isolates append failure, reports it once, and does not retry a degraded store", async () => {
    const store = new MemoryStore();
    store.appendError = new Error("write failed");
    const stderr: string[] = [];
    const runtime = await openDiagnosticsRuntimeForTest({
      resolveState: async () => state,
      openStore: async () => store,
      allocateGeneration: async () => v.parse(daemonGenerationSchema, "a"),
      stderr: (message) => stderr.push(message),
    });

    expect(await runtime.record(input())).toBeUndefined();
    expect(await runtime.record(input())).toBeUndefined();

    expect(stderr).toEqual([
      expect.stringMatching(/^Diagnostics recorder append failed:/),
    ]);
    expect(runtime.health().status).toBe("degraded");
    await runtime.close();
  });

  test("marks query failure degraded without retrying diagnostics writes", async () => {
    const store = new MemoryStore();
    store.queryError = new Error("query failed");
    const stderr: string[] = [];
    const runtime = await openDiagnosticsRuntimeForTest({
      resolveState: async () => state,
      openStore: async () => store,
      allocateGeneration: async () => v.parse(daemonGenerationSchema, "a"),
      stderr: (message) => stderr.push(message),
    });

    await expect(runtime.query({})).rejects.toThrow("query failed");
    expect(runtime.health()).toMatchObject({
      status: "degraded",
      operation: "query",
    });
    expect(await runtime.record(input())).toBeUndefined();
    expect(stderr).toEqual([
      expect.stringMatching(/^Diagnostics recorder query failed:/),
    ]);
    await runtime.close();
  });

  test("a normal diagnostic miss keeps health healthy and recording available", async () => {
    const store = new MemoryStore();
    const runtime = await openRuntime(store);

    await expect(
      runtime.query({
        diagnosticId: v.parse(diagnosticRecordSchema, {
          ...input(),
          v: 1,
          diagnosticId: makeDiagnosticId("a", "1"),
          recordedAt: "2026-08-20T00:00:00.000Z",
          severity: "info",
        }).diagnosticId,
      }),
    ).rejects.toMatchObject({ code: "diagnostic_not_found" });
    expect(runtime.health().status).toBe("healthy");
    expect(await runtime.record(input())).toBeDefined();
    await runtime.close();
  });

  test("records each startup tail repair exactly once", async () => {
    const store = new MemoryStore([
      { kind: "tail_repaired", affectedBytes: 12 },
    ]);
    const runtime = await openRuntime(store);

    expect(store.records).toHaveLength(1);
    expect(store.records[0]).toMatchObject({
      kind: "storage_failure",
      operation: "recover",
      reason: "tail_repaired",
      affectedBytes: 12,
      severity: "warning",
    });
    await expect(
      runtime.query({ diagnosticId: store.records[0]!.diagnosticId }),
    ).resolves.toEqual({ record: store.records[0] });
    await runtime.close();
  });

  test("fails startup and releases the store when a tail repair cannot be accepted", async () => {
    const store = new MemoryStore([
      { kind: "tail_repaired", affectedBytes: 12 },
    ]);
    store.appendError = new Error("repair append failed");

    await expect(openRuntime(store)).rejects.toThrow(
      "Startup tail repair was not accepted",
    );
    expect(store.closed).toBe(1);
  });

  test("a real tail-repair acceptance failure releases the OS writer lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "reins-recorder-repair-"));
    temporaryDirectories.push(root);
    const diagnosticsDirectory = join(root, "diagnostics");
    const initial = await openDiagnosticsStore({
      directory: diagnosticsDirectory,
    });
    await initial.close();
    await appendFile(join(diagnosticsDirectory, "active.ndjson"), '{"v":1');
    const localState: DaemonState = {
      directory: root,
      diagnosticsDirectory,
      durable: true,
      retention: { maxAgeMs: 1000, maxBytes: 1 },
    };

    await expect(
      openDiagnosticsRuntimeForTest({
        resolveState: async () => localState,
        openStore: async () =>
          openDiagnosticsStoreForTest({
            directory: diagnosticsDirectory,
            maxBytes: 1,
            stderr: () => {},
          }),
        allocateGeneration: async () => v.parse(daemonGenerationSchema, "a"),
        stderr: () => {},
      }),
    ).rejects.toThrow("Startup tail repair was not accepted");

    const reopened = await openDiagnosticsStore({
      directory: diagnosticsDirectory,
    });
    await reopened.close();
  });

  test("closes the acquired store when generation allocation fails", async () => {
    const store = new MemoryStore();

    await expect(
      openDiagnosticsRuntimeForTest({
        resolveState: async () => state,
        openStore: async () => store,
        allocateGeneration: async () => {
          throw new Error("allocation failed");
        },
        stderr: () => {},
      }),
    ).rejects.toThrow("allocation failed");

    expect(store.closed).toBe(1);
  });

  test("constructs session IDs and closes idempotently", async () => {
    const store = new MemoryStore();
    const runtime = await openRuntime(store);

    expect(
      runtime.sessionId(v.parse(sessionNameSchema, "reviewer") as SessionName),
    ).toBe("reviewer@ga");
    await runtime.close();
    await runtime.close();
    expect(store.closed).toBe(1);
  });
});
