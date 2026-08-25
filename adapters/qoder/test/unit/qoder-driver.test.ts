import type { SDKMessage } from "@qodercn-ai/qodercn-agent-sdk";
import type { DiagnosticSink } from "@reins/adapter-kit";
import type {
  DriverDiagnosticFact,
  DomainEvent,
  PermissionId,
  SessionId,
  SessionName,
  TurnId,
} from "@reins/protocol";
import { describe, expect, test } from "vitest";

import { createQoderDriver } from "#/qoder-driver";

import { createFakeSdk } from "../helpers/fake-sdk.ts";

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};
const sessionId = "reviewer@g1" as SessionId;
const firstTurnId = "t1" as TurnId;
const secondTurnId = "t2" as TurnId;
const permissionId = "p1" as PermissionId;
const sessionName = "reviewer" as SessionName;

function setup(
  authorizationMode: "interactive" | "allowAll" | "omitted" = "interactive",
): {
  events: DomainEvent[];
  diagnostics: DriverDiagnosticFact[];
  fake: ReturnType<typeof createFakeSdk>;
  driver: ReturnType<ReturnType<typeof createQoderDriver>>;
} {
  const fake = createFakeSdk();
  const diagnostics: DriverDiagnosticFact[] = [];
  const sink: DiagnosticSink = async (input) => {
    diagnostics.push(input);
    return undefined;
  };
  const factory = createQoderDriver({ sdk: fake.sdk });
  const events: DomainEvent[] = [];
  const driver = factory({
    emit: (event) => events.push(event),
    diagnostics: sink,
  });
  driver.start({
    sessionId,
    turnId: firstTurnId,
    sessionName,
    harness: "qoder",
    message: "检查",
    cwd: "/tmp/demo",
    ...(authorizationMode === "omitted" ? {} : { authorizationMode }),
  });
  return { events, diagnostics, fake, driver };
}

const textDelta = (uuid: string, text: string): SDKMessage => ({
  type: "stream_event",
  event: {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  },
  parent_tool_use_id: null,
  uuid,
  session_id: "qs",
});

const messageStart = (uuid: string, nativeId: string): SDKMessage => ({
  type: "stream_event",
  event: {
    type: "message_start",
    message: {
      id: nativeId,
      type: "message",
      role: "assistant",
      content: [],
      model: "qwen",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  },
  parent_tool_use_id: null,
  uuid,
  session_id: "qs",
});

const assistantText = (
  uuid: string,
  text: string,
  nativeId = uuid,
): SDKMessage => ({
  type: "assistant",
  message: {
    id: nativeId,
    role: "assistant",
    content: [{ type: "text", text }],
    usage: { input_tokens: 12, output_tokens: 34 },
  },
  parent_tool_use_id: null,
  uuid,
  session_id: "qs",
});

const idle = (): SDKMessage => ({
  type: "system",
  subtype: "session_state_changed",
  state: "idle",
  uuid: "sys1",
  session_id: "qs",
});

const assistantEndTurn = (uuid: string, text: string): SDKMessage => ({
  type: "assistant",
  message: {
    id: uuid,
    role: "assistant",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 5, output_tokens: 6 },
  },
  parent_tool_use_id: null,
  uuid,
  session_id: "qs",
});

const assistantToolUseBlock = (uuid: string, id: string): SDKMessage => ({
  type: "assistant",
  message: {
    id: uuid,
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id,
        name: "Bash",
        input: { command: "ls" },
      },
    ],
    stop_reason: "tool_use",
  },
  parent_tool_use_id: null,
  uuid,
  session_id: "qs",
});

const userToolResultBlock = (
  uuid: string,
  id: string,
  content: string,
): SDKMessage => ({
  type: "user",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content }],
  },
  parent_tool_use_id: null,
  uuid,
  session_id: "qs",
});

const assistantThinking = (uuid: string): SDKMessage => ({
  type: "assistant",
  message: {
    id: uuid,
    role: "assistant",
    content: [{ type: "thinking", thinking: "思考中" }],
  },
  parent_tool_use_id: null,
  uuid,
  session_id: "qs",
});

