import { createWorkspaceClient } from "@reins/client";
import { consumerContextSchema } from "@reins/protocol";
import { createUnixSocketClient } from "@reins/transport";
import type { WorkspaceMessage } from "@reins/workspace-protocol";
import * as v from "valibot";

const task = JSON.parse(process.argv[2]!) as {
  socket: string;
  cwd: string;
  consumer: string;
} & ({ keepAlive: true } | { keepAlive?: false; bindings: string[] });
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
  } else
    process.stdout.write(
      JSON.stringify(
        await manager.request("workspace.attach", {
          cwd: task.cwd,
          bindings: task.bindings,
        }),
      ) + "\n",
    );
} finally {
  manager.close();
}
