import type {
  CapabilitiesResult,
  CapabilityFailure,
  HarnessCapability,
  MachineError,
  SpawnParams,
} from "@reins/protocol";

import type { ReinsClient } from "./client.ts";
import { machineError } from "./errors.ts";

type Store = {
  capabilities: Map<string, HarnessCapability>;
  failures: Map<string, CapabilityFailure>;
};

// 能力矩阵缓存：CLI 进程生命周期内只查询一次；失败面保留 harness 名，
// 以便"查询失败 ≠ harness 不存在"。
export class CapabilityStore {
  private readonly client: ReinsClient;
  private store: Store | null = null;

  constructor(client: ReinsClient) {
    this.client = client;
  }

  private async load(): Promise<Store> {
    if (this.store !== null) return this.store;
    const response = await this.client.request("capabilities", {});
    if ("error" in response) throw response.error;
    const result = response.result;
    this.store = {
      capabilities: new Map(
        result.capabilities.map((capability) => [
          capability.harness,
          capability,
        ]),
      ),
      failures: new Map(
        result.failures.map((failure) => [failure.harness, failure]),
      ),
    };
    return this.store;
  }

  async result(): Promise<CapabilitiesResult> {
    const store = await this.load();
    return {
      capabilities: [...store.capabilities.values()],
      failures: [...store.failures.values()],
    };
  }

  // spawn 前置校验：一次往返自纠（spec Q16）。模型/推理强度不硬校验，
  // 只在校验失败时内联 context.valid；查询失败的 harness 透明放行。
  async validateSpawn(params: SpawnParams): Promise<MachineError | null> {
    const store = await this.load();
    const known = new Set<string>([
      ...store.capabilities.keys(),
      ...store.failures.keys(),
    ]);
    if (!known.has(params.harness)) {
      return machineError({
        code: "unknown_harness",
        harness: params.harness,
        availableHarnesses: [...known],
      });
    }
    const capability = store.capabilities.get(params.harness);
    if (capability === undefined) return null;
    if (params.model === undefined) return null;
    const model = capability.models.find(
      (candidate) => candidate.id === params.model,
    );
    if (model === undefined) {
      return machineError({
        code: "invalid_params",
        issues: [
          {
            issue: "invalid_value",
            path: "model",
          },
        ],
      });
    }
    if (
      params.reasoning !== undefined &&
      !model.reasoningEfforts.includes(params.reasoning)
    ) {
      return machineError({
        code: "invalid_params",
        issues: [
          {
            issue: "invalid_value",
            path: "reasoning",
          },
        ],
      });
    }
    return null;
  }
}
