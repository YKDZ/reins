import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

import { createAsyncQueue } from "@reins/adapter-kit";

export type InboundMessage =
  | { kind: "notification"; method: string; params: unknown }
  | { kind: "request"; id: number; method: string; params: unknown };

// app-server 的 JSON-RPC 2.0 传输（jsonrpc 头省略，stdio JSONL）。
export type CodexTransport = {
  start(): void;
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
  respond(id: number, result: unknown): void;
  respondError(id: number, code: number, message: string): void;
  messages: AsyncIterable<InboundMessage>;
  close(): void;
};

export function createCodexTransport(options: {
  binaryPath?: string;
}): CodexTransport {
  let child: ChildProcess | null = null;
  let nextId = 0;
  let closed = false;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  const inbox = createAsyncQueue<InboundMessage>();

  function push(message: InboundMessage): void {
    inbox.push(message);
  }

  function end(): void {
    if (closed) return;
    closed = true;
    inbox.end();
    for (const [, entry] of pending) {
      entry.reject(new Error("codex app-server 已关闭"));
    }
    pending.clear();
  }

  function write(payload: unknown): void {
    if (child === null || closed) return;
    child.stdin?.write(`${JSON.stringify(payload)}\n`);
  }

  return {
    start() {
      child = spawn(
        options.binaryPath ?? "codex",
        ["app-server", "--listen", "stdio://"],
        { stdio: ["pipe", "pipe", "inherit"] },
      );
      child.on("exit", end);
      child.on("error", end);
      const lines = createInterface({ input: child.stdout ?? process.stdin });
      lines.on("line", (line) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          return;
        }
        if (typeof parsed !== "object" || parsed === null) return;
        const message = parsed as {
          id?: number;
          method?: string;
          params?: unknown;
          result?: unknown;
          error?: unknown;
        };
        if (message.method !== undefined && message.id === undefined) {
          push({
            kind: "notification",
            method: message.method,
            params: message.params,
          });
        } else if (message.method !== undefined && message.id !== undefined) {
          push({
            kind: "request",
            id: message.id,
            method: message.method,
            params: message.params,
          });
        } else if (message.id !== undefined) {
          const entry = pending.get(message.id);
          if (entry === undefined) return;
          pending.delete(message.id);
          if (message.error !== undefined && message.error !== null) {
            entry.reject(new Error(JSON.stringify(message.error)));
          } else {
            entry.resolve(message.result);
          }
        }
      });
    },
    request(method, params) {
      nextId += 1;
      const id = nextId;
      write({ id, method, params });
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    },
    notify(method, params) {
      write({ method, params });
    },
    respond(id, result) {
      write({ id, result });
    },
    respondError(id, code, message) {
      write({ id, error: { code, message } });
    },
    messages: {
      [Symbol.asyncIterator]() {
        return inbox[Symbol.asyncIterator]();
      },
    },
    close() {
      child?.kill("SIGTERM");
      end();
    },
  };
}
