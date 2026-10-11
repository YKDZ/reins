import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createWorkspaceClient } from "@reins/client";
import { consumerContextSchema } from "@reins/protocol";
import { createUnixSocketClient } from "@reins/transport";
import {
  PUBLISHER_CAPABILITIES,
  type WorkspaceMessage,
} from "@reins/workspace-protocol";
import { Command, CommanderError } from "commander";
import * as v from "valibot";

import {
  commandSpecForToken,
  parseDeclaredInput,
  publisherCommandSpecs,
  publisherGroupSpec,
} from "./command-spec.ts";
import {
  EXIT_USAGE,
  ExitError,
  exitCodeForError,
  toCliError,
} from "./errors.ts";
import { commanderToUsageError } from "./grammar.ts";
import { printError, printResult, type OutputMode } from "./output.ts";

export async function publisherMain(argv: readonly string[]): Promise<number> {
  const program = new Command()
    .name("reins")
    .description("Publish selected worker files")
    .option("--pretty", "human-readable output (default: NDJSON)")
    .exitOverride()
    .configureOutput({ writeErr: () => {} });
  for (const spec of publisherCommandSpecs) {
    const capability = PUBLISHER_CAPABILITIES.find(
      (item) => item.name === spec.name,
    );
    if (capability === undefined)
      throw new Error(`Missing publisher capability: ${spec.name}`);
    const command = program
      .command(spec.name)
      .description(spec.description)
      .usage("<file> [options]")
      .argument("[file]", "selected file; use -- before option-like names")
      .option("--pretty", "human-readable output (default: NDJSON)");
    command.action(async (...values: unknown[]) => {
      const { args, options } = unsafeCommanderCallbackInput(values);
      const mode: OutputMode =
        options.pretty === true || program.opts().pretty === true
          ? "pretty"
          : "json";
      try {
        const parsed = parseDeclaredInput(spec, args, options);
        const file = parsed.args[0] as string;
        const source = resolve(file);
        const before = await lstat(source);
        if (!before.isFile()) throw new Error("Source must be a regular file");
        const payload = await readFile(source);
        const after = await lstat(source);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
          throw new Error("Source changed during publication");
        const socket = process.env.REINS_PUBLICATION_SOCKET;
        if (socket === undefined) throw { code: "publication_failed" };
        const client = createWorkspaceClient(
          await createUnixSocketClient<WorkspaceMessage>(socket),
          {
            consumerContext: v.parse(
              consumerContextSchema,
              process.env.REINS_CONSUMER_CONTEXT,
            ),
          },
        );
        try {
          const publication = await client.request(capability.method, {
            cwd: process.cwd(),
            path: source,
            contentBase64: payload.toString("base64"),
          });
          printResult(publication, mode);
        } finally {
          client.close();
        }
      } catch (error) {
        const cliError = toCliError(error);
        printError(cliError, mode, spec);
        throw new ExitError(exitCodeForError(cliError), cliError.code);
      }
    });
  }
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof ExitError) return error.code;
    const mode: OutputMode = argv.includes("--pretty") ? "pretty" : "json";
    if (error instanceof CommanderError) {
      if (["commander.helpDisplayed", "commander.help"].includes(error.code)) {
        if (error.code === "commander.help") program.outputHelp();
        return 0;
      }
      const spec = commandSpecForToken(argv) ?? publisherGroupSpec;
      const cliError = commanderToUsageError(error, spec);
      printError(cliError, mode, spec);
      return EXIT_USAGE;
    }
    const cliError = toCliError(error);
    printError(cliError, mode, commandSpecForToken(argv));
    return exitCodeForError(cliError);
  }
}

function unsafeCommanderCallbackInput(values: readonly unknown[]): {
  readonly args: readonly unknown[];
  readonly options: Record<string, unknown>;
} {
  return {
    args: values.slice(0, -2),
    options: values.at(-2) as Record<string, unknown>,
  };
}
