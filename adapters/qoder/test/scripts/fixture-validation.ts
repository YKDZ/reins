import type { SDKMessage } from "@qodercn-ai/qodercn-agent-sdk";

export type FixtureValidationErrorCode =
  | "recording_timed_out"
  | "missing_terminal_result"
  | "terminal_result_not_last"
  | "terminal_result_failed"
  | "insufficient_tool_requests"
  | "duplicate_tool_results"
  | "orphan_tool_results"
  | "unmatched_tool_results";

export class FixtureValidationError extends Error {
  readonly code: FixtureValidationErrorCode;

  constructor(code: FixtureValidationErrorCode, message: string) {
    super(message);
    this.name = "FixtureValidationError";
    this.code = code;
  }
}

export type FixtureValidationFacts = {
  uniqueNativeToolCount: number;
  contentResultCount: number;
};

export function validateRecordedFixture(
  messages: readonly SDKMessage[],
  options: { timedOut: boolean; minimumNativeToolCount: number },
): FixtureValidationFacts {
  if (options.timedOut) {
    throw new FixtureValidationError(
      "recording_timed_out",
      "Fixture recording timed out before acceptance",
    );
  }
  const terminal = messages.at(-1);
  if (terminal?.type !== "result") {
    const observedResult = messages.some(
      (message) => message.type === "result",
    );
    throw new FixtureValidationError(
      observedResult ? "terminal_result_not_last" : "missing_terminal_result",
      observedResult
        ? "Fixture result was not the final recorded message"
        : "Fixture recording ended without a terminal result",
    );
  }
  if (terminal.subtype !== "success" || terminal.is_error !== false) {
    throw new FixtureValidationError(
      "terminal_result_failed",
      "Fixture recording ended with a failed terminal result",
    );
  }
  const requestIds = new Set<string>();
  const resultCountById = new Map<string, number>();
  for (const message of messages) {
    if (message.type === "stream_event") {
      const event = message.event;
      const block = event.content_block;
      if (
        event.type === "content_block_start" &&
        block?.type === "tool_use" &&
        typeof block.id === "string" &&
        block.id.length > 0
      ) {
        requestIds.add(block.id);
      }
      continue;
    }
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (
          block.type === "tool_use" &&
          typeof block.id === "string" &&
          block.id.length > 0
        ) {
          requestIds.add(block.id);
        }
      }
      continue;
    }
    if (message.type === "user" && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (
          block.type === "tool_result" &&
          typeof block.tool_use_id === "string" &&
          block.tool_use_id.length > 0
        ) {
          resultCountById.set(
            block.tool_use_id,
            (resultCountById.get(block.tool_use_id) ?? 0) + 1,
          );
        }
      }
    }
  }
  if (requestIds.size < options.minimumNativeToolCount) {
    throw new FixtureValidationError(
      "insufficient_tool_requests",
      `Fixture has ${requestIds.size} native tool request(s); expected at least ${options.minimumNativeToolCount}`,
    );
  }
  const duplicateResults = [...resultCountById].filter(
    ([, count]) => count > 1,
  );
  if (duplicateResults.length > 0) {
    throw new FixtureValidationError(
      "duplicate_tool_results",
      `Fixture has ${duplicateResults.length} native tool(s) with duplicate content results`,
    );
  }
  const resultIds = new Set(resultCountById.keys());
  const orphanResults = [...resultIds].filter((id) => !requestIds.has(id));
  if (orphanResults.length > 0) {
    throw new FixtureValidationError(
      "orphan_tool_results",
      `Fixture has ${orphanResults.length} content result(s) without native tool requests`,
    );
  }
  const missingResults = [...requestIds].filter((id) => !resultIds.has(id));
  if (missingResults.length > 0) {
    throw new FixtureValidationError(
      "unmatched_tool_results",
      `Fixture has ${missingResults.length} native tool request(s) without content results`,
    );
  }
  return {
    uniqueNativeToolCount: requestIds.size,
    contentResultCount: resultIds.size,
  };
}
