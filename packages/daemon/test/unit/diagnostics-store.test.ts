import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  diagnosticRecordSchema,
  makeDiagnosticId,
  sessionIdSchema,
  turnIdSchema,
  type DiagnosticRecord,
} from "@reins/protocol";
import * as v from "valibot";
import { afterEach, describe, expect, test } from "vitest";

import { openDiagnosticsStoreForTest } from "../../src/diagnostics-store.testing.ts";
import {
  DiagnosticsStoreError,
  openDiagnosticsStore,
} from "../../src/diagnostics-store.ts";
import { withChildHarness } from "../helpers/child-process.ts";

const temporaryDirectories: string[] = [];

async function temporaryStoreDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reins-diagnostics-store-"));
  temporaryDirectories.push(directory);
  return join(directory, "diagnostics");
}

function record(counter: string, recordedAt: string): DiagnosticRecord {
  return v.parse(diagnosticRecordSchema, {
    source: "daemon",
    kind: "lifecycle",
    operation: "daemon",
    reason: "started",
    v: 1,
    diagnosticId: makeDiagnosticId("1", counter),
    recordedAt,
    severity: "info",
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DiagnosticsStore contract", () => {
  test("accepted records are immediately queryable and survive restart", async () => {
    const directory = await temporaryStoreDirectory();
    const first = record("1", "2026-08-20T00:00:00.000Z");
    const second = record("2", "2026-08-20T00:00:01.000Z");
    const store = await openDiagnosticsStore({ directory });

    await store.append(first);
    await store.append(second);
    await expect(
      store.query({ diagnosticId: first.diagnosticId }),
    ).resolves.toEqual({
      record: first,
    });
    await expect(store.query({})).resolves.toEqual({
      records: [first, second],
      truncated: false,
    });
    await store.close();

    const reopened = await openDiagnosticsStore({ directory });
    await expect(reopened.query({})).resolves.toEqual({
      records: [first, second],
      truncated: false,
    });
    await reopened.close();
  });

  test("filter dimensions compose as OR within and AND across dimensions", async () => {
    const directory = await temporaryStoreDirectory();
    const store = await openDiagnosticsStore({ directory });
    const sessionId = v.parse(sessionIdSchema, "reviewer@g1");
    const turnId = v.parse(turnIdSchema, "t1");
    const matching = v.parse(diagnosticRecordSchema, {
      source: "adapter",
      harness: "codex",
      sessionId,
      turnId,
      kind: "stream_failure",
      operation: "receive_worker_stream",
      reason: "read_error",
      message: { text: "failed", truncated: false, originalBytes: 6 },
      v: 1,
      diagnosticId: makeDiagnosticId("1", "3"),
      recordedAt: "2026-08-20T00:00:02.000Z",
      severity: "error",
    });
    await store.append(record("1", "2026-08-20T00:00:00.000Z"));
    await store.append(matching);

    await expect(
      store.query({
        sessionId,
        turnId,
        harness: "codex",
        sources: ["core", "adapter"],
        kinds: ["mapping_gap", "stream_failure"],
        minSeverity: "warning",
        since: "2026-08-20T00:00:02.000Z",
        until: "2026-08-20T00:00:02.000Z",
      }),
    ).resolves.toEqual({ records: [matching], truncated: false });
    await store.close();
  });

  test("limit selects the latest accepted records and returns them in accept order", async () => {
    const directory = await temporaryStoreDirectory();
    const store = await openDiagnosticsStore({ directory });
    const first = record("1", "2026-08-20T00:00:03.000Z");
    const second = record("2", "2026-08-20T00:00:01.000Z");
    const third = record("3", "2026-08-20T00:00:02.000Z");
    await store.append(first);
    await store.append(second);
    await store.append(third);

    await expect(store.query({ limit: 2 })).resolves.toEqual({
      records: [second, third],
      truncated: true,
    });
    await expect(
      store.query({ sources: ["adapter"], limit: 1 }),
    ).resolves.toEqual({ records: [], truncated: false });
    await expect(
      store.query({ diagnosticId: makeDiagnosticId("1", "missing") }),
    ).rejects.toMatchObject({ code: "diagnostic_not_found" });
    await store.close();
  });

  test("an omitted limit selects the latest one hundred matching records", async () => {
    const directory = await temporaryStoreDirectory();
    const store = await openDiagnosticsStore({ directory });
    const records = Array.from({ length: 101 }, (_, index) =>
      record(
        String(index + 1),
        `2026-08-20T00:00:${String(index % 60).padStart(2, "0")}.${String(index).padStart(3, "0")}Z`,
      ),
    );
    for (const candidate of records) await store.append(candidate);

    await expect(store.query({})).resolves.toEqual({
      records: records.slice(1),
      truncated: true,
    });
    await store.close();
  });

  test("query captures a stable acceptance snapshot", async () => {
    const directory = await temporaryStoreDirectory();
    let enterQuery!: () => void;
    const queryEntered = new Promise<void>((resolve) => {
      enterQuery = resolve;
    });
    let releaseQuery!: () => void;
    const queryReleased = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    const store = await openDiagnosticsStoreForTest({
      directory,
      beforeQueryRead: async () => {
        enterQuery();
        await queryReleased;
      },
    });
    const first = record("1", "2026-08-20T00:00:00.000Z");
    const second = record("2", "2026-08-20T00:00:01.000Z");
    await store.append(first);

    const snapshot = store.query({});
    await queryEntered;
    await store.append(second);
    releaseQuery();
    try {
      await expect(snapshot).resolves.toEqual({
        records: [first],
        truncated: false,
      });
    } finally {
      releaseQuery();
      await store.close();
    }

    const reopened = await openDiagnosticsStoreForTest({
      directory,
      now: () => new Date("2026-08-21T00:00:01.000Z"),
    });
    await expect(reopened.query({})).resolves.toEqual({
      records: [first, second],
      truncated: false,
    });
    await reopened.close();
  });

  test("rotation uses immutable whole files across size and UTC date boundaries", async () => {
    const sizeDirectory = await temporaryStoreDirectory();
    const sizeStore = await openDiagnosticsStoreForTest({
      directory: sizeDirectory,
      segmentBytes: 1,
      now: () => new Date("2026-08-21T00:00:01.000Z"),
    });
    await sizeStore.append(record("1", "2026-08-21T00:00:00.000Z"));
    await sizeStore.append(record("2", "2026-08-21T00:00:01.000Z"));
    expect(
      (await readdir(sizeDirectory)).filter((name) =>
        name.startsWith("segment-"),
      ),
    ).toHaveLength(1);
    await sizeStore.close();

    const directory = await temporaryStoreDirectory();
    const store = await openDiagnosticsStoreForTest({
      directory,
      segmentBytes: 1024 * 1024,
      now: () => new Date("2026-08-21T00:00:01.000Z"),
    });
    const first = record("3", "2026-08-20T23:59:59.000Z");
    const second = record("4", "2026-08-21T00:00:00.000Z");
    await store.append(first);
    await store.append(second);

    const files = await readdir(directory);
    expect(files.filter((name) => name.startsWith("segment-")).length).toBe(1);
    await expect(store.query({})).resolves.toEqual({
      records: [first, second],
      truncated: false,
    });
    await store.close();

    const reopened = await openDiagnosticsStoreForTest({
      directory,
      now: () => new Date("2026-08-21T00:00:01.000Z"),
    });
    await expect(reopened.query({})).resolves.toEqual({
      records: [first, second],
      truncated: false,
    });
    await reopened.close();
  });

  test("a serialized record cannot exceed 256 KiB", async () => {
    const directory = await temporaryStoreDirectory();
    const store = await openDiagnosticsStore({ directory });
    const oversized = v.parse(diagnosticRecordSchema, {
      source: "adapter",
      harness: "codex",
      kind: "mapping_gap",
      operation: "spawn",
      reason: "unsupported_input",
      fields: Array.from({ length: 100_000 }, () => "agent"),
      v: 1,
      diagnosticId: makeDiagnosticId("1", "1"),
      recordedAt: "2026-08-20T00:00:00.000Z",
      severity: "warning",
    });

    await expect(store.append(oversized)).rejects.toThrow(
      "Diagnostic record exceeds 256 KiB",
    );
    expect(store.health()).toEqual({ status: "healthy", repairs: [] });
    await expect(store.query({})).resolves.toEqual({
      records: [],
      truncated: false,
    });
    await store.close();
  });

  test("time and size retention delete only oldest immutable segments", async () => {
    const timeDirectory = await temporaryStoreDirectory();
    let now = new Date("2026-08-20T00:00:00.000Z");
    const timeStore = await openDiagnosticsStoreForTest({
      directory: timeDirectory,
      segmentBytes: 1,
      maxAgeMs: 1000,
      now: () => now,
    });
    const expired = record("1", "2026-08-20T00:00:00.000Z");
    await timeStore.append(expired);
    now = new Date("2026-08-20T00:00:02.000Z");
    const current = record("2", "2026-08-20T00:00:02.000Z");
    await timeStore.append(current);
    await expect(
      timeStore.query({ diagnosticId: expired.diagnosticId }),
    ).rejects.toMatchObject({ code: "diagnostic_not_found" });
    await expect(timeStore.query({})).resolves.toEqual({
      records: [current],
      truncated: false,
    });
    await timeStore.close();

    const sizeDirectory = await temporaryStoreDirectory();
    const evicted = record("3", "2026-08-20T00:00:03.000Z");
    const retained = record("4", "2026-08-20T00:00:04.000Z");
    const sizeStore = await openDiagnosticsStoreForTest({
      directory: sizeDirectory,
      segmentBytes: 1,
      maxBytes: Buffer.byteLength(JSON.stringify(evicted)) + 1,
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });
    await sizeStore.append(evicted);
    await sizeStore.append(retained);
    await expect(sizeStore.query({})).resolves.toEqual({
      records: [retained],
      truncated: false,
    });
    expect(
      (await readdir(sizeDirectory)).filter((name) =>
        name.startsWith("segment-"),
      ),
    ).toEqual([]);
    await sizeStore.close();
  });

  test("a record larger than maxBytes is not accepted into active storage", async () => {
    const directory = await temporaryStoreDirectory();
    const store = await openDiagnosticsStoreForTest({
      directory,
      maxBytes: 1,
      stderr: () => {},
    });

    await expect(
      store.append(record("1", "2026-08-20T00:00:00.000Z")),
    ).rejects.toMatchObject({ code: "diagnostics_unavailable" });
    expect(store.health()).toMatchObject({
      status: "degraded",
      operation: "append",
      cause: "Diagnostic record exceeds configured store capacity",
    });
    await store.close();

    const reopened = await openDiagnosticsStore({ directory });
    await expect(reopened.query({})).resolves.toEqual({
      records: [],
      truncated: false,
    });
    await reopened.close();

    const tightenedDirectory = await temporaryStoreDirectory();
    const beforeTightening = await openDiagnosticsStore({
      directory: tightenedDirectory,
    });
    await beforeTightening.append(record("2", "2026-08-20T00:00:00.000Z"));
    await beforeTightening.close();
    const afterTightening = await openDiagnosticsStoreForTest({
      directory: tightenedDirectory,
      maxBytes: 1,
      stderr: () => {},
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });
    await expect(afterTightening.query({})).resolves.toEqual({
      records: [],
      truncated: false,
    });
    await afterTightening.close();
  });

  test("records stop being queryable when the age window passes without another append", async () => {
    const directory = await temporaryStoreDirectory();
    let now = new Date("2026-08-20T00:00:00.000Z");
    const store = await openDiagnosticsStoreForTest({
      directory,
      maxAgeMs: 1000,
      now: () => now,
    });
    const expired = record("1", "2026-08-20T00:00:00.000Z");
    await store.append(expired);
    now = new Date("2026-08-20T00:00:02.000Z");

    await expect(store.query({})).resolves.toEqual({
      records: [],
      truncated: false,
    });
    await expect(
      store.query({ diagnosticId: expired.diagnosticId }),
    ).rejects.toMatchObject({ code: "diagnostic_not_found" });
    await store.close();
  });

  test("directory and files remain private, and close releases the writer lock", async () => {
    const directory = await temporaryStoreDirectory();
    const first = await openDiagnosticsStore({ directory });
    await first.append(record("1", "2026-08-20T00:00:00.000Z"));
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    for (const name of await readdir(directory)) {
      const entry = await stat(join(directory, name));
      if (entry.isFile()) expect(entry.mode & 0o777).toBe(0o600);
    }
    await expect(openDiagnosticsStore({ directory })).rejects.toMatchObject({
      code: "diagnostics_store_locked",
    });
    await expect(openDiagnosticsStore({ directory })).rejects.toMatchObject({
      code: "diagnostics_store_locked",
    });
    await first.close();
    await first.close();

    await chmod(directory, 0o755);
    await chmod(join(directory, "active.ndjson"), 0o666);

    const second = await openDiagnosticsStore({ directory });
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, "active.ndjson"))).mode & 0o777).toBe(
      0o600,
    );
    await second.close();

    await writeFile(join(directory, "writer.lock"), `${process.pid}:stale`, {
      mode: 0o600,
    });
    const pidReuseContentIgnored = await openDiagnosticsStore({
      directory,
    });
    await pidReuseContentIgnored.close();
  });

  test("a replaced writer lease prevents append and preserves the replacement inode", async () => {
    const directory = await temporaryStoreDirectory();
    const messages: string[] = [];
    let armed = false;
    const store = await openDiagnosticsStoreForTest({
      directory,
      stderr: (message) => messages.push(message),
      beforeFileOperation: async (operation) => {
        if (!armed || operation !== "appendFile") return;
        armed = false;
        await replaceWriterLease(directory);
      },
    });
    const activePath = join(directory, "active.ndjson");
    const before = await readFile(activePath);
    armed = true;

    await expect(
      store.append(record("1", "2026-08-20T00:00:00.000Z")),
    ).rejects.toMatchObject({ code: "diagnostics_unavailable" });
    expect(await readFile(activePath)).toEqual(before);
    expect(store.health()).toMatchObject({
      status: "degraded",
      operation: "append",
    });
    await store.close().catch(() => undefined);
    await expect(replacementMarker(directory)).resolves.toBe("owned elsewhere");
  });

  test("a replaced bootstrap lease prevents initial directory creation", async () => {
    const directory = await temporaryStoreDirectory();

    await expect(
      openDiagnosticsStoreForTest({
        directory,
        beforeFileOperation: async (operation, path) => {
          if (operation === "mkdir" && path === directory) {
            await replaceLockDirectory(bootstrapLockDirectory(directory));
          }
        },
      }),
    ).rejects.toMatchObject({ code: "LOCK_COMPROMISED" });
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(bootstrapLockDirectory(directory), "replacement"), "utf8"),
    ).resolves.toBe("owned elsewhere");
  });

  test("a replaced writer lease prevents rotation rename", async () => {
    const directory = await temporaryStoreDirectory();
    let armed = false;
    const store = await openDiagnosticsStoreForTest({
      directory,
      segmentBytes: 1,
      stderr: () => {},
      beforeFileOperation: async (operation) => {
        if (!armed || operation !== "rename") return;
        armed = false;
        await replaceWriterLease(directory);
      },
    });
    const first = record("1", "2026-08-20T00:00:00.000Z");
    await store.append(first);
    armed = true;

    await expect(
      store.append(record("2", "2026-08-20T00:00:01.000Z")),
    ).rejects.toMatchObject({ code: "diagnostics_unavailable" });
    expect(await readFile(join(directory, "active.ndjson"), "utf8")).toBe(
      `${JSON.stringify(first)}\n`,
    );
    expect(
      (await readdir(directory)).filter((name) => name.startsWith("segment-")),
    ).toEqual([]);
    await store.close().catch(() => undefined);
    await expect(replacementMarker(directory)).resolves.toBe("owned elsewhere");
  });

  test("a replaced writer lease prevents retention unlink", async () => {
    const directory = await temporaryStoreDirectory();
    let now = new Date("2026-08-20T00:00:00.000Z");
    let armed = false;
    const store = await openDiagnosticsStoreForTest({
      directory,
      segmentBytes: 1,
      maxAgeMs: 1_000,
      now: () => now,
      stderr: () => {},
      beforeFileOperation: async (operation) => {
        if (!armed || operation !== "unlink") return;
        armed = false;
        await replaceWriterLease(directory);
      },
    });
    const oldest = record("1", "2026-08-20T00:00:00.000Z");
    await store.append(oldest);
    await store.append(record("2", "2026-08-20T00:00:00.500Z"));
    const oldestSegment = (await readdir(directory)).find((name) =>
      name.startsWith("segment-"),
    )!;
    now = new Date("2026-08-20T00:00:02.000Z");
    armed = true;

    await expect(
      store.append(record("3", "2026-08-20T00:00:02.000Z")),
    ).rejects.toMatchObject({ code: "diagnostics_unavailable" });
    expect(await readFile(join(directory, oldestSegment), "utf8")).toBe(
      `${JSON.stringify(oldest)}\n`,
    );
    await store.close().catch(() => undefined);
    await expect(replacementMarker(directory)).resolves.toBe("owned elsewhere");
  });

  test("a replaced writer lease prevents startup repair truncate", async () => {
    const directory = await temporaryStoreDirectory();
    const initial = await openDiagnosticsStore({ directory });
    await initial.close();
    const activePath = join(directory, "active.ndjson");
    await appendFile(activePath, '{"v":1');
    const before = await readFile(activePath);

    await expect(
      openDiagnosticsStoreForTest({
        directory,
        stderr: () => {},
        beforeFileOperation: async (operation) => {
          if (operation === "truncate") await replaceWriterLease(directory);
        },
      }),
    ).rejects.toMatchObject({ code: "LOCK_COMPROMISED" });
    expect(await readFile(activePath)).toEqual(before);
    await expect(replacementMarker(directory)).resolves.toBe("owned elsewhere");
  });

  test("a replaced writer lease stops startup loading before the next read", async () => {
    const directory = await temporaryStoreDirectory();
    const first = record("1", "2026-08-20T00:00:00.000Z");
    const initial = await openDiagnosticsStore({ directory });
    await initial.append(first);
    await initial.close();
    const activePath = join(directory, "active.ndjson");
    const before = await readFile(activePath);
    let replaced = false;

    await expect(
      openDiagnosticsStoreForTest({
        directory,
        beforeFileOperation: async (operation, path) => {
          if (replaced || operation !== "readFile" || path !== activePath)
            return;
          replaced = true;
          await replaceWriterLease(directory);
        },
      }),
    ).rejects.toMatchObject({ code: "LOCK_COMPROMISED" });
    expect(await readFile(activePath)).toEqual(before);
    await expect(replacementMarker(directory)).resolves.toBe("owned elsewhere");
  });

  test("writer lease excludes another process and is released by process death", async () => {
    const directory = await temporaryStoreDirectory();
    const fixture = fileURLToPath(
      new URL("../fixtures/hold-diagnostics-store.ts", import.meta.url),
    );
    await withChildHarness(async (harness) => {
      const children = [
        harness.spawn(fixture, [directory]),
        harness.spawn(fixture, [directory]),
      ];
      let recovered:
        | Awaited<ReturnType<typeof openDiagnosticsStore>>
        | undefined;
      try {
        const outcomes = await Promise.all(
          children.map((child) =>
            harness.waitForHandshake(
              child,
              (observation) => {
                if (observation.stdout.includes("ready\n")) {
                  return { status: "ready" as const };
                }
                if (
                  observation.exitCode !== null &&
                  observation.stderr.includes(
                    "Diagnostics store already has a writer",
                  )
                ) {
                  return { status: "locked" as const };
                }
                return undefined;
              },
              5_000,
            ),
          ),
        );
        expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
          "locked",
          "ready",
        ]);
        const winner =
          children[
            outcomes.findIndex((outcome) => outcome.status === "ready")
          ]!;
        winner.kill("SIGKILL");
        await Promise.all(
          children.map((child) => harness.waitForExit(child, 5_000)),
        );

        recovered = await retryOpen(directory);
      } finally {
        await recovered?.close();
      }
    });
  });

  test("active tail repair is observable and preserves complete records", async () => {
    const directory = await temporaryStoreDirectory();
    const first = record("1", "2026-08-20T00:00:00.000Z");
    const initial = await openDiagnosticsStore({ directory });
    await initial.append(first);
    await initial.close();
    const activePath = join(directory, "active.ndjson");
    const complete = await readFile(activePath);
    await writeFile(activePath, complete.subarray(0, -1));
    const messages: string[] = [];

    const repairedNewline = await openDiagnosticsStoreForTest({
      directory,
      stderr: (message) => messages.push(message),
    });
    expect(repairedNewline.health()).toEqual({
      status: "healthy",
      repairs: [{ kind: "tail_repaired", affectedBytes: 0 }],
    });
    await expect(repairedNewline.query({})).resolves.toEqual({
      records: [first],
      truncated: false,
    });
    await repairedNewline.close();

    await appendFile(activePath, '{"v":1');
    const repairedPartial = await openDiagnosticsStoreForTest({
      directory,
      stderr: (message) => messages.push(message),
    });
    expect(repairedPartial.health()).toEqual({
      status: "healthy",
      repairs: [{ kind: "tail_repaired", affectedBytes: 6 }],
    });
    expect(
      messages.every((message) => Buffer.byteLength(message) <= 4096),
    ).toBe(true);
    await expect(repairedPartial.query({})).resolves.toEqual({
      records: [first],
      truncated: false,
    });
    await repairedPartial.close();
  });

  test("complete corruption, corrupt segments and unknown versions fail fast", async () => {
    const activeDirectory = await temporaryStoreDirectory();
    const active = await openDiagnosticsStore({ directory: activeDirectory });
    await active.append(record("1", "2026-08-20T00:00:00.000Z"));
    await active.close();
    const validActive = await readFile(join(activeDirectory, "active.ndjson"));
    await appendFile(join(activeDirectory, "active.ndjson"), "not-json\n");
    await expect(
      openDiagnosticsStore({ directory: activeDirectory }),
    ).rejects.toMatchObject({
      code: "diagnostics_store_corrupt",
    });
    await writeFile(join(activeDirectory, "active.ndjson"), validActive, {
      mode: 0o600,
    });
    const afterFailedStartup = await openDiagnosticsStore({
      directory: activeDirectory,
    });
    await afterFailedStartup.close();

    const segmentDirectory = await temporaryStoreDirectory();
    const segmented = await openDiagnosticsStoreForTest({
      directory: segmentDirectory,
      segmentBytes: 1,
    });
    await segmented.append(record("2", "2026-08-20T00:00:00.000Z"));
    await segmented.append(record("3", "2026-08-20T00:00:01.000Z"));
    await segmented.close();
    const segment = (await readdir(segmentDirectory)).find((name) =>
      name.startsWith("segment-"),
    )!;
    await appendFile(join(segmentDirectory, segment), "broken\n");
    await expect(
      openDiagnosticsStore({ directory: segmentDirectory }),
    ).rejects.toMatchObject({
      code: "diagnostics_store_corrupt",
    });

    const versionDirectory = await temporaryStoreDirectory();
    const versionStore = await openDiagnosticsStore({
      directory: versionDirectory,
    });
    await versionStore.close();
    await writeFile(join(versionDirectory, "active.ndjson"), '{"v":2}\n', {
      mode: 0o600,
    });
    await expect(
      openDiagnosticsStore({ directory: versionDirectory }),
    ).rejects.toMatchObject({
      code: "diagnostics_store_corrupt",
    });

    const utf8Directory = await temporaryStoreDirectory();
    const utf8Store = await openDiagnosticsStore({ directory: utf8Directory });
    await utf8Store.close();
    await writeFile(
      join(utf8Directory, "active.ndjson"),
      Buffer.from([0xff, 0x0a]),
      {
        mode: 0o600,
      },
    );
    await expect(
      openDiagnosticsStore({ directory: utf8Directory }),
    ).rejects.toMatchObject({
      code: "diagnostics_store_corrupt",
    });
  });

  test("runtime failures degrade the store without an in-memory fallback", async () => {
    const appendDirectory = await temporaryStoreDirectory();
    const messages: string[] = [];
    const longCause = "€".repeat(2000);
    const appendStore = await openDiagnosticsStoreForTest({
      directory: appendDirectory,
      failAppend: () => new Error(longCause),
      stderr: (message) => messages.push(message),
    });
    await expect(
      appendStore.append(record("1", "2026-08-20T00:00:00.000Z")),
    ).rejects.toMatchObject({ code: "diagnostics_unavailable" });
    expect(appendStore.health()).toMatchObject({
      status: "degraded",
      operation: "append",
    });
    const appendHealth = appendStore.health();
    expect(appendHealth.status).toBe("degraded");
    if (appendHealth.status === "degraded") {
      expect(Buffer.byteLength(appendHealth.cause)).toBeLessThanOrEqual(4096);
    }
    await expect(appendStore.query({})).rejects.toMatchObject({
      code: "diagnostics_unavailable",
    });
    expect(messages).toHaveLength(1);
    expect(Buffer.byteLength(messages[0]!)).toBeLessThanOrEqual(4096);
    await appendStore.close();

    const queryStore = await openDiagnosticsStoreForTest({
      directory: await temporaryStoreDirectory(),
      failQuery: () => new Error("read failed"),
      stderr: (message) => messages.push(message),
    });
    await expect(queryStore.query({})).rejects.toMatchObject({
      code: "diagnostics_unavailable",
    });
    expect(queryStore.health()).toMatchObject({
      status: "degraded",
      operation: "query",
      cause: "read failed",
    });
    await queryStore.close();
  });

  test("invalid retention configuration is rejected", async () => {
    const directory = await temporaryStoreDirectory();
    await expect(
      openDiagnosticsStore({ directory, maxBytes: 0 }),
    ).rejects.toBeInstanceOf(DiagnosticsStoreError);
    await expect(
      openDiagnosticsStore({ directory, maxAgeMs: Number.POSITIVE_INFINITY }),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
  });
});

async function retryOpen(
  directory: string,
): Promise<Awaited<ReturnType<typeof openDiagnosticsStore>>> {
  return await openDiagnosticsStoreForTest({
    directory,
    lock: {
      staleMs: 2_000,
      updateMs: 1_000,
      timeoutMs: 5_000,
      retryDelayMs: 25,
    },
  });
}

function writerLockDirectory(directory: string): string {
  return join(directory, "writer-lease.lock");
}

function bootstrapLockDirectory(directory: string): string {
  return join(
    dirname(directory),
    `.${basename(directory)}.diagnostics-bootstrap-lease.lock`,
  );
}

async function replaceWriterLease(directory: string): Promise<void> {
  await replaceLockDirectory(writerLockDirectory(directory));
}

async function replaceLockDirectory(lockDirectory: string): Promise<void> {
  await rm(lockDirectory, { recursive: true });
  await mkdir(lockDirectory);
  await writeFile(join(lockDirectory, "replacement"), "owned elsewhere");
}

async function replacementMarker(directory: string): Promise<string> {
  return await readFile(
    join(writerLockDirectory(directory), "replacement"),
    "utf8",
  );
}
