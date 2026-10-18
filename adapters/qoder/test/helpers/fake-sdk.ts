import { randomUUID } from "node:crypto";

import type {
  ModelInfo,
  SDKMessage,
  SDKUserMessage,
} from "@qodercn-ai/qodercn-agent-sdk";
import { createAsyncQueue } from "@reins/adapter-kit";

import type { QoderOptions, QoderQuery, QoderSdk } from "#/sdk-seam";

export type FakeQoderControls = {
  push(message: SDKMessage): void;
  end(): void;
  fail(error: unknown): void;
  delivered(): SDKUserMessage[];
  lastOptions(): QoderOptions | null;
  interruptCount(): number;
  closeCount(): number;
  setAvailableModels(models: ModelInfo[]): void;
  modelsCalls(): number;
  acknowledge(uuid: string, state?: "queued" | "cancelled"): void;
};

export function createFakeSdk(
  behavior: {
    initializationResult?: () => Promise<unknown>;
    interrupt?: () => Promise<unknown>;
    close?: () => Promise<void>;
    autoQueueAcceptance?: boolean;
  } = {},
): {
  sdk: QoderSdk;
  controls: FakeQoderControls;
} {
  const failureMarker = Symbol("failure");
  const queue = createAsyncQueue<unknown>();
  let queryFailure: unknown;
  const delivered: SDKUserMessage[] = [];
  let lastOptions: QoderOptions | null = null;
  let interruptCount = 0;
  let closeCount = 0;
  let closePromise: Promise<void> | undefined;
  let availableModels: ModelInfo[] = [];
  let modelsCallsCount = 0;

  const sdk: QoderSdk = {
    query({ prompt, options }) {
      lastOptions = options ?? null;
      let promptCount = 0;
      const promptReader = (async () => {
        for await (const message of prompt) {
          delivered.push(message);
          if (promptCount === 0 || behavior.autoQueueAcceptance !== false)
            queue.push({
              type: "command_lifecycle",
              command_uuid: message.uuid,
              state: "queued",
              uuid: randomUUID(),
              session_id: "00000000-0000-4000-8000-000000000001",
            });
          promptCount += 1;
          queue.push({
            type: "system",
            subtype: "init",
            qodercli_version: "1.1.65",
          });
        }
      })();
      void promptReader.catch(() => {});
      const q: QoderQuery = {
        [Symbol.asyncIterator]() {
          const iterator = queue[Symbol.asyncIterator]();
          return {
            async next() {
              const result = await iterator.next();
              if (!result.done && result.value === failureMarker) {
                throw queryFailure;
              }
              return result as IteratorResult<unknown, undefined>;
            },
          };
        },
        interrupt: async () => {
          interruptCount += 1;
          return await behavior.interrupt?.();
        },
        initializationResult: async () => {
          return await behavior.initializationResult?.();
        },
        close: () => {
          closeCount += 1;
          if (closePromise !== undefined) return Promise.resolve();
          closePromise = (async () => {
            await behavior.close?.();
            queue.end();
            await promptReader;
          })();
          return closePromise;
        },
      };
      return q;
    },
    async getAvailableModels() {
      modelsCallsCount += 1;
      return availableModels;
    },
  };

  return {
    sdk,
    controls: {
      push: (message) => queue.push(message),
      end: () => queue.end(),
      fail: (error) => {
        queryFailure = error;
        queue.push(failureMarker);
      },
      delivered: () => [...delivered],
      lastOptions: () => lastOptions,
      interruptCount: () => interruptCount,
      closeCount: () => closeCount,
      setAvailableModels: (models) => {
        availableModels = models;
      },
      modelsCalls: () => modelsCallsCount,
      acknowledge: (uuid, state = "queued") =>
        queue.push({
          type: "command_lifecycle",
          command_uuid: uuid,
          state,
          uuid: randomUUID(),
          session_id: "00000000-0000-4000-8000-000000000001",
        }),
    },
  };
}
