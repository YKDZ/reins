import type { AdvisoryFileLeaseOptions } from "./diagnostics-store-lock.ts";
import {
  openDiagnosticsStoreInternal,
  type DiagnosticsFileOperation,
  type DiagnosticsStore,
  type DiagnosticsStoreOptions,
} from "./diagnostics-store.ts";

export type DiagnosticsStoreTestOptions = DiagnosticsStoreOptions & {
  now?: () => Date;
  segmentBytes?: number;
  stderr?: (message: string) => void;
  failAppend?: () => Error | undefined;
  failQuery?: () => Error | undefined;
  beforeQueryRead?: () => Promise<void>;
  beforeFileOperation?: (
    operation: DiagnosticsFileOperation,
    path: string,
  ) => Promise<void>;
  lock?: AdvisoryFileLeaseOptions;
};

export function openDiagnosticsStoreForTest(
  options: DiagnosticsStoreTestOptions,
): Promise<DiagnosticsStore> {
  return openDiagnosticsStoreInternal(options);
}
