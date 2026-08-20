import { Command } from "commander";

import {
  ROOT_USAGE,
  commandSpecs,
  flagDisplay,
  parseCommandInvocation,
  usageFor,
  valueHint,
  type CommandConstraint,
} from "./command-spec.ts";
import { dispatchInvocation } from "./commands.ts";
import { ExitError, exitCodeForError, toCliError } from "./errors.ts";
import type { OutputMode } from "./output.ts";
import { printError } from "./output.ts";

function prettyOf(
  options: Record<string, unknown>,
  program: Command,
): OutputMode {
  return options.pretty === true || program.opts().pretty === true
    ? "pretty"
    : "json";
}

export function registerCommands(program: Command): void {
  program
    .name("reins")
    .description("Control plane for agent harnesses")
    .version("0.0.0")
    .usage(ROOT_USAGE)
    .option("--pretty", "human-readable output (default: NDJSON)")
    .exitOverride()
    .configureOutput({ writeErr: () => {} });

  for (const spec of commandSpecs) {
    const command = program
      .command(spec.name)
      .description(spec.description)
      .usage(usageFor(spec));
    const constraintText = (spec.constraints ?? [])
      .map((constraint) => constraintHelp(spec.options, constraint))
      .join("\n");
    if (constraintText !== "")
      command.addHelpText("after", `\nConstraints:\n${constraintText}\n`);
    for (const arg of spec.args) {
      command.argument(
        arg.variadic === true ? `<${arg.name}...>` : `<${arg.name}>`,
        helpDescription(arg.description, valueHint(arg.kind)),
      );
    }
    for (const option of spec.options) {
      const description = helpDescription(
        option.description,
        valueHint(option.kind),
      );
      if (option.required === true) {
        command.requiredOption(option.flags, description);
      } else if (option.defaultValue !== undefined) {
        command.option(option.flags, description, option.defaultValue);
      } else {
        command.option(option.flags, description);
      }
    }
    command.option("--pretty", "human-readable output (default: NDJSON)");
    command.action(async (...values: unknown[]) => {
      const { args, options } = unsafeCommanderCallbackInput(values);
      const mode = prettyOf(options, program);
      try {
        await dispatchInvocation(
          parseCommandInvocation(spec.name, args, options, mode),
        );
      } catch (error) {
        if (error instanceof ExitError) throw error;
        const cliError = toCliError(error);
        printError(cliError, mode, spec);
        throw new ExitError(exitCodeForError(cliError), cliError.code);
      }
    });
  }
}

// Commander 在 action 回调尾部追加 options 与 Command；将不透明边界隔离在此处。
function unsafeCommanderCallbackInput(values: readonly unknown[]): {
  readonly args: readonly unknown[];
  readonly options: Record<string, unknown>;
} {
  return {
    args: values.slice(0, -2),
    options: values.at(-2) as Record<string, unknown>,
  };
}

function constraintHelp(
  options: readonly { readonly name: string; readonly flags: string }[],
  constraint: CommandConstraint,
): string {
  const flag = (name: string): string =>
    flagDisplay(options.find((option) => option.name === name)?.flags ?? name);
  switch (constraint.type) {
    case "exclusive":
    case "requires":
    case "forbiddenModeValue":
      return `${flag(constraint.field)}: ${constraint.hint}`;
    case "orderedTime":
      return `${flag(constraint.since)} / ${flag(constraint.until)}: ${constraint.hint}`;
    default:
      return assertNever(constraint);
  }
}

function helpDescription(
  description: string,
  hint: string | undefined,
): string {
  if (hint === undefined || description.includes(hint)) return description;
  return `${description}; ${hint}`;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled command constraint: ${String(value)}`);
}
