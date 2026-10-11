import { access } from "node:fs/promises";
import { createInterface } from "node:readline";

import { UNKNOWN_HARNESS_FAILURE } from "@reins/protocol";

for await (const line of createInterface({ input: process.stdin })) {
  const { turnId, message } = JSON.parse(line) as {
    turnId: string;
    message: string;
  };
  process.stdout.write(JSON.stringify({ kind: "accepted", turnId }) + "\n");
  const task = message.startsWith("{")
    ? (JSON.parse(message) as {
        gate?: string;
        stopReason?: string;
        reply: string;
      })
    : { reply: message };
  if (task.gate !== undefined) {
    while (
      !(await access(task.gate).then(
        () => true,
        () => false,
      ))
    )
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  process.stdout.write(
    JSON.stringify({
      kind: "completed",
      turnId,
      stopReason: task.stopReason ?? "end_turn",
      ...(task.stopReason === "failed"
        ? { failure: UNKNOWN_HARNESS_FAILURE }
        : {}),
      finalReply: task.reply,
    }) + "\n",
  );
}
