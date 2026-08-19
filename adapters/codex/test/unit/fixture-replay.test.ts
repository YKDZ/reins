import { readFile } from "node:fs/promises";

import type { DomainEvent } from "@reins/protocol";
import { describe, expect, test } from "vitest";

import { createCodexDriver } from "#/codex-driver";
import type { InboundMessage } from "#/transport";

import { createFakeTransport } from "../helpers/fake-transport.ts";

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
      .map((line) => JSON.parse(line) as InboundMessage);
    const fake = createFakeTransport();
    const transcript: Array<[string, unknown]> = [];
    const factory = createCodexDriver({
      transportFactory: () => fake.transport,
      transcript: (kind, payload) => transcript.push([kind, payload]),
    });
    const events: DomainEvent[] = [];
    const driver = factory((event) => events.push(event));
    driver.start({
      sessionId: "s1",
      turnId: "s1:t1",
      harness: "codex",
      message: "列出当前目录的内容",
      cwd: "/tmp",
      model: "gpt-5.3-codex-spark",
      authorizationMode: "interactive",
    });
    await flush();
    for (const message of messages) fake.controls.pushInbound(message);
    fake.controls.end();
    await flush();

    expect(events.some((event) => event.type === "text.delta")).toBe(true);
    expect(events.some((event) => event.type === "tool.completed")).toBe(true);
    expect(
      events.filter((event) => event.type === "turn.completed").at(-1),
    ).toMatchObject({
      stopReason: "end_turn",
      finalReply: expect.any(String),
    });
    expect(transcript.some(([kind]) => kind === "reasoning")).toBe(true);
  });
});
