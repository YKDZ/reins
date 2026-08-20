import { Command } from "commander";

import {
  ROOT_USAGE,
  commandSpecs,
  usageFor,
  validateCommand,
  type CommandName,
} from "./command-spec.ts";
import { handlers } from "./commands.ts";
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
    for (const arg of spec.args) {
      command.argument(
        arg.variadic === true ? `<${arg.name}...>` : `<${arg.name}>`,
        arg.description,
      );
    }
    for (const option of spec.options) {
      if (option.required === true) {
        command.requiredOption(option.flags, option.description);
      } else if (option.defaultValue !== undefined) {
        command.option(option.flags, option.description, option.defaultValue);
      } else {
        command.option(option.flags, option.description);
      }
    }
    command.option("--pretty", "human-readable output (default: NDJSON)");
    command.action(async (...values: unknown[]) => {
      const options = values.at(-2) as Record<string, unknown>;
      const args = values.slice(0, -2);
      const handler = handlers[spec.name as CommandName];
      if (handler === undefined) {
        throw new Error(`missing handler for command: ${spec.name}`);
      }
      const mode = prettyOf(options, program);
      try {
        validateCommand(spec, args, options);
        await handler({ args, options, mode, program });
      } catch (error) {
        if (error instanceof ExitError) throw error;
        const cliError = toCliError(error);
        printError(cliError, mode, spec);
        throw new ExitError(exitCodeForError(cliError), cliError.code);
      }
    });
  }
}
