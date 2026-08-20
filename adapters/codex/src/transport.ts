import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { createAsyncQueue } from "@reins/adapter-kit";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export type CodexChild = {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  on(event: "exit" | "error", listener: () => void): void;
  kill(signal?: NodeJS.Signals): void;
};

export type SpawnChild = (
  command: string,
  args: readonly string[],
  options: { readonly stdio: readonly ("pipe" | "inherit")[] },
) => CodexChild;

function spawnRealChild(
  command: string,
  args: readonly string[],
  options: { readonly stdio: readonly ("pipe" | "inherit")[] },
): CodexChild {
  const child = spawn(command, [...args], { stdio: [...options.stdio] });
  return {
    stdin: child.stdin as NodeJS.WritableStream,
    stdout: child.stdout as NodeJS.ReadableStream,
    on: (event, listener) => {
      child.on(event, listener);
    },
    kill: (signal) => child.kill(signal),
  };
}

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
  spawnChild?: SpawnChild;
  requestTimeoutMs?: number;
}): CodexTransport {
  let child: CodexChild | null = null;
  let nextId = 0;
  let closed = false;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
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
      clearTimeout(entry.timer);
      entry.reject(new Error("codex app-server closed"));
    }
    pending.clear();
  }

  function write(payload: unknown): void {
    if (child === null || closed) return;
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  return {
    start() {
      const doSpawn = options.spawnChild ?? spawnRealChild;
      child = doSpawn(
        options.binaryPath ?? "codex",
        ["app-server", "--listen", "stdio://"],
        { stdio: ["pipe", "pipe", "inherit"] },
      );
      child.on("exit", end);
      child.on("error", end);
      const lines = createInterface({ input: child.stdout });
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
          clearTimeout(entry.timer);
          if (message.error !== undefined && message.error !== null) {
            entry.reject(new Error(JSON.stringify(message.error)));
          } else {
            entry.resolve(message.result);
          }
        }
      });
    },
    request(method, params) {
      if (closed) {
        return Promise.reject(new Error("codex app-server closed"));
      }
      nextId += 1;
      const id = nextId;
      write({ id, method, params });
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`codex app-server request timed out: ${method}`));
        }, requestTimeoutMs);
        pending.set(id, { resolve, reject, timer });
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
      child?.kill();
      end();
    },
  };
}
