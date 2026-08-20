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
  readonly repairs: DiagnosticsStoreHealth["repairs"];

  constructor(repairs: DiagnosticsStoreHealth["repairs"] = []) {
    this.repairs = repairs;
  }

  async append(record: DiagnosticRecord): Promise<void> {
    if (this.appendError !== undefined) throw this.appendError;
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
  }
}

async function openRuntime(
  store = new MemoryStore(),
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
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
