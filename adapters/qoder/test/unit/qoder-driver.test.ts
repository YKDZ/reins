import type { SDKMessage } from "@qodercn-ai/qodercn-agent-sdk";
import type { DiagnosticSink } from "@reins/adapter-kit";
import type {
  DriverDiagnosticFact,
  DomainEvent,
  MessageId,
  PermissionId,
  SessionId,
  TurnId,
} from "@reins/protocol";
import { describe, expect, test } from "vitest";

import { createQoderDriver } from "#/qoder-driver";

import { createFakeSdk } from "../helpers/fake-sdk.ts";

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};
const sessionId =
  "session:00000000-0000-4000-8000-000000000000:reviewer:1" as SessionId;
const firstTurnId = "t1" as TurnId;
const secondTurnId = "t2" as TurnId;
const permissionId = "p1" as PermissionId;

async function setup(
  authorizationMode: "interactive" | "allowAll" | "omitted" = "interactive",
  close?: () => Promise<void>,
  behavior: { autoQueueAcceptance?: boolean } = {},
  messageId?: MessageId,
): Promise<{
  events: DomainEvent[];
  diagnostics: DriverDiagnosticFact[];
  unavailableSessionIds: SessionId[];
  fake: ReturnType<typeof createFakeSdk>;
  driver: ReturnType<ReturnType<typeof createQoderDriver>>;
}> {
  const fake = createFakeSdk({
    ...behavior,
    ...(close === undefined ? {} : { close }),
  });
  const diagnostics: DriverDiagnosticFact[] = [];
  const unavailableSessionIds: SessionId[] = [];
  const sink: DiagnosticSink = async (input) => {
    diagnostics.push(input);
    return undefined;
  };
  const factory = createQoderDriver({ sdk: fake.sdk });
  const events: DomainEvent[] = [];
  const driver = factory({
    emit: (event) => events.push(event),
    markControlUnavailable: () => unavailableSessionIds.push(sessionId),
    diagnostics: sink,
  });
  await driver.start({
    sessionId,
    turnId: firstTurnId,
    harness: "qoder",
    message: "检查",
    cwd: "/tmp/demo",
    ...(messageId === undefined ? {} : { messageId }),
    ...(authorizationMode === "omitted" ? {} : { authorizationMode }),
  });
  return { events, diagnostics, unavailableSessionIds, fake, driver };
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
    content: [
      {
        type: "thinking",
        thinking: "思考中",
        signature: "原生公开签名",
      },
    ],
  },
  parent_tool_use_id: null,
  uuid,
  session_id: "qs",
});

