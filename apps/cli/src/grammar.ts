import type { MachineError } from "@reins/protocol";
import type { CommanderError } from "commander";

import {
  commandSpecs,
  flagDisplay,
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
  if (error.code === "invalid_params") {
    const context = error.context ?? {};
    return typeof context.field === "string" && "value" in context;
  }
  return false;
}

export function renderCliError(
  error: CliError,
  spec?: CommandSpec,
): RenderedError {
  if (error.code === "usage_error") return renderUsageError(error, spec);
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
    error.context;
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
  }
}

function suggestionForMissing(
  spec: CommandSpec | undefined,
  target: "argument" | "option" | undefined,
  field: string | undefined,
): string | undefined {
  const item = findSpecItem(spec, target, field);
  if (item === undefined) return undefined;
  if (item.kind.type === "enum") {
    return `Allowed: ${item.kind.values.join(", ")}`;
  }
  if (
    item.kind.type === "dynamic" ||
    item.kind.type === "number" ||
    item.kind.type === "jsonObject"
  ) {
    return item.kind.hint;
  }
  return item.description;
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
  const context = error.context ?? {};
  const value = typeof context.value === "string" ? context.value : "";
  const harnesses = validStringList(
    (context.valid as { harness?: unknown } | undefined)?.harness,
  );
  return rendered(
    `Unknown harness '${value}'`,
    harnesses.length === 0 ? undefined : `Allowed: ${harnesses.join(", ")}`,
  );
}

type CapabilityModel = {
  readonly id: string;
  readonly displayName: string;
  readonly reasoningEfforts: readonly string[];
};

function isCapabilityModel(value: unknown): value is CapabilityModel {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    id?: unknown;
    displayName?: unknown;
    reasoningEfforts?: unknown;
  };
  return (
    typeof candidate.id === "string" &&
    typeof candidate.displayName === "string" &&
    Array.isArray(candidate.reasoningEfforts) &&
    candidate.reasoningEfforts.every((effort) => typeof effort === "string")
  );
}

function validListOfModels(value: unknown): CapabilityModel[] {
  return Array.isArray(value) ? value.filter(isCapabilityModel) : [];
}

function renderInvalidParams(error: MachineError): RenderedError | null {
  const context = error.context ?? {};
  const field = context.field;
  if (typeof field !== "string" || !("value" in context)) return null;
  const value =
    typeof context.value === "string" ? context.value : String(context.value);
  if (field === "model") {
    const harness = typeof context.harness === "string" ? context.harness : "";
    const models = validListOfModels(
      (context.valid as { models?: unknown } | undefined)?.models,
    );
    return rendered(
      `Invalid model '${value}' for harness '${harness}'`,
      models.length === 0
        ? undefined
        : `Allowed models: ${models
            .map(
              (model) => `${model.id} (${model.reasoningEfforts.join(", ")})`,
            )
            .join("; ")}`,
    );
  }
  if (field === "reasoning") {
    const model = typeof context.model === "string" ? context.model : "";
    const models = validListOfModels(
      (context.valid as { models?: unknown } | undefined)?.models,
    );
    const efforts =
      models[0] === undefined ? [] : [...models[0].reasoningEfforts];
    return rendered(
      `Invalid reasoning effort '${value}' for model '${model}'`,
      efforts.length === 0 ? undefined : `Allowed: ${efforts.join(", ")}`,
    );
  }
  return { message: `Invalid value '${value}' for '${field}'` };
}

function validStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
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
  const context = error.context ?? {};
  const text = (value: unknown): string =>
    typeof value === "string" ? value : JSON.stringify(value);
  const sessionId = context.sessionId;
  const harness = context.harness;

  switch (error.code) {
    case "session_not_found":
      return `Session not found${sessionId === undefined ? "" : `: ${text(sessionId)}`}`;
    case "session_killed":
      return `Session is already killed${sessionId === undefined ? "" : `: ${text(sessionId)}`}`;
    case "invalid_params":
      return `Invalid parameters${harness === undefined ? "" : ` for harness ${text(harness)}`}`;
    case "permission_not_pending":
      return "Permission request is no longer pending";
    case "permission_resolution_mismatch":
      return "Resolution is not allowed by the request menu";
    case "unknown_harness":
      return `Unknown harness${harness === undefined ? "" : `: ${text(harness)}`}`;
    case "method_not_found":
      return `Unknown protocol method: ${context.method === undefined ? "" : text(context.method)}`;
    case "protocol_error":
      return "Protocol error";
    case "capability_query_failed":
      return `Capability query failed for harness ${harness === undefined ? "" : text(harness)}`;
    case "internal_error":
      return context.message === undefined
        ? "Internal error"
        : text(context.message);
    default:
      return `Unknown error: ${String(error.code)}`;
  }
}
