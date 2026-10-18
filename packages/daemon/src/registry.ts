import type { AdapterDiagnosticSink } from "@reins/adapter-kit";
import type {
  AdapterDriverFactory,
  HarnessId,
  HarnessModelCatalog,
} from "@reins/protocol";

// daemon 的 adapter 注册表：每个 harness 一个条目，拼接发生在发布阶段。
export type HarnessAdapter = {
  driverFactory: AdapterDriverFactory;
  modelCatalog(
    diagnostics: AdapterDiagnosticSink,
  ): Promise<HarnessModelCatalog>;
  canCaptureHarnessStderr?: boolean;
};

export type AdapterRegistry = ReadonlyMap<HarnessId, HarnessAdapter>;
