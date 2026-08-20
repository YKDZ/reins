import type { HarnessCapability, WorkerDriverFactory } from "@reins/protocol";

// daemon 的 adapter 注册表：每个 harness 一个条目，拼接发生在发布阶段。
export type HarnessAdapter = {
  driverFactory: WorkerDriverFactory;
  capabilities(): Promise<HarnessCapability>;
  canCaptureHarnessStderr?: boolean;
};

export type AdapterRegistry = ReadonlyMap<string, HarnessAdapter>;
