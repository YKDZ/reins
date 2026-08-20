import {
  noopDiagnosticSink,
  type AdapterDiagnosticSink,
  type DiagnosticSink,
} from "@reins/adapter-kit";
import type { AdapterDiagnosticFact, HarnessCapability } from "@reins/protocol";

import {
  createCodexTransport,
  type CodexModel,
  type CodexTransport,
} from "./transport.ts";

function mapModel(model: CodexModel): {
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
  transportFactory?: (options: {
    diagnostics: DiagnosticSink;
  }) => CodexTransport;
}): (diagnostics?: AdapterDiagnosticSink) => Promise<HarnessCapability> {
  return async (diagnostics = noopDiagnosticSink) => {
    const transportDiagnostics: DiagnosticSink = async (input) =>
      input.kind === "harness_stderr"
        ? undefined
        : await diagnostics(input as AdapterDiagnosticFact);
    const transport =
      options?.transportFactory?.({ diagnostics: transportDiagnostics }) ??
      createCodexTransport({ diagnostics: transportDiagnostics });
    transport.start();
    try {
      await transport.request("initialize", {
        clientInfo: { name: "reins", title: null, version: "0.0.0" },
        capabilities: null,
      });
      transport.notify("initialized", {});
      const response = await transport.request("model/list", {});
      return {
        harness: "codex",
        models: response.data.filter((model) => !model.hidden).map(mapModel),
      };
    } finally {
      await transport.close();
    }
  };
}
