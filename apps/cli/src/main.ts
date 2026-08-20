import { Command, CommanderError } from "commander";

import { commandSpecForToken } from "./command-spec.ts";
import {
  ExitError,
  EXIT_USAGE,
  exitCodeForError,
  toCliError,
} from "./errors.ts";
import { commanderToUsageError } from "./grammar.ts";
import { printError } from "./output.ts";
import { registerCommands } from "./register.ts";

export async function main(argv: readonly string[]): Promise<number> {
  const program = new Command();
  registerCommands(program);
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof ExitError) return error.code;
    const mode = argv.includes("--pretty") ? "pretty" : "json";
    const spec = commandSpecForToken(argv);
    if (error instanceof CommanderError) {
      if (
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.version"
      ) {
        return 0;
      }
      if (error.code === "commander.help") {
        // 无子命令调用：Commander 原本向 stderr 输出帮助并退出 1；
        // 我们接管为 stdout 帮助 + 退出 0（A 类输出契约）。
        program.outputHelp();
        return 0;
      }
      printError(commanderToUsageError(error, spec), mode, spec);
      return EXIT_USAGE;
    }
    const cliError = toCliError(error);
    printError(cliError, mode, spec);
    return exitCodeForError(cliError);
  }
}
