import { createAsyncQueue } from "@reins/adapter-kit";

import type { CodexTransport, InboundMessage } from "#/transport";

type FakeRequest = { method: string; params: unknown };
type FakeResponse = { id: number; result: unknown };
type FakeErrorResponse = { id: number; code: number; message: string };

export type FakeCodexControls = {
  pushInbound(message: InboundMessage): void;
  end(): void;
  requests(): Array<FakeRequest>;
  responded(): Array<FakeResponse>;
  respondErrors(): Array<FakeErrorResponse>;
  closed(): boolean;
  setResponse(method: string, value: unknown): void;
};

export function createFakeTransport(): {
  transport: CodexTransport;
  controls: FakeCodexControls;
} {
  const requests: Array<FakeRequest> = [];
  const responded: Array<FakeResponse> = [];
  const respondErrors: Array<FakeErrorResponse> = [];
  const inbox = createAsyncQueue<InboundMessage>();
  let closedFlag = false;
  let nextId = 0;
  let turnSeq = 0;
  const overrides = new Map<string, unknown>();

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
      if (closedFlag) {
        return Promise.reject(new Error("codex app-server closed"));
      }
      nextId += 1;
      requests.push({ method, params });
      return Promise.resolve(
        overrides.has(method)
          ? overrides.get(method)
          : defaultResponse(method, params),
      );
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
      setResponse: (method, value) => {
        overrides.set(method, value);
      },
    },
  };
}
