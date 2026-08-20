import { qodercliAuth, query } from "@qodercn-ai/qodercn-agent-sdk";

import type { QoderSdk, SDKUserMessage } from "./sdk-seam.ts";

// 模型查询用空提示建立控制会话，不进入对话回合。
async function* noPrompt(): AsyncGenerator<SDKUserMessage> {}

// 真实绑定：进程内 SDK + 复用本机 qodercli 登录态（ADR-0011）。
export function createRealQoderSdk(): QoderSdk {
  return {
    query({ prompt, options }) {
      return query({ prompt, options: { ...options, auth: qodercliAuth() } });
    },
    async getAvailableModels(modelOptions) {
      const session = query({
        prompt: noPrompt(),
        options: { auth: qodercliAuth(), persistSession: false },
      });
      try {
        return await session.getAvailableModels({
          ...modelOptions,
          fetchStrategy: "live",
        });
      } finally {
        await session.close().catch(() => {});
      }
    },
  };
}
