import type { HarnessCapability } from "@reins/protocol";

import type { QoderSdk } from "./sdk-seam.ts";

// 实时查询 qodercli 的模型目录（SDK get_models 控制请求）；
// defaultEffort / isDefault 不进矩阵（最小干扰原则）。
export function createQoderCapabilities(
  sdk: QoderSdk,
): () => Promise<HarnessCapability> {
  return async () => {
    const models = await sdk.getAvailableModels({ fetchStrategy: "live" });
    return {
      harness: "qoder",
      models: models
        .filter((model) => model.isEnabled !== false)
        .map((model) => ({
          id: model.value,
          displayName: model.displayName,
          reasoningEfforts: model.efforts ?? [],
        })),
    };
  };
}
