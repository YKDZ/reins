import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { SDKMessage } from "@qodercn-ai/qodercn-agent-sdk";
import { createAsyncQueue } from "@reins/adapter-kit";

import { parseRecordedQoderFixtureAnchors } from "./fixture-anchors.ts";
import { assertMatchesKnownCredentialPolicy } from "./fixture-policy.ts";
import {
  assertCanonicalRecordedQoderMessages,
  assertRecordedQoderFixtureMetadata,
  parseCanonicalRecordedQoderJsonl,
  parseCanonicalRecordedQoderMetadata,
  toQoderSdkMessages,
  type RecordedQoderFixtureMetadata,
  type RecordedQoderFixtureName,
  type RecordedQoderMessage,
  type RecordedUsage,
} from "./fixture-projection.ts";
import type { QoderQuery, QoderSdk } from "./sdk-seam.ts";

export type RecordedQoderFixtureFacts = {
  textDeltaCount: number;
  messages: Array<{ deltaHash: string; snapshotHash: string }>;
  tools: Array<{ name: string; resultHash: string; isError: boolean }>;
  terminal: {
    stopReason: string;
    finalReplyHash: string;
    usage: RecordedUsage;
  };
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deriveFixtureFacts(
  messages: readonly RecordedQoderMessage[],
): RecordedQoderFixtureFacts {
  let currentMessageId: string | undefined;
  const deltasById = new Map<string, string[]>();
  const snapshotsById = new Map<string, string>();
  const toolsById = new Map<string, { name: string }>();
  const resultsById = new Map<string, { content: string; isError: boolean }>();
  let terminalUsage: RecordedUsage | undefined;
  let terminalStopReason: string | undefined;
  let resultCount = 0;
  let textDeltaCount = 0;
  for (const message of messages) {
    if (message.type === "stream_event") {
      if (message.event.type === "message_start") {
        currentMessageId = message.event.message.id;
      } else if (message.event.type === "content_block_delta") {
        if (currentMessageId === undefined) {
          throw new Error("Recorded Qoder fixture fact mismatch");
        }
        const deltas = deltasById.get(currentMessageId) ?? [];
        deltas.push(message.event.delta.text);
        deltasById.set(currentMessageId, deltas);
        textDeltaCount += 1;
      } else if (message.event.type === "content_block_start") {
        const { id, name } = message.event.content_block;
        const existing = toolsById.get(id);
        if (
          id.length === 0 ||
          name.length === 0 ||
          (existing !== undefined && existing.name !== name)
        ) {
          throw new Error("Recorded Qoder fixture fact mismatch");
        }
        toolsById.set(id, { name });
      } else if (
        message.event.type === "message_delta" &&
        message.event.delta.stop_reason === "end_turn"
      ) {
        terminalStopReason = message.event.delta.stop_reason;
        terminalUsage = message.event.usage;
      } else if (message.event.type === "message_stop") {
        currentMessageId = undefined;
      }
      continue;
    }
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "tool_use") {
          const existing = toolsById.get(block.id);
          if (
            block.id.length === 0 ||
            block.name.length === 0 ||
            (existing !== undefined && existing.name !== block.name)
          ) {
            throw new Error("Recorded Qoder fixture fact mismatch");
          }
          toolsById.set(block.id, { name: block.name });
        }
      }
      const content = message.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (
        content.length > 0 &&
        (message.message.id.length === 0 ||
          snapshotsById.has(message.message.id))
      ) {
        throw new Error("Recorded Qoder fixture fact mismatch");
      }
      if (content.length > 0) snapshotsById.set(message.message.id, content);
      continue;
    }
    if (message.type === "user") {
      for (const block of message.message.content) {
        if (
          block.tool_use_id.length === 0 ||
          resultsById.has(block.tool_use_id)
        ) {
          throw new Error("Recorded Qoder fixture fact mismatch");
        }
        resultsById.set(block.tool_use_id, {
          content: block.content,
          isError: block.is_error === true,
        });
      }
      continue;
    }
    if (message.type === "result") {
      resultCount += 1;
    }
  }
  const terminal = messages.at(-1);
  const messageFacts = [...snapshotsById].map(([id, snapshot]) => {
    const delta = (deltasById.get(id) ?? []).join("");
    return { deltaHash: sha256(delta), snapshotHash: sha256(snapshot) };
  });
  const toolFacts = [...toolsById].map(([id, tool]) => {
    const result = resultsById.get(id);
    if (result === undefined) {
      throw new Error("Recorded Qoder fixture fact mismatch");
    }
    return {
      name: tool.name,
      resultHash: sha256(result.content),
      isError: result.isError,
    };
  });
  const finalSnapshot = [...snapshotsById.values()].at(-1);
  if (
    terminalStopReason === undefined ||
    terminalUsage === undefined ||
    terminal?.type !== "result" ||
    terminal.subtype !== "success" ||
    terminal.is_error ||
    resultCount !== 1 ||
    finalSnapshot === undefined ||
    messageFacts.some((fact) => fact.deltaHash !== fact.snapshotHash) ||
    toolFacts.length !== resultsById.size
  ) {
    throw new Error("Recorded Qoder fixture fact mismatch");
  }
  return {
    textDeltaCount,
    messages: messageFacts,
    tools: toolFacts,
    terminal: {
      stopReason: terminalStopReason,
      finalReplyHash: sha256(finalSnapshot),
      usage: terminalUsage,
    },
  };
}

