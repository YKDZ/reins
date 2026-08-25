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
  test("固定版本的 list-and-tool 流保留原生消息和工具生命周期", async () => {
    const metadata = JSON.parse(
      await readFile(
        new URL("../fixtures/list-and-tool.metadata.json", import.meta.url),
        "utf8",
      ),
    ) as {
      lineCount: number;
      nativeToolCount: number;
      protocolVersion: string;
      qoderCliVersion: string;
      sdkVersion: string;
    };
    const raw = await readFile(
      new URL("../fixtures/list-and-tool.jsonl", import.meta.url),
      "utf8",
    );
    const messages = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SDKMessage);
    expect(metadata).toMatchObject({
      lineCount: 53,
      nativeToolCount: 1,
      protocolVersion: "1.2.0",
      qoderCliVersion: "1.1.25",
      sdkVersion: "1.0.23",
    });
    expect(messages).toHaveLength(metadata.lineCount);
    expect(messages[0]).toMatchObject({
      type: "system",
      protocol_version: metadata.protocolVersion,
      qodercli_version: metadata.qoderCliVersion,
    });
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
      message: "列出当前目录的内容",
      cwd: "/tmp",
      model: "qwen3.7-flash",
      authorizationMode: "interactive",
    });
    for (const message of messages) fake.controls.push(message);
    fake.controls.end();
    await flush();

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
  });
});
