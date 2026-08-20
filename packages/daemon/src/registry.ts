import type { DiagnosticSink } from "@reins/adapter-kit";
import type { AdapterDriverFactory, HarnessCapability } from "@reins/protocol";

// daemon 的 adapter 注册表：每个 harness 一个条目，拼接发生在发布阶段。
export type HarnessAdapter = {
  driverFactory: AdapterDriverFactory;
  capabilities(diagnostics: DiagnosticSink): Promise<HarnessCapability>;
  canCaptureHarnessStderr?: boolean;
};

export type AdapterRegistry = ReadonlyMap<string, HarnessAdapter>;
