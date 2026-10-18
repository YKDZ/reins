import { describe, expect, test } from "vitest";

import {
  assertCanonicalRecordedQoderMessages,
  assertRecordedQoderFixtureMetadata,
  parseCanonicalRecordedQoderJsonl,
  parseCanonicalRecordedQoderMetadata,
  projectRecordedQoderMessages,
  toQoderSdkMessages,
} from "#/fixture-projection";

const metadata = {
  fixture: "two-tools.jsonl",
  recordedAt: "2026-08-25T18:10:33.366Z",
  sdkVersion: "1.0.23",
  qoderCliVersion: "1.1.23",
  protocolVersion: "1.2.0",
  projectionVersion: 4,
  lineCount: 1,
  uniqueNativeToolCount: 0,
  artifactSha256:
    "fd22bd2353a3b9651e88a52e057c3dd31ca7de04d811ce8d803826a022096491",
  sourceSha256:
    "58e8d23afce4c0aa2cd8b5293f2b06dee2be3f4c968f01acc6391f1c327b4be8",
  scenario:
    "Two sequential non-combined Bash tool requests and results followed by a streamed text reply",
};

const observed = {
  recordedAt: metadata.recordedAt,
  sdkVersion: metadata.sdkVersion,
  qoderCliVersion: metadata.qoderCliVersion,
  protocolVersion: metadata.protocolVersion,
  lineCount: metadata.lineCount,
  uniqueNativeToolCount: metadata.uniqueNativeToolCount,
  artifactSha256: metadata.artifactSha256,
  sourceSha256: metadata.sourceSha256,
};

const nonZeroUsage = {
  input_tokens: 7,
  cache_creation_input_tokens: 1,
  cache_read_input_tokens: 2,
  output_tokens: 3,
  server_tool_use: { web_search_requests: 4, web_fetch_requests: 5 },
  service_tier: "standard",
  cache_creation: {
    ephemeral_1h_input_tokens: 6,
    ephemeral_5m_input_tokens: 8,
  },
  inference_geo: "us",
  iterations: [],
  speed: "standard",
  credits: 9,
  original_credits: 10,
  billable: true,
};

