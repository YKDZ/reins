import {
  ProcessTransport,
  qodercliAuth,
  query,
  resolveQoderWorkerRuntimePath,
} from "@qodercn-ai/qodercn-agent-sdk";
import type { ModelInfo } from "@qodercn-ai/qodercn-agent-sdk";

import {
  bindOwnedProcess,
  createOwnedProcessTree,
  terminateOwnedDescendants,
  waitForOwnedRootExit,
} from "./owned-process.ts";
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
  if (process.platform !== "linux") {
    const runtime =
      process.env.QODERCLI_PATH === undefined
        ? {}
        : { pathToQoderCLIExecutable: process.env.QODERCLI_PATH };
    return query({
      prompt,
      options: { ...runtime, ...options, auth: qodercliAuth() },
    });
  }

  const owner = createOwnedProcessTree();
  const session = query({
    prompt,
    options: {
      ...options,
      pathToQoderCLIExecutable:
        process.env.QODERCLI_PATH ?? resolveQoderWorkerRuntimePath(),
      transport: ProcessTransport.default,
      spawnQoderCLIProcess: (spawnOptions) => owner.spawn(spawnOptions),
      auth: qodercliAuth(),
    },
  });
  bindOwnedProcess(session, owner);
  return session;
}

function combineErrors(primary: unknown, cleanup: unknown): unknown {
  if (primary === undefined) return cleanup;
  if (cleanup === undefined) return primary;
  return new AggregateError(
    [primary, cleanup],
    "Qoder model lookup and owned-process cleanup both failed",
  );
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
      let failure: unknown;
      try {
        result = await session.getAvailableModels({
          ...modelOptions,
          fetchStrategy: "live",
        });
      } catch (error) {
        failure = error;
      }

      try {
        await terminateOwnedDescendants(session, true);
      } catch (error) {
        failure = combineErrors(failure, error);
      } finally {
        promptAbort.abort();
      }

      try {
        await session.close();
        await waitForOwnedRootExit(session);
      } catch (error) {
        failure = combineErrors(failure, error);
      }

      if (failure !== undefined) throw failure;
      if (result === undefined) {
        throw new Error("Qoder model lookup completed without a result");
      }
      return result;
    },
  };
}
