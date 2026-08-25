import type { ProtocolNotification } from "@reins/protocol";
import {
  messageIdSchema,
  sessionIdSchema,
  turnIdSchema,
} from "@reins/protocol";
import * as v from "valibot";
import { afterEach, expect, test, vi } from "vitest";

import { createPrettyAttachPresenter } from "../../src/attach-presenter.ts";

const sessionId = v.parse(sessionIdSchema, "presenter@g1");
const turnId = v.parse(turnIdSchema, "t1");
const messageId = v.parse(messageIdSchema, "m1");
const secondMessageId = v.parse(messageIdSchema, "m2");

function event(
  params: Extract<ProtocolNotification, { method: "event" }>["params"],
): ProtocolNotification {
  return { kind: "notification", method: "event", params };
}

afterEach(() => vi.restoreAllMocks());

test("an initial complete delta sequence prints its worker body once", () => {
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const presenter = createPrettyAttachPresenter();

  presenter.bufferInitial(
    event({ type: "text.delta", sessionId, turnId, messageId, delta: "hel" }),
  );
  presenter.bufferInitial(
    event({ type: "text.delta", sessionId, turnId, messageId, delta: "lo" }),
  );
  presenter.bufferInitial(
    event({
      type: "message",
      sessionId,
      turnId,
      messageId,
      role: "worker",
      content: "hello",
    }),
  );
  presenter.flushInitial();

  expect(output.join("")).toBe("hello\n");
});

test("initial snapshots remain complete when no matching full delta window exists", () => {
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const presenter = createPrettyAttachPresenter();

  presenter.bufferInitial(
    event({
      type: "message",
      sessionId,
      turnId,
      messageId,
      role: "worker",
      content: "snapshot only",
    }),
  );
  presenter.bufferInitial(
    event({
      type: "text.delta",
      sessionId,
      turnId,
      messageId: secondMessageId,
      delta: "tail",
    }),
  );
  presenter.bufferInitial(
    event({
      type: "message",
      sessionId,
      turnId,
      messageId: secondMessageId,
      role: "worker",
      content: "complete tail",
    }),
  );
  presenter.flushInitial();

  expect(output.join("")).toBe(
    "worker: snapshot only\nworker: complete tail\n",
  );
});

test("an uncertain initial tail stays held until its full snapshot arrives live", () => {
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const presenter = createPrettyAttachPresenter();

  presenter.bufferInitial(
    event({ type: "text.delta", sessionId, turnId, messageId, delta: "lo" }),
  );
  presenter.flushInitial();
  expect(output.join("")).toBe("");

  presenter.present(
    event({
      type: "text.delta",
      sessionId,
      turnId,
      messageId,
      delta: " from live",
    }),
  );
  expect(output.join("")).toBe("");
  presenter.present(
    event({
      type: "message",
      sessionId,
      turnId,
      messageId,
      role: "worker",
      content: "hello from live",
    }),
  );

  expect(output.join("")).toBe("worker: hello from live\n");
  expect(output.join("")).not.toContain("loworker");
});

test("an uncertain initial tail without a snapshot is committed once before terminal output", () => {
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const presenter = createPrettyAttachPresenter();

  presenter.bufferInitial(
    event({ type: "text.delta", sessionId, turnId, messageId, delta: "tail" }),
  );
  presenter.flushInitial();
  presenter.present(
    event({
      type: "turn.completed",
      sessionId,
      turnId,
      stopReason: "end_turn",
      finalReply: "complete reply unavailable to presenter",
    }),
  );
  presenter.present({
    kind: "notification",
    method: "attach.ended",
    params: { sessionId, reason: "end_turn" },
  });
  presenter.clear();

  expect(output.join("")).toBe(
    "tail\n[turn completed] end_turn (presenter@g1)\n[attach ended] presenter@g1: end_turn\n",
  );
});

test("an initial attach end commits an uncertain known tail before the end marker", () => {
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const presenter = createPrettyAttachPresenter();

  presenter.bufferInitial(
    event({ type: "text.delta", sessionId, turnId, messageId, delta: "tail" }),
  );
  presenter.bufferInitial({
    kind: "notification",
    method: "attach.ended",
    params: { sessionId, reason: "end_turn" },
  });
  presenter.flushInitial();

  expect(output.join("")).toBe("tail\n[attach ended] presenter@g1: end_turn\n");
});

test("clear drops an uncertain tail without inventing a terminal boundary", () => {
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const presenter = createPrettyAttachPresenter();

  presenter.bufferInitial(
    event({ type: "text.delta", sessionId, turnId, messageId, delta: "tail" }),
  );
  presenter.flushInitial();
  presenter.clear();
  presenter.clear();

  expect(output.join("")).toBe("");
});

test("equal text from different message identities is never deduplicated", () => {
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const presenter = createPrettyAttachPresenter();

  for (const id of [messageId, secondMessageId]) {
    presenter.bufferInitial(
      event({
        type: "message",
        sessionId,
        turnId,
        messageId: id,
        role: "worker",
        content: "same",
      }),
    );
  }
  presenter.flushInitial();

  expect(output.join("")).toBe("worker: same\nworker: same\n");
});

test("a live snapshot only terminates its already streamed body", () => {
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const presenter = createPrettyAttachPresenter();

  presenter.present(
    event({ type: "text.delta", sessionId, turnId, messageId, delta: "live" }),
  );
  presenter.present(
    event({
      type: "message",
      sessionId,
      turnId,
      messageId,
      role: "worker",
      content: "live",
    }),
  );
  presenter.present(
    event({
      type: "message",
      sessionId,
      turnId,
      messageId,
      role: "worker",
      content: "live",
    }),
  );

  expect(output.join("")).toBe("live\n");
});

test("presenter state is isolated to one subscription instance", () => {
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const snapshot = event({
    type: "message",
    sessionId,
    turnId,
    messageId,
    role: "worker",
    content: "reused identity",
  });

  createPrettyAttachPresenter().present(snapshot);
  createPrettyAttachPresenter().present(snapshot);

  expect(output.join("")).toBe(
    "worker: reused identity\nworker: reused identity\n",
  );
});

test("turn completion prints only terminal facts and releases turn message state", () => {
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const presenter = createPrettyAttachPresenter();
  presenter.present(
    event({ type: "text.delta", sessionId, turnId, messageId, delta: "draft" }),
  );
  presenter.present(
    event({
      type: "turn.completed",
      sessionId,
      turnId,
      stopReason: "end_turn",
      finalReply: "must not be repeated",
      usage: { inputTokens: 3 },
    }),
  );
  presenter.present(
    event({
      type: "message",
      sessionId,
      turnId,
      messageId,
      role: "worker",
      content: "draft",
    }),
  );

  expect(output.join("")).toBe(
    'draft[turn completed] end_turn (presenter@g1)\nusage: {"inputTokens":3}\nworker: draft\n',
  );
  expect(output.join("")).not.toContain("must not be repeated");
});
