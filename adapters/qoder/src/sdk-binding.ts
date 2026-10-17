import { qodercliAuth, query } from "@qodercn-ai/qodercn-agent-sdk";
import type { ModelInfo } from "@qodercn-ai/qodercn-agent-sdk";

import type { QoderSdk, SDKUserMessage } from "./sdk-seam.ts";

// 模型查询用空提示建立控制会话，不进入对话回合。
async function* noPrompt(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  yield* [];
}

function createSession(
  prompt: AsyncIterable<SDKUserMessage>,
  options: Parameters<typeof query>[0]["options"],
) {
  const runtime =
    process.env.QODERCLI_PATH === undefined
      ? {}
      : { pathToQoderCLIExecutable: process.env.QODERCLI_PATH };
  return query({
    prompt,
    options: { ...runtime, ...options, auth: qodercliAuth() },
  });
}

// 真实绑定：进程内 SDK + 复用本机 qodercli 登录态（ADR-0011）。
export function createRealQoderSdk(): QoderSdk {
  return {
    query({ prompt, options }) {
      return createSession(prompt, options);
    },
    async getAvailableModels(modelOptions) {
      const promptAbort = new AbortController();
      const session = createSession(noPrompt(promptAbort.signal), {
        persistSession: false,
      });
      let result: ModelInfo[] | undefined;
      let lookupFailure: unknown;
      let lookupFailed = false;
      try {
        result = await session.getAvailableModels({
          ...modelOptions,
          fetchStrategy: "live",
        });
      } catch (error) {
        lookupFailure = error;
        lookupFailed = true;
      }

      // 先释放 Reins 自建的提示输入迭代器，再等待 SDK 首次 close。
      promptAbort.abort();
      let closeFailure: unknown;
      let closeFailed = false;
      try {
        await session.close();
      } catch (error) {
        closeFailure = error;
        closeFailed = true;
      }

      if (lookupFailed && closeFailed) {
        throw new AggregateError(
          [lookupFailure, closeFailure],
          "Qoder model lookup and SDK query close both failed",
        );
      }
      if (lookupFailed) throw lookupFailure;
      if (closeFailed) throw closeFailure;
      if (result === undefined) {
        throw new Error("Qoder model lookup completed without a result");
      }
      return result;
    },
  };
}
