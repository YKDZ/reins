import { open, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  workspaceHistoryEventSchema,
  type WorkspaceHistoryEvent,
  type WorkspaceHistoryHealth,
} from "@reins/workspace-protocol";
import * as v from "valibot";

export const historyEventKey = (entry: WorkspaceHistoryEvent) =>
  `${entry.daemonGeneration}/${entry.event.sessionId}/${entry.eventId}`;

export async function readWorkspaceHistory(
  directory: string,
  saved: WorkspaceHistoryHealth,
): Promise<{
  health: WorkspaceHistoryHealth;
  events: WorkspaceHistoryEvent[];
}> {
  const health = { ...saved, errors: [...saved.errors] };
  const events: WorkspaceHistoryEvent[] = [];
  const failed = () => {
    health.status = "failed";
    if (!health.errors.includes("read_failed"))
      health.errors.push("read_failed");
  };
  try {
    const lines = (
      await readFile(join(directory, "history.ndjson"), "utf8")
    ).split("\n");
    // 事件日志是权威事实；崩溃前较旧的元数据不能隐藏已同步成功的原事件。
    if (saved.status === "unavailable" || saved.status === "deleted")
      health.status = "available";
    // 未闭合的最后一行没有完整提交边界；保留此前可证明的事实并独立报告故障。
    if (lines.pop() !== "") failed();
    for (const line of lines) {
      try {
        const parsed = v.safeParse(
          workspaceHistoryEventSchema,
          JSON.parse(line),
        );
        if (parsed.success) events.push(parsed.output);
        else failed();
      } catch {
        failed();
      }
    }
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "ENOENT" ||
      (saved.status !== "unavailable" && saved.status !== "deleted")
    )
      failed();
  }
  return { health, events };
}

export async function appendWorkspaceHistory(
  directory: string,
  entry: WorkspaceHistoryEvent,
): Promise<void> {
  const file = await open(join(directory, "history.ndjson"), "a", 0o600);
  try {
    await file.writeFile(JSON.stringify(entry) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  const parent = await open(directory, "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}
