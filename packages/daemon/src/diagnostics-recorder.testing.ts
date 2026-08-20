import {
  openDiagnosticsRuntimeInternal,
  type DiagnosticsRuntime,
} from "./diagnostics-recorder.ts";
import type { DiagnosticsStore } from "./diagnostics-store.ts";
import type { DaemonGeneration } from "./generation.ts";
import type { DaemonState } from "./state.ts";

export type DiagnosticsRuntimeTestOptions = {
  resolveState(): Promise<DaemonState>;
  openStore(state: DaemonState): Promise<DiagnosticsStore>;
  allocateGeneration(): Promise<DaemonGeneration>;
  now?: () => Date;
  stderr?: (message: string) => void;
};

export async function openDiagnosticsRuntimeForTest(
  options: DiagnosticsRuntimeTestOptions,
): Promise<DiagnosticsRuntime> {
  return await openDiagnosticsRuntimeInternal({
    resolveState: () => options.resolveState(),
    openStore: (state) => options.openStore(state),
    acquireAllocator: async () => ({
      allocate: () => options.allocateGeneration(),
      async close() {},
    }),
    now: options.now ?? (() => new Date()),
    stderr: options.stderr ?? (() => {}),
  });
}
