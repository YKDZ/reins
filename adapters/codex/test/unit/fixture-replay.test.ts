import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";

import type {
  DomainEvent,
  SessionId,
  SessionName,
  TurnId,
} from "@reins/protocol";
import { describe, expect, test } from "vitest";

import { createCodexDriver } from "#/codex-driver";
import { createCodexTransport, type CodexChild } from "#/transport";

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("录制 fixture 回放", () => {
  test("list-and-tool fixture 映射出完整事件序列", async () => {
    const raw = await readFile(
      new URL("../fixtures/list-and-tool.jsonl", import.meta.url),
      "utf8",
    );
    const messages = raw
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            kind: "notification" | "request";
            id?: number;
            method: string;
            params: unknown;
          },
      );
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const emitter = new EventEmitter();
    const child: CodexChild = {
      stdin,
      stdout,
      on: (event, listener) => emitter.on(event, listener),
      kill: () => emitter.emit("exit"),
    };
    let outbound = "";
    stdin.on("data", (chunk) => {
      outbound += String(chunk);
      for (;;) {
        const newline = outbound.indexOf("\n");
        if (newline < 0) break;
        const line = outbound.slice(0, newline);
        outbound = outbound.slice(newline + 1);
        const request = JSON.parse(line) as { id?: number; method?: string };
        if (request.id === undefined || request.method === undefined) continue;
        const result =
          request.method === "thread/start"
            ? { thread: { id: "thr1" } }
            : request.method === "turn/start"
              ? { turn: { id: "turn1" } }
              : {};
        queueMicrotask(() => {
          stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
        });
      }
    });
    const transport = createCodexTransport({ spawnChild: () => child });
    const factory = createCodexDriver({
      transportFactory: () => transport,
    });
    const events: DomainEvent[] = [];
    const driver = factory({
      emit: (event) => events.push(event),
      diagnostics: async () => undefined,
    });
    driver.start({
      sessionId: "reviewer@g1" as SessionId,
      turnId: "t1" as TurnId,
      sessionName: "reviewer" as SessionName,
      harness: "codex",
      message: "列出当前目录的内容",
      cwd: "/tmp",
      model: "gpt-5.3-codex-spark",
      authorizationMode: "interactive",
    });
    await flush();
    for (const { kind: _kind, ...message } of messages) {
      stdout.write(`${JSON.stringify(message)}\n`);
    }
    stdout.end();
    await flush();
    emitter.emit("exit");
    await flush();

    expect(events.some((event) => event.type === "text.delta")).toBe(true);
    expect(events.some((event) => event.type === "tool.completed")).toBe(true);
    expect(
      events.filter((event) => event.type === "turn.completed").at(-1),
    ).toMatchObject({
      stopReason: "end_turn",
      finalReply: expect.any(String),
    });
  });
});
