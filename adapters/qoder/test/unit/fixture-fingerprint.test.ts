import type { SDKMessage } from "@qodercn-ai/qodercn-agent-sdk";
import { describe, expect, test } from "vitest";

import { toQoderSdkMessages, type RecordedUsage } from "#/fixture-projection";

import {
  assertQoderEventSemanticEquivalence,
  assertQoderProjectionSemanticEquivalence,
  FixtureSemanticMismatchError,
  qoderPublicEventFingerprint,
} from "../scripts/fixture-fingerprint.ts";

const usage: RecordedUsage = {
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
};

function assistantWithUsage(value: RecordedUsage): SDKMessage[] {
  return toQoderSdkMessages([
    {
      type: "assistant",
      message: {
        id: "native-message",
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
        usage: value,
      },
    },
  ]);
}

describe("Qoder fixture semantic fingerprint", () => {
  test("preserves non-zero assistant-only terminal usage through the formal mapper", async () => {
    const raw = assistantWithUsage(usage);
    await expect(
      assertQoderProjectionSemanticEquivalence(raw),
    ).resolves.toBeUndefined();
    const fingerprint = await qoderPublicEventFingerprint(raw);
    expect(fingerprint).toContainEqual(
      expect.objectContaining({
        type: "turn.completed",
        usage: expect.objectContaining({ input_tokens: 7, output_tokens: 3 }),
      }),
    );
  });

  test("detects a deliberately lossy usage projection without exposing text", async () => {
    const raw = assistantWithUsage(usage);
    const lossy = assistantWithUsage({
      ...usage,
      input_tokens: 0,
      output_tokens: 0,
    });
    await expect(qoderPublicEventFingerprint(raw)).resolves.not.toEqual(
      await qoderPublicEventFingerprint(lossy),
    );
    await expect(
      assertQoderEventSemanticEquivalence(raw, lossy),
    ).rejects.toBeInstanceOf(FixtureSemanticMismatchError);
  });
});
