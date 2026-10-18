import {
  noopDiagnosticSink,
  type AdapterDiagnosticSink,
  type DiagnosticSink,
} from "@reins/adapter-kit";
import type { HarnessModelCatalog } from "@reins/protocol";

import { initializeCodexTransport } from "./initialization.ts";
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
// 不属于模型目录。
export function createCodexModelCatalog(options?: {
  transportFactory?: (options: {
    diagnostics: DiagnosticSink;
  }) => CodexTransport;
}): (diagnostics?: AdapterDiagnosticSink) => Promise<HarnessModelCatalog> {
  return async (diagnostics = noopDiagnosticSink) => {
    const transportDiagnostics: DiagnosticSink = async (input) =>
      input.kind === "harness_stderr" ? undefined : await diagnostics(input);
    const transport =
      options?.transportFactory?.({ diagnostics: transportDiagnostics }) ??
      createCodexTransport({ diagnostics: transportDiagnostics });
    try {
      await initializeCodexTransport(transport);
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
