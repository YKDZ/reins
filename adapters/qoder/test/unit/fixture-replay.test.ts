import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { SDKMessage } from "@qodercn-ai/qodercn-agent-sdk";
import type { DomainEvent, SessionId, TurnId } from "@reins/protocol";
import { describe, expect, test } from "vitest";

import { KnownCredentialPolicyError } from "#/fixture-policy";
import { createQoderDriver } from "#/qoder-driver";
import {
  loadAnchoredRecordedQoderFixtureSource,
  loadRecordedQoderFixture,
  loadRecordedQoderFixtureSource,
} from "#/testing";

import { createFakeSdk } from "../helpers/fake-sdk.ts";

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

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
  await driver.start({
    sessionId:
      "session:00000000-0000-4000-8000-000000000000:reviewer:1" as SessionId,
    turnId: "t1" as TurnId,
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
  test("loader拒绝canonical metadata中的额外认证与运行态字段", async () => {
    const fixture = await loadRecordedQoderFixture("two-tools");
    const raw = await readFile(
      new URL("../fixtures/two-tools.jsonl", import.meta.url),
      "utf8",
    );
    const metadataWithCredential = `${JSON.stringify(
      {
        ...fixture.metadata,
        runtime: {
          QODER_ACCESS_TOKEN: "opaque-device-secret",
          transcript: [],
        },
      },
      null,
      2,
    )}\n`;
    expect(() =>
      loadRecordedQoderFixtureSource("two-tools", {
        raw,
        metadataRaw: metadataWithCredential,
        sdkVersion: fixture.metadata.sdkVersion,
      }),
    ).toThrow(KnownCredentialPolicyError);
    const metadataWithRuntime = `${JSON.stringify(
      { ...fixture.metadata, runtime: { transcript: [] } },
      null,
      2,
    )}\n`;
    expect(() =>
      loadRecordedQoderFixtureSource("two-tools", {
        raw,
        metadataRaw: metadataWithRuntime,
        sdkVersion: fixture.metadata.sdkVersion,
      }),
    ).toThrow("Recorded Qoder fixture metadata mismatch");
  });

  test("通用source loader接受自洽的新录制artifact而不声称固定provenance", async () => {
    const fixture = await loadRecordedQoderFixture("two-tools");
    const raw = await readFile(
      new URL("../fixtures/two-tools.jsonl", import.meta.url),
      "utf8",
    );
    const lines = raw.trimEnd().split("\n");
    const init = JSON.parse(lines[0]!) as Record<string, unknown>;
    lines[0] = JSON.stringify({ ...init, qodercli_version: "1.1.99" });
    const changedRaw = `${lines.join("\n")}\n`;
    const changedMetadata = `${JSON.stringify(
      {
        ...fixture.metadata,
        qoderCliVersion: "1.1.99",
        artifactSha256: sha256(changedRaw),
        sourceSha256: "0".repeat(64),
      },
      null,
      2,
    )}\n`;
    expect(() =>
      loadRecordedQoderFixtureSource("two-tools", {
        raw: changedRaw,
        metadataRaw: changedMetadata,
        sdkVersion: fixture.metadata.sdkVersion,
      }),
    ).not.toThrow();
  });

  test("anchored loader拒绝只forge pair而未更新独立anchor", async () => {
    const fixture = await loadRecordedQoderFixture("two-tools");
    const raw = await readFile(
      new URL("../fixtures/two-tools.jsonl", import.meta.url),
      "utf8",
    );
    const lines = raw.trimEnd().split("\n");
    const init = JSON.parse(lines[0]!) as Record<string, unknown>;
    lines[0] = JSON.stringify({ ...init, qodercli_version: "1.1.99" });
    const changedRaw = `${lines.join("\n")}\n`;
    const changedMetadata = `${JSON.stringify(
      {
        ...fixture.metadata,
        qoderCliVersion: "1.1.99",
        artifactSha256: sha256(changedRaw),
      },
      null,
      2,
    )}\n`;
    const anchors = `${JSON.stringify(
      {
        version: 1,
        fixtures: {
          "list-and-tool": {
            sourceSha256:
              "c5ee314bd0db8fd340fd3b811600399b1319a04e0277f3b89488614a6a72c4b0",
            artifactSha256:
              "380b7a9d716ce02770f2f35a6976f9e2227eb240388ff47d7679fd20d7d7a9fb",
            projectionVersion: 3,
          },
          "two-tools": {
            sourceSha256: fixture.metadata.sourceSha256,
            artifactSha256: fixture.metadata.artifactSha256,
            projectionVersion: fixture.metadata.projectionVersion,
          },
        },
      },
      null,
      2,
    )}\n`;
    expect(() =>
      loadAnchoredRecordedQoderFixtureSource(
        "two-tools",
        {
          raw: changedRaw,
          metadataRaw: changedMetadata,
          sdkVersion: fixture.metadata.sdkVersion,
        },
        anchors,
      ),
    ).toThrow("Recorded Qoder fixture anchor mismatch");
  });

  test("固定版本的 list-and-tool 流保留原生消息和工具生命周期", async () => {
    const { messages, metadata } =
      await loadRecordedQoderFixture("list-and-tool");
    expect(metadata).toMatchObject({
      lineCount: 23,
      uniqueNativeToolCount: 1,
      protocolVersion: "1.2.0",
      qoderCliVersion: "1.1.25",
      sdkVersion: "1.0.23",
      projectionVersion: 3,
      artifactSha256:
        "380b7a9d716ce02770f2f35a6976f9e2227eb240388ff47d7679fd20d7d7a9fb",
      sourceSha256:
        "c5ee314bd0db8fd340fd3b811600399b1319a04e0277f3b89488614a6a72c4b0",
    });
    const events = await replayFixture(messages);
    // 固定指纹确认录制回放的公开事件流没有意外漂移。
    expect(sha256(JSON.stringify(events))).toBe(
      "202ef223e237e0790276b3483e4373f6a28817347a4c30e34711dfab8d91b1c4",
    );

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
        sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:1",
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
        sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:1",
        turnId: "t1",
        toolCallId: "c1",
        name: "Bash",
      },
      {
        type: "tool.completed",
        sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:1",
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
        sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:1",
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
    const { messages, metadata } = await loadRecordedQoderFixture("two-tools");
    expect(metadata).toMatchObject({
      lineCount: 34,
      uniqueNativeToolCount: 2,
      protocolVersion: "1.2.0",
      qoderCliVersion: "1.1.23",
      sdkVersion: "1.0.23",
      projectionVersion: 3,
      artifactSha256:
        "fd22bd2353a3b9651e88a52e057c3dd31ca7de04d811ce8d803826a022096491",
      sourceSha256:
        "58e8d23afce4c0aa2cd8b5293f2b06dee2be3f4c968f01acc6391f1c327b4be8",
    });
    const events = await replayFixture(messages);
    // 固定指纹确认录制回放的公开事件流没有意外漂移。
    expect(sha256(JSON.stringify(events))).toBe(
      "cbce4388e2a1c870b94fed670472c048c9708f5196ce9a450808f3dc2637feac",
    );

    expect(
      events.filter(
        (event) =>
          event.type === "tool.requested" || event.type === "tool.completed",
      ),
    ).toEqual([
      {
        type: "tool.requested",
        sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:1",
        turnId: "t1",
        toolCallId: "c1",
        name: "Bash",
      },
      {
        type: "tool.completed",
        sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:1",
        turnId: "t1",
        toolCallId: "c1",
        name: "Bash",
        result: "first",
        isError: false,
      },
      {
        type: "tool.requested",
        sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:1",
        turnId: "t1",
        toolCallId: "c2",
        name: "Bash",
      },
      {
        type: "tool.completed",
        sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:1",
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
        sessionId: "session:00000000-0000-4000-8000-000000000000:reviewer:1",
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
