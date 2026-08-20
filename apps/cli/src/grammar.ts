import type { MachineError } from "@reins/protocol";
import type { CommanderError } from "commander";

import {
  commandSpecs,
  flagDisplay,
  valueHint,
  type CommandSpec,
  type ValueKind,
} from "./command-spec.ts";
import type { CliError, UsageError } from "./errors.ts";
import { usageError } from "./errors.ts";

export type RenderedError = {
  readonly message: string;
  readonly suggestion?: string;
};

function rendered(message: string, suggestion?: string): RenderedError {
  return suggestion === undefined ? { message } : { message, suggestion };
}

export function isUsageClassError(error: CliError): boolean {
  if (error.code === "usage_error") return true;
  if (error.code === "unknown_harness") return true;
  if (error.code === "invalid_params") return true;
  return false;
}

export function renderCliError(
  error: CliError,
  spec?: CommandSpec,
): RenderedError {
  if (error.code === "usage_error") return renderUsageError(error, spec);
  if (error.code === "input_error") {
    return {
      message:
        error.reason === "permission_choice_eof"
          ? "Permission input closed before a choice was received"
          : "Permission input closed before feedback was received",
    };
  }
  if (error.code === "unknown_harness") return renderUnknownHarness(error);
  if (error.code === "invalid_params") {
    const rendered = renderInvalidParams(error);
    if (rendered !== null) return rendered;
  }
  return { message: domainMessage(error) };
}

export function jsonErrorMessage(rendered: RenderedError): string {
  if (rendered.suggestion === undefined) return rendered.message;
  const separator = rendered.message.endsWith("?") ? " " : ". ";
  return `${rendered.message}${separator}${rendered.suggestion}`;
}

export function commanderToUsageError(
  error: CommanderError,
  spec?: CommandSpec,
): UsageError {
  const raw = error.message.replace(/^error: /u, "");
  const [firstLine = "", ...rest] = raw.split("\n");
  const didYouMeanLine = rest.find((line) => line.startsWith("(Did you mean"));
  const didYouMeanPhrase = didYouMeanLine
    ?.replace(/^\(|\)$/gu, "")
    .replace(/^Did you mean /u, "")
    .replace(/[?]$/u, "");
  const didYouMean =
    didYouMeanPhrase === undefined
      ? undefined
      : didYouMeanPhrase.startsWith("one of ")
        ? didYouMeanPhrase
        : `'${didYouMeanPhrase}'`;
  const quoted = /'([^']+)'/u.exec(firstLine)?.[1];
  switch (error.code) {
    case "commander.missingArgument":
      return usageError("missing_argument", {
        target: "argument",
        field: quoted ?? firstLine,
      });
    case "commander.missingMandatoryOptionValue":
      return usageError("missing_argument", {
        target: "option",
        field: quoted ?? firstLine,
      });
    case "commander.optionMissingArgument":
      return usageError("missing_argument", {
        target: "option",
        field: quoted ?? firstLine,
      });
    case "commander.unknownCommand":
      return usageError("unknown_command", {
        ...(quoted === undefined ? {} : { value: quoted }),
        valid: commandSpecs.map((candidate) => candidate.name),
        ...(didYouMean === undefined ? {} : { didYouMean }),
      });
    case "commander.unknownOption":
      return usageError("unknown_option", {
        ...(quoted === undefined ? {} : { value: quoted }),
        valid: longFlagsFor(spec),
        ...(didYouMean === undefined ? {} : { didYouMean }),
      });
    case "commander.excessArguments":
      return usageError("invalid_value", {
        field: "arguments",
        detail: firstLine,
        hint: "Remove the extra arguments",
      });
    default:
      return usageError("invalid_value", { detail: firstLine });
  }
}

function renderUsageError(
  error: UsageError,
  spec: CommandSpec | undefined,
): RenderedError {
  const { issue, target, field, value, valid, hint, detail, didYouMean } =
    error;
  switch (issue) {
    case "missing_argument": {
      const message =
        target === "option"
          ? `Missing required option '${field ?? ""}'`
          : `Missing required argument '${field ?? ""}'`;
      return rendered(message, suggestionForMissing(spec, target, field));
    }
    case "unknown_command":
      return rendered(
        `Unknown command '${value ?? ""}'${didYouMean === undefined ? "" : `. Did you mean ${didYouMean}?`}`,
        `Allowed: ${commandSpecs.map((candidate) => candidate.name).join(", ")}`,
      );
    case "unknown_option":
      return rendered(
        `Unknown option '${value ?? ""}'${didYouMean === undefined ? "" : ` Did you mean ${didYouMean}?`}`,
        allowedText(valid),
      );
    case "invalid_value":
      return rendered(
        detail ?? `Invalid value '${value ?? ""}' for '${field ?? ""}'`,
        allowedText(valid) ?? hint,
      );
    case "invalid_combination":
      return rendered(
        `Invalid parameter combination${field === undefined ? "" : `: ${field}`}`,
        hint,
      );
  }
}