describe("qoder driver 事件映射", () => {
  test("文本流与回合结束：text.delta、message、turn.completed", async () => {
    const { events, fake } = setup();
    fake.controls.push(messageStart("start-1", "native-a1"));
    fake.controls.push(textDelta("a1", "分析"));
    fake.controls.push(textDelta("a2", "完成"));
    fake.controls.push(assistantText("a3", "分析完成", "native-a1"));
    fake.controls.push(idle());
    await flush();

    expect(events.map((event) => event.type)).toEqual([
      "text.delta",
      "text.delta",
      "message",
      "turn.completed",
    ]);
    const completed = events.find((event) => event.type === "turn.completed");
    expect(completed).toEqual({
      type: "turn.completed",
      sessionId,
      turnId: firstTurnId,
      stopReason: "end_turn",
      finalReply: "分析完成",
      usage: expect.objectContaining({ input_tokens: 12, output_tokens: 34 }),
    });
  });

  test("按原生产物去重重复 snapshot 与双工具结果", async () => {
    const { events, fake } = setup();
    fake.controls.push(messageStart("start-1", "native-text"));
    fake.controls.push(textDelta("delta-1", "稳"));
    fake.controls.push(textDelta("delta-2", "定"));
    fake.controls.push(assistantText("snapshot-1", "稳定", "native-text"));
    fake.controls.push(assistantText("snapshot-2", "稳定", "native-text"));

    const twoTools: SDKMessage = {
      type: "assistant",
      message: {
        id: "native-tools",
        role: "assistant",
        content: [
          { type: "tool_use", id: "tc1", name: "Bash", input: {} },
          { type: "tool_use", id: "tc2", name: "Read", input: {} },
        ],
      },
      parent_tool_use_id: null,
      uuid: "tools-1",
      session_id: "qs",
    };
    fake.controls.push(twoTools);
    fake.controls.push({ ...twoTools, uuid: "tools-2" });

    const results: SDKMessage = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tc1", content: "one" }],
      },
      parent_tool_use_id: "tc1",
      tool_use_result: "duplicate wrapper for one",
      uuid: "results-1",
      session_id: "qs",
    };
    fake.controls.push(results);
    const secondResult: SDKMessage = {
      type: "user",
      message: { role: "user", content: "wrapper result" },
      parent_tool_use_id: "tc2",
      tool_use_result: "two",
      uuid: "results-2",
      session_id: "qs",
    };
    fake.controls.push(secondResult);
    fake.controls.push({ ...results, uuid: "results-2" });
    fake.controls.push({ ...secondResult, uuid: "results-4" });
    fake.controls.push({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "unknown-tool",
            content: "unknown content result",
          },
        ],
      },
      parent_tool_use_id: null,
      tool_use_result: "missing native id",
      uuid: "results-3",
      session_id: "qs",
    });
    await flush();

    expect(
      events
        .filter(
          (event) => event.type === "text.delta" || event.type === "message",
        )
        .map((event) => ({ type: event.type, messageId: event.messageId })),
    ).toEqual([
      { type: "text.delta", messageId: "m1" },
      { type: "text.delta", messageId: "m1" },
      { type: "message", messageId: "m1" },
    ]);
    expect(
      events.filter(
        (event) =>
          event.type === "tool.requested" || event.type === "tool.completed",
      ),
    ).toEqual([
      {
        type: "tool.requested",
        sessionId,
        turnId: firstTurnId,
        toolCallId: "c1",
        name: "Bash",
      },
      {
        type: "tool.requested",
        sessionId,
        turnId: firstTurnId,
        toolCallId: "c2",
        name: "Read",
      },
      {
        type: "tool.completed",
        sessionId,
        turnId: firstTurnId,
        toolCallId: "c1",
        name: "Bash",
        result: "one",
        isError: false,
      },
      {
        type: "tool.completed",
        sessionId,
        turnId: firstTurnId,
        toolCallId: "c2",
        name: "Read",
        result: "two",
        isError: false,
      },
    ]);
  });

  test("content tool_result 阻止同一消息的跨工具 top-level wrapper", async () => {
    const { events, fake } = setup();
    fake.controls.push(assistantToolUseBlock("request-1", "tc1"));
    fake.controls.push({
      type: "assistant",
      message: {
        id: "request-2",
        role: "assistant",
        content: [{ type: "tool_use", id: "tc2", name: "Read", input: {} }],
      },
      parent_tool_use_id: null,
      uuid: "request-2",
      session_id: "qs",
    });
    fake.controls.push({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tc1", content: "one" }],
      },
      parent_tool_use_id: "tc2",
      tool_use_result: "must not complete tc2",
      uuid: "combined-results",
      session_id: "qs",
    });
    await flush();

    expect(events.filter((event) => event.type === "tool.completed")).toEqual([
      {
        type: "tool.completed",
        sessionId,
        turnId: firstTurnId,
        toolCallId: "c1",
        name: "Bash",
        result: "one",
        isError: false,
      },
    ]);

    fake.controls.push({
      type: "user",
      message: { role: "user", content: "independent wrapper" },
      parent_tool_use_id: "tc2",
      tool_use_result: "two",
      uuid: "fallback-result",
      session_id: "qs",
    });
    await flush();
    expect(
      events.filter(
        (event) =>
          event.type === "tool.requested" || event.type === "tool.completed",
      ),
    ).toEqual([
      {
        type: "tool.requested",
        sessionId,
        turnId: firstTurnId,
        toolCallId: "c1",
        name: "Bash",
      },
      {
        type: "tool.requested",
        sessionId,
        turnId: firstTurnId,
        toolCallId: "c2",
        name: "Read",
      },
      {
        type: "tool.completed",
        sessionId,
        turnId: firstTurnId,
        toolCallId: "c1",
        name: "Bash",
        result: "one",
        isError: false,
      },
      {
        type: "tool.completed",
        sessionId,
        turnId: firstTurnId,
        toolCallId: "c2",
        name: "Read",
        result: "two",
        isError: false,
      },
    ]);
  });

  test("无效 content tool_result 也阻止 top-level fallback", async () => {
    const { events, fake } = setup();
    fake.controls.push(assistantToolUseBlock("request-1", "tc1"));
    fake.controls.push({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "unknown",
            content: "unknown result",
          },
        ],
      },
      parent_tool_use_id: "tc1",
      tool_use_result: "must not fallback",
      uuid: "invalid-content-result",
      session_id: "qs",
    });
    await flush();
    expect(events.filter((event) => event.type === "tool.completed")).toEqual(
      [],
    );

    fake.controls.push({
      type: "user",
      message: { role: "user", content: "independent wrapper" },
      parent_tool_use_id: "tc1",
      tool_use_result: "fallback",
      uuid: "fallback-result",
      session_id: "qs",
    });
    await flush();
    expect(events.filter((event) => event.type === "tool.completed")).toEqual([
      {
        type: "tool.completed",
        sessionId,
        turnId: firstTurnId,
        toolCallId: "c1",
        name: "Bash",
        result: "fallback",
        isError: false,
      },
    ]);
  });

  test("没有稳定原生 assistant id 时不从外层 uuid 制造消息身份", async () => {
    const { events, fake } = setup();
    fake.controls.push(textDelta("outer-delta", "不可关联"));
    fake.controls.push({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "仍不可关联" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "outer-snapshot",
      session_id: "qs",
    });
    await flush();

    expect(
      events.filter(
        (event) => event.type === "text.delta" || event.type === "message",
      ),
    ).toEqual([]);
    expect(events.filter((event) => event.type === "turn.completed")).toEqual([
      {
        type: "turn.completed",
        sessionId,
        turnId: firstTurnId,
        stopReason: "end_turn",
        finalReply: "仍不可关联",
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    ]);
  });

  test("缺少 id 的中间 snapshot 清除此前的 assistant identity", async () => {
    const { events, fake } = setup();
    fake.controls.push(messageStart("start-a", "native-a"));
    fake.controls.push(textDelta("delta-before", "可关联"));
    fake.controls.push({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "无身份快照" }],
        stop_reason: null,
      },
      parent_tool_use_id: null,
      uuid: "outer-snapshot",
      session_id: "qs",
    });
    fake.controls.push(textDelta("delta-after", "不可再沿用"));
    await flush();

    expect(
      events.filter(
        (event) => event.type === "text.delta" || event.type === "message",
      ),
    ).toEqual([
      {
        type: "text.delta",
        sessionId,
        turnId: firstTurnId,
        messageId: "m1",
        delta: "可关联",
      },
    ]);
  });

  test("同一原生消息的渐进完整 snapshot 在 idle 前只发布最新文本", async () => {
    const { events, fake } = setup();
    fake.controls.push(assistantText("outer-a", "A", "native-progressive"));
    fake.controls.push(assistantText("outer-ab", "AB", "native-progressive"));
    fake.controls.push(idle());
    await flush();

    expect(
      events.filter(
        (event) => event.type === "message" || event.type === "turn.completed",
      ),
    ).toEqual([
      {
        type: "message",
        sessionId,
        turnId: firstTurnId,
        messageId: "m1",
        role: "worker",
        content: "AB",
      },
      {
        type: "turn.completed",
        sessionId,
        turnId: firstTurnId,
        stopReason: "end_turn",
        finalReply: "AB",
        usage: { input_tokens: 12, output_tokens: 34 },
      },
    ]);
  });

  test("同一原生消息的相同完整 snapshot 幂等发布一次", async () => {
    const { events, fake } = setup();
    fake.controls.push(assistantText("outer-a1", "A", "native-repeat"));
    fake.controls.push(assistantText("outer-a2", "A", "native-repeat"));
    fake.controls.push(idle());
    await flush();

    expect(
      events.filter(
        (event) => event.type === "message" || event.type === "turn.completed",
      ),
    ).toEqual([
      {
        type: "message",
        sessionId,
        turnId: firstTurnId,
        messageId: "m1",
        role: "worker",
        content: "A",
      },
      {
        type: "turn.completed",
        sessionId,
        turnId: firstTurnId,
        stopReason: "end_turn",
        finalReply: "A",
        usage: { input_tokens: 12, output_tokens: 34 },
      },
    ]);
  });

  test("已 flush 的原生消息拒绝不同文本但保留终态事实", async () => {
    const { events, fake } = setup();
    fake.controls.push(assistantText("outer-a", "A", "native-flushed"));
    fake.controls.push({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
      parent_tool_use_id: null,
      uuid: "block-stop",
      session_id: "qs",
    });
    fake.controls.push({
      type: "assistant",
      message: {
        id: "native-flushed",
        role: "assistant",
        content: [{ type: "text", text: "AB" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 7 },
      },
      parent_tool_use_id: null,
      uuid: "outer-ab",
      session_id: "qs",
    });
    await flush();

    expect(
      events.filter(
        (event) => event.type === "message" || event.type === "turn.completed",
      ),
    ).toEqual([
      {
        type: "message",
        sessionId,
        turnId: firstTurnId,
        messageId: "m1",
        role: "worker",
        content: "A",
      },
      {
        type: "turn.completed",
        sessionId,
        turnId: firstTurnId,
        stopReason: "end_turn",
        finalReply: "A",
        usage: { input_tokens: 0, output_tokens: 7 },
      },
    ]);
  });

  test("同一回合的多个原生 assistant 消息按边界顺序发布", async () => {
    const { events, fake } = setup();
    fake.controls.push(messageStart("start-1", "native-1"));
    fake.controls.push(assistantText("outer-1", "first", "native-1"));
    fake.controls.push(messageStart("start-2", "native-2"));
    fake.controls.push(assistantText("outer-2", "second", "native-2"));
    fake.controls.push(idle());
    await flush();

    expect(events.filter((event) => event.type === "message")).toEqual([
      {
        type: "message",
        sessionId,
        turnId: firstTurnId,
        messageId: "m1",
        role: "worker",
        content: "first",
      },
      {
        type: "message",
        sessionId,
        turnId: firstTurnId,
        messageId: "m2",
        role: "worker",
        content: "second",
      },
    ]);
  });

  test("新回合丢弃迟到工具结果并允许复用原生 tool id", async () => {
    const { events, fake, driver } = setup();
    fake.controls.push(assistantToolUseBlock("request-t1", "tc-shared"));
    fake.controls.push(idle());
    await flush();

    fake.controls.push(
      userToolResultBlock("late-while-idle", "tc-shared", "late"),
    );
    await flush();
    expect(events.filter((event) => event.type === "tool.completed")).toEqual(
      [],
    );

    driver.deliver(sessionId, secondTurnId, "继续");
    fake.controls.push(
      userToolResultBlock("late-after-deliver", "tc-shared", "late"),
    );
    await flush();
    expect(events.filter((event) => event.type === "tool.completed")).toEqual(
      [],
    );

    fake.controls.push(assistantToolUseBlock("request-t2", "tc-shared"));
    fake.controls.push(userToolResultBlock("result-t2", "tc-shared", "ok"));
    await flush();

    expect(
      events.filter(
        (event) =>
          event.type === "tool.requested" || event.type === "tool.completed",
      ),
    ).toEqual([
      {
        type: "tool.requested",
        sessionId,
        turnId: firstTurnId,
        toolCallId: "c1",
        name: "Bash",
      },
      {
        type: "tool.requested",
        sessionId,
        turnId: secondTurnId,
        toolCallId: "c1",
        name: "Bash",
      },
      {
        type: "tool.completed",
        sessionId,
        turnId: secondTurnId,
        toolCallId: "c1",
        name: "Bash",
        result: "ok",
        isError: false,
      },
    ]);
  });

  test("新回合可复用原生 assistant id 及通用 MessageId", async () => {
    const { events, fake, driver } = setup();
    fake.controls.push(messageStart("start-t1", "native-shared"));
    fake.controls.push(textDelta("delta-t1", "one"));
    fake.controls.push(assistantText("snapshot-t1", "one", "native-shared"));
    fake.controls.push(idle());
    await flush();

    driver.deliver(sessionId, secondTurnId, "继续");
    fake.controls.push(messageStart("start-t2", "native-shared"));
    fake.controls.push(textDelta("delta-t2", "two"));
    fake.controls.push(assistantText("snapshot-t2", "two", "native-shared"));
    fake.controls.push(idle());
    await flush();

    expect(
      events.filter(
        (event) => "turnId" in event && event.turnId === secondTurnId,
      ),
    ).toEqual([
      {
        type: "text.delta",
        sessionId,
        turnId: secondTurnId,
        messageId: "m1",
        delta: "two",
      },
      {
        type: "message",
        sessionId,
        turnId: secondTurnId,
        messageId: "m1",
        role: "worker",
        content: "two",
      },
      {
        type: "turn.completed",
        sessionId,
        turnId: secondTurnId,
        stopReason: "end_turn",
        finalReply: "two",
        usage: { input_tokens: 12, output_tokens: 34 },
      },
    ]);
  });

  test("assistant stop_reason=end_turn 合成回合终态", async () => {
    const { events, fake } = setup();
    fake.controls.push(assistantEndTurn("a1", "回答完毕"));
    await flush();

    expect(events.map((event) => event.type)).toEqual([
      "message",
      "turn.completed",
    ]);
    expect(events.find((event) => event.type === "turn.completed")).toEqual({
      type: "turn.completed",
      sessionId,
      turnId: firstTurnId,
      stopReason: "end_turn",
      finalReply: "回答完毕",
      usage: expect.objectContaining({ input_tokens: 5, output_tokens: 6 }),
    });
  });

  test("缺少 usage 时不填造 token 字段", async () => {
    const { events, fake } = setup();
    fake.controls.push({
      type: "assistant",
      message: {
        id: "native-final",
        role: "assistant",
        content: [{ type: "text", text: "完成" }],
        stop_reason: "end_turn",
      },
      parent_tool_use_id: null,
      uuid: "outer-final",
      session_id: "qs",
    });
    await flush();

    expect(events.filter((event) => event.type === "turn.completed")).toEqual([
      {
        type: "turn.completed",
        sessionId,
        turnId: firstTurnId,
        stopReason: "end_turn",
        finalReply: "完成",
      },
    ]);
  });

  test("message_delta 的 end_turn 合成回合终态（partial 模式）", async () => {
    const { events, fake } = setup();
    fake.controls.push(assistantText("a1", "回答完毕"));
    fake.controls.push({
      type: "stream_event",
      event: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 7, output_tokens: 8 },
      },
      parent_tool_use_id: null,
      uuid: "d1",
      session_id: "qs",
    });
    await flush();

    expect(events.find((event) => event.type === "turn.completed")).toEqual({
      type: "turn.completed",
      sessionId,
      turnId: firstTurnId,
      stopReason: "end_turn",
      finalReply: "回答完毕",
      usage: expect.objectContaining({ input_tokens: 7, output_tokens: 8 }),
    });
  });

  test("完整消息里的 tool_use 块与流式起点不重复映射", async () => {
    const { events, fake } = setup();
    fake.controls.push({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "tc1",
          name: "Bash",
          input: { command: "ls" },
        },
      },
      parent_tool_use_id: null,
      uuid: "s2",
      session_id: "qs",
    });
    fake.controls.push(assistantToolUseBlock("a2", "tc1"));
    await flush();

    expect(
      events.filter((event) => event.type === "tool.requested"),
    ).toHaveLength(1);
  });

  test("user 消息 content 中的 tool_result 块映射 tool.completed", async () => {
    const { events, fake } = setup();
    fake.controls.push(assistantToolUseBlock("a3", "tc2"));
    fake.controls.push(userToolResultBlock("u1", "tc2", "ok"));
    await flush();

    expect(events.filter((event) => event.type === "tool.completed")).toEqual([
      {
        type: "tool.completed",
        sessionId,
        turnId: firstTurnId,
        toolCallId: "c1",
        name: "Bash",
        result: "ok",
        isError: false,
      },
    ]);
  });

  test("thinking 块不进入消息或诊断", async () => {
    const { events, fake, diagnostics } = setup();
    fake.controls.push(assistantThinking("a4"));
    await flush();

    expect(events.filter((event) => event.type === "message")).toEqual([]);
    expect(diagnostics.filter((input) => input.kind !== "lifecycle")).toEqual(
      [],
    );
  });

  test("工具生命周期：tool.requested 与 tool.completed(isError)", async () => {
    const { events, fake } = setup();
    fake.controls.push({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "tc1",
          name: "Bash",
          input: { command: "ls" },
        },
      },
      parent_tool_use_id: null,
      uuid: "a2",
      session_id: "qs",
    });
    fake.controls.push({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tc1",
            content: "ok",
            is_error: false,
          },
        ],
      },
      parent_tool_use_id: null,
      uuid: "a3",
      session_id: "qs",
    });
    fake.controls.push(idle());
    await flush();

    expect(
      events.filter(
        (event) =>
          event.type === "tool.requested" || event.type === "tool.completed",
      ),
    ).toEqual([
      {
        type: "tool.requested",
        sessionId,
        turnId: firstTurnId,
        toolCallId: "c1",
        name: "Bash",
      },
      {
        type: "tool.completed",
        sessionId,
        turnId: firstTurnId,
        toolCallId: "c1",
        name: "Bash",
        result: "ok",
        isError: false,
      },
    ]);
  });

  test("worker reported failure 合成终态并记录类型化 turn_failure", async () => {
    const { events, fake, diagnostics } = setup();
    fake.controls.push({
      type: "assistant",
      message: { role: "assistant", content: [] },
      parent_tool_use_id: null,
      uuid: "a4",
      session_id: "qs",
      isApiErrorMessage: true,
    });
    await flush();

    expect(events.find((event) => event.type === "turn.completed")).toEqual({
      type: "turn.completed",
      sessionId,
      turnId: firstTurnId,
      stopReason: "failed",
      finalReply: null,
    });
    expect(diagnostics.filter((input) => input.kind !== "lifecycle")).toEqual([
      expect.objectContaining({
        kind: "turn_failure",
        operation: "run_turn",
        reason: "worker_reported_failure",
        sessionId,
        turnId: firstTurnId,
      }),
    ]);
  });

  test("busy 与 idle 的 clean EOF 都各记录一次 exited_unexpectedly", async () => {
    const busy = setup();
    busy.fake.controls.end();
    await flush();
    expect(
      busy.diagnostics.filter(
        (input) =>
          input.kind === "lifecycle" && input.reason === "exited_unexpectedly",
      ),
    ).toHaveLength(1);

    const idleWorker = setup();
    idleWorker.fake.controls.push(idle());
    await flush();
    idleWorker.fake.controls.end();
    await flush();
    const idleExit = idleWorker.diagnostics.filter(
      (input) =>
        input.kind === "lifecycle" && input.reason === "exited_unexpectedly",
    );
    expect(idleExit).toHaveLength(1);
    expect(idleExit[0]).not.toHaveProperty("turnId");
    expect(idleExit[0]).toMatchObject({
      message: expect.objectContaining({
        text: "worker stream ended unexpectedly while idle",
      }),
    });
  });
});

