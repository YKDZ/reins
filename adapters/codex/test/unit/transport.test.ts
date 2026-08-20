import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import type { DiagnosticInput, SessionId, TurnId } from "@reins/protocol";
import { describe, expect, test } from "vitest";

import { createCodexTransport, type CodexChild } from "#/transport";

function fakeChild(): {
  child: CodexChild;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exit(): void;
  error(): void;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  return {
    child: {
      stdin,
      stdout,
      stderr,
      on: (event, listener) => {
        emitter.on(event, listener);
      },
      kill: () => {
        emitter.emit("exit");
        stdout.end();
      },
    },
    stdin,
    stdout,
    stderr,
    exit: () => {
      emitter.emit("exit");
    },
    error: () => {
      emitter.emit("error");
    },
  };
}

const tick = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("codex transport", () => {
  test("缺省时保持 harness stderr 继承且不采集", async () => {
    const fake = fakeChild();
    const diagnostics: DiagnosticInput[] = [];
    let stdio: readonly ("pipe" | "inherit")[] | undefined;
    const transport = createCodexTransport({
      diagnostics: async (input) => {
        diagnostics.push(input);
        return undefined;
      },
      spawnChild: (_command, _args, options) => {
        stdio = options.stdio;
        return fake.child;
      },
    });

    transport.start();
    fake.stderr.write("not captured");
    await tick(10);

    expect(stdio).toEqual(["pipe", "pipe", "inherit"]);
    expect(diagnostics).toEqual([]);
    await transport.close();
  });

  test("显式采集 stderr 时按 UTF-8 边界分块并在流尾写出余量", async () => {
    const fake = fakeChild();
    const diagnostics: DiagnosticInput[] = [];
    const sessionId = "s-test" as SessionId;
    const turnId = "t-test" as TurnId;
    let stdio: readonly ("pipe" | "inherit")[] | undefined;
    const transport = createCodexTransport({
      captureHarnessStderr: true,
      diagnostics: async (input) => {
        diagnostics.push(input);
        return undefined;
      },
      diagnosticContext: () => ({ sessionId, turnId }),
      spawnChild: (_command, _args, options) => {
        stdio = options.stdio;
        return fake.child;
      },
    });

    transport.start();
    fake.stderr.write(`${"x".repeat(16 * 1024 - 1)}😀tail`);
    fake.stderr.end();
    await tick(10);

    expect(stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        source: "harness",
        harness: "codex",
        sessionId,
        turnId,
        kind: "harness_stderr",
        text: {
          text: "x".repeat(16 * 1024 - 1),
          truncated: false,
          originalBytes: 16 * 1024 - 1,
        },
      }),
      expect.objectContaining({
        kind: "harness_stderr",
        text: {
          text: "😀tail",
          truncated: false,
          originalBytes: Buffer.byteLength("😀tail"),
        },
      }),
    ]);
    await transport.close();
  });

  test("stderr 每块读取当时上下文，不串用前一回合", async () => {
    const fake = fakeChild();
    const diagnostics: DiagnosticInput[] = [];
    const firstSession = "s-first" as SessionId;
    const secondSession = "s-second" as SessionId;
    const firstTurn = "t-first" as TurnId;
    let context: { sessionId: SessionId; turnId: TurnId | null } = {
      sessionId: firstSession,
      turnId: firstTurn,
    };
    const transport = createCodexTransport({
      captureHarnessStderr: true,
      diagnostics: async (input) => {
        diagnostics.push(input);
        return undefined;
      },
      diagnosticContext: () => context,
      spawnChild: () => fake.child,
    });

    transport.start();
    fake.stderr.write("first");
    context = { sessionId: secondSession, turnId: null };
    fake.stderr.write("second");
    fake.stderr.end();
    await tick(10);

    expect(diagnostics).toEqual([
      expect.objectContaining({ sessionId: firstSession, turnId: firstTurn }),
      expect.objectContaining({ sessionId: secondSession }),
    ]);
    expect(diagnostics[1]).not.toHaveProperty("turnId");
    await transport.close();
  });

  test("stderr sink 受压时暂停读取并串行保序，rejection 不中断后续块", async () => {
    const fake = fakeChild();
    const seen: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstAccepted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const transport = createCodexTransport({
      captureHarnessStderr: true,
      diagnostics: async (input) => {
        if (input.kind !== "harness_stderr") return undefined;
        calls += 1;
        if (calls === 1) await firstAccepted;
        seen.push(input.text.text);
        if (calls === 1) throw new Error("sink rejected");
        return undefined;
      },
      diagnosticContext: () => ({
        sessionId: "s-test" as SessionId,
        turnId: null,
      }),
      spawnChild: () => fake.child,
    });
    transport.start();

    fake.stderr.write("first");
    await tick(1);
    expect(fake.stderr.isPaused()).toBe(true);
    fake.stderr.write("second");
    fake.stderr.end();
    releaseFirst?.();
    await transport.close();

    expect(seen).toEqual(["first", "second"]);
  });

  test("子进程先 exit 也等待 stderr 尾部完成 UTF-8 解码后再关闭", async () => {
    const fake = fakeChild();
    const diagnostics: DiagnosticInput[] = [];
    const transport = createCodexTransport({
      captureHarnessStderr: true,
      diagnostics: async (input) => {
        diagnostics.push(input);
        return undefined;
      },
      diagnosticContext: () => ({
        sessionId: "s-test" as SessionId,
        turnId: null,
      }),
      spawnChild: () => fake.child,
    });
    transport.start();

    const emoji = Buffer.from("😀");
    fake.stderr.write(emoji.subarray(0, 2));
    fake.exit();
    const closing = transport.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await tick(1);
    expect(closed).toBe(false);
    fake.stderr.end(emoji.subarray(2));
    await closing;

    expect(diagnostics).toEqual([
      expect.objectContaining({
        kind: "harness_stderr",
        text: { text: "😀", truncated: false, originalBytes: 4 },
      }),
    ]);
  });

  test("close 对持有 stdout/stderr fd 的后代进程有界并强制刷出 UTF-8 尾部", async () => {
    const fake = fakeChild();
    const diagnostics: DiagnosticInput[] = [];
    const signals: Array<NodeJS.Signals | undefined> = [];
    const transport = createCodexTransport({
      captureHarnessStderr: true,
      shutdownGraceMs: 5,
      diagnostics: async (input) => {
        diagnostics.push(input);
        return undefined;
      },
      diagnosticContext: () => ({
        sessionId: "s-test" as SessionId,
        turnId: null,
      }),
      spawnChild: () => ({
        ...fake.child,
        kill: (signal) => {
          signals.push(signal);
          return true;
        },
      }),
    });
    transport.start();
    fake.stderr.write(Buffer.from("😀").subarray(0, 2));

    await expect(
      Promise.race([
        transport.close().then(() => "closed"),
        tick(100).then(() => "timeout"),
      ]),
    ).resolves.toBe("closed");

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        kind: "harness_stderr",
        text: {
          text: "�",
          truncated: false,
          originalBytes: 2,
        },
      }),
    ]);
  });

  test.each([
    {
      name: "kill false",
      kill: () => false,
      message: "rejected SIGTERM",
    },
    {
      name: "kill throw",
      kill: () => {
        throw new Error("kill failed");
      },
      message: "kill failed",
    },
  ])("$name 也不会让 close 永久 pending", async ({ kill, message }) => {
    const fake = fakeChild();
    const transport = createCodexTransport({
      shutdownGraceMs: 5,
      spawnChild: () => ({ ...fake.child, kill }),
    });
    transport.start();

    await expect(
      Promise.race([
        transport.close().then(
          () => "resolved",
          (error: unknown) =>
            error instanceof Error ? error.message : String(error),
        ),
        tick(100).then(() => "timeout"),
      ]),
    ).resolves.toContain(message);
  });

  test("子进程 error 且 stdout fd 未收口时有界结束 inbox", async () => {
    const fake = fakeChild();
    const transport = createCodexTransport({
      shutdownGraceMs: 5,
      spawnChild: () => fake.child,
    });
    transport.start();
    const iterator = transport.messages[Symbol.asyncIterator]();
    const request = transport.request("initialize", {});

    fake.error();

    await expect(request).rejects.toThrow("codex app-server closed");
    await expect(
      Promise.race([
        iterator.next(),
        tick(100).then(() => ({ done: false, value: "timeout" as const })),
      ]),
    ).rejects.toThrow("process error");
  });

  test("spawn 同步失败后 close 仍可有界 settle", async () => {
    const transport = createCodexTransport({
      shutdownGraceMs: 5,
      spawnChild: () => {
        throw new Error("spawn failed");
      },
    });

    expect(() => transport.start()).toThrow("spawn failed");
    await expect(
      Promise.race([
        transport.close().then(() => "closed"),
        tick(100).then(() => "timeout"),
      ]),
    ).resolves.toBe("closed");
  });

  test("无效 JSON 会在 transport 边界记录 protocol violation", async () => {
    const fake = fakeChild();
    const diagnostics: DiagnosticInput[] = [];
    const transport = createCodexTransport({
      diagnostics: async (input) => {
        diagnostics.push(input);
        return undefined;
      },
      spawnChild: () => fake.child,
    });
    transport.start();

    fake.stdout.write("not json\n");
    await tick(10);

    expect(diagnostics).toEqual([
      expect.objectContaining({
        source: "adapter",
        harness: "codex",
        kind: "protocol_violation",
        operation: "decode_worker_message",
        reason: "invalid_json",
      }),
    ]);
    await transport.close();
  });

  test("无关未知 notification 忽略，已知 item 的非法 status 拒绝", async () => {
    const fake = fakeChild();
    const diagnostics: DiagnosticInput[] = [];
    const transport = createCodexTransport({
      diagnostics: async (input) => {
        diagnostics.push(input);
        return undefined;
      },
      spawnChild: () => fake.child,
    });
    transport.start();
    const iterator = transport.messages[Symbol.asyncIterator]();

    fake.stdout.write(
      `${JSON.stringify({ method: "account/rateLimits/updated", params: null })}\n`,
    );
    fake.stdout.write(
      `${JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            type: "commandExecution",
            id: "tool-1",
            status: "unknown",
            aggregatedOutput: "ignored",
          },
        },
      })}\n`,
    );
    fake.stdout.write(
      `${JSON.stringify({
        method: "item/agentMessage/delta",
        params: { itemId: "message-1", delta: "ok" },
      })}\n`,
    );

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        kind: "notification",
        method: "item/agentMessage/delta",
        params: { itemId: "message-1", delta: "ok" },
      },
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      kind: "protocol_violation",
      operation: "validate_worker_event",
      reason: "invalid_shape",
    });
    await transport.close();
  });

  test("已知 item notification 中未知 variant 不得当作无关消息忽略", async () => {
    const fake = fakeChild();
    const diagnostics: DiagnosticInput[] = [];
    const transport = createCodexTransport({
      diagnostics: async (input) => {
        diagnostics.push(input);
        return undefined;
      },
      spawnChild: () => fake.child,
    });
    transport.start();
    const iterator = transport.messages[Symbol.asyncIterator]();

    fake.stdout.write(
      `${JSON.stringify({
        method: "item/completed",
        params: {
          item: { type: "agentMesage", id: "message-typo", text: "lost" },
        },
      })}\n`,
    );
    fake.stdout.write(
      `${JSON.stringify({
        method: "item/agentMessage/delta",
        params: { itemId: "message-1", delta: "ok" },
      })}\n`,
    );

    await expect(iterator.next()).resolves.toMatchObject({
      value: { method: "item/agentMessage/delta" },
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      kind: "protocol_violation",
      operation: "validate_worker_event",
      reason: "invalid_shape",
    });
    await transport.close();
  });

  test("已知审批请求的 availableDecisions 含未知值时整体拒绝", async () => {
    const fake = fakeChild();
    const diagnostics: DiagnosticInput[] = [];
    let written = "";
    fake.stdin.on("data", (chunk) => {
      written += String(chunk);
    });
    const transport = createCodexTransport({
      diagnostics: async (input) => {
        diagnostics.push(input);
        return undefined;
      },
      spawnChild: () => fake.child,
    });
    transport.start();
    const iterator = transport.messages[Symbol.asyncIterator]();

    fake.stdout.write(
      `${JSON.stringify({
        id: 42,
        method: "item/commandExecution/requestApproval",
        params: { availableDecisions: ["accept", "futureDecision"] },
      })}\n`,
    );
    fake.stdout.write(
      `${JSON.stringify({
        method: "item/agentMessage/delta",
        params: { itemId: "message-1", delta: "ok" },
      })}\n`,
    );

    await expect(iterator.next()).resolves.toMatchObject({
      value: { method: "item/agentMessage/delta" },
    });
    expect(diagnostics).toHaveLength(1);
    expect(written).toContain(
      '"id":42,"error":{"code":-32602,"message":"Invalid server request"}',
    );
    await transport.close();
  });

  test("非法 worker response 会在 transport 边界记录 protocol violation", async () => {
    const fake = fakeChild();
    const diagnostics: DiagnosticInput[] = [];
    const transport = createCodexTransport({
      diagnostics: async (input) => {
        diagnostics.push(input);
        return undefined;
      },
      spawnChild: () => fake.child,
    });
    transport.start();

    fake.stdout.write(`${JSON.stringify({ id: "wrong", result: {} })}\n`);
    await tick(10);

    expect(diagnostics).toEqual([
      expect.objectContaining({
        source: "adapter",
        harness: "codex",
        kind: "protocol_violation",
        operation: "validate_worker_response",
        reason: "invalid_shape",
      }),
    ]);
    await transport.close();
  });

  test("畸形 thread/start result 拒绝请求并记录一次 protocol violation", async () => {
    const fake = fakeChild();
    const diagnostics: DiagnosticInput[] = [];
    const transport = createCodexTransport({
      diagnostics: async (input) => {
        diagnostics.push(input);
        return undefined;
      },
      spawnChild: () => fake.child,
    });
    transport.start();
    const request = transport.request("thread/start", {});
    await tick(1);
    fake.stdout.write(`${JSON.stringify({ id: 1, result: { thread: {} } })}\n`);
    await expect(request).rejects.toThrow("invalid shape");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      kind: "protocol_violation",
      operation: "validate_worker_response",
      reason: "invalid_shape",
    });
    await transport.close();
  });

  test("已知 server request 参数畸形时记录一次并立即回应错误", async () => {
    const fake = fakeChild();
    const diagnostics: DiagnosticInput[] = [];
    let written = "";
    fake.stdin.on("data", (chunk) => {
      written += String(chunk);
    });
    const transport = createCodexTransport({
      diagnostics: async (input) => {
        diagnostics.push(input);
        return undefined;
      },
      spawnChild: () => fake.child,
    });
    transport.start();

    fake.stdout.write(
      `${JSON.stringify({
        id: 41,
        method: "item/commandExecution/requestApproval",
        params: null,
      })}\n`,
    );
    await tick(10);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      kind: "protocol_violation",
      operation: "validate_worker_event",
      reason: "invalid_shape",
    });
    expect(written).toContain(
      '"id":41,"error":{"code":-32602,"message":"Invalid server request"}',
    );
    await transport.close();
  });

  test("在途请求的畸形 error 不等到超时且只记录一次", async () => {
    const fake = fakeChild();
    const diagnostics: DiagnosticInput[] = [];
    const transport = createCodexTransport({
      diagnostics: async (input) => {
        diagnostics.push(input);
        return undefined;
      },
      requestTimeoutMs: 5_000,
      spawnChild: () => fake.child,
    });
    transport.start();

    const request = transport.request("thread/start", {});
    await tick(1);
    fake.stdout.write(`${JSON.stringify({ id: 1, error: { message: 7 } })}\n`);

    await expect(request).rejects.toBeInstanceOf(Error);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      kind: "protocol_violation",
      operation: "validate_worker_response",
      reason: "invalid_shape",
    });
    await transport.close();
  });

  test("请求经 stdin 发出并从 stdout 取响应", async () => {
    const fake = fakeChild();
    let written = "";
    fake.stdin.on("data", (chunk) => {
      written += String(chunk);
    });
    const transport = createCodexTransport({ spawnChild: () => fake.child });
    transport.start();

    const requestPromise = transport.request("initialize", { value: 1 });
    await tick(10);
    expect(written).toContain('"method":"initialize"');
    const sent = JSON.parse(written.trim().split("\n").at(-1) ?? "{}") as {
      id: number;
    };
    fake.stdout.write(`${JSON.stringify({ id: sent.id, result: {} })}\n`);
    await expect(requestPromise).resolves.toEqual({});
    await transport.close();
  });

  test("子进程退出时在途请求拒绝", async () => {
    const fake = fakeChild();
    const transport = createCodexTransport({ spawnChild: () => fake.child });
    transport.start();

    const requestPromise = transport.request("initialize", {});
    fake.exit();
    fake.stdout.end();
    await expect(requestPromise).rejects.toThrow("codex app-server closed");
  });

  test("子进程 exit 早于 stdout 尾事件时仍先 drain 消息", async () => {
    const fake = fakeChild();
    const transport = createCodexTransport({ spawnChild: () => fake.child });
    transport.start();
    const iterator = transport.messages[Symbol.asyncIterator]();

    fake.exit();
    fake.stdout.write(
      `${JSON.stringify({
        method: "turn/completed",
        params: { turn: { status: "completed" } },
      })}\n`,
    );
    fake.stdout.end();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        kind: "notification",
        method: "turn/completed",
      },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  test("子进程 exit 早于 stdout 尾响应时在途请求仍可结算", async () => {
    const fake = fakeChild();
    const transport = createCodexTransport({ spawnChild: () => fake.child });
    transport.start();
    const request = transport.request("thread/start", {});
    await tick(1);

    fake.exit();
    fake.stdout.write(
      `${JSON.stringify({ id: 1, result: { thread: { id: "tail-thread" } } })}\n`,
    );
    fake.stdout.end();

    await expect(request).resolves.toEqual({ thread: { id: "tail-thread" } });
  });

  test("子进程退出后新请求立即拒绝而不是挂死", async () => {
    const fake = fakeChild();
    const transport = createCodexTransport({ spawnChild: () => fake.child });
    transport.start();
    fake.exit();
    fake.stdout.end();

    const outcome = await Promise.race([
      transport.request("initialize", {}).then(
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

    await expect(transport.request("initialize", {})).rejects.toThrow(
      "request timed out",
    );
    await transport.close();
  });
});
