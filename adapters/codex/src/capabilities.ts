import type { HarnessCapability } from "@reins/protocol";

import type { Model } from "#/generated/v2/Model";

import { createCodexTransport, type CodexTransport } from "./transport.ts";

function mapModel(model: Model): {
  id: string;
  displayName: string;
  reasoningEfforts: string[];
} {
  return {
    // spawn 时传给 turn/start 的 model override 使用 model 字段（配置语义）。
    id: model.model,
    displayName: model.displayName,
    reasoningEfforts: model.supportedReasoningEfforts.map(
      (option) => option.reasoningEffort,
    ),
  };
}

// 实时查询 app-server 的 model/list；defaultReasoningEffort / isDefault
// 不进矩阵（最小干扰原则）。
export function createCodexCapabilities(options?: {
  transportFactory?: () => CodexTransport;
}): () => Promise<HarnessCapability> {
  return async () => {
    const transport = options?.transportFactory?.() ?? createCodexTransport({});
    transport.start();
    try {
      await transport.request("initialize", {
        clientInfo: { name: "reins", title: null, version: "0.0.0" },
        capabilities: null,
      });
      transport.notify("initialized", {});
      const response = (await transport.request("model/list", {})) as {
        data?: Model[];
      };
      return {
        harness: "codex",
        models: (response.data ?? [])
          .filter((model) => !model.hidden)
          .map(mapModel),
      };
    } finally {
      transport.close();
    }
  };
}
