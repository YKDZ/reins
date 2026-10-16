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
};

export function createFakeSdk(
  behavior: {
    interrupt?: () => Promise<unknown>;
    close?: () => Promise<void>;
  } = {},
): {
  sdk: QoderSdk;
  controls: FakeQoderControls;
} {
  const failureMarker = Symbol("failure");
  const queue = createAsyncQueue<SDKMessage | typeof failureMarker>();
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
      const promptReader = (async () => {
        for await (const message of prompt) delivered.push(message);
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
              return result as IteratorResult<SDKMessage, undefined>;
            },
          };
        },
        interrupt: async () => {
          interruptCount += 1;
          return await behavior.interrupt?.();
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
    },
  };
}
