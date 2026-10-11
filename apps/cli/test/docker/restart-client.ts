import { createInterface } from "node:readline";

import { createWorkspaceClient } from "@reins/client";
import type { ConsumerContext } from "@reins/protocol";
import { createUnixSocketClient } from "@reins/transport";
import type { WorkspaceMessage } from "@reins/workspace-protocol";

const manager = createWorkspaceClient(
  await createUnixSocketClient<WorkspaceMessage>(
    process.env.REINS_WORKSPACE_MANAGER_SOCKET!,
  ),
  { consumerContext: process.env.REINS_CONSUMER_CONTEXT as ConsumerContext },
);
await manager.initialize();
// 公开共享客户端连接跨重启保留；不通过重新 route 掩盖旧准入。
const cwd = process.argv[2]!;
for await (const line of createInterface({ input: process.stdin })) {
  const { name, message } = JSON.parse(line) as {
    name: string;
    message: string;
  };
  try {
    const result = await manager.request("workspace.admit", {
      cwd,
      action: "spawn",
      params: { cwd, harness: "codex", sessionName: name, message },
    });
    process.stdout.write(JSON.stringify({ result }) + "\n");
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        error: error instanceof Error ? JSON.parse(error.message) : error,
      }) + "\n",
    );
  }
}
manager.close();
