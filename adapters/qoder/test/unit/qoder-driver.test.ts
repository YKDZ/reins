import type { SDKMessage } from "@qodercn-ai/qodercn-agent-sdk";
import type {
  DomainEvent,
  PermissionId,
  SessionId,
  SessionName,
  TurnId,
} from "@reins/protocol";
import { describe, expect, test } from "vitest";

import { createQoderDriver } from "#/qoder-driver";
import type { TranscriptSink } from "#/transcript";

import { createFakeSdk } from "../helpers/fake-sdk.ts";

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};
const sessionId = "reviewer@g1" as SessionId;
const firstTurnId = "t1" as TurnId;
const permissionId = "p1" as PermissionId;
const sessionName = "reviewer" as SessionName;

function setup(authorizationMode: "interactive" | "allowAll" = "interactive"): {
  events: DomainEvent[];
  transcript: Array<[string, unknown]>;
  fake: ReturnType<typeof createFakeSdk>;
  driver: ReturnType<ReturnType<typeof createQoderDriver>>;
} {
  const fake = createFakeSdk();
  const transcript: Array<[string, unknown]> = [];
  const sink: TranscriptSink = (kind, payload) =>
    transcript.push([kind, payload]);
  const factory = createQoderDriver({ sdk: fake.sdk, transcript: sink });
  const events: DomainEvent[] = [];
  const driver = factory((event) => events.push(event));
  driver.start({
    sessionId,
    turnId: firstTurnId,
    sessionName,
    harness: "qoder",
    message: "检查",
    cwd: "/tmp/demo",
    authorizationMode,
  });
  return { events, transcript, fake, driver };
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

const assistantText = (uuid: string, text: string): SDKMessage => ({
  type: "assistant",
  message: {
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
    fake.controls.push(textDelta("a1", "分析"));
    fake.controls.push(textDelta("a1", "完成"));
    fake.controls.push(assistantText("a1", "分析完成"));
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

  test("thinking 块进调试转录，不进 message 内容", async () => {
    const { events, fake, transcript } = setup();
    fake.controls.push(assistantThinking("a4"));
    await flush();

    expect(events.filter((event) => event.type === "message")).toEqual([]);
    expect(transcript.some(([kind]) => kind === "thinking")).toBe(true);
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

  test("assistant.isApiErrorMessage 合成 turn.completed(failed)", async () => {
    const { events, fake } = setup();
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
  });
});

describe("授权模式映射", () => {
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

  test("terminate 中止底层会话；流结束后进行中回合兜底 failed", async () => {
    const { events, fake, driver } = setup();
    driver.terminate(sessionId);
    expect(fake.controls.lastOptions()?.abortController?.signal.aborted).toBe(
      true,
    );

    fake.controls.end();
    await flush();
    expect(events.find((event) => event.type === "turn.completed")).toEqual({
      type: "turn.completed",
      sessionId,
      turnId: firstTurnId,
      stopReason: "failed",
      finalReply: null,
    });
  });
});
