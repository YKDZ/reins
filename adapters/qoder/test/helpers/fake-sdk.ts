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
  delivered(): SDKUserMessage[];
  lastOptions(): QoderOptions | null;
  interruptCount(): number;
  setAvailableModels(models: ModelInfo[]): void;
  modelsCalls(): number;
};

export function createFakeSdk(): {
  sdk: QoderSdk;
  controls: FakeQoderControls;
} {
  const queue = createAsyncQueue<SDKMessage>();
  const delivered: SDKUserMessage[] = [];
  let lastOptions: QoderOptions | null = null;
  let interruptCount = 0;
  let availableModels: ModelInfo[] = [];
  let modelsCallsCount = 0;

  const sdk: QoderSdk = {
    query({ prompt, options }) {
      lastOptions = options ?? null;
      void (async () => {
        for await (const message of prompt) delivered.push(message);
      })();
      const q: QoderQuery = {
        [Symbol.asyncIterator]() {
          return queue[Symbol.asyncIterator]();
        },
        interrupt: async () => {
          interruptCount += 1;
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
      delivered: () => [...delivered],
      lastOptions: () => lastOptions,
      interruptCount: () => interruptCount,
      setAvailableModels: (models) => {
        availableModels = models;
      },
      modelsCalls: () => modelsCallsCount,
    },
  };
}