export async function loadRecordedQoderFixture(
  name: RecordedQoderFixtureName,
): Promise<{
  messages: SDKMessage[];
  metadata: RecordedQoderFixtureMetadata;
  facts: RecordedQoderFixtureFacts;
}> {
  const [raw, metadataRaw, anchorsRaw, sdkPackageRaw] = await Promise.all([
    readFile(
      new URL(`../test/fixtures/${name}.jsonl`, import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(`../test/fixtures/${name}.metadata.json`, import.meta.url),
      "utf8",
    ),
    readFile(new URL("../test/fixtures/anchors.json", import.meta.url), "utf8"),
    readFile(
      new URL(
        "../package.json",
        import.meta.resolve("@qodercn-ai/qodercn-agent-sdk"),
      ),
      "utf8",
    ),
  ]);
  const sdkPackage = JSON.parse(sdkPackageRaw) as { version?: unknown };
  return loadAnchoredRecordedQoderFixtureSource(
    name,
    { raw, metadataRaw, sdkVersion: sdkPackage.version },
    anchorsRaw,
  );
}

export function loadAnchoredRecordedQoderFixtureSource(
  name: RecordedQoderFixtureName,
  source: { raw: string; metadataRaw: string; sdkVersion: unknown },
  anchorsRaw: string,
): ReturnType<typeof loadRecordedQoderFixtureSource> {
  const loaded = loadRecordedQoderFixtureSource(name, source);
  const anchor = parseRecordedQoderFixtureAnchors(anchorsRaw).fixtures[name];
  if (
    loaded.metadata.sourceSha256 !== anchor.sourceSha256 ||
    loaded.metadata.artifactSha256 !== anchor.artifactSha256 ||
    loaded.metadata.projectionVersion !== anchor.projectionVersion
  ) {
    throw new Error("Recorded Qoder fixture anchor mismatch");
  }
  return loaded;
}

export function loadRecordedQoderFixtureSource(
  name: RecordedQoderFixtureName,
  source: { raw: string; metadataRaw: string; sdkVersion: unknown },
): {
  messages: SDKMessage[];
  metadata: RecordedQoderFixtureMetadata;
  facts: RecordedQoderFixtureFacts;
} {
  const metadata = parseCanonicalRecordedQoderMetadata(source.metadataRaw);
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    throw new Error("Recorded Qoder fixture metadata mismatch");
  }
  const saved = parseCanonicalRecordedQoderJsonl(source.raw);
  assertMatchesKnownCredentialPolicy([saved, metadata]);
  assertCanonicalRecordedQoderMessages(saved);
  const init = saved[0];
  if (init?.type !== "system" || init.cwd !== "<fixture-cwd>") {
    throw new Error("Recorded Qoder fixture metadata mismatch");
  }
  const facts = deriveFixtureFacts(saved);
  const metadataRecord = metadata as Record<string, unknown>;
  assertRecordedQoderFixtureMetadata(name, metadata, {
    recordedAt:
      typeof metadataRecord.recordedAt === "string"
        ? metadataRecord.recordedAt
        : "",
    sdkVersion: typeof source.sdkVersion === "string" ? source.sdkVersion : "",
    qoderCliVersion: init.qodercli_version,
    protocolVersion: init.protocol_version,
    lineCount: saved.length,
    uniqueNativeToolCount: facts.tools.length,
    artifactSha256: sha256(source.raw),
  });
  return {
    messages: toQoderSdkMessages(saved),
    metadata,
    facts,
  };
}

export function createQoderFixtureSdk(
  messages: readonly SDKMessage[],
): QoderSdk {
  return {
    query({ prompt }) {
      const replies = createAsyncQueue<unknown>();
      let replayed = false;
      const promptReader = (async () => {
        for await (const input of prompt) {
          if (replayed) continue;
          replayed = true;
          replies.push({
            type: "command_lifecycle",
            command_uuid: input.uuid,
            state: "queued",
            uuid: randomUUID(),
            session_id: "00000000-0000-4000-8000-000000000001",
          });
          for (const message of messages) replies.push(message);
        }
      })();
      void promptReader.catch(() => undefined);
      const query: QoderQuery = {
        [Symbol.asyncIterator]: () => replies[Symbol.asyncIterator](),
        async initializationResult() {
          return {};
        },
        async interrupt() {},
        async close() {
          replies.end();
          await promptReader;
        },
      };
      return query;
    },
    async getAvailableModels() {
      return [];
    },
  };
}
