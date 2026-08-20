import { readFile } from "node:fs/promises";

import type { SDKMessage } from "@qodercn-ai/qodercn-agent-sdk";
import type {
  DomainEvent,
  SessionId,
  SessionName,
  TurnId,
} from "@reins/protocol";
import { describe, expect, test } from "vitest";

import { createQoderDriver } from "#/qoder-driver";

import { createFakeSdk } from "../helpers/fake-sdk.ts";

const flush = async (): Promise<void> => {
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
      .map((line) => JSON.parse(line) as SDKMessage);
    const fake = createFakeSdk();
    const transcript: Array<[string, unknown]> = [];
    const factory = createQoderDriver({
      sdk: fake.sdk,
      transcript: (kind, payload) => transcript.push([kind, payload]),
    });
    const events: DomainEvent[] = [];
    const driver = factory((event) => events.push(event));
    driver.start({
      sessionId: "reviewer@g1" as SessionId,
      turnId: "t1" as TurnId,
      sessionName: "reviewer" as SessionName,
      harness: "qoder",
      message: "列出当前目录的内容",
      cwd: "/tmp",
      model: "qwen3.7-flash",
      authorizationMode: "interactive",
    });
    for (const message of messages) fake.controls.push(message);
    fake.controls.end();
    await flush();

    expect(events.some((event) => event.type === "text.delta")).toBe(true);
    expect(
      events.some((event) => event.type === "tool.completed" && !event.isError),
    ).toBe(true);
    expect(events.some((event) => event.type === "tool.requested")).toBe(true);
    expect(
      events.filter((event) => event.type === "turn.completed").at(-1),
    ).toMatchObject({
      stopReason: "end_turn",
      finalReply: expect.any(String),
    });
    expect(transcript.some(([kind]) => kind === "thinking")).toBe(true);
  });
});