describe("授权模式映射", () => {
  test("未指定时不注入 SDK 权限选项", () => {
    const { fake } = setup("omitted");
    const options = fake.controls.lastOptions();
    expect(options?.permissionMode).toBeUndefined();
    expect(options?.allowDangerouslySkipPermissions).toBeUndefined();
    expect(options?.canUseTool).toBeUndefined();
  });

  test("interactive：default + canUseTool 注册", () => {
    const { fake } = setup("interactive");
    const options = fake.controls.lastOptions();
    expect(options?.permissionMode).toBe("default");
    expect(options?.canUseTool).toBeTypeOf("function");
    expect(options?.includePartialMessages).toBe(true);
    expect(options?.allowDangerouslySkipPermissions).toBeUndefined();
    expect(options?.persistSession).toBe(false);
    expect(options?.cwd).toBe("/tmp/demo");
  });

  test("allowAll：bypassPermissions + 显式确认，不注册 canUseTool", () => {
    const { fake } = setup("allowAll");
    const options = fake.controls.lastOptions();
    expect(options?.permissionMode).toBe("bypassPermissions");
    expect(options?.allowDangerouslySkipPermissions).toBe(true);
    expect(options?.canUseTool).toBeUndefined();
  });
});

describe("permission 桥", () => {
  test("allow session：决议翻译为带会话规则的 PermissionResult", async () => {
    const { events, fake, driver } = setup();
    const canUseTool = fake.controls.lastOptions()?.canUseTool;
    expect(canUseTool).toBeTypeOf("function");
    const signal = new AbortController().signal;
    const suggestion = {
      type: "addRules" as const,
      rules: [{ toolName: "Bash" }],
      behavior: "allow" as const,
      destination: "session" as const,
    };
    const resultPromise = canUseTool?.(
      "Bash",
      { command: "ls" },
      {
        signal,
        toolUseID: "tu1",
        suggestions: [suggestion],
      },
    );
    await flush();

    const requested = events.find(
      (event) => event.type === "permission.requested",
    );
    expect(requested).toEqual({
      type: "permission.requested",
      sessionId,
      turnId: firstTurnId,
      permissionId: "p1",
      kind: "tool:Bash",
      input: { command: "ls" },
      options: [
        { outcome: "allow", scope: "once" },
        { outcome: "allow", scope: "session" },
        { outcome: "deny", feedback: true },
      ],
    });

    driver.resolvePermission(sessionId, permissionId, {
      outcome: "allow",
      scope: "session",
    });
    await expect(resultPromise).resolves.toEqual({
      behavior: "allow",
      updatedInput: { command: "ls" },
      toolUseID: "tu1",
      updatedPermissions: [suggestion],
    });
  });

  test("deny feedback：翻译为 message，缺省给默认文案", async () => {
    const { fake, driver } = setup();
    const canUseTool = fake.controls.lastOptions()?.canUseTool;
    const resultPromise = canUseTool?.(
      "Bash",
      { command: "rm -rf /" },
      {
        signal: new AbortController().signal,
        toolUseID: "tu2",
      },
    );
    await flush();

    driver.resolvePermission(sessionId, permissionId, {
      outcome: "deny",
      feedback: "改用安全命令",
    });
    await expect(resultPromise).resolves.toEqual({
      behavior: "deny",
      message: "改用安全命令",
      toolUseID: "tu2",
    });
  });
});

