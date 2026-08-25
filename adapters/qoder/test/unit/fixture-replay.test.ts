import { createHash } from "node:crypto";
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

type FixtureMetadata = {
  fixture: string;
  recordedAt: string;
  sdkVersion: string;
  qoderCliVersion: string;
  protocolVersion: string;
  lineCount: number;
  uniqueNativeToolCount: number;
  sha256: string;
  scenario: string;
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

async function loadFixture(name: string): Promise<{
  messages: SDKMessage[];
  metadata: FixtureMetadata;
}> {
  const [raw, metadataRaw, sdkPackageRaw] = await Promise.all([
    readFile(new URL(`../fixtures/${name}.jsonl`, import.meta.url), "utf8"),
    readFile(
      new URL(`../fixtures/${name}.metadata.json`, import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../package.json",
        import.meta.resolve("@qodercn-ai/qodercn-agent-sdk"),
      ),
      "utf8",
    ),
  ]);
  const metadata = JSON.parse(metadataRaw) as FixtureMetadata;
  const sdkPackage = JSON.parse(sdkPackageRaw) as { version: string };
  const messages = raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as SDKMessage);
  const nativeToolIds = new Set<string>();
  for (const message of messages) {
    if (
      message.type === "stream_event" &&
      message.event.type === "content_block_start" &&
      message.event.content_block?.type === "tool_use" &&
      typeof message.event.content_block.id === "string"
    ) {
      nativeToolIds.add(message.event.content_block.id);
    }
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "tool_use" && typeof block.id === "string") {
          nativeToolIds.add(block.id);
        }
      }
    }
  }
  const recordedAt = messages
    .flatMap((message) =>
      "timestamp" in message && typeof message.timestamp === "string"
        ? [message.timestamp]
        : [],
    )
    .at(0);
  expect(metadata).toMatchObject({
    fixture: `${name}.jsonl`,
    lineCount: messages.length,
    recordedAt,
    sdkVersion: sdkPackage.version,
    uniqueNativeToolCount: nativeToolIds.size,
    sha256: sha256(raw),
    scenario: expect.any(String),
  });
  expect(messages[0]).toMatchObject({
    type: "system",
    cwd: "<fixture-cwd>",
    protocol_version: metadata.protocolVersion,
    qodercli_version: metadata.qoderCliVersion,
  });
  return { messages, metadata };
}

async function replayFixture(
  messages: readonly SDKMessage[],
): Promise<DomainEvent[]> {
  const fake = createFakeSdk();
  const factory = createQoderDriver({ sdk: fake.sdk });
  const events: DomainEvent[] = [];
  const driver = factory({
    emit: (event) => events.push(event),
    diagnostics: async () => undefined,
  });
  driver.start({
    sessionId: "reviewer@g1" as SessionId,
    turnId: "t1" as TurnId,
    sessionName: "reviewer" as SessionName,
    harness: "qoder",
    message: "fixture replay",
    cwd: "/tmp",
    model: "qwen3.7-flash",
    authorizationMode: "interactive",
  });
  for (const message of messages) fake.controls.push(message);
  fake.controls.end();
  await flush();
  return events;
}

