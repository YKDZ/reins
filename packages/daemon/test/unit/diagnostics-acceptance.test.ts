import {
  makeDiagnosticId,
  sessionIdSchema,
  type DiagnosticInput,
  type DiagnosticsResult,
} from "@reins/protocol";
import * as v from "valibot";
import { describe, expect, test } from "vitest";

import { createConsumerScope } from "../../src/consumer-scope.ts";
import { orderDiagnosticsAcceptance } from "../../src/diagnostics-acceptance.ts";
import type { DiagnosticsRuntime } from "../../src/diagnostics-recorder.ts";
import { daemonGenerationSchema } from "../../src/generation.ts";

const lifecycleFact = {
  source: "daemon",
  kind: "lifecycle",
  operation: "daemon",
  reason: "started",
} as const satisfies DiagnosticInput;

const emptyResult = (): DiagnosticsResult => ({
  records: [],
  truncated: false,
});

describe("diagnostics acceptance ordering", () => {
  test("同步重入 query 不能越过先接纳的 record", async () => {
    const trace: string[] = [];
    let releaseRecord!: () => void;
    const recordReleased = new Promise<void>((resolve) => {
      releaseRecord = resolve;
    });
    let nestedQuery!: Promise<DiagnosticsResult>;
    let ordered: ReturnType<typeof orderDiagnosticsAcceptance>;
    const runtime: DiagnosticsRuntime = {
      generation: v.parse(daemonGenerationSchema, "reentry"),
      sessionId: () => v.parse(sessionIdSchema, "session:greentry:1"),
      record() {
        trace.push("record-start");
        nestedQuery = ordered.query({});
        return recordReleased.then(() => {
          trace.push("record-end");
          return makeDiagnosticId("reentry", "1");
        });
      },
      query() {
        trace.push("query-start");
        return Promise.resolve().then(() => {
          trace.push("query-end");
          return emptyResult();
        });
      },
      health: () => ({ status: "healthy", repairs: [] }),
      async close() {},
    };
    ordered = orderDiagnosticsAcceptance(runtime, createConsumerScope());

    const outerRecord = ordered.record(lifecycleFact);
    expect(trace).toEqual(["record-start"]);
    releaseRecord();
    await outerRecord;
    await nestedQuery;
    expect(trace).toEqual([
      "record-start",
      "record-end",
      "query-start",
      "query-end",
    ]);

    const followUp = ordered.query({});
    expect(trace.at(-1)).toBe("query-start");
    await followUp;
    expect(trace.at(-1)).toBe("query-end");
  });

  test("同步 throw 与异步 rejection 均释放接纳位置", async () => {
    const trace: string[] = [];
    let attempt = 0;
    const runtime: DiagnosticsRuntime = {
      generation: v.parse(daemonGenerationSchema, "rejection"),
      sessionId: () => v.parse(sessionIdSchema, "session:grejection:1"),
      record() {
        attempt += 1;
        trace.push(`record-${attempt}-start`);
        if (attempt === 1) throw new Error("Synchronous record failure");
        return Promise.reject(new Error("Asynchronous record failure"));
      },
      query() {
        trace.push("query-start");
        return Promise.resolve(emptyResult());
      },
      health: () => ({ status: "healthy", repairs: [] }),
      async close() {},
    };
    const ordered = orderDiagnosticsAcceptance(runtime, createConsumerScope());

    await expect(ordered.record(lifecycleFact)).rejects.toThrow(
      "Synchronous record failure",
    );
    const afterThrow = ordered.query({});
    expect(trace.at(-1)).toBe("query-start");
    await afterThrow;

    await expect(ordered.record(lifecycleFact)).rejects.toThrow(
      "Asynchronous record failure",
    );
    const afterRejection = ordered.query({});
    expect(trace.at(-1)).toBe("query-start");
    await afterRejection;
  });
});
