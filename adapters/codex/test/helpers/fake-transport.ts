import { createAsyncQueue } from "@reins/adapter-kit";

import type {
  CodexRequestMethod,
  CodexRequestResultMap,
  CodexTransport,
  InboundMessage,
} from "#/transport";

type FakeRequest = { method: string; params: unknown };
type FakeResponse = { id: number; result: unknown };
type FakeErrorResponse = { id: number; code: number; message: string };

export type FakeCodexControls = {
  pushInbound(message: InboundMessage): void;
  end(): void;
  fail(error: unknown): void;
  requests(): Array<FakeRequest>;
  responded(): Array<FakeResponse>;
  respondErrors(): Array<FakeErrorResponse>;
  closed(): boolean;
  setResponse<TMethod extends CodexRequestMethod>(
    method: TMethod,
    value:
      | CodexRequestResultMap[TMethod]
      | PromiseLike<CodexRequestResultMap[TMethod]>,
  ): void;
  setCloseError(error: unknown): void;
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
  const overrides = new Map<CodexRequestMethod, unknown>();
  let closeError: unknown;
  let streamError: unknown;
  const defaults: CodexRequestResultMap = {
    initialize: {},
    "thread/start": { thread: { id: "thr1" } },
    "turn/start": { turn: { id: "turn0" } },
    "turn/steer": {},
    "turn/interrupt": {},
    "thread/delete": {},
    "model/list": { data: [] },
  };

  const transport: CodexTransport = {
    start() {},
    isClosed: () => closedFlag,
    request(method, params) {
      if (closedFlag) {
        return Promise.reject(new Error("codex app-server closed"));
      }
      nextId += 1;
      requests.push({ method, params });
      if (method === "turn/start") {
        turnSeq += 1;
        defaults["turn/start"] = { turn: { id: `turn${turnSeq}` } };
      }
      const response = overrides.has(method)
        ? overrides.get(method)
        : defaults[method];
      return Promise.resolve(response as CodexRequestResultMap[typeof method]);
    },
    notify(_method, _params) {},
    respond(id, result) {
      responded.push({ id, result });
    },
    respondError(id, code, message) {
      respondErrors.push({ id, code, message });
    },
    messages: {
      async *[Symbol.asyncIterator]() {
        for await (const message of inbox) yield message;
        if (streamError !== undefined) throw streamError;
      },
    },
    async close() {
      closedFlag = true;
      inbox.end();
      if (closeError !== undefined) throw closeError;
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
      fail(error) {
        streamError = error;
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
      setCloseError: (error) => {
        closeError = error;
      },
    },
  };
}