describe("recorded Qoder projection", () => {
  test("工具请求与结果保留结构化正文", () => {
    const toolInput = { command: "cat notes.txt", options: { raw: true } };
    const toolOutput = [{ type: "text", text: "完整输出" }];
    const projected = projectRecordedQoderMessages([
      {
        type: "assistant",
        message: {
          id: "assistant-1",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: toolInput,
            },
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: toolOutput,
            },
          ],
          stop_reason: null,
        },
      },
    ]);

    expect(projected[0]).toMatchObject({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", input: toolInput },
          { type: "tool_result", content: toolOutput },
        ],
      },
    });
    expect(toQoderSdkMessages(projected)[0]).toMatchObject({
      message: { content: [{ input: toolInput }, { content: toolOutput }] },
    });
  });

  test("projects init to the closed saved-fixture contract", () => {
    const projected = projectRecordedQoderMessages([
      {
        type: "system",
        subtype: "init",
        apiKeySource: "none",
        qodercli_version: "1.1.23",
        protocol_version: "1.2.0",
        cwd: "<fixture-cwd>",
        tools: ["Bash", "Read"],
        slash_commands: ["login"],
        agents: ["general-purpose"],
        capabilities: ["background_tasks_v1"],
        uuid: "personal-message",
        session_id: "personal-session",
      },
    ]);

    expect(projected).toEqual([
      {
        type: "system",
        subtype: "init",
        apiKeySource: "none",
        qodercli_version: "1.1.23",
        protocol_version: "1.2.0",
        cwd: "<fixture-cwd>",
      },
    ]);
    expect(() => assertCanonicalRecordedQoderMessages(projected)).not.toThrow();
    expect(toQoderSdkMessages(projected)[0]).toMatchObject({
      type: "system",
      subtype: "init",
      apiKeySource: "none",
    });
  });

  test("rejects manually added runtime state and unknown variants", () => {
    const canonical = projectRecordedQoderMessages([
      {
        type: "system",
        subtype: "init",
        apiKeySource: "none",
        qodercli_version: "1.1.23",
        protocol_version: "1.2.0",
        cwd: "<fixture-cwd>",
      },
    ]);
    expect(() =>
      assertCanonicalRecordedQoderMessages([
        { ...canonical[0], runtime: { slash_commands: ["login"] } },
      ]),
    ).toThrow("Recorded Qoder fixture is not canonical");
    expect(() =>
      projectRecordedQoderMessages([{ type: "vendor_future_state" }]),
    ).toThrow("Unsupported recorded Qoder message");
  });

  test("requires the exact non-empty recorded scenario", () => {
    expect(() =>
      assertRecordedQoderFixtureMetadata("two-tools", metadata, observed),
    ).not.toThrow();
    expect(() =>
      assertRecordedQoderFixtureMetadata(
        "two-tools",
        { ...metadata, scenario: "" },
        observed,
      ),
    ).toThrow("Recorded Qoder fixture metadata mismatch");
    const { scenario: _removed, ...missingScenario } = metadata;
    expect(() =>
      assertRecordedQoderFixtureMetadata(
        "two-tools",
        missingScenario,
        observed,
      ),
    ).toThrow("Recorded Qoder fixture metadata mismatch");
  });

  test("rejects extra, missing, and undefined metadata fields", () => {
    expect(() =>
      assertRecordedQoderFixtureMetadata(
        "two-tools",
        {
          ...metadata,
          runtime: {
            QODER_ACCESS_TOKEN: "opaque-device-secret",
            transcript: [],
          },
        },
        observed,
      ),
    ).toThrow("Recorded Qoder fixture metadata mismatch");
    expect(() =>
      assertRecordedQoderFixtureMetadata(
        "two-tools",
        { ...metadata, sourceSha256: "NOT-A-DIGEST" },
        observed,
      ),
    ).toThrow("Recorded Qoder fixture metadata mismatch");
    const { artifactSha256: _missing, ...missing } = metadata;
    expect(() =>
      assertRecordedQoderFixtureMetadata("two-tools", missing, observed),
    ).toThrow("Recorded Qoder fixture metadata mismatch");
    expect(() =>
      assertRecordedQoderFixtureMetadata(
        "two-tools",
        { ...metadata, artifactSha256: undefined },
        observed,
      ),
    ).toThrow("Recorded Qoder fixture metadata mismatch");
  });

  test("requires a canonical RFC 3339 recorded timestamp", () => {
    const nonCanonicalRecordedAt = "2026-08-25T18:10:33.366+00:00";
    expect(() =>
      assertRecordedQoderFixtureMetadata(
        "two-tools",
        { ...metadata, recordedAt: nonCanonicalRecordedAt },
        { ...observed, recordedAt: nonCanonicalRecordedAt },
      ),
    ).toThrow("Recorded Qoder fixture metadata mismatch");
  });

  test("preserves assistant-only usage through projection and SDK rehydration", () => {
    const projected = projectRecordedQoderMessages([
      {
        type: "assistant",
        message: {
          id: "native-message",
          content: [{ type: "text", text: "done" }],
          stop_reason: "end_turn",
          usage: nonZeroUsage,
        },
      },
    ]);
    expect(projected[0]).toMatchObject({
      type: "assistant",
      message: { usage: nonZeroUsage },
    });
    expect(toQoderSdkMessages(projected)[0]).toMatchObject({
      type: "assistant",
      message: { usage: nonZeroUsage },
    });
  });

  test("rejects duplicate-key raw fixture and metadata before parsed policy", () => {
    const duplicateCwd =
      '{"type":"system","subtype":"init","apiKeySource":"none","qodercli_version":"1.1.23","protocol_version":"1.2.0","cwd":"opaque-device-secret","cwd":"<fixture-cwd>"}\n';
    expect(() => parseCanonicalRecordedQoderJsonl(duplicateCwd)).toThrow(
      "Recorded Qoder fixture bytes are not canonical",
    );

    const duplicateScenario = `${JSON.stringify(
      { ...metadata, scenario: "opaque-device-secret" },
      null,
      2,
    ).replace(
      '  "scenario": "opaque-device-secret"',
      `  "scenario": "opaque-device-secret",\n  "scenario": ${JSON.stringify(metadata.scenario)}`,
    )}\n`;
    expect(() =>
      parseCanonicalRecordedQoderMetadata(duplicateScenario),
    ).toThrow("Recorded Qoder metadata bytes are not canonical");
  });

  test("rejects mapper-consumed variants that v1 cannot preserve", () => {
    expect(() =>
      projectRecordedQoderMessages([
        {
          type: "user",
          message: { role: "user", content: [] },
          parent_tool_use_id: "native-tool",
          tool_use_result: { stdout: "done" },
          tool_result_meta: [{ id: "native-tool" }],
        },
      ]),
    ).toThrow("Unsupported recorded Qoder user fallback result");
    expect(() =>
      projectRecordedQoderMessages([
        {
          type: "system",
          subtype: "session_state_changed",
          state: "idle",
        },
      ]),
    ).toThrow("Unsupported recorded Qoder system message");
    expect(() =>
      projectRecordedQoderMessages([
        {
          type: "assistant",
          message: {
            id: "native-message",
            content: [],
            stop_reason: "end_turn",
            usage: { ...nonZeroUsage, vendor_runtime_usage: 99 },
          },
        },
      ]),
    ).toThrow("Unsupported recorded Qoder usage");
  });
});
