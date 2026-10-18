import { createHash } from "node:crypto";

import { createReinsClient } from "@reins/client";
import { openEphemeralDaemonForTest } from "@reins/daemon/testing";
import type {
  ConsumerContext,
  DiagnosticsResult,
  DomainEvent,
  ProtocolNotification,
  WaitResult,
} from "@reins/protocol";
import { createQoderModelCatalog, createQoderDriver } from "@reins/qoder";
import {
  createQoderFixtureSdk,
  loadRecordedQoderFixture,
  type RecordedQoderFixtureFacts,
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

async function runFixture(
  messages: FixtureMessages,
  diagnosticSources?: ["core"],
): Promise<{
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
          modelCatalog: createQoderModelCatalog(sdk),
        },
      ],
    ]),
  });
  const client = createReinsClient(daemon.connect(), {
    consumerContext: "conformance" as ConsumerContext,
    runtimeScopeId: daemon.runtimeScopeId,
  });
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
    if (notification.method === "event") events.push(notification.params.event);
    else resolveEnded(notification.params);
  });
  try {
    const handshake = await client.initialize();
    if ("error" in handshake) throw new Error(JSON.stringify(handshake.error));
    const spawned = await client.request("spawn", {
      sessionLabel: "conformance",
      harness: "qoder",
      message: "fixture replay",
      cwd: "/tmp",
      authorizationMode: "interactive",
    });
    if ("error" in spawned) throw new Error(JSON.stringify(spawned.error));
    const attached = await client.request("attach", {
      scope: "turn",
      sessionId: spawned.result.sessionId,
      turnId: spawned.result.turnId,
      replay: { mode: "available" },
    });
    if ("error" in attached) throw new Error(JSON.stringify(attached.error));
    const ended = await endedPromise;
    const waited = await client.request("wait", {
      targets: [
        { sessionId: spawned.result.sessionId, turnId: spawned.result.turnId },
      ],
      completion: "all",
    });
    if ("error" in waited) throw new Error(JSON.stringify(waited.error));
    const diagnostics = await client.request("diagnostics", {
      sessionId: spawned.result.sessionId,
      kinds: ["protocol_violation"],
      ...(diagnosticSources === undefined
        ? {}
        : { sources: diagnosticSources }),
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

function assertPublicLifecycle(
  events: readonly DomainEvent[],
  facts: RecordedQoderFixtureFacts,
): void {
  const sessionId = events[0]?.sessionId;
  if (sessionId === undefined) throw new Error("Session event is missing");
  expect(sessionId).toMatch(
    /^session:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:test:\d+$/u,
  );
  const deltas = events.filter((event) => event.type === "text.delta");
  const snapshots = events.filter((event) => event.type === "message");
  expect(deltas).toHaveLength(facts.textDeltaCount);
  expect(snapshots.map((event) => [event.messageId, event.role])).toEqual([
    ["m1", "caller"],
    ["w1", "worker"],
    ["w2", "worker"],
    ["w3", "worker"],
  ]);
  expect(snapshots[0]).toMatchObject({
    content: "fixture replay",
    messageId: "m1",
    role: "caller",
  });
  const workerSnapshots = snapshots.filter((event) => event.role === "worker");
  const parts = workerSnapshots.map((snapshot) =>
    typeof snapshot.content === "string"
      ? [{ type: "text" as const, text: snapshot.content }]
      : snapshot.content,
  );
  expect(parts.map((content) => content.map((part) => part.type))).toEqual([
    ["thinking", "text", "tool_call"],
    ["thinking", "tool_call"],
    ["thinking", "text"],
  ]);
  const thinkingHashes = parts.flatMap((content) =>
    content
      .filter((part) => part.type === "thinking")
      .map((part) => sha256(part.text)),
  );
  expect(thinkingHashes).toEqual(facts.thinkingHashes);
  const toolCallIds = parts.flatMap((content) =>
    content
      .filter((part) => part.type === "tool_call")
      .map((part) => part.toolCallId),
  );
  expect(toolCallIds).toEqual(
    facts.tools.map((_tool, index) => `c${index + 1}`),
  );
  const textSnapshots = workerSnapshots.filter(
    (snapshot) =>
      typeof snapshot.content !== "string" &&
      snapshot.content.some((part) => part.type === "text"),
  );
  expect(new Set(deltas.map((event) => event.messageId))).toEqual(
    new Set(textSnapshots.map((event) => event.messageId)),
  );
  const deltaHashes = textSnapshots.map((snapshot) =>
    sha256(
      deltas
        .filter((delta) => delta.messageId === snapshot.messageId)
        .map((delta) => delta.delta)
        .join(""),
    ),
  );
  expect(deltaHashes).toEqual(facts.messages.map((fact) => fact.deltaHash));
  expect(
    textSnapshots.map((snapshot) =>
      sha256(
        typeof snapshot.content === "string"
          ? snapshot.content
          : snapshot.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join(""),
      ),
    ),
  ).toEqual(facts.messages.map((fact) => fact.snapshotHash));
  const toolEvents = events.filter(
    (event) =>
      event.type === "tool.requested" || event.type === "tool.completed",
  );
  expect(toolEvents).toHaveLength(facts.tools.length * 2);
  for (const [index, fact] of facts.tools.entries()) {
    const toolCallId = `c${index + 1}`;
    expect(toolEvents[index * 2]).toEqual({
      type: "tool.requested",
      sessionId,
      turnId: "t1",
      toolCallId,
      name: fact.name,
      input: fact.input,
    });
    const completed = toolEvents[index * 2 + 1];
    expect(
      completed?.type === "tool.completed"
        ? {
            type: completed.type,
            sessionId: completed.sessionId,
            turnId: completed.turnId,
            toolCallId: completed.toolCallId,
            name: completed.name,
            resultHash: sha256(
              typeof completed.result === "string"
                ? completed.result
                : (JSON.stringify(completed.result) ?? ""),
            ),
            isError: completed.isError,
          }
        : completed,
    ).toEqual({
      type: "tool.completed",
      sessionId,
      turnId: "t1",
      toolCallId,
      name: fact.name,
      resultHash: fact.resultHash,
      isError: fact.isError,
    });
  }
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
      projectionVersion: 4,
      lineCount: 34,
      uniqueNativeToolCount: 2,
      artifactSha256:
        "61bff04768ebaaa8b590ea050427faa43653fb9901f91c6df28e3cc71bc326a3",
      sourceSha256:
        "58e8d23afce4c0aa2cd8b5293f2b06dee2be3f4c968f01acc6391f1c327b4be8",
      scenario:
        "Two sequential non-combined Bash tool requests and results followed by a streamed text reply",
    });
    expect(fixture.messages[0]).toMatchObject({
      type: "system",
      apiKeySource: "none",
      cwd: "<fixture-cwd>",
    });
    expect(fixture.facts.textDeltaCount).toBe(12);
    expect(fixture.facts.messages).toHaveLength(2);
    expect(fixture.facts.tools).toHaveLength(2);

    const result = await runFixture(fixture.messages);
    assertPublicLifecycle(result.events, fixture.facts);
    const snapshots = result.events.filter((event) => event.type === "message");
    const completed = result.events.filter(
      (event) => event.type === "turn.completed",
    );
    expect(completed).toHaveLength(1);
    const terminal = completed[0];
    if (terminal === undefined) throw new Error("Terminal event is missing");
    const sessionId = result.events[0]?.sessionId;
    if (sessionId === undefined) throw new Error("Session event is missing");
    expect({
      type: terminal.type,
      sessionId: terminal.sessionId,
      turnId: terminal.turnId,
      stopReason: terminal.stopReason,
    }).toEqual({
      type: "turn.completed",
      sessionId,
      turnId: "t1",
      stopReason: fixture.facts.terminal.stopReason,
    });
    const finalContent = snapshots.at(-1)?.content;
    const finalText =
      finalContent === undefined
        ? undefined
        : typeof finalContent === "string"
          ? finalContent
          : finalContent
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("");
    expect(terminal.finalReply).toBe(finalText);
    expect(sha256(terminal.finalReply ?? "")).toBe(
      fixture.facts.terminal.finalReplyHash,
    );
    expect(terminal.usage).toEqual(fixture.facts.terminal.usage);
    expect(result.ended).toMatchObject({
      sessionId: terminal.sessionId,
      reason: "end_turn",
    });
    expect(result.waited).toMatchObject({
      status: "satisfied",
      pending: [],
      completed: [
        {
          sessionId: terminal.sessionId,
          turnId: terminal.turnId,
          stopReason: terminal.stopReason,
        },
      ],
    });
    const waitedTurn = result.waited.completed[0];
    expect(waitedTurn?.finalReply === terminal.finalReply).toBe(true);
    expect(waitedTurn?.usage).toEqual(terminal.usage);
    expect(result.diagnostics).toEqual({ records: [], truncated: false });
  });

  test("duplicate, late and orphan SDK facts remain contained by the adapter", async () => {
    const fixture = await loadRecordedQoderFixture("two-tools");
    const result = await runFixture(mutatedFixture(fixture.messages), ["core"]);

    assertPublicLifecycle(result.events, fixture.facts);
    expect(
      result.events.filter((event) => event.type === "turn.completed"),
    ).toHaveLength(1);
    expect(result.diagnostics).toEqual({ records: [], truncated: false });
  });
});