function suggestionForMissing(
  spec: CommandSpec | undefined,
  target: "argument" | "option" | undefined,
  field: string | undefined,
): string | undefined {
  const item = findSpecItem(spec, target, field);
  if (item === undefined) return undefined;
  return valueHint(item.kind) ?? item.description;
}

function findSpecItem(
  spec: CommandSpec | undefined,
  target: "argument" | "option" | undefined,
  field: string | undefined,
): { readonly description: string; readonly kind: ValueKind } | undefined {
  if (spec === undefined || field === undefined) return undefined;
  if (target === "option") {
    return spec.options.find(
      (option) => option.flags === field || flagDisplay(option.flags) === field,
    );
  }
  return spec.args.find((arg) => arg.name === field);
}

function renderUnknownHarness(error: MachineError): RenderedError {
  if (!("availableHarnesses" in error) || !("harness" in error))
    return { message: "Unknown harness" };
  const harnesses = error.availableHarnesses;
  return rendered(
    `Unknown harness '${error.harness}'`,
    harnesses.length === 0 ? undefined : `Allowed: ${harnesses.join(", ")}`,
  );
}

function renderInvalidParams(error: MachineError): RenderedError | null {
  if (!("issues" in error)) return null;
  const issue = error.issues[0];
  if (issue === undefined) return { message: "Invalid parameters" };
  switch (issue.issue) {
    case "missing_required":
      return { message: `Missing required parameter: ${issue.path}` };
    case "invalid_type":
      return {
        message: `Invalid parameter type at ${issue.path}; expected ${issue.expected}`,
      };
    case "invalid_value":
      return { message: `Invalid parameter value: ${issue.path}` };
    case "invalid_combination":
      return {
        message: `Invalid parameter combination: ${issue.paths.join(", ")}`,
      };
  }
}

function allowedText(valid: readonly string[] | undefined): string | undefined {
  return valid !== undefined && valid.length > 0
    ? `Allowed: ${valid.join(", ")}`
    : undefined;
}

function longFlagsFor(spec: CommandSpec | undefined): string[] {
  const flags =
    spec === undefined
      ? []
      : spec.options.map((option) => flagDisplay(option.flags));
  return [...flags, "--pretty"];
}

function domainMessage(error: MachineError): string {
  switch (error.code) {
    case "session_not_found":
      return `Session not found${"sessionId" in error ? `: ${error.sessionId}` : ""}`;
    case "session_killed":
      return `Session is already killed${"sessionId" in error ? `: ${error.sessionId}` : ""}`;
    case "session_terminating":
      return `Session is terminating${"sessionId" in error ? `: ${error.sessionId}` : ""}`;
    case "daemon_shutting_down":
      return "Daemon is shutting down";
    case "invalid_params":
      return "Invalid parameters";
    case "unknown_harness":
      return `Unknown harness${"harness" in error ? `: ${error.harness}` : ""}`;
    case "method_not_found":
      return `Unknown protocol method${"method" in error ? `: ${error.method}` : ""}`;
    case "protocol_error":
      return "Protocol error";
    case "capability_query_failed":
      return !("cause" in error) || error.cause === undefined
        ? "Capability query failed"
        : error.cause.message;
    case "internal_error":
      return !("cause" in error) || error.cause === undefined
        ? "Internal error"
        : error.cause.message;
    case "permission_not_pending":
      return `Permission request is no longer pending${"permissionId" in error ? `: ${error.permissionId}` : ""}`;
    case "permission_resolution_mismatch":
      return `Resolution is not allowed by the request menu${"permissionId" in error ? `: ${error.permissionId}` : ""}`;
    case "diagnostic_not_found":
      return `Diagnostic not found${"diagnosticId" in error ? `: ${error.diagnosticId}` : ""}`;
    case "session_name_conflict":
      return `Session name is already in use${"sessionName" in error ? `: ${error.sessionName}` : ""}`;
    case "unsupported_feature":
      return `Unsupported feature${"feature" in error ? `: ${error.feature}` : ""}`;
    case "daemon_timeout":
      return "Daemon request timed out";
    case "invalid_daemon_response":
      return "Daemon returned an invalid response";
    case "daemon_start_failed":
      return "cause" in error && error.cause !== undefined
        ? error.cause.message
        : "Daemon failed to start";
    case "daemon_disconnected":
      return "Daemon disconnected";
    case "diagnostics_unavailable":
      return "Diagnostics are unavailable";
    case "diagnostics_store_corrupt":
      return !("cause" in error) || error.cause === undefined
        ? "Diagnostics store is corrupt"
        : error.cause.message;
  }
}
