import {
  isCommandOutcomeUnknown,
  type CommandOutcomeUnknown,
} from "@reins/client";
import type { MachineError, StopReason } from "@reins/protocol";
import { machineErrorSchema, makeErrorCause } from "@reins/protocol";
import * as v from "valibot";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_CANCELLED = 2;
export const EXIT_KILLED = 3;
export const EXIT_TIMEOUT = 4;
export const EXIT_USAGE = 64;
export const EXIT_RESOURCE = 65;

export function machineError(error: MachineError): MachineError {
  return error;
}

export function isMachineError(value: unknown): value is MachineError {
  return (
    typeof value === "object" &&
    value !== null &&
    v.safeParse(machineErrorSchema, value).success
  );
}

export type UsageIssue =
  | {
      readonly issue: "missing_argument";
      readonly target: "argument" | "option";
      readonly field: string;
      readonly valid?: readonly string[];
      readonly hint?: string;
    }
  | {
      readonly issue: "unknown_command";
      readonly value?: string;
      readonly valid: readonly string[];
      readonly didYouMean?: string;
    }
  | {
      readonly issue: "unknown_option";
      readonly value?: string;
      readonly valid: readonly string[];
      readonly didYouMean?: string;
    }
  | {
      readonly issue: "invalid_value";
      readonly target?: "argument" | "option";
      readonly field?: string;
      readonly value?: string;
      readonly valid?: readonly string[];
      readonly hint?: string;
      readonly detail?: string;
    }
  | {
      readonly issue: "invalid_combination";
      readonly field?: string;
      readonly hint?: string;
    };

export type UsageIssues = readonly [UsageIssue, ...UsageIssue[]];

export type UsageError = {
  readonly code: "usage_error";
  readonly issues: UsageIssues;
};

export type InputError = {
  readonly code: "input_error";
  readonly reason: "permission_choice_eof" | "permission_feedback_eof";
};

export type OutputError = {
  readonly code: "output_error";
  readonly reason: "stdout_write_failed";
  readonly systemCode?: string;
};

export type CliError =
  | MachineError
  | Omit<CommandOutcomeUnknown, "commandId" | "daemonGeneration">
  | UsageError
  | InputError
  | OutputError;

export function outputError(systemCode?: string): OutputError {
  return {
    code: "output_error",
    reason: "stdout_write_failed",
    ...(systemCode === undefined ? {} : { systemCode }),
  };
}

export function inputError(reason: InputError["reason"]): InputError {
  return { code: "input_error", reason };
}

export function isInputError(value: unknown): value is InputError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { code?: unknown; reason?: unknown };
  return (
    candidate.code === "input_error" &&
    (candidate.reason === "permission_choice_eof" ||
      candidate.reason === "permission_feedback_eof")
  );
}

export function isOutputError(value: unknown): value is OutputError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    code?: unknown;
    reason?: unknown;
    systemCode?: unknown;
  };
  return (
    candidate.code === "output_error" &&
    candidate.reason === "stdout_write_failed" &&
    (candidate.systemCode === undefined ||
      typeof candidate.systemCode === "string")
  );
}

export function usageError(issue: UsageIssue): UsageError {
  return { code: "usage_error", issues: [issue] };
}

export function usageErrors(issues: UsageIssues): UsageError {
  return { code: "usage_error", issues };
}

export function isUsageError(value: unknown): value is UsageError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { code?: unknown }).code === "usage_error"
  );
}

export function toCliError(error: unknown): CliError {
  if (isCommandOutcomeUnknown(error))
    return {
      code: error.code,
      cause: error.cause,
      method: error.method,
      retryToken: error.retryToken,
      ...(error.targets === undefined ? {} : { targets: error.targets }),
    };
  if (isUsageError(error)) return error;
  if (isMachineError(error)) return error;
  if (isInputError(error)) return error;
  if (isOutputError(error)) return error;
  if (error instanceof Error) {
    try {
      const parsed = JSON.parse(error.message) as unknown;
      if (isCommandOutcomeUnknown(parsed)) return toCliError(parsed);
      if (isMachineError(parsed)) return parsed;
    } catch {
      // 非 JSON 错误体，按内部错误包装
    }
    return machineError({
      code: "internal_error",
      cause: makeErrorCause("exception", error.message),
    });
  }
  return machineError({
    code: "internal_error",
    cause: makeErrorCause("exception", String(error)),
  });
}

export function exitCodeForError(error: CliError): number {
  switch (error.code) {
    case "usage_error":
    case "invalid_params":
    case "protocol_error":
    case "protocol_version_mismatch":
    case "consumer_context_required":
    case "method_not_found":
    case "unknown_harness":
      return EXIT_USAGE;
    case "command_outcome_unknown":
    case "command_id_conflict":
    case "stale_command_id":
    case "output_error":
    case "input_error":
    case "session_not_found":
    case "session_killed":
    case "session_terminating":
    case "daemon_shutting_down":
    case "permission_not_pending":
    case "permission_resolution_mismatch":
    case "diagnostic_not_found":
    case "session_name_conflict":
    case "unsupported_feature":
    case "daemon_timeout":
    case "invalid_daemon_response":
    case "daemon_start_failed":
    case "daemon_disconnected":
    case "diagnostics_unavailable":
    case "capability_query_failed":
    case "internal_error":
    case "diagnostics_store_corrupt":
      return EXIT_RESOURCE;
  }
  return assertNever(error);
}

// oxlint-disable-next-line typescript/consistent-return -- StopReason 是闭集；新增成员必须触发编译期穷尽检查。
export function exitCodeForStopReason(reason: StopReason): number {
  switch (reason) {
    case "end_turn":
      return EXIT_OK;
    case "failed":
      return EXIT_FAILED;
    case "cancelled":
      return EXIT_CANCELLED;
    case "killed":
      return EXIT_KILLED;
  }
}

export class ExitError extends Error {
  readonly code: number;

  constructor(code: number, message?: string) {
    super(message ?? `exit ${code}`);
    this.code = code;
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled CLI error: ${String(value)}`);
}
