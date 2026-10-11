import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

import { createWorkspaceClient } from "@reins/client";
import { consumerContextSchema, spawnParamsSchema } from "@reins/protocol";
import { createUnixSocketClient } from "@reins/transport";
import type { WorkspaceMessage } from "@reins/workspace-protocol";
import * as v from "valibot";

const task = JSON.parse(process.argv[2]!) as {
  socket: string;
  cwd: string;
  consumer: string;
  timeoutMs?: number;
} & (
  | { keepAlive: true; control?: false }
  | { control: true; keepAlive?: false }
  | { keepAlive?: false; control?: false; bindings: string[] }
);
const manager = createWorkspaceClient(
  await createUnixSocketClient<WorkspaceMessage>(task.socket),
  { consumerContext: v.parse(consumerContextSchema, task.consumer) },
);
try {
  await manager.initialize();
  if (task.keepAlive === true) {
    process.stdout.write(JSON.stringify({ connected: true }) + "\n");
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
    });
  } else if (task.control === true) {
    let client;
    for (;;) {
      try {
        client = await manager.control(task.cwd);
        break;
      } catch (error) {
        if ((error as { code?: string }).code !== "manager_timeout")
          throw error;
        await delay(2000);
      }
    }
    try {
      await client.initialize();
      process.stdout.write(JSON.stringify({ connected: true }) + "\n");
      for await (const line of createInterface({ input: process.stdin })) {
        try {
          process.stdout.write(
            JSON.stringify(
              await client.request(
                "spawn",
                v.parse(spawnParamsSchema, JSON.parse(line)),
              ),
            ) + "\n",
          );
        } catch (error) {
          process.stdout.write(JSON.stringify(error) + "\n");
          process.exitCode = 1;
        }
      }
    } finally {
      client.close();
    }
  } else
    process.stdout.write(
      JSON.stringify(
        await manager.request(
          "workspace.attach",
          { cwd: task.cwd, bindings: task.bindings },
          task.timeoutMs,
        ),
      ) + "\n",
    );
} finally {
  manager.close();
}