describe("qoder driver 事件映射", () => {
  test("caller 正文按受理 UUID 关联并保留原生结构化内容", async () => {
    const messageId = "m-core-first" as MessageId;
    const { events, fake, driver } = await setup(
      "interactive",
      undefined,
      {},
      messageId,
    );
    const submitted = fake.controls.delivered()[0];
    if (submitted?.uuid === undefined)
      throw new Error("Qoder did not retain the accepted input UUID");
    fake.controls.push({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "检查",
            citations: [{ source: "native", offset: 2 }],
          },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AAEC" },
          },
          {
            type: "audio",
            source: { type: "url", url: "https://example.test/audio.wav" },
          },
          { type: "thinking", thinking: "公开消息正文" },
          { type: "custom_annotation", value: { label: "visible" } },
        ],
      },
      parent_tool_use_id: null,
      uuid: submitted.uuid,
      session_id: "qs",
    });
    await flush();

    expect(events.filter((event) => event.type === "message")).toEqual([
      {
        type: "message",
        sessionId,
        turnId: firstTurnId,
        messageId,
        role: "caller",
        content: [
          {
            type: "text",
            text: "检查",
            annotations: [{ source: "native", offset: 2 }],
          },
          {
            type: "image",
            source: "bytes",
            data: "AAEC",
            mediaType: "image/png",
          },
          {
            type: "audio",
            source: "url",
            url: "https://example.test/audio.wav",
          },
          { type: "thinking", text: "公开消息正文" },
          {
            type: "opaque",
            harness: "qoder",
            nativeType: "custom_annotation",
            value: { type: "custom_annotation", value: { label: "visible" } },
          },
        ],
      },
    ]);
    await driver.terminate(sessionId);
  });

  test("先启动reader并等待官方初始化后才提交首条输入", async () => {
    let resolveInitialization!: () => void;
    const initialization = new Promise<void>((resolve) => {
      resolveInitialization = resolve;
    });
    const fake = createFakeSdk({
      initializationResult: () => initialization,
    });
    const driver = createQoderDriver({ sdk: fake.sdk })({
      emit: () => {},
      diagnostics: async () => undefined,
    });
    const started = driver.start({
      sessionId,
      turnId: firstTurnId,
      harness: "qoder",
      message: "初始化完成后提交",
      cwd: "/tmp/demo",
    });
    await flush();

    expect(fake.controls.delivered()).toEqual([]);
    resolveInitialization();
    await started;
    expect(fake.controls.delivered()).toHaveLength(1);
    await driver.terminate(sessionId);
  });

  test("官方初始化失败时首条输入没有派发且接受为未发生", async () => {
    const fake = createFakeSdk({
      initializationResult: async () => {
        throw new Error("unsupported CLI protocol");
      },
    });
    const driver = createQoderDriver({ sdk: fake.sdk })({
      emit: () => {},
      diagnostics: async () => undefined,
    });
    const started = driver.start({
      sessionId,
      turnId: firstTurnId,
      harness: "qoder",
      message: "不得派发",
      cwd: "/tmp/demo",
    });

    await expect(started).rejects.toMatchObject({
      acceptance: "not_accepted",
    });
    expect(fake.controls.delivered()).toEqual([]);
    await driver.terminate(sessionId);
  });

  test("新回合等待与输入 UUID 精确匹配的 command_lifecycle queued", async () => {
    const { fake, driver } = await setup("interactive", undefined, {
      autoQueueAcceptance: false,
    });
    const initial = fake.controls.delivered()[0];
    if (initial?.uuid === undefined)
      throw new Error("Qoder did not receive the initial input UUID");
    fake.controls.finish(initial.uuid);
    await flush();
    const delivery = driver.deliver(
      sessionId,
      secondTurnId,
      "等原生入队回执",
      "new_turn",
    );
    await flush();
    const input = fake.controls.delivered().at(-1);
    expect(input?.message.content).toBe("等原生入队回执");
    const commandUuid = input?.uuid;
    expect(commandUuid).toBeDefined();
    if (commandUuid === undefined) throw new Error("Expected command UUID");

    let accepted = false;
    void delivery.then(() => {
      accepted = true;
    });
    fake.controls.acknowledge(initial.uuid, "completed");
    await flush();
    expect(accepted).toBe(false);

    fake.controls.acknowledge(commandUuid);
    await expect(delivery).resolves.toBeUndefined();
    expect(accepted).toBe(true);
    await driver.terminate(sessionId);
  });

  test("文本流与回合结束：text.delta、message、turn.completed", async () => {
    const { events, fake } = await setup();
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
    const { events, fake } = await setup();
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
      { type: "text.delta", messageId: "w1" },
      { type: "text.delta", messageId: "w1" },
      { type: "message", messageId: "w1" },
      { type: "message", messageId: "w2" },
    ]);
    expect(
      events.find(
        (event) => event.type === "message" && event.messageId === "w2",
      ),
    ).toMatchObject({
      content: [
        { type: "tool_call", toolCallId: "c1" },
        { type: "tool_call", toolCallId: "c2" },
      ],
    });
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
        input: {},
      },
      {
        type: "tool.requested",
        sessionId,
        turnId: firstTurnId,
        toolCallId: "c2",
        name: "Read",
        input: {},
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
    const { events, fake } = await setup();
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
        input: { command: "ls" },
      },
      {
        type: "tool.requested",
        sessionId,
        turnId: firstTurnId,
        toolCallId: "c2",
        name: "Read",
        input: {},
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
    const { events, fake } = await setup();
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
    const { events, fake } = await setup();
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
    const { events, fake } = await setup();
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
        messageId: "w1",
        delta: "可关联",
      },
    ]);
  });

  test("同一原生消息的渐进完整 snapshot 在 idle 前只发布最新文本", async () => {
    const { events, fake } = await setup();
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
        messageId: "w1",
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
    const { events, fake } = await setup();
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
        messageId: "w1",
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

  test("content_block_stop 后的渐进 snapshot 在终态发布最新文本", async () => {
    const { events, fake } = await setup();
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
        messageId: "w1",
        role: "worker",
        content: "AB",
      },
      {
        type: "turn.completed",
        sessionId,
        turnId: firstTurnId,
        stopReason: "end_turn",
        finalReply: "AB",
        usage: { input_tokens: 0, output_tokens: 7 },
      },
    ]);
  });

  test("content_block_stop 后由 message_stop 发布完整 snapshot", async () => {
    const { events, fake } = await setup();
    fake.controls.push(assistantText("outer-a", "A", "native-boundary"));
    fake.controls.push({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
      parent_tool_use_id: null,
      uuid: "block-stop",
      session_id: "qs",
    });
    fake.controls.push({
      type: "stream_event",
      event: { type: "message_stop" },
      parent_tool_use_id: null,
      uuid: "message-stop",
      session_id: "qs",
    });
    await flush();

    expect(events.filter((event) => event.type === "message")).toEqual([
      {
        type: "message",
        sessionId,
        turnId: firstTurnId,
        messageId: "w1",
        role: "worker",
        content: "A",
      },
    ]);
  });

  test("message_stop 后保持已发布的完整快照", async () => {
    const { events, fake } = await setup();
    fake.controls.push(assistantText("outer-a", "A", "native-flushed"));
    fake.controls.push({
      type: "stream_event",
      event: { type: "message_stop" },
      parent_tool_use_id: null,
      uuid: "message-stop",
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
        messageId: "w1",
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

  test("message_stop 后丢弃迟到文本但保留 end_turn usage", async () => {
    const { events, fake } = await setup();
    fake.controls.push(messageStart("start-a", "native-a"));
    fake.controls.push(textDelta("delta-a", "A"));
    fake.controls.push(assistantText("snapshot-a", "A", "native-a"));
    fake.controls.push({
      type: "stream_event",
      event: { type: "message_stop" },
      parent_tool_use_id: null,
      uuid: "message-stop-a",
      session_id: "qs",
    });
    fake.controls.push(textDelta("late-delta", "X"));
    fake.controls.push({
      type: "stream_event",
      event: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 13, output_tokens: 21 },
      },
      parent_tool_use_id: null,
      uuid: "end-turn-a",
      session_id: "qs",
    });
    await flush();

    expect(
      events.filter(
        (event) =>
          event.type === "text.delta" ||
          event.type === "message" ||
          event.type === "turn.completed",
      ),
    ).toEqual([
      {
        type: "text.delta",
        sessionId,
        turnId: firstTurnId,
        messageId: "w1",
        delta: "A",
      },
      {
        type: "message",
        sessionId,
        turnId: firstTurnId,
        messageId: "w1",
        role: "worker",
        content: "A",
      },
      {
        type: "turn.completed",
        sessionId,
        turnId: firstTurnId,
        stopReason: "end_turn",
        finalReply: "A",
        usage: { input_tokens: 13, output_tokens: 21 },
      },
    ]);
  });

  test("同一回合的多个原生 assistant 消息按边界顺序发布", async () => {
    const { events, fake } = await setup();
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
        messageId: "w1",
        role: "worker",
        content: "first",
      },
      {
        type: "message",
        sessionId,
        turnId: firstTurnId,
        messageId: "w2",
        role: "worker",
        content: "second",
      },
    ]);
  });

  test("active_turn 只在旧 root 已取消后发送新 UUID", async () => {
    const { events, fake, driver } = await setup();
    fake.controls.push(assistantToolUseBlock("request-t1", "tc-active"));
    await flush();

    const initial = fake.controls.delivered()[0];
    if (initial?.uuid === undefined)
      throw new Error("Qoder did not receive the initial input UUID");
    fake.controls.acknowledge(initial.uuid, "started");
    const delivery = driver.deliver(
      sessionId,
      firstTurnId,
      "补充消息",
      "active_turn",
    );
    await flush();
    expect(fake.controls.interruptCount()).toBe(1);
    expect(fake.controls.delivered()).toHaveLength(1);
    fake.controls.pushRaw({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      uuid: "cancelled-root-result",
      session_id: "qoder-session",
    } as unknown as SDKMessage);
    fake.controls.acknowledge(initial.uuid, "cancelled");
    await delivery;

    expect(
      events.filter((event) => event.type === "tool.requested"),
    ).toMatchObject([
      {
        type: "tool.requested",
        sessionId,
        turnId: firstTurnId,
        toolCallId: "c1",
        name: "Bash",
        input: { command: "ls" },
      },
    ]);
    expect(events.filter((event) => event.type === "turn.completed")).toEqual(
      [],
    );
    expect(fake.controls.delivered()).toHaveLength(2);
    expect(fake.controls.delivered()[1]?.uuid).not.toBe(initial.uuid);
  });

  test("自然完成赢过 active_turn 竞争时不发送迟到纠偏", async () => {
    const { events, fake, driver } = await setup();
    fake.controls.push(
      assistantText("snapshot-t1", "pending", "native-active"),
    );
    await flush();

    const delivery = driver.deliver(
      sessionId,
      firstTurnId,
      "迟到纠偏",
      "active_turn",
    );
    await flush();
    fake.controls.push(idle());
    await expect(delivery).rejects.toMatchObject({
      code: "turn_not_active",
      turnId: firstTurnId,
    });

    expect(
      events.filter(
        (event) => event.type === "message" || event.type === "turn.completed",
      ),
    ).toEqual([
      {
        type: "message",
        sessionId,
        turnId: firstTurnId,
        messageId: "w1",
        role: "worker",
        content: "pending",
      },
      {
        type: "turn.completed",
        sessionId,
        turnId: firstTurnId,
        stopReason: "end_turn",
        finalReply: "pending",
        usage: { input_tokens: 12, output_tokens: 34 },
      },
    ]);
    expect(fake.controls.delivered()).toHaveLength(1);
  });

  test("新回合丢弃迟到工具结果并允许复用原生 tool id", async () => {
    const { events, fake, driver } = await setup();
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

    await driver.deliver(sessionId, secondTurnId, "继续", "new_turn");
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
        input: { command: "ls" },
      },
      {
        type: "tool.requested",
        sessionId,
        turnId: secondTurnId,
        toolCallId: "c1",
        name: "Bash",
        input: { command: "ls" },
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
    const { events, fake, driver } = await setup();
    fake.controls.push(messageStart("start-t1", "native-shared"));
    fake.controls.push(textDelta("delta-t1", "one"));
    fake.controls.push(assistantText("snapshot-t1", "one", "native-shared"));
    fake.controls.push(idle());
    await flush();

    await driver.deliver(sessionId, secondTurnId, "继续", "new_turn");
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
        messageId: "w1",
        delta: "two",
      },
      {
        type: "message",
        sessionId,
        turnId: secondTurnId,
        messageId: "w1",
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
    const { events, fake } = await setup();
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
    const { events, fake } = await setup();
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
    const { events, fake } = await setup();
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
    const { events, fake } = await setup();
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
    const { events, fake } = await setup();
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

  test("thinking 正文保留在消息事实且不生成诊断", async () => {
    const { events, fake, diagnostics } = await setup();
    fake.controls.push(assistantThinking("a4"));
    fake.controls.push({
      type: "stream_event",
      event: { type: "message_stop" },
      parent_tool_use_id: null,
      uuid: "thinking-stop",
      session_id: "qs",
    });
    await flush();

    expect(events.filter((event) => event.type === "message")).toMatchObject([
      {
        type: "message",
        role: "worker",
        content: [
          {
            type: "thinking",
            text: "思考中",
            signature: "原生公开签名",
          },
        ],
      },
    ]);
    expect(diagnostics.filter((input) => input.kind !== "lifecycle")).toEqual(
      [],
    );
  });

  test("Agent 子任务以精确 tool_use 归属并在回合结束后保留完成事实", async () => {
    const { events, fake } = await setup();
    fake.controls.push({
      type: "assistant",
      message: {
        id: "agent-message",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "agent-tool-use",
            name: "Agent",
            input: { description: "只读检查", prompt: "列出文件" },
          },
        ],
        stop_reason: "tool_use",
      },
      parent_tool_use_id: null,
      uuid: "agent-message",
      session_id: "qs",
    });
    fake.controls.push({
      type: "system",
      subtype: "task_started",
      task_id: "qoder-task-1",
      tool_use_id: "agent-tool-use",
      description: "只读检查",
      uuid: "task-started",
      session_id: "qs",
    });
    await flush();

    expect(
      events.filter((event) => event.type === "background.activity"),
    ).toEqual([
      {
        type: "background.activity",
        sessionId,
        source: { kind: "qoder_task", id: "qoder-task-1" },
        status: "active",
        causedBy: { turnId: firstTurnId, toolCallId: "c1" },
      },
    ]);

    fake.controls.push(assistantEndTurn("agent-reply", "完成"));
    await flush();
    fake.controls.push({
      type: "system",
      subtype: "task_notification",
      task_id: "qoder-task-1",
      tool_use_id: "agent-tool-use",
      status: "completed",
      output_file: "/tmp/qoder-output",
      summary: "已完成",
      uuid: "task-completed",
      session_id: "qs",
    });
    await flush();

    expect(
      events.filter((event) => event.type === "background.activity"),
    ).toEqual([
      {
        type: "background.activity",
        sessionId,
        source: { kind: "qoder_task", id: "qoder-task-1" },
        status: "active",
        causedBy: { turnId: firstTurnId, toolCallId: "c1" },
      },
      {
        type: "background.activity",
        sessionId,
        source: { kind: "qoder_task", id: "qoder-task-1" },
        status: "completed",
        causedBy: { turnId: firstTurnId, toolCallId: "c1" },
      },
    ]);
    expect(
      events.filter((event) => event.type === "turn.completed"),
    ).toMatchObject([{ turnId: firstTurnId, stopReason: "end_turn" }]);
  });

  test("未绑定旧 phase 的 task_start 不会绑定到后续回合", async () => {
    const { events, fake, driver } = await setup();
    fake.controls.push({
      type: "system",
      subtype: "task_started",
      task_id: "late-qoder-task",
      tool_use_id: "reused-tool-use",
      description: "旧 phase 的子任务",
      uuid: "late-task-started",
      session_id: "qs",
    });
    await flush();
    expect(
      events.filter((event) => event.type === "background.activity"),
    ).toEqual([
      {
        type: "background.activity",
        sessionId,
        source: { kind: "qoder_task", id: "late-qoder-task" },
        status: "active",
      },
    ]);

    fake.controls.push(assistantEndTurn("first-completed", "第一回合完成"));
    await flush();
    await driver.deliver(sessionId, secondTurnId, "下一回合", "new_turn");
    fake.controls.push({
      type: "assistant",
      message: {
        id: "second-agent-message",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "reused-tool-use",
            name: "Agent",
            input: { description: "新回合", prompt: "列出文件" },
          },
        ],
        stop_reason: "tool_use",
      },
      parent_tool_use_id: null,
      uuid: "second-agent-message",
      session_id: "qs",
    });
    await flush();

    fake.controls.push({
      type: "system",
      subtype: "task_notification",
      task_id: "late-qoder-task",
      tool_use_id: "reused-tool-use",
      status: "completed",
      output_file: "/tmp/qoder-old-task-output",
      summary: "旧 phase 的任务完成",
      uuid: "late-task-completed",
      session_id: "qs",
    });
    await flush();

    expect(
      events.filter((event) => event.type === "background.activity"),
    ).toEqual([
      {
        type: "background.activity",
        sessionId,
        source: { kind: "qoder_task", id: "late-qoder-task" },
        status: "active",
      },
      {
        type: "background.activity",
        sessionId,
        source: { kind: "qoder_task", id: "late-qoder-task" },
        status: "completed",
      },
    ]);
    await driver.terminate(sessionId);
  });

  test("工具生命周期：tool.requested 与 tool.completed(isError)", async () => {
    const { events, fake } = await setup();
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
        id: "a3",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tc1",
            name: "Bash",
            input: { command: "printf body", options: ["--raw"] },
          },
          {
            type: "tool_result",
            tool_use_id: "tc1",
            content: [{ type: "text", text: "完整返回正文" }],
            is_error: true,
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
        input: { command: "printf body", options: ["--raw"] },
      },
      {
        type: "tool.completed",
        sessionId,
        turnId: firstTurnId,
        toolCallId: "c1",
        name: "Bash",
        result: [{ type: "text", text: "完整返回正文" }],
        isError: true,
      },
    ]);
  });

  test("原生中断标记的消息正文保留截断事实", async () => {
    const { events, fake } = await setup();
    fake.controls.push({
      type: "assistant",
      message: {
        id: "partial-message",
        role: "assistant",
        content: [{ type: "text", text: "响应在字词中" }],
      },
      parent_tool_use_id: null,
      uuid: "partial-message",
      session_id: "qs",
      aborted: true,
    });
    await flush();

    expect(events.filter((event) => event.type === "message")).toEqual([
      {
        type: "message",
        sessionId,
        turnId: firstTurnId,
        messageId: "w1",
        role: "worker",
        content: "响应在字词中",
        nativeTruncated: true,
      },
    ]);
  });

  test("worker reported failure 合成终态并记录类型化 turn_failure", async () => {
    const { events, fake, diagnostics } = await setup();
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
      failure: { failureCategory: "unclassified", retryDisposition: "unknown" },
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

  test("API 失败消息在失败终态前仍保留原生公开正文", async () => {
    const { events, fake } = await setup();
    fake.controls.push({
      type: "assistant",
      message: {
        id: "native-api-error",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "公开的思考正文" },
          { type: "text", text: "请求失败" },
        ],
      },
      parent_tool_use_id: null,
      uuid: "api-error",
      session_id: "qs",
      isApiErrorMessage: true,
      error: "invalid_request",
    });
    await flush();

    expect(events.filter((event) => event.type === "message")).toMatchObject([
      {
        type: "message",
        role: "worker",
        content: [
          { type: "thinking", text: "公开的思考正文" },
          { type: "text", text: "请求失败" },
        ],
      },
    ]);
    expect(
      events.find((event) => event.type === "turn.completed"),
    ).toMatchObject({
      stopReason: "failed",
      failure: {
        failureCategory: "request_rejected",
        retryDisposition: "input_change",
      },
    });
  });

  test("busy 与 idle 的 clean EOF 只标记控制不可用，不补造失败终态", async () => {
    const busy = await setup();
    busy.fake.controls.end();
    await flush();
    expect(busy.unavailableSessionIds).toEqual([sessionId]);
    expect(
      busy.events.filter(
        (event) =>
          event.type === "turn.completed" && event.stopReason === "failed",
      ),
    ).toEqual([]);
    expect(
      busy.diagnostics.filter(
        (input) =>
          input.kind === "lifecycle" && input.reason === "exited_unexpectedly",
      ),
    ).toHaveLength(1);

    const idleWorker = await setup();
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
    expect(idleWorker.unavailableSessionIds).toEqual([sessionId]);
    expect(
      idleWorker.events.filter((event) => event.type === "turn.completed"),
    ).toMatchObject([{ turnId: firstTurnId, stopReason: "end_turn" }]);
  });

  test("read_error 不补造回合失败且保留控制不可用事实", async () => {
    const worker = await setup();
    worker.fake.controls.fail(new Error("Qoder stdout disconnected"));
    await flush();

    expect(worker.unavailableSessionIds).toEqual([sessionId]);
    expect(
      worker.events.filter((event) => event.type === "turn.completed"),
    ).toEqual([]);
    expect(worker.diagnostics).toContainEqual(
      expect.objectContaining({
        kind: "stream_failure",
        operation: "receive_worker_stream",
        reason: "read_error",
        sessionId,
        turnId: firstTurnId,
      }),
    );
  });
});

