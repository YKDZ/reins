import type { MachineError } from "@reins/protocol";
import { machineErrorSchema, makeErrorCause } from "@reins/protocol";
import {
  workspaceErrorSchema,
  type WorkspaceError,
} from "@reins/workspace-protocol";
import * as v from "valibot";

export function isWorkspaceError(value: unknown): value is WorkspaceError {
  return v.safeParse(workspaceErrorSchema, value).success;
}

export const EXIT_OK = 0;
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

export type OutputError = {
  readonly code: "output_error";
  readonly reason: "stdout_write_failed";
  readonly systemCode?: string;
};

export type CliError = MachineError | WorkspaceError | UsageError | OutputError;

export function outputError(systemCode?: string): OutputError {
  return {
    code: "output_error",
    reason: "stdout_write_failed",
    ...(systemCode === undefined ? {} : { systemCode }),
  };
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
  if (isUsageError(error)) return error;
  if (isWorkspaceError(error)) return error;
  if (isMachineError(error)) return error;
  if (isOutputError(error)) return error;
  if (error instanceof Error) {
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
  if (isWorkspaceError(error))
    return error.code === "consumer_context_required" ||
      error.code === "protocol_version_mismatch"
      ? EXIT_USAGE
      : EXIT_RESOURCE;
  switch (error.code) {
    case "usage_error":
    case "invalid_params":
    case "protocol_error":
    case "protocol_version_mismatch":
    case "consumer_context_required":
    case "method_not_found":
    case "unknown_harness":
      return EXIT_USAGE;
    case "command_id_conflict":
    case "stale_command_id":
    case "output_error":
    case "session_not_found":
    case "session_busy":
    case "turn_not_active":
    case "session_killed":
    case "session_terminating":
    case "daemon_shutting_down":
    case "workspace_detaching":
    case "permission_not_pending":
    case "permission_resolution_mismatch":
    case "diagnostic_not_found":
    case "session_name_conflict":
    case "unsupported_feature":
    case "daemon_timeout":
    case "invalid_daemon_response":
    case "daemon_start_failed":
    case "daemon_disconnected":
    case "event_cursor_expired":
    case "diagnostics_unavailable":
    case "capability_query_failed":
    case "internal_error":
    case "diagnostics_store_corrupt":
      return EXIT_RESOURCE;
  }
  return assertNever(error);
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
