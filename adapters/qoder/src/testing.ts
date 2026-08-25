import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { SDKMessage } from "@qodercn-ai/qodercn-agent-sdk";

import { assertMatchesKnownCredentialPolicy } from "./fixture-policy.ts";
import type { QoderQuery, QoderSdk } from "./sdk-seam.ts";

export type RecordedQoderFixtureMetadata = {
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

export async function loadRecordedQoderFixture(
  name: "list-and-tool" | "two-tools",
): Promise<{
  messages: SDKMessage[];
  metadata: RecordedQoderFixtureMetadata;
}> {
  const [raw, metadataRaw, sdkPackageRaw] = await Promise.all([
    readFile(
      new URL(`../test/fixtures/${name}.jsonl`, import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(`../test/fixtures/${name}.metadata.json`, import.meta.url),
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
  const metadata = JSON.parse(metadataRaw) as RecordedQoderFixtureMetadata;
  const sdkPackage = JSON.parse(sdkPackageRaw) as { version?: unknown };
  const messages = raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as SDKMessage);
  assertMatchesKnownCredentialPolicy([messages, metadata]);
  const firstTimestamp = messages
    .flatMap((message) =>
      "timestamp" in message && typeof message.timestamp === "string"
        ? [message.timestamp]
        : [],
    )
    .at(0);
  const init = messages[0];
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
  const valid =
    metadata.fixture === `${name}.jsonl` &&
    metadata.lineCount === messages.length &&
    metadata.recordedAt === firstTimestamp &&
    metadata.sdkVersion === sdkPackage.version &&
    metadata.uniqueNativeToolCount === nativeToolIds.size &&
    metadata.sha256 === createHash("sha256").update(raw).digest("hex") &&
    init?.type === "system" &&
    init.subtype === "init" &&
    init.cwd === "<fixture-cwd>" &&
    init.protocol_version === metadata.protocolVersion &&
    init.qodercli_version === metadata.qoderCliVersion;
  if (!valid) throw new Error("Recorded Qoder fixture metadata mismatch");
  return { messages, metadata };
}

export function createQoderFixtureSdk(
  messages: readonly SDKMessage[],
): QoderSdk {
  return {
    query() {
      const query: QoderQuery = {
        async *[Symbol.asyncIterator]() {
          for (const message of messages) yield message;
        },
        async interrupt() {},
      };
      return query;
    },
    async getAvailableModels() {
      return [];
    },
  };
}
