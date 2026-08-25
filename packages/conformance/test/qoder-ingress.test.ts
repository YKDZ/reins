import { createHash } from "node:crypto";

import { createReinsClient } from "@reins/client";
import { openEphemeralDaemonForTest } from "@reins/daemon/testing";
import type {
  DiagnosticsResult,
  DomainEvent,
  ProtocolNotification,
  SpawnParams,
  WaitResult,
} from "@reins/protocol";
import { createQoderCapabilities, createQoderDriver } from "@reins/qoder";
import {
  createQoderFixtureSdk,
  loadRecordedQoderFixture,
} from "@reins/qoder/testing";
import { describe, expect, test } from "vitest";

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

type FixtureMessages = Awaited<
  ReturnType<typeof loadRecordedQoderFixture>
>["messages"];

function mutatedFixture(messages: FixtureMessages): FixtureMessages {
  const mutated: FixtureMessages = [];
  let duplicateSnapshotAdded = false;
  let lateDelta:
    | Extract<FixtureMessages[number], { type: "stream_event" }>
    | undefined;
  let lateDeltaAdded = false;
  let toolResultMutationsAdded = false;
  for (const message of messages) {
    mutated.push(structuredClone(message));
    if (
      !duplicateSnapshotAdded &&
      message.type === "assistant" &&
      message.message.content.some((block) => block.type === "text")
    ) {
      mutated.push(structuredClone(message));
      duplicateSnapshotAdded = true;
    }
    if (
      message.type === "stream_event" &&
      message.event.type === "content_block_delta" &&
      typeof message.event.delta === "object" &&
      message.event.delta !== null &&
      "type" in message.event.delta &&
      message.event.delta.type === "text_delta"
    ) {
      lateDelta = structuredClone(message);
    }
    if (
      !lateDeltaAdded &&
      lateDelta !== undefined &&
      message.type === "stream_event" &&
      message.event.type === "message_stop"
    ) {
      mutated.push(structuredClone(lateDelta));
      lateDeltaAdded = true;
    }
    if (
      !toolResultMutationsAdded &&
      message.type === "user" &&
      Array.isArray(message.message.content)
    ) {
      const toolResult = message.message.content.find(
        (block) => block.type === "tool_result",
      );
      if (toolResult !== undefined) {
        mutated.push(structuredClone(message));
        mutated.push({
          ...structuredClone(message),
          message: {
            ...structuredClone(message.message),
            content: message.message.content.map((block) =>
              block.type === "tool_result"
                ? { ...structuredClone(block), tool_use_id: "fixture-orphan" }
                : structuredClone(block),
            ),
          },
        });
        toolResultMutationsAdded = true;
      }
    }
  }
  if (!duplicateSnapshotAdded || !lateDeltaAdded || !toolResultMutationsAdded) {
    throw new Error("Fixture mutation anchors are missing");
  }
  return mutated;
}

async function runFixture(messages: FixtureMessages): Promise<{
  events: DomainEvent[];
  ended: Extract<ProtocolNotification, { method: "attach.ended" }>["params"];
  waited: WaitResult;
  diagnostics: DiagnosticsResult;
}> {
  const sdk = createQoderFixtureSdk(messages);
  const daemon = await openEphemeralDaemonForTest({
    adapters: new Map([
      [
        "qoder",
        {
          driverFactory: createQoderDriver({ sdk }),
          capabilities: createQoderCapabilities(sdk),
        },
      ],
    ]),
  });
  const client = createReinsClient(daemon.connect());
  const events: DomainEvent[] = [];
  let resolveEnded!: (
    ended: Extract<ProtocolNotification, { method: "attach.ended" }>["params"],
  ) => void;
  const endedPromise = new Promise<
    Extract<ProtocolNotification, { method: "attach.ended" }>["params"]
  >((resolve) => {
    resolveEnded = resolve;
  });
  const unsubscribe = client.onNotification((notification) => {
    if (notification.method === "event") events.push(notification.params);
    else resolveEnded(notification.params);
  });
  try {
    const spawned = await client.request("spawn", {
      sessionName: "conformance" as SpawnParams["sessionName"],
      harness: "qoder",
      message: "fixture replay",
      cwd: "/tmp",
      model: "qwen3.7-flash",
      authorizationMode: "interactive",
    });
    if ("error" in spawned) throw new Error(JSON.stringify(spawned.error));
    const attached = await client.request("attach", {
      sessionId: spawned.result.sessionId,
      exitOn: ["end_turn"],
    });
    if ("error" in attached) throw new Error(JSON.stringify(attached.error));
    const ended = await endedPromise;
    const waited = await client.request("wait", {
      ids: [spawned.result.sessionId],
    });
    if ("error" in waited) throw new Error(JSON.stringify(waited.error));
    const diagnostics = await client.request("diagnostics", {
      sessionId: spawned.result.sessionId,
      sources: ["core"],
      kinds: ["protocol_violation"],
    });
    if ("error" in diagnostics)
      throw new Error(JSON.stringify(diagnostics.error));
    return {
      events,
      ended,
      waited: waited.result,
      diagnostics: diagnostics.result,
    };
  } finally {
    unsubscribe();
    client.close();
    await daemon.close();
  }
}