describe("录制 fixture 回放", () => {
  test("固定版本的 list-and-tool 流保留原生消息和工具生命周期", async () => {
    const { messages, metadata } = await loadFixture("list-and-tool");
    expect(metadata).toMatchObject({
      lineCount: 53,
      uniqueNativeToolCount: 1,
      protocolVersion: "1.2.0",
      qoderCliVersion: "1.1.25",
      sdkVersion: "1.0.23",
      sha256:
        "c5ee314bd0db8fd340fd3b811600399b1319a04e0277f3b89488614a6a72c4b0",
    });
    const events = await replayFixture(messages);

    const deltas = events.filter((event) => event.type === "text.delta");
    const snapshots = events.filter((event) => event.type === "message");
    expect(deltas.map((event) => event.delta)).toEqual([
      "当前目录",
      "包含两个文件：",
      "\n\n",
      "- `alpha.txt",
      "` — 6",
      " 字节\n-",
      " `beta.md`",
      " — 7 ",
      "字节",
    ]);
    expect(new Set(deltas.map((event) => event.messageId))).toEqual(
      new Set(["m1"]),
    );
    expect(snapshots).toEqual([
      {
        type: "message",
        sessionId: "reviewer@g1",
        turnId: "t1",
        messageId: "m1",
        role: "worker",
        content:
          "当前目录包含两个文件：\n\n- `alpha.txt` — 6 字节\n- `beta.md` — 7 字节",
      },
    ]);

    expect(
      events.filter(
        (event) =>
          event.type === "tool.requested" || event.type === "tool.completed",
      ),
    ).toEqual([
      {
        type: "tool.requested",
        sessionId: "reviewer@g1",
        turnId: "t1",
        toolCallId: "c1",
        name: "Bash",
      },
      {
        type: "tool.completed",
        sessionId: "reviewer@g1",
        turnId: "t1",
        toolCallId: "c1",
        name: "Bash",
        result:
          "total 28\ndrwx------ 2 root root  4096 Aug 19 04:14 .\ndrwxrwxrwt 1 root root 12288 Aug 19 04:14 ..\n-rw-r--r-- 1 root root     6 Aug 19 04:14 alpha.txt\n-rw-r--r-- 1 root root     7 Aug 19 04:14 beta.md",
        isError: false,
      },
    ]);

    expect(events.filter((event) => event.type === "turn.completed")).toEqual([
      {
        type: "turn.completed",
        sessionId: "reviewer@g1",
        turnId: "t1",
        stopReason: "end_turn",
        finalReply:
          "当前目录包含两个文件：\n\n- `alpha.txt` — 6 字节\n- `beta.md` — 7 字节",
        usage: {
          input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
          server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
          service_tier: "standard",
          cache_creation: {
            ephemeral_1h_input_tokens: 0,
            ephemeral_5m_input_tokens: 0,
          },
          inference_geo: "",
          iterations: [],
          speed: "standard",
          credits: 0.089142196,
          original_credits: 0.089142196,
          billable: true,
        },
      },
    ]);
    expect(events.findIndex((event) => event.type === "message")).toBeLessThan(
      events.findIndex((event) => event.type === "turn.completed"),
    );
  });

  test("真实 two-tools 流精确保留两个工具与消息终态", async () => {
    const { messages, metadata } = await loadFixture("two-tools");
    expect(metadata).toMatchObject({
      lineCount: 84,
      uniqueNativeToolCount: 2,
      protocolVersion: "1.2.0",
      qoderCliVersion: "1.1.23",
      sdkVersion: "1.0.23",
      sha256:
        "58e8d23afce4c0aa2cd8b5293f2b06dee2be3f4c968f01acc6391f1c327b4be8",
    });
    const events = await replayFixture(messages);

    expect(
      events.filter(
        (event) =>
          event.type === "tool.requested" || event.type === "tool.completed",
      ),
    ).toEqual([
      {
        type: "tool.requested",
        sessionId: "reviewer@g1",
        turnId: "t1",
        toolCallId: "c1",
        name: "Bash",
      },
      {
        type: "tool.completed",
        sessionId: "reviewer@g1",
        turnId: "t1",
        toolCallId: "c1",
        name: "Bash",
        result: "first",
        isError: false,
      },
      {
        type: "tool.requested",
        sessionId: "reviewer@g1",
        turnId: "t1",
        toolCallId: "c2",
        name: "Bash",
      },
      {
        type: "tool.completed",
        sessionId: "reviewer@g1",
        turnId: "t1",
        toolCallId: "c2",
        name: "Bash",
        result: "second",
        isError: false,
      },
    ]);

    const deltas = events.filter((event) => event.type === "text.delta");
    const snapshots = events.filter((event) => event.type === "message");
    expect(deltas).toHaveLength(12);
    expect(snapshots.map((event) => event.messageId)).toEqual(["m1", "m2"]);
    expect(new Set(deltas.map((event) => event.messageId))).toEqual(
      new Set(["m1", "m2"]),
    );
    const deltaHashes = snapshots.map((snapshot) =>
      sha256(
        deltas
          .filter((delta) => delta.messageId === snapshot.messageId)
          .map((delta) => delta.delta)
          .join(""),
      ),
    );
    const snapshotHashes = snapshots.map((snapshot) =>
      sha256(snapshot.content),
    );
    expect(deltaHashes).toEqual([
      "d45dd6feecf4f151424376d88796d93b761b9101488e5bc845545c3385fa48a5",
      "cf483b98c8ab2e60be487129d3439e04c74fab1f1da82bc6ef64c72877f854a8",
    ]);
    expect(snapshotHashes).toEqual(deltaHashes);

    const completed = events.filter((event) => event.type === "turn.completed");
    expect(completed).toEqual([
      {
        type: "turn.completed",
        sessionId: "reviewer@g1",
        turnId: "t1",
        stopReason: "end_turn",
        finalReply: snapshots[1]?.content,
        usage: {
          input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
          server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
          service_tier: "standard",
          cache_creation: {
            ephemeral_1h_input_tokens: 0,
            ephemeral_5m_input_tokens: 0,
          },
          inference_geo: "",
          iterations: [],
          speed: "standard",
          credits: 0.03156128799999999,
          original_credits: 0.03156128799999999,
          billable: true,
        },
      },
    ]);
    expect(sha256(completed[0]?.finalReply ?? "")).toBe(
      "cf483b98c8ab2e60be487129d3439e04c74fab1f1da82bc6ef64c72877f854a8",
    );
    expect(events.findIndex((event) => event.type === "message")).toBeLessThan(
      events.findIndex((event) => event.type === "turn.completed"),
    );
  });
});
