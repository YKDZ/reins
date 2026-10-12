import { fullUsageFor, type CommandSpec } from "./command-spec.ts";
import type { CliError } from "./errors.ts";
import {
  isUsageClassError,
  jsonErrorMessage,
  renderCliError,
} from "./grammar.ts";

export type OutputMode = "json" | "pretty";

export function printJsonLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function printResult(value: unknown, mode: OutputMode): void {
  process.stdout.write(
    `${JSON.stringify(value, null, mode === "pretty" ? 2 : undefined)}\n`,
  );
}

export function printError(
  error: CliError,
  mode: OutputMode,
  spec?: CommandSpec,
): void {
  const rendered = renderCliError(error, spec);
  if (mode === "json") {
    const message = jsonErrorMessage(rendered);
    printJsonLine({
      ...error,
      message:
        "diagnosticId" in error && error.diagnosticId !== undefined
          ? `${message}. reins diagnostics --id ${error.diagnosticId}`
          : message,
      ...(isUsageClassError(error)
        ? { usage: `reins ${fullUsageFor(spec)}` }
        : {}),
    });
    return;
  }
  for (const item of rendered.items) {
    process.stderr.write(`error: ${item.message}\n`);
    if (item.suggestion !== undefined) {
      process.stderr.write(`suggestion: ${item.suggestion}\n`);
    }
  }
  if ("diagnosticId" in error && error.diagnosticId !== undefined) {
    process.stderr.write(`diagnostic: ${error.diagnosticId}\n`);
    process.stderr.write(
      `suggestion: reins diagnostics --id ${error.diagnosticId}\n`,
    );
  }
  if (isUsageClassError(error)) {
    process.stderr.write(`usage: reins ${fullUsageFor(spec)}\n`);
  }
}
