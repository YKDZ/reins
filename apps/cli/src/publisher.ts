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

// 部署入口固定此集合，不读取容器探测或调用方角色选项。
const capabilities = PUBLISHER_CAPABILITIES;
export async function publisherMain(argv: readonly string[]): Promise<number> {
  const program = new Command()
    .name("reins")
    .description("Publish selected worker files")
    .exitOverride()
    .configureOutput({ writeErr: () => {} });
  for (const capability of capabilities) {
    program
      .command(capability.name)
      .description(capability.description)
      .argument("<file>", "selected file; use -- before option-like names")
      .action(async (file: string) => {
        const source = resolve(file);
        const before = await lstat(source);
        if (!before.isFile()) throw new Error("Source must be a regular file");
        const payload = await readFile(source);
        const after = await lstat(source);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
          throw new Error("Source changed during publication");
        const socket = process.env.REINS_PUBLICATION_SOCKET;
        if (socket === undefined)
          throw new Error("Publisher socket is not bound");
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
            path: source,
            contentBase64: payload.toString("base64"),
          });
          process.stdout.write(JSON.stringify(publication) + "\n");
        } finally {
          client.close();
        }
      });
  }
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (["commander.helpDisplayed", "commander.help"].includes(error.code)) {
        if (error.code === "commander.help") program.outputHelp();
        return 0;
      }
      process.stdout.write(
        JSON.stringify({
          code: "usage_error",
          message: error.message,
          valid: capabilities.map((item) => item.name),
        }) + "\n",
      );
      return 64;
    }
    process.stdout.write(JSON.stringify({ code: "publication_failed" }) + "\n");
    return 1;
  }
}
