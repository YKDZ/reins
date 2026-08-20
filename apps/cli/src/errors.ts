import type { MachineError, StopReason } from "@reins/protocol";
import { machineErrorSchema } from "@reins/protocol";
import * as v from "valibot";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_CANCELLED = 2;
export const EXIT_KILLED = 3;
export const EXIT_TIMEOUT = 4;
export const EXIT_USAGE = 64;
export const EXIT_RESOURCE = 65;

export function machineError(
  code: MachineError["code"],
  context?: MachineError["context"],
): MachineError {
  return context === undefined ? { code } : { code, context };
}

export function isMachineError(value: unknown): value is MachineError {
  return (
    typeof value === "object" &&
    value !== null &&
    v.safeParse(machineErrorSchema, value).success
  );
}

export type UsageIssue =
  | "missing_argument"
  | "unknown_command"
  | "unknown_option"
  | "invalid_value";

export type UsageErrorContext = {
  readonly issue: UsageIssue;
  readonly target?: "argument" | "option";
  readonly field?: string;
  readonly value?: string;
  readonly valid?: readonly string[];
  readonly hint?: string;
  readonly detail?: string;
  readonly didYouMean?: string;
};

export type UsageError = {
  readonly code: "usage_error";
  readonly context: UsageErrorContext;
};

export type CliError = MachineError | UsageError;

export function usageError(
  issue: UsageIssue,
  extra: Omit<UsageErrorContext, "issue">,
): UsageError {
  return { code: "usage_error", context: { issue, ...extra } };
}

export function isUsageError(value: unknown): value is UsageError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { code?: unknown }).code === "usage_error"
  );
}

export function toCliError(error: unknown): CliError {
  if (isUsageError(error)) return error;
  if (isMachineError(error)) return error;
  if (error instanceof Error) {
    try {
      const parsed = JSON.parse(error.message) as unknown;
      if (isMachineError(parsed)) return parsed;
    } catch {
      // 非 JSON 错误体，按内部错误包装
    }
    return machineError("internal_error", { message: error.message });
  }
  return machineError("internal_error", { message: String(error) });
}

export function exitCodeForError(error: CliError): number {
  switch (error.code) {
    case "usage_error":
    case "invalid_params":
    case "protocol_error":
    case "method_not_found":
    case "unknown_harness":
      return EXIT_USAGE;
    default:
      return EXIT_RESOURCE;
  }
}

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
