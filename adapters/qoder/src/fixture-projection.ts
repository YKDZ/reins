import { isDeepStrictEqual } from "node:util";

import type { SDKMessage } from "@qodercn-ai/qodercn-agent-sdk";

export const RECORDED_QODER_PROJECTION_VERSION = 4 as const;

export type RecordedUsage = {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  server_tool_use: {
    web_search_requests: number;
    web_fetch_requests: number;
  };
  service_tier: string;
  cache_creation: {
    ephemeral_1h_input_tokens: number;
    ephemeral_5m_input_tokens: number;
  };
  inference_geo: string;
  iterations: [];
  speed: string;
  credits?: number;
  original_credits?: number;
  billable?: boolean;
};

type RecordedContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input?: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: unknown;
      is_error?: boolean;
    };

export type RecordedQoderMessage =
  | {
      type: "system";
      subtype: "init";
      apiKeySource: "none";
      qodercli_version: string;
      protocol_version: string;
      cwd: string;
    }
  | {
      type: "stream_event";
      event:
        | { type: "message_start"; message: { id: string } }
        | {
            type: "content_block_start";
            index: number;
            content_block: {
              type: "tool_use";
              id: string;
              name: string;
              input?: unknown;
            };
          }
        | {
            type: "content_block_delta";
            index: number;
            delta: { type: "text_delta"; text: string };
          }
        | {
            type: "message_delta";
            delta: { stop_reason: string | null };
            usage?: RecordedUsage;
          }
        | { type: "message_stop" };
    }
  | {
      type: "assistant";
      message: {
        id: string;
        content: RecordedContentBlock[];
        stop_reason: string | null;
        usage?: RecordedUsage;
      };
      isApiErrorMessage?: true;
      aborted?: true;
    }
  | {
      type: "user";
      message: {
        role: "user";
        content: Extract<RecordedContentBlock, { type: "tool_result" }>[];
      };
    }
  | { type: "result"; subtype: string; is_error: boolean };

export type RecordedQoderFixtureName = "list-and-tool" | "two-tools";

export const recordedQoderScenarios = {
  "list-and-tool":
    "One Bash tool request and result followed by a streamed text reply",
  "two-tools":
    "Two sequential non-combined Bash tool requests and results followed by a streamed text reply",
} as const satisfies Record<RecordedQoderFixtureName, string>;

export type RecordedQoderFixtureMetadata = {
  fixture: string;
  recordedAt: string;
  sdkVersion: string;
  qoderCliVersion: string;
  protocolVersion: string;
  projectionVersion: number;
  lineCount: number;
  uniqueNativeToolCount: number;
  artifactSha256: string;
  sourceSha256: string;
  scenario: string;
};