describe("interrupt 与 kill", () => {
  test("interrupt 后 aborted 合成 cancelled", async () => {
    const { events, fake, driver } = setup();
    driver.interrupt(sessionId);
    expect(fake.controls.interruptCount()).toBe(1);

    fake.controls.push({
      type: "assistant",
      message: { role: "assistant", content: [] },
      parent_tool_use_id: null,
      uuid: "a5",
      session_id: "qs",
      aborted: true,
    });
    await flush();

    expect(events.find((event) => event.type === "turn.completed")).toEqual({
      type: "turn.completed",
      sessionId,
      turnId: firstTurnId,
      stopReason: "cancelled",
      finalReply: null,
    });
  });

  test("terminate 等到底层流关闭且不伪造 turn failure", async () => {
    const { events, diagnostics, fake, driver } = setup();
    const termination = driver.terminate(sessionId);
    expect(fake.controls.lastOptions()?.abortController?.signal.aborted).toBe(
      true,
    );

    fake.controls.end();
    await termination;
    expect(
      events.find((event) => event.type === "turn.completed"),
    ).toBeUndefined();
    expect(
      diagnostics
        .filter((input) => input.kind === "lifecycle")
        .map((input) => input.reason),
    ).toEqual(["initialized", "closed"]);
    expect(diagnostics.filter((input) => input.kind !== "lifecycle")).toEqual(
      [],
    );
  });

  test("terminate 导致的底层流抛错不伪装成 stream failure", async () => {
    const { diagnostics, fake, driver } = setup();
    const termination = driver.terminate(sessionId);
    fake.controls.fail(new Error("stream rejected during termination"));
    await termination;

    expect(diagnostics.filter((input) => input.kind !== "lifecycle")).toEqual(
      [],
    );
    expect(
      diagnostics
        .filter((input) => input.kind === "lifecycle")
        .map((input) => input.reason),
    ).toEqual(["initialized", "closed"]);
  });
});
