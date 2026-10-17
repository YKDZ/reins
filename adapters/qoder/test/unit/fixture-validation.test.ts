import type { SDKMessage } from "@qodercn-ai/qodercn-agent-sdk";
import { describe, expect, test } from "vitest";

import {
  FixtureValidationError,
  validateRecordedFixture,
} from "../scripts/fixture-validation.ts";

const toolMessages = [
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "tc1", name: "Bash", input: {} },
        { type: "tool_use", id: "tc2", name: "Bash", input: {} },
      ],
    },
    parent_tool_use_id: null,
    uuid: "assistant",
    session_id: "qs",
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tc1", content: "first" },
        { type: "tool_result", tool_use_id: "tc2", content: "second" },
      ],
    },
    parent_tool_use_id: null,
    uuid: "user",
    session_id: "qs",
  },
] as SDKMessage[];

const successResult = {
  type: "result",
  subtype: "success",
  is_error: false,
} as SDKMessage;

const errorResult = {
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
} as SDKMessage;

function expectCode(
  run: () => unknown,
  code: FixtureValidationError["code"],
): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(FixtureValidationError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected fixture validation error: ${code}`);
}

describe("fixture 录制终态验收", () => {
  test("工具与结果齐全但没有 terminal result 时拒绝", () => {
    expectCode(
      () =>
        validateRecordedFixture(toolMessages, {
          timedOut: false,
          minimumNativeToolCount: 2,
        }),
      "missing_terminal_result",
    );
  });

  test("即使观察到 success result，发生过 timeout 仍拒绝", () => {
    expectCode(
      () =>
        validateRecordedFixture([...toolMessages, successResult], {
          timedOut: true,
          minimumNativeToolCount: 2,
        }),
      "recording_timed_out",
    );
  });

  test("error terminal result 拒绝", () => {
    expectCode(
      () =>
        validateRecordedFixture([...toolMessages, errorResult], {
          timedOut: false,
          minimumNativeToolCount: 2,
        }),
      "terminal_result_failed",
    );
  });

  test("已观察到 success result 但它不是最后一条消息时拒绝", () => {
    expectCode(
      () =>
        validateRecordedFixture(
          [...toolMessages, successResult, toolMessages[0]!],
          {
            timedOut: false,
            minimumNativeToolCount: 2,
          },
        ),
      "terminal_result_not_last",
    );
  });

  test("正式 success terminal 与工具配对齐全时返回事实", () => {
    expect(
      validateRecordedFixture([...toolMessages, successResult], {
        timedOut: false,
        minimumNativeToolCount: 2,
      }),
    ).toEqual({
      uniqueNativeToolCount: 2,
      contentResultCount: 2,
    });
  });

  test("同一 native tool 的两个 content results 拒绝", () => {
    const duplicateResult = {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tc1", content: "again" },
        ],
      },
      parent_tool_use_id: null,
      uuid: "duplicate-result",
      session_id: "qs",
    } as SDKMessage;

    expectCode(
      () =>
        validateRecordedFixture(
          [...toolMessages, duplicateResult, successResult],
          { timedOut: false, minimumNativeToolCount: 2 },
        ),
      "duplicate_tool_results",
    );
  });

  test("所有 requests 完成后仍拒绝 unknown content result", () => {
    const orphanResult = {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "unknown", content: "extra" },
        ],
      },
      parent_tool_use_id: null,
      uuid: "orphan-result",
      session_id: "qs",
    } as SDKMessage;

    expectCode(
      () =>
        validateRecordedFixture(
          [...toolMessages, orphanResult, successResult],
          { timedOut: false, minimumNativeToolCount: 2 },
        ),
      "orphan_tool_results",
    );
  });
});
