import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { SDKMessage } from "@qodercn-ai/qodercn-agent-sdk";
import type { DomainEvent, SessionId, TurnId } from "@reins/protocol";

import {
  projectRecordedQoderMessages,
  toQoderSdkMessages,
} from "../../src/fixture-projection.ts";
import { createQoderDriver } from "../../src/qoder-driver.ts";
import { createFakeSdk } from "../helpers/fake-sdk.ts";

export class FixtureSemanticMismatchError extends Error {
  readonly code = "fixture_semantic_mismatch";

  constructor() {
    super("Recorded Qoder projection changes public events");
    this.name = "FixtureSemanticMismatchError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprintEvent(event: DomainEvent): unknown {
  switch (event.type) {
    case "session.created":
      return {
        type: event.type,
        sessionId: event.sessionId,
        harness: event.harness,
        model: event.model,
        reasoning: event.reasoning,
        cwd: event.cwd,
        sessionLabel: event.sessionLabel,
      };
    case "turn.started":
      return event;
    case "text.delta":
      return { ...event, deltaHash: sha256(event.delta), delta: undefined };
    case "message":
      return {
        ...event,
        contentHash: sha256(event.content),
        content: undefined,
      };
    case "tool.requested":
      return event;
    case "tool.completed":
      return {
        ...event,
        resultPresent: event.result !== null,
        resultHash: sha256(event.result ?? ""),
        result: undefined,
      };
    case "permission.requested":
      return {
        ...event,
        inputHash: sha256(JSON.stringify(event.input ?? null)),
        input: undefined,
      };
    case "permission.resolved":
      return event;
    case "turn.completed":
      return {
        ...event,
        finalReplyPresent: event.finalReply !== null,
        finalReplyHash: sha256(event.finalReply ?? ""),
        finalReply: undefined,
      };
    case "session.killed":
      return event;
  }
}

export async function qoderPublicEventFingerprint(
  messages: readonly SDKMessage[],
): Promise<unknown[]> {
  const fake = createFakeSdk();
  const events: DomainEvent[] = [];
  let resolveTerminal!: () => void;
  const terminal = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });
  const driver = createQoderDriver({ sdk: fake.sdk })({
    emit: (event) => {
      events.push(event);
      if (event.type === "turn.completed") resolveTerminal();
    },
    diagnostics: async () => undefined,
  });
  driver.start({
    sessionId: "session:fixture:1" as SessionId,
    turnId: "t1" as TurnId,
    harness: "qoder",
    message: "fixture replay",
    cwd: "/tmp",
    model: "qwen3.7-flash",
    authorizationMode: "interactive",
  });
  for (const message of messages) fake.controls.push(message);
  fake.controls.end();
  await terminal;
  await driver.terminate("session:fixture:1" as SessionId);
  return events.map(fingerprintEvent);
}

export async function assertQoderProjectionSemanticEquivalence(
  messages: readonly SDKMessage[],
): Promise<void> {
  const projected = toQoderSdkMessages(projectRecordedQoderMessages(messages));
  await assertQoderEventSemanticEquivalence(messages, projected);
}

export async function assertQoderEventSemanticEquivalence(
  source: readonly SDKMessage[],
  candidate: readonly SDKMessage[],
): Promise<void> {
  const [rawFingerprint, projectedFingerprint] = await Promise.all([
    qoderPublicEventFingerprint(source),
    qoderPublicEventFingerprint(candidate),
  ]);
  if (!isDeepStrictEqual(rawFingerprint, projectedFingerprint)) {
    throw new FixtureSemanticMismatchError();
  }
}
