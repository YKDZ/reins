import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createAsyncQueue } from "@reins/adapter-kit";
import { createCodexDriver, createCodexTransport } from "@reins/codex";
import { createQoderDriver, type QoderQuery } from "@reins/qoder";
type NativeSdkMessage = QoderQuery extends AsyncIterable<infer T> ? T : never;
const qoderFactory: ReturnType<typeof createQoderDriver> = (options) => {
  const replies = createAsyncQueue<NativeSdkMessage>();
  return createQoderDriver({
    sdk: {
      getAvailableModels: async () => [],
      query(params) {
        appendFileSync(
          process.env.REINS_W05_NATIVE_LOG!,
          JSON.stringify({
            method: "sdk.query",
            options: params.options,
            keys: Object.keys(params.options ?? {}),
          }) + "\n",
        );
        params.options?.abortController?.signal.addEventListener("abort", () =>
          replies.end(),
        );
        const prompt = (async function* () {
          for await (const message of params.prompt) {
            appendFileSync(
              process.env.REINS_W05_NATIVE_LOG!,
              JSON.stringify({ method: "sdk.message", message }) + "\n",
            );
            if (
              typeof message.message.content === "string" &&
              ["permission", "session-permission"].includes(
                message.message.content,
              ) &&
              params.options?.canUseTool !== undefined
            ) {
              const suggestions =
                message.message.content === "session-permission"
                  ? [
                      {
                        type: "addRules" as const,
                        rules: [{ toolName: "Bash" }],
                        behavior: "allow" as const,
                        destination: "session" as const,
                      },
                    ]
                  : [];
              void params.options
                .canUseTool(
                  "Bash",
                  { command: "caller command" },
                  {
                    signal: params.options.abortController!.signal,
                    toolUseID: "native-tool",
                    suggestions,
                  },
                )
                .then((result) =>
                  appendFileSync(
                    process.env.REINS_W05_NATIVE_LOG!,
                    JSON.stringify({ method: "sdk.permissionResult", result }) +
                      "\n",
                  ),
                );
            }
            yield message;
          }
        })();
        void (async () => {
          for await (const message of prompt) void message;
        })();
        return {
          [Symbol.asyncIterator]: () => replies[Symbol.asyncIterator](),
          interrupt: async () => {},
        };
      },
    },
  })(options);
};
export default {
  qoder: {
    driverFactory: qoderFactory,
    capabilities: async () => ({
      harness: "qoder",
      models: [
        {
          id: "fixture-model",
          displayName: "Fixture model",
          reasoningEfforts: ["low", "high"],
        },
      ],
    }),
  },
  codex: {
    driverFactory: createCodexDriver({
      transportFactory: (options) =>
        createCodexTransport({
          ...options,
          binaryPath: process.execPath,
          binaryArgs: [
            fileURLToPath(new URL("./faithful-native.ts", import.meta.url)),
          ],
        }),
    }),
    capabilities: async () => ({
      harness: "codex",
      models: [
        {
          id: "fixture-model",
          displayName: "Fixture model",
          reasoningEfforts: ["low", "high"],
        },
      ],
    }),
  },
};
