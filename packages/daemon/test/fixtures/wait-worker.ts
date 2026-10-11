import { access } from "node:fs/promises";
import { createInterface } from "node:readline";

for await (const line of createInterface({input: process.stdin})) {
  const {turnId, message} = JSON.parse(line) as {turnId: string; message: string};
  const task = message.startsWith("{") ? JSON.parse(message) as {gate?: string; stopReason?: string; reply: string} : {reply: message};
  if (task.gate !== undefined) {
    while (!await access(task.gate).then(() => true, () => false)) await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  process.stdout.write(JSON.stringify({turnId, stopReason: task.stopReason ?? "end_turn", finalReply: task.reply}) + "\n");
}