export function serializeRecordedQoderMessages(
  messages: readonly RecordedQoderMessage[],
): string {
  return `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
}

export function serializeRecordedQoderMetadata(
  metadata: RecordedQoderFixtureMetadata,
): string {
  return `${JSON.stringify(metadata, null, 2)}\n`;
}

export function parseCanonicalRecordedQoderJsonl(raw: string): unknown[] {
  if (!raw.endsWith("\n") || raw.length === 1) {
    throw new Error("Recorded Qoder fixture bytes are not canonical");
  }
  let parsed: unknown[];
  try {
    parsed = raw
      .slice(0, -1)
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
  } catch {
    throw new Error("Recorded Qoder fixture bytes are not canonical");
  }
  const canonical = `${parsed.map((value) => JSON.stringify(value)).join("\n")}\n`;
  if (canonical !== raw) {
    throw new Error("Recorded Qoder fixture bytes are not canonical");
  }
  return parsed;
}

export function parseCanonicalRecordedQoderMetadata(raw: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Recorded Qoder metadata bytes are not canonical");
  }
  if (`${JSON.stringify(parsed, null, 2)}\n` !== raw) {
    throw new Error("Recorded Qoder metadata bytes are not canonical");
  }
  return parsed;
}

const recordedMetadataKeys = [
  "artifactSha256",
  "fixture",
  "lineCount",
  "projectionVersion",
  "protocolVersion",
  "qoderCliVersion",
  "recordedAt",
  "scenario",
  "sdkVersion",
  "sourceSha256",
  "uniqueNativeToolCount",
] as const;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Unsupported recorded Qoder message");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Unsupported recorded Qoder message");
  }
  return value;
}

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Unsupported recorded Qoder message");
  }
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return string(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [
    ...required,
    ...optional.filter((key) => value[key] !== undefined),
  ].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function projectUsage(value: unknown): RecordedUsage {
  const source = record(value);
  const serverToolUse = record(source.server_tool_use);
  const cacheCreation = record(source.cache_creation);
  if (
    !hasExactKeys(
      source,
      [
        "input_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
        "output_tokens",
        "server_tool_use",
        "service_tier",
        "cache_creation",
        "inference_geo",
        "iterations",
        "speed",
      ],
      ["credits", "original_credits", "billable"],
    ) ||
    !hasExactKeys(serverToolUse, [
      "web_search_requests",
      "web_fetch_requests",
    ]) ||
    !hasExactKeys(cacheCreation, [
      "ephemeral_1h_input_tokens",
      "ephemeral_5m_input_tokens",
    ]) ||
    !Array.isArray(source.iterations) ||
    source.iterations.length !== 0
  ) {
    throw new Error("Unsupported recorded Qoder usage");
  }
  return {
    input_tokens: number(source.input_tokens),
    cache_creation_input_tokens: number(source.cache_creation_input_tokens),
    cache_read_input_tokens: number(source.cache_read_input_tokens),
    output_tokens: number(source.output_tokens),
    server_tool_use: {
      web_search_requests: number(serverToolUse.web_search_requests),
      web_fetch_requests: number(serverToolUse.web_fetch_requests),
    },
    service_tier: string(source.service_tier),
    cache_creation: {
      ephemeral_1h_input_tokens: number(
        cacheCreation.ephemeral_1h_input_tokens,
      ),
      ephemeral_5m_input_tokens: number(
        cacheCreation.ephemeral_5m_input_tokens,
      ),
    },
    inference_geo: string(source.inference_geo),
    iterations: [],
    speed: string(source.speed),
    ...(source.credits === undefined
      ? {}
      : { credits: number(source.credits) }),
    ...(source.original_credits === undefined
      ? {}
      : { original_credits: number(source.original_credits) }),
    ...(source.billable === undefined
      ? {}
      : typeof source.billable === "boolean"
        ? { billable: source.billable }
        : (() => {
            throw new Error("Unsupported recorded Qoder usage");
          })()),
  };
}

function projectToolResult(
  value: unknown,
): Extract<RecordedContentBlock, { type: "tool_result" }> {
  const block = record(value);
  if (block.type !== "tool_result") {
    throw new Error("Unsupported recorded Qoder message");
  }
  if (!Object.hasOwn(block, "content")) {
    throw new Error("Unsupported recorded Qoder message");
  }
  return {
    type: "tool_result",
    tool_use_id: string(block.tool_use_id),
    content: block.content,
    ...(block.is_error === undefined
      ? {}
      : typeof block.is_error === "boolean"
        ? { is_error: block.is_error }
        : (() => {
            throw new Error("Unsupported recorded Qoder message");
          })()),
  };
}

function projectAssistant(
  value: Record<string, unknown>,
): RecordedQoderMessage {
  const message = record(value.message);
  if (!Array.isArray(message.content)) {
    throw new Error("Unsupported recorded Qoder message");
  }
  const content: RecordedContentBlock[] = [];
  for (const candidate of message.content) {
    const block = record(candidate);
    if (block.type === "thinking") {
      content.push({
        type: "thinking",
        thinking: string(block.thinking),
        ...(block.signature === undefined
          ? {}
          : { signature: string(block.signature) }),
      });
      continue;
    }
    if (block.type === "redacted_thinking") {
      content.push({ type: "redacted_thinking", data: string(block.data) });
      continue;
    }
    if (block.type === "text") {
      content.push({ type: "text", text: string(block.text) });
      continue;
    }
    if (block.type === "tool_use") {
      content.push({
        type: "tool_use",
        id: string(block.id),
        name: string(block.name),
        ...(block.input === undefined ? {} : { input: block.input }),
      });
      continue;
    }
    if (block.type === "tool_result") {
      content.push(projectToolResult(block));
      continue;
    }
    throw new Error("Unsupported recorded Qoder message");
  }
  return {
    type: "assistant",
    message: {
      id: string(message.id),
      content,
      stop_reason: nullableString(message.stop_reason),
      ...(message.usage === undefined
        ? {}
        : { usage: projectUsage(message.usage) }),
    },
    ...(value.isApiErrorMessage === true ? { isApiErrorMessage: true } : {}),
    ...(value.aborted === true ? { aborted: true } : {}),
  };
}

function projectStreamEvent(
  value: Record<string, unknown>,
): RecordedQoderMessage | undefined {
  const event = record(value.event);
  if (event.type === "message_start") {
    const message = record(event.message);
    return {
      type: "stream_event",
      event: { type: "message_start", message: { id: string(message.id) } },
    };
  }
  if (event.type === "content_block_start") {
    const block = record(event.content_block);
    if (block.type !== "tool_use") return undefined;
    return {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: number(event.index),
        content_block: {
          type: "tool_use",
          id: string(block.id),
          name: string(block.name),
          ...(block.input === undefined ? {} : { input: block.input }),
        },
      },
    };
  }
  if (event.type === "content_block_delta") {
    const delta = record(event.delta);
    if (
      delta.type === "thinking_delta" ||
      delta.type === "input_json_delta" ||
      delta.type === "signature_delta"
    ) {
      return undefined;
    }
    if (delta.type !== "text_delta") {
      throw new Error("Unsupported recorded Qoder stream delta");
    }
    return {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: number(event.index),
        delta: { type: "text_delta", text: string(delta.text) },
      },
    };
  }
  if (event.type === "content_block_stop") return undefined;
  if (event.type === "message_delta") {
    const delta = record(event.delta);
    return {
      type: "stream_event",
      event: {
        type: "message_delta",
        delta: { stop_reason: nullableString(delta.stop_reason) },
        ...(event.usage === undefined
          ? {}
          : { usage: projectUsage(event.usage) }),
      },
    };
  }
  if (event.type === "message_stop") {
    return { type: "stream_event", event: { type: "message_stop" } };
  }
  throw new Error("Unsupported recorded Qoder stream event");
}

function projectMessage(value: unknown): RecordedQoderMessage | undefined {
  const source = record(value);
  if (source.type === "system" && source.subtype === "init") {
    if (source.apiKeySource !== "none") {
      throw new Error("Unsupported recorded Qoder credential source");
    }
    string(source.cwd);
    return {
      type: "system",
      subtype: "init",
      apiKeySource: "none",
      qodercli_version: string(source.qodercli_version),
      protocol_version: string(source.protocol_version),
      cwd: "<fixture-cwd>",
    };
  }
  if (source.type === "system") {
    throw new Error("Unsupported recorded Qoder system message");
  }
  if (source.type === "stream_event") return projectStreamEvent(source);
  if (source.type === "assistant") return projectAssistant(source);
  if (source.type === "user") {
    const message = record(source.message);
    if (message.role !== "user" || !Array.isArray(message.content)) {
      throw new Error("Unsupported recorded Qoder message");
    }
    const content = message.content.map(projectToolResult);
    if (
      content.length === 0 &&
      (source.tool_use_result !== undefined ||
        source.tool_result_meta !== undefined ||
        (source.parent_tool_use_id !== undefined &&
          source.parent_tool_use_id !== null))
    ) {
      throw new Error("Unsupported recorded Qoder user fallback result");
    }
    return { type: "user", message: { role: "user", content } };
  }
  if (source.type === "result") {
    return {
      type: "result",
      subtype: string(source.subtype),
      ...(typeof source.is_error === "boolean"
        ? { is_error: source.is_error }
        : (() => {
            throw new Error("Unsupported recorded Qoder message");
          })()),
    };
  }
  throw new Error("Unsupported recorded Qoder message");
}

export function projectRecordedQoderMessages(
  value: unknown,
): RecordedQoderMessage[] {
  if (!Array.isArray(value)) {
    throw new Error("Recorded Qoder fixture must be an array");
  }
  return value.flatMap((message) => {
    const projected = projectMessage(message);
    return projected === undefined ? [] : [projected];
  });
}

export function assertCanonicalRecordedQoderMessages(
  value: unknown,
): asserts value is RecordedQoderMessage[] {
  const projected = projectRecordedQoderMessages(value);
  if (!isDeepStrictEqual(projected, value)) {
    throw new Error("Recorded Qoder fixture is not canonical");
  }
}

export function assertRecordedQoderFixtureMetadata(
  name: RecordedQoderFixtureName,
  metadata: unknown,
  observed: {
    recordedAt: string;
    sdkVersion: string;
    qoderCliVersion: string;
    protocolVersion: string;
    lineCount: number;
    uniqueNativeToolCount: number;
    artifactSha256: string;
  },
): asserts metadata is RecordedQoderFixtureMetadata {
  const candidate = record(metadata);
  const candidateKeys = Object.keys(candidate).sort();
  const valid =
    candidateKeys.length === recordedMetadataKeys.length &&
    isDeepStrictEqual(candidateKeys, recordedMetadataKeys) &&
    candidate.fixture === `${name}.jsonl` &&
    candidate.recordedAt === observed.recordedAt &&
    candidate.sdkVersion === observed.sdkVersion &&
    candidate.qoderCliVersion === observed.qoderCliVersion &&
    candidate.protocolVersion === observed.protocolVersion &&
    candidate.projectionVersion === RECORDED_QODER_PROJECTION_VERSION &&
    candidate.lineCount === observed.lineCount &&
    candidate.uniqueNativeToolCount === observed.uniqueNativeToolCount &&
    candidate.artifactSha256 === observed.artifactSha256 &&
    typeof candidate.sourceSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(candidate.sourceSha256) &&
    typeof candidate.recordedAt === "string" &&
    !Number.isNaN(Date.parse(candidate.recordedAt)) &&
    new Date(candidate.recordedAt).toISOString() === candidate.recordedAt &&
    typeof candidate.scenario === "string" &&
    candidate.scenario === recordedQoderScenarios[name] &&
    candidate.scenario.length > 0;
  if (!valid) throw new Error("Recorded Qoder fixture metadata mismatch");
}

const emptyUsage = {
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
};

// 测试接缝在内存中补齐 SDK wrapper 必填壳；这些 sentinel 永不进入 fixture。
export function toQoderSdkMessages(
  messages: readonly RecordedQoderMessage[],
): SDKMessage[] {
  return messages.map((message) => {
    if (message.type === "system") {
      return {
        ...message,
        tools: [],
        mcp_servers: [],
        model: "<fixture-model>",
        permissionMode: "default",
        slash_commands: [],
        output_style: "",
        skills: [],
        plugins: [],
        uuid: "<fixture-uuid>",
        session_id: "<fixture-session>",
      } as SDKMessage;
    }
    if (message.type === "stream_event") {
      const event =
        message.event.type === "message_start"
          ? {
              ...message.event,
              message: {
                ...message.event.message,
                type: "message",
                role: "assistant",
                content: [],
                container: null,
                context_management: null,
                model: "<fixture-model>",
                stop_reason: null,
                stop_sequence: null,
                usage: emptyUsage,
              },
            }
          : message.event.type === "content_block_start"
            ? message.event
            : message.event.type === "message_delta"
              ? {
                  ...message.event,
                  context_management: null,
                  delta: {
                    ...message.event.delta,
                    stop_sequence: null,
                    container: null,
                  },
                }
              : message.event;
      return {
        type: "stream_event",
        event,
        parent_tool_use_id: null,
        uuid: "<fixture-uuid>",
        session_id: "<fixture-session>",
      } as SDKMessage;
    }
    if (message.type === "assistant") {
      return {
        ...message,
        message: {
          ...message.message,
          type: "message",
          role: "assistant",
          content: message.message.content,
          container: null,
          context_management: null,
          model: "<fixture-model>",
          stop_sequence: null,
          usage: message.message.usage ?? emptyUsage,
        },
        parent_tool_use_id: null,
        uuid: "<fixture-uuid>",
        session_id: "<fixture-session>",
      } as SDKMessage;
    }
    if (message.type === "user") {
      return {
        ...message,
        parent_tool_use_id: null,
        uuid: "<fixture-uuid>",
        session_id: "<fixture-session>",
      } as SDKMessage;
    }
    return {
      ...message,
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 0,
      result: "",
      stop_reason: null,
      total_cost_usd: 0,
      usage: emptyUsage,
      modelUsage: {},
      permission_denials: [],
      uuid: "<fixture-uuid>",
      session_id: "<fixture-session>",
    } as SDKMessage;
  });
}