describe("授权模式映射", () => {
  test("未指定时不注入 SDK 权限选项", async () => {
    const { fake } = await setup("omitted");
    const options = fake.controls.lastOptions();
    expect(options?.permissionMode).toBeUndefined();
    expect(options?.allowDangerouslySkipPermissions).toBeUndefined();
    expect(options?.canUseTool).toBeUndefined();
  });

  test("interactive：default + canUseTool 注册", async () => {
    const { fake } = await setup("interactive");
    const options = fake.controls.lastOptions();
    expect(options?.permissionMode).toBe("default");
    expect(options?.canUseTool).toBeTypeOf("function");
    expect(options?.includePartialMessages).toBe(true);
    expect(options?.allowDangerouslySkipPermissions).toBeUndefined();
    expect(options?.persistSession).toBe(false);
    expect(options?.cwd).toBe("/tmp/demo");
  });

  test("allowAll：bypassPermissions + 显式确认，不注册 canUseTool", async () => {
    const { fake } = await setup("allowAll");
    const options = fake.controls.lastOptions();
    expect(options?.permissionMode).toBe("bypassPermissions");
    expect(options?.allowDangerouslySkipPermissions).toBe(true);
    expect(options?.canUseTool).toBeUndefined();
  });
});

describe("permission 桥", () => {
  test("allow session：决议翻译为带会话规则的 PermissionResult", async () => {
    const { events, fake, driver } = await setup();
    const canUseTool = fake.controls.lastOptions()?.canUseTool;
    expect(canUseTool).toBeTypeOf("function");
    fake.controls.pushRaw(assistantToolUseBlock("assistant-tu1", "tu1"));
    await flush();
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
      toolCallId: "c1",
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

  test("deny feedback：原样翻译调用方 message", async () => {
    const { fake, driver } = await setup();
    const canUseTool = fake.controls.lastOptions()?.canUseTool;
    fake.controls.pushRaw(assistantToolUseBlock("assistant-tu2", "tu2"));
    await flush();
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
  test("terminate waits for the first official close promise before reporting closed", async () => {
    let finishClose!: () => void;
    let fakeForClose: ReturnType<typeof createFakeSdk> | undefined;
    let signalWasAbortedWhenCloseStarted: boolean | undefined;
    const closing = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const { diagnostics, fake, driver } = await setup("interactive", () => {
      signalWasAbortedWhenCloseStarted =
        fakeForClose?.controls.lastOptions()?.abortController?.signal.aborted;
      return closing;
    });
    fakeForClose = fake;
    const first = driver.terminate(sessionId);
    const concurrent = driver.terminate(sessionId);

    try {
      await flush();
      expect(fake.controls.interruptCount()).toBe(0);
      expect(fake.controls.closeCount()).toBe(1);
      expect(signalWasAbortedWhenCloseStarted).toBe(false);
      expect(fake.controls.lastOptions()?.abortController?.signal.aborted).toBe(
        true,
      );
      expect(diagnostics.some((input) => input.reason === "closed")).toBe(
        false,
      );

      finishClose();
      await Promise.all([first, concurrent]);
      expect(
        diagnostics.filter((input) => input.reason === "closed"),
      ).toHaveLength(1);
    } finally {
      finishClose();
      fake.controls.end();
      await Promise.allSettled([first, concurrent]);
    }
  });

  test("a rejected official close remains failed on explicit retry", async () => {
    const closeFailure = new Error("official Qoder close failed");
    const { diagnostics, fake, driver } = await setup(
      "interactive",
      async () => {
        throw closeFailure;
      },
    );

    await expect(driver.terminate(sessionId)).rejects.toBe(closeFailure);
    expect(fake.controls.closeCount()).toBe(1);
    expect(diagnostics.some((input) => input.reason === "closed")).toBe(false);

    await expect(driver.terminate(sessionId)).rejects.toBe(closeFailure);
    expect(fake.controls.closeCount()).toBe(1);
    expect(diagnostics.some((input) => input.reason === "closed")).toBe(false);
    fake.controls.end();
  });

  test("过期 TurnId 的 interrupt 在原生派发前拒绝", async () => {
    const { events, fake, driver } = await setup();
    await expect(driver.interrupt(sessionId, secondTurnId)).rejects.toEqual({
      code: "turn_not_active",
      sessionId,
      turnId: secondTurnId,
    });
    expect(fake.controls.interruptCount()).toBe(0);

    expect(events.filter((event) => event.type === "turn.completed")).toEqual(
      [],
    );
  });

  test("terminate 等到底层流关闭且不伪造 turn failure", async () => {
    const { events, diagnostics, fake, driver } = await setup();
    const termination = driver.terminate(sessionId);
    await flush();
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
    const { diagnostics, fake, driver } = await setup();
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

test("adapter refuses unavailable session scope and preserves the caller feedback callback", async () => {
  const { fake, driver } = await setup();
  fake.controls.pushRaw(
    assistantToolUseBlock("assistant-native-tool", "native-tool"),
  );
  await flush();
  const callback = fake.controls.lastOptions()!.canUseTool!;
  const answer = callback(
    "Bash",
    { command: "caller command" },
    { signal: new AbortController().signal, toolUseID: "native-tool" },
  );
  await flush();
  const before = fake.controls.delivered().length;
  expect(() =>
    driver.resolvePermission(sessionId, permissionId, {
      outcome: "allow",
      scope: "session",
    }),
  ).toThrow(
    expect.objectContaining({ code: "permission_resolution_mismatch" }),
  );
  driver.resolvePermission(sessionId, permissionId, {
    outcome: "deny",
    feedback: "  caller feedback\nsecond line  ",
  });
  await expect(answer).resolves.toEqual({
    behavior: "deny",
    message: "  caller feedback\nsecond line  ",
    toolUseID: "native-tool",
  });
  expect(fake.controls.delivered()).toHaveLength(before);
});

test("interrupt ACK 不提前结算，等精确根取消和 error result", async () => {
  const { driver, fake, events } = await setup();
  const initial = fake.controls.delivered()[0];
  if (initial?.uuid === undefined)
    throw new Error("Qoder did not receive the initial input UUID");
  fake.controls.acknowledge(initial.uuid, "started");
  try {
    await driver.interrupt(sessionId, firstTurnId);
    expect(fake.controls.interruptCount()).toBe(1);
    expect(events.filter((event) => event.type === "turn.completed")).toEqual(
      [],
    );
    expect(fake.controls.delivered()).toHaveLength(1);
    fake.controls.pushRaw({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      uuid: "interrupt-root-result",
      session_id: "qoder-session",
    } as unknown as SDKMessage);
    fake.controls.acknowledge(initial.uuid, "cancelled");
    await flush();
    expect(events.filter((event) => event.type === "turn.completed")).toEqual([
      {
        type: "turn.completed",
        sessionId,
        turnId: firstTurnId,
        stopReason: "cancelled",
        finalReply: null,
      },
    ]);
  } finally {
    await driver.terminate(sessionId);
  }
});