function assertPublicLifecycle(events: readonly DomainEvent[]): void {
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
  expect(deltaHashes).toEqual([
    "d45dd6feecf4f151424376d88796d93b761b9101488e5bc845545c3385fa48a5",
    "cf483b98c8ab2e60be487129d3439e04c74fab1f1da82bc6ef64c72877f854a8",
  ]);
  expect(snapshots.map((snapshot) => sha256(snapshot.content))).toEqual(
    deltaHashes,
  );
  expect(
    events.filter(
      (event) =>
        event.type === "tool.requested" || event.type === "tool.completed",
    ),
  ).toEqual([
    {
      type: "tool.requested",
      sessionId: "conformance@gtest",
      turnId: "t1",
      toolCallId: "c1",
      name: "Bash",
    },
    {
      type: "tool.completed",
      sessionId: "conformance@gtest",
      turnId: "t1",
      toolCallId: "c1",
      name: "Bash",
      result: "first",
      isError: false,
    },
    {
      type: "tool.requested",
      sessionId: "conformance@gtest",
      turnId: "t1",
      toolCallId: "c2",
      name: "Bash",
    },
    {
      type: "tool.completed",
      sessionId: "conformance@gtest",
      turnId: "t1",
      toolCallId: "c2",
      name: "Bash",
      result: "second",
      isError: false,
    },
  ]);
  expect(
    events
      .filter(
        (event) =>
          event.type === "tool.requested" || event.type === "tool.completed",
      )
      .every((event) => event.toolCallId.length > 0),
  ).toBe(true);
}

describe("Qoder ingress conformance", () => {
  test("fixed two-tools recording crosses adapter, daemon and formal client without changing facts", async () => {
    const fixture = await loadRecordedQoderFixture("two-tools");
    expect(fixture.metadata).toMatchObject({
      fixture: "two-tools.jsonl",
      recordedAt: "2026-08-25T18:10:33.366Z",
      sdkVersion: "1.0.23",
      qoderCliVersion: "1.1.23",
      protocolVersion: "1.2.0",
      lineCount: 84,
      uniqueNativeToolCount: 2,
      sha256:
        "58e8d23afce4c0aa2cd8b5293f2b06dee2be3f4c968f01acc6391f1c327b4be8",
    });
    expect(fixture.messages[0]).toMatchObject({
      type: "system",
      apiKeySource: "none",
      cwd: "<fixture-cwd>",
      tools: expect.arrayContaining(["Bash"]),
    });

    const result = await runFixture(fixture.messages);
    assertPublicLifecycle(result.events);
    const snapshots = result.events.filter((event) => event.type === "message");
    const completed = result.events.filter(
      (event) => event.type === "turn.completed",
    );
    expect(completed).toHaveLength(1);
    const terminal = completed[0];
    if (terminal === undefined) throw new Error("Terminal event is missing");
    expect({
      type: terminal.type,
      sessionId: terminal.sessionId,
      turnId: terminal.turnId,
      stopReason: terminal.stopReason,
    }).toEqual({
      type: "turn.completed",
      sessionId: "conformance@gtest",
      turnId: "t1",
      stopReason: "end_turn",
    });
    expect(terminal.finalReply === snapshots[1]?.content).toBe(true);
    expect(terminal.usage).toEqual({
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
      server_tool_use: {
        web_search_requests: 0,
        web_fetch_requests: 0,
      },
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
    });
    expect(result.ended).toEqual({
      sessionId: terminal.sessionId,
      reason: "end_turn",
    });
    expect({
      status: result.waited.status,
      results: result.waited.results.map(({ sessionId, status, turn }) => ({
        sessionId,
        status,
        turnId: turn?.turnId,
        stopReason: turn?.stopReason,
      })),
    }).toEqual({
      status: "completed",
      results: [
        {
          sessionId: terminal.sessionId,
          status: "completed",
          turnId: terminal.turnId,
          stopReason: terminal.stopReason,
        },
      ],
    });
    const waitedTurn = result.waited.results[0]?.turn;
    expect(waitedTurn?.finalReply === terminal.finalReply).toBe(true);
    expect(waitedTurn?.usage).toEqual(terminal.usage);
    expect(result.diagnostics).toEqual({ records: [], truncated: false });
  });

  test("duplicate, late and orphan SDK facts remain contained by the adapter", async () => {
    const fixture = await loadRecordedQoderFixture("two-tools");
    const result = await runFixture(mutatedFixture(fixture.messages));

    assertPublicLifecycle(result.events);
    expect(
      result.events.filter((event) => event.type === "turn.completed"),
    ).toHaveLength(1);
    expect(result.diagnostics).toEqual({ records: [], truncated: false });
  });
});
