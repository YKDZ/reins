import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, test } from "vitest";

import { createCodexTransport, type CodexChild } from "#/transport";

function fakeChild(): {
  child: CodexChild;
  stdin: PassThrough;
  stdout: PassThrough;
  exit(): void;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const emitter = new EventEmitter();
  return {
    child: {
      stdin,
      stdout,
      on: (event, listener) => {
        emitter.on(event, listener);
      },
      kill: () => {
        emitter.emit("exit");
      },
    },
    stdin,
    stdout,
    exit: () => {
      emitter.emit("exit");
    },
  };
}

const tick = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("codex transport", () => {
  test("请求经 stdin 发出并从 stdout 取响应", async () => {
    const fake = fakeChild();
    let written = "";
    fake.stdin.on("data", (chunk) => {
      written += String(chunk);
    });
    const transport = createCodexTransport({ spawnChild: () => fake.child });
    transport.start();

    const requestPromise = transport.request("ping", { value: 1 });
    await tick(10);
    expect(written).toContain('"method":"ping"');
    const sent = JSON.parse(written.trim().split("\n").at(-1) ?? "{}") as {
      id: number;
    };
    fake.stdout.write(
      `${JSON.stringify({ id: sent.id, result: { ok: true } })}\n`,
    );
    await expect(requestPromise).resolves.toEqual({ ok: true });
    transport.close();
  });

  test("子进程退出时在途请求拒绝", async () => {
    const fake = fakeChild();
    const transport = createCodexTransport({ spawnChild: () => fake.child });
    transport.start();

    const requestPromise = transport.request("ping", {});
    fake.exit();
    await expect(requestPromise).rejects.toThrow("codex app-server closed");
  });

  test("子进程退出后新请求立即拒绝而不是挂死", async () => {
    const fake = fakeChild();
    const transport = createCodexTransport({ spawnChild: () => fake.child });
    transport.start();
    fake.exit();

    const outcome = await Promise.race([
      transport.request("ping", {}).then(
        (value) => `resolved:${JSON.stringify(value)}`,
        (error: unknown) =>
          `rejected:${error instanceof Error ? error.message : String(error)}`,
      ),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("timeout"), 200),
      ),
    ]);
    expect(outcome).toBe("rejected:codex app-server closed");
  });

  test("无响应的请求按超时拒绝", async () => {
    const fake = fakeChild();
    const transport = createCodexTransport({
      spawnChild: () => fake.child,
      requestTimeoutMs: 50,
    });
    transport.start();

    await expect(transport.request("hang", {})).rejects.toThrow(
      "request timed out",
    );
    transport.close();
  });
});
