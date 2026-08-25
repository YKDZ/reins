import type { ProtocolNotification } from "@reins/protocol";
import {
  messageIdSchema,
  sessionIdSchema,
  toolCallIdSchema,
  turnIdSchema,
} from "@reins/protocol";
import * as v from "valibot";
import { afterEach, expect, test, vi } from "vitest";

import { createPrettyAttachPresenter } from "../../src/attach-presenter.ts";

const sessionId = v.parse(sessionIdSchema, "presenter@g1");
const turnId = v.parse(turnIdSchema, "t1");
const messageId = v.parse(messageIdSchema, "m1");
const secondMessageId = v.parse(messageIdSchema, "m2");
const toolCallId = v.parse(toolCallIdSchema, "c1");

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
  presenter.flushInitial([]);

  expect(output.join("")).toBe("hello\n");
});

test("an explicit replay prefix restores text at the first delta without moving tools", () => {
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const presenter = createPrettyAttachPresenter();

  presenter.bufferInitial(
    event({ type: "text.delta", sessionId, turnId, messageId, delta: "llo" }),
  );
  presenter.bufferInitial(
    event({
      type: "tool.requested",
      sessionId,
      turnId,
      toolCallId,
      name: "Read",
    }),
  );
  presenter.bufferInitial(
    event({
      type: "text.delta",
      sessionId,
      turnId,
      messageId,
      delta: " world",
    }),
  );
  presenter.bufferInitial(
    event({
      type: "message",
      sessionId,
      turnId,
      messageId,
      role: "worker",
      content: "hello world",
    }),
  );

  presenter.flushInitial([{ turnId, messageId, prefix: "he" }]);

  expect(output.join("")).toBe("hello[tool] Read requested (c1)\n world\n");
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
  presenter.flushInitial([
    { turnId, messageId: secondMessageId, prefix: "complete " },
  ]);

  expect(output.join("")).toBe("worker: snapshot only\ncomplete tail\n");
});

test("a replay-zero prefix is written at the start of the initial batch", () => {
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const presenter = createPrettyAttachPresenter();

  presenter.bufferInitial(
    event({
      type: "tool.requested",
      sessionId,
      turnId,
      toolCallId,
      name: "Read",
    }),
  );
  presenter.flushInitial([{ turnId, messageId, prefix: "working" }]);

  expect(output.join("")).toBe("working[tool] Read requested (c1)\n");
});

test("prefixes for multiple identities are applied independently", () => {
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const presenter = createPrettyAttachPresenter();

  presenter.bufferInitial(
    event({ type: "text.delta", sessionId, turnId, messageId, delta: " one" }),
  );
  presenter.bufferInitial(
    event({
      type: "message",
      sessionId,
      turnId,
      messageId,
      role: "worker",
      content: "full one",
    }),
  );
  presenter.bufferInitial(
    event({
      type: "text.delta",
      sessionId,
      turnId,
      messageId: secondMessageId,
      delta: " two",
    }),
  );
  presenter.bufferInitial(
    event({
      type: "message",
      sessionId,
      turnId,
      messageId: secondMessageId,
      role: "worker",
      content: "full two",
    }),
  );
  presenter.flushInitial([
    { turnId, messageId, prefix: "full" },
    { turnId, messageId: secondMessageId, prefix: "full" },
  ]);

  expect(output.join("")).toBe("full one\nfull two\n");
});

test("clear discards buffered notifications and seeded message state", () => {
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const presenter = createPrettyAttachPresenter();

  presenter.bufferInitial(
    event({ type: "text.delta", sessionId, turnId, messageId, delta: "tail" }),
  );
  presenter.clear();
  presenter.clear();
  presenter.present(
    event({ type: "text.delta", sessionId, turnId, messageId, delta: "live" }),
  );

  expect(output.join("")).toBe("live");
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
  presenter.flushInitial([]);

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
