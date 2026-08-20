import {
  diagnosticInputSchema,
  diagnosticRecordSchema,
  makeErrorCause,
  type DiagnosticId,
  type DiagnosticInput,
  type DiagnosticsParams,
  type DiagnosticsResult,
  type SessionId,
  type SessionName,
} from "@reins/protocol";
import * as v from "valibot";

import {
  openDiagnosticsStore,
  type DiagnosticsStore,
  type DiagnosticsStoreHealth,
} from "./diagnostics-store.ts";
import {
  createDaemonIdFactory,
  acquireGenerationAllocator,
  type DaemonIdFactory,
  type DaemonGeneration,
  type GenerationAllocatorLease,
} from "./generation.ts";
import { resolveDaemonState, type DaemonState } from "./state.ts";

export type DiagnosticsRuntime = {
  readonly generation: DaemonGeneration;
  sessionId(sessionName: SessionName): SessionId;
  record(input: DiagnosticInput): Promise<DiagnosticId | undefined>;
  query(params: DiagnosticsParams): Promise<DiagnosticsResult>;
  health(): DiagnosticsStoreHealth;
  close(): Promise<void>;
};

type RuntimeDependencies = {
  resolveState(): Promise<DaemonState>;
  openStore(state: DaemonState): Promise<DiagnosticsStore>;
  acquireAllocator(state: DaemonState): Promise<GenerationAllocatorLease>;
  now(): Date;
  stderr(message: string): void;
};

function productionDependencies(): RuntimeDependencies {
  return {
    resolveState: () => resolveDaemonState(),
    openStore: (state) =>
      openDiagnosticsStore({
        directory: state.diagnosticsDirectory,
        maxAgeMs: state.retention.maxAgeMs,
        maxBytes: state.retention.maxBytes,
      }),
    acquireAllocator: (state) => acquireGenerationAllocator(state),
    now: () => new Date(),
    stderr: (message) => process.stderr.write(`${message}\n`),
  };
}

export async function openDiagnosticsRuntime(): Promise<DiagnosticsRuntime> {
  return await openDiagnosticsRuntimeInternal(productionDependencies());
}

export async function openDiagnosticsRuntimeInternal(
  dependencies: RuntimeDependencies,
): Promise<DiagnosticsRuntime> {
  const state = await dependencies.resolveState();
  const store = await dependencies.openStore(state);
  try {
    const allocator = await dependencies.acquireAllocator(state);
    let generation: DaemonGeneration;
    try {
      generation = await allocator.allocate();
    } finally {
      await allocator.close();
    }
    const runtime = new RecorderRuntime({
      generation,
      store,
      now: () => dependencies.now(),
      stderr: (message) => dependencies.stderr(message),
    });
    for (const repair of store.health().repairs) {
      const repairId = await runtime.record({
        source: "daemon",
        kind: "storage_failure",
        operation: "recover",
        reason: "tail_repaired",
        affectedBytes: repair.affectedBytes,
      });
      if (repairId === undefined) {
        throw new Error("Startup tail repair was not accepted");
      }
    }
    return runtime;
  } catch (error) {
    await store.close();
    throw error;
  }
}

class RecorderRuntime implements DiagnosticsRuntime {
  readonly generation: DaemonGeneration;
  readonly #store: DiagnosticsStore;
  readonly #now: () => Date;
  readonly #stderr: (message: string) => void;
  readonly #idFactory: DaemonIdFactory;
  #degraded: { operation: "append" | "query"; cause: string } | undefined;
  #closed = false;

  constructor(options: {
    generation: DaemonGeneration;
    store: DiagnosticsStore;
    now: () => Date;
    stderr: (message: string) => void;
  }) {
    this.generation = options.generation;
    this.#store = options.store;
    this.#now = options.now;
    this.#stderr = options.stderr;
    this.#idFactory = createDaemonIdFactory(options.generation);
  }

  sessionId(sessionName: SessionName): SessionId {
    return this.#idFactory.session(sessionName);
  }

  async record(input: DiagnosticInput): Promise<DiagnosticId | undefined> {
    const diagnosticId = this.#idFactory.diagnostic();
    if (this.#degraded !== undefined || this.#closed) return undefined;
    const parsedInput = v.safeParse(diagnosticInputSchema, input);
    if (!parsedInput.success) return undefined;
    const candidate = {
      ...parsedInput.output,
      v: 1,
      diagnosticId,
      recordedAt: this.#now().toISOString(),
      severity: severityFor(parsedInput.output),
    };
    const parsedRecord = v.safeParse(diagnosticRecordSchema, candidate);
    if (!parsedRecord.success) return undefined;
    try {
      await this.#store.append(parsedRecord.output);
      const result = await this.#store.query({
        diagnosticId: parsedRecord.output.diagnosticId,
      });
      if (
        "record" in result &&
        result.record.diagnosticId === parsedRecord.output.diagnosticId
      ) {
        return parsedRecord.output.diagnosticId;
      }
      this.#markDegraded(
        "append",
        new Error("Accepted diagnostic record was not immediately queryable"),
      );
      return undefined;
    } catch (error) {
      this.#markDegraded("append", error);
      return undefined;
    }
  }

  async query(params: DiagnosticsParams): Promise<DiagnosticsResult> {
    if (this.#degraded !== undefined || this.#closed) {
      throw new Error("Diagnostics store is unavailable");
    }
    try {
      return await this.#store.query(params);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "diagnostic_not_found"
      ) {
        throw error;
      }
      this.#markDegraded("query", error);
      throw error;
    }
  }

  health(): DiagnosticsStoreHealth {
    const storeHealth = this.#store.health();
    if (this.#degraded === undefined) return storeHealth;
    return {
      status: "degraded",
      ...this.#degraded,
      repairs: storeHealth.repairs,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#store.close();
  }

  #markDegraded(operation: "append" | "query", error: unknown): void {
    if (this.#degraded !== undefined) return;
    const cause = makeErrorCause("exception", String(error)).message;
    this.#degraded = { operation, cause };
    if (this.#store.health().status === "healthy") {
      this.#stderr(`Diagnostics recorder ${operation} failed: ${cause}`);
    }
  }
}

function severityFor(input: DiagnosticInput): "info" | "warning" | "error" {
  if (
    input.kind === "mapping_gap" ||
    input.kind === "compatibility_gap" ||
    (input.kind === "storage_failure" && input.reason === "tail_repaired")
  ) {
    return "warning";
  }
  if (
    input.kind === "harness_stderr" ||
    (input.kind === "lifecycle" &&
      ["started", "stopped", "idle_exit", "initialized", "closed"].includes(
        input.reason,
      ))
  ) {
    return "info";
  }
  return "error";
}
