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
  pushRaw(message: SDKMessage): void;
  end(): void;
  fail(error: unknown): void;
  delivered(): SDKUserMessage[];
  lastOptions(): QoderOptions | null;
  interruptCount(): number;
  cancelAsyncCount(): number;
  closeCount(): number;
  setAvailableModels(models: ModelInfo[]): void;
  modelsCalls(): number;
  acknowledge(
    uuid: string,
    state?: "queued" | "started" | "completed" | "cancelled",
  ): void;
  finish(uuid: string, result?: SDKMessage, lifecycleFirst?: boolean): void;
};

export function createFakeSdk(
  behavior: {
    initializationResult?: () => Promise<unknown>;
    interrupt?: () => Promise<unknown>;
    cancelAsyncMessage?: (uuid: string) => Promise<boolean>;
    cancelAsyncLifecycle?: boolean;
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
  let cancelAsyncCount = 0;
  let closeCount = 0;
  let closePromise: Promise<void> | undefined;
  let availableModels: ModelInfo[] = [];
  let modelsCallsCount = 0;

  function pushRaw(message: SDKMessage): void {
    queue.push(message);
  }

  function finish(
    uuid: string,
    result?: SDKMessage,
    lifecycleFirst = false,
  ): void {
    const nativeResult =
      result ??
      ({
        type: "result",
        subtype: "success",
        is_error: false,
        stop_reason: "end_turn",
        result: "ok",
        uuid: randomUUID(),
        session_id: "00000000-0000-4000-8000-000000000001",
      } as unknown as SDKMessage);
    const lifecycle = {
      type: "command_lifecycle",
      command_uuid: uuid,
      state: "completed",
      uuid: randomUUID(),
      session_id: "00000000-0000-4000-8000-000000000001",
    };
    if (lifecycleFirst) {
      queue.push(lifecycle);
      queue.push(nativeResult);
    } else {
      queue.push(nativeResult);
      queue.push(lifecycle);
    }
  }

  function push(message: SDKMessage): void {
    queue.push(message);
    const candidate = message as unknown as Record<string, unknown>;
    const body =
      typeof candidate.message === "object" && candidate.message !== null
        ? (candidate.message as Record<string, unknown>)
        : undefined;
    const nativeMessage = body;
    const content =
      candidate.type === "stream_event" &&
      typeof candidate.event === "object" &&
      candidate.event !== null
        ? (candidate.event as Record<string, unknown>)
        : undefined;
    const delta =
      typeof content?.delta === "object" && content.delta !== null
        ? (content.delta as Record<string, unknown>)
        : undefined;
    const terminal =
      (candidate.type === "system" &&
        candidate.subtype === "session_state_changed" &&
        candidate.state === "idle") ||
      (candidate.type === "assistant" &&
        (candidate.isApiErrorMessage === true ||
          nativeMessage?.stop_reason === "end_turn")) ||
      (candidate.type === "stream_event" &&
        content?.type === "message_delta" &&
        delta?.stop_reason === "end_turn");
    if (!terminal) return;
    const input = delivered.at(-1);
    if (input === undefined) return;
    if (typeof input.uuid !== "string") return;
    const failed =
      candidate.type === "assistant" && candidate.isApiErrorMessage === true;
    finish(
      input.uuid,
      failed
        ? ({
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            uuid: randomUUID(),
            session_id: "00000000-0000-4000-8000-000000000001",
          } as unknown as SDKMessage)
        : undefined,
    );
  }

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
          return await (behavior.interrupt?.() ?? { still_queued: [] });
        },
        cancelAsyncMessage: async (uuid) => {
          cancelAsyncCount += 1;
          const cancelled = await behavior.cancelAsyncMessage?.(uuid);
          if (cancelled === true && behavior.cancelAsyncLifecycle !== false) {
            queue.push({
              type: "command_lifecycle",
              command_uuid: uuid,
              state: "cancelled",
              uuid: randomUUID(),
              session_id: "00000000-0000-4000-8000-000000000001",
            });
          }
          return cancelled ?? false;
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
      push,
      pushRaw,
      end: () => queue.end(),
      fail: (error) => {
        queryFailure = error;
        queue.push(failureMarker);
      },
      delivered: () => [...delivered],
      lastOptions: () => lastOptions,
      interruptCount: () => interruptCount,
      cancelAsyncCount: () => cancelAsyncCount,
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
      finish,
    },
  };
}
