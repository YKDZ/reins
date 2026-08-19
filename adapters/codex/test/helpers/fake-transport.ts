import { createAsyncQueue } from "@reins/adapter-kit";

import type { CodexTransport, InboundMessage } from "#/transport";

export type FakeCodexControls = {
  pushInbound(message: InboundMessage): void;
  end(): void;
  requests(): Array<{ method: string; params: unknown }>;
  responded(): Array<{ id: number; result: unknown }>;
  respondErrors(): Array<{ id: number; code: number; message: string }>;
  closed(): boolean;
};

export function createFakeTransport(): {
  transport: CodexTransport;
  controls: FakeCodexControls;
} {
  const requests: Array<{ method: string; params: unknown }> = [];
  const responded: Array<{ id: number; result: unknown }> = [];
  const respondErrors: Array<{ id: number; code: number; message: string }> =
    [];
  const inbox = createAsyncQueue<InboundMessage>();
  let closedFlag = false;
  let nextId = 0;
  let turnSeq = 0;

  function defaultResponse(method: string, _params: unknown): unknown {
    if (method === "thread/start") {
      return { thread: { id: "thr1", ephemeral: true } };
    }
    if (method === "turn/start") {
      turnSeq += 1;
      return { turn: { id: `turn${turnSeq}` } };
    }
    return {};
  }

  const transport: CodexTransport = {
    start() {},
    request(method, params) {
      nextId += 1;
      requests.push({ method, params });
      return Promise.resolve(defaultResponse(method, params));
    },
    notify(_method, _params) {},
    respond(id, result) {
      responded.push({ id, result });
    },
    respondError(id, code, message) {
      respondErrors.push({ id, code, message });
    },
    messages: {
      [Symbol.asyncIterator]() {
        return inbox[Symbol.asyncIterator]();
      },
    },
    close() {
      closedFlag = true;
      inbox.end();
    },
  };

  return {
    transport,
    controls: {
      pushInbound(message) {
        inbox.push(message);
      },
      end() {
        closedFlag = true;
        inbox.end();
      },
      requests: () => [...requests],
      responded: () => [...responded],
      respondErrors: () => [...respondErrors],
      closed: () => closedFlag,
    },
  };
}
