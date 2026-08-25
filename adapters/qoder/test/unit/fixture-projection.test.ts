import { describe, expect, test } from "vitest";

import {
  assertCanonicalRecordedQoderMessages,
  assertRecordedQoderFixtureMetadata,
  projectRecordedQoderMessages,
  toQoderSdkMessages,
} from "#/fixture-projection";

const metadata = {
  fixture: "two-tools.jsonl",
  recordedAt: "2026-08-25T18:10:33.366Z",
  sdkVersion: "1.0.23",
  qoderCliVersion: "1.1.23",
  protocolVersion: "1.2.0",
  projectionVersion: 1,
  lineCount: 1,
  uniqueNativeToolCount: 0,
  sha256: "fixture-digest",
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
  sha256: metadata.sha256,
};

describe("recorded Qoder projection", () => {
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
});
