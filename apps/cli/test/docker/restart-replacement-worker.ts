import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

let timer: NodeJS.Timeout | undefined;
for await (const line of createInterface({ input: process.stdin })) {
  const input = JSON.parse(line) as {
    sessionId: string;
    turnId: string;
    message: string;
  };
  const task = JSON.parse(input.message) as {
    path: string;
    hold?: boolean;
    output?: string;
  };
  const reply = {
    pid: process.pid,
    cwd: process.cwd(),
    message: input.message,
    content: readFileSync(task.path, "utf8"),
  };
  appendFileSync("worker-starts.ndjson", JSON.stringify(reply) + "\n");
  process.stdout.write(
    JSON.stringify({ kind: "accepted", turnId: input.turnId }) + "\n",
  );
  if (task.hold) {
    writeFileSync("active-writer.json", JSON.stringify(reply));
    timer = setInterval(
      () => appendFileSync("old-writes.txt", "old task\n"),
      25,
    );
  } else {
    if (task.output !== undefined) writeFileSync(task.output, reply.content);
    process.stdout.write(
      JSON.stringify({
        kind: "event",
        event: {
          type: "turn.completed",
          sessionId: input.sessionId,
          turnId: input.turnId,
          stopReason: "end_turn",
          finalReply: JSON.stringify(reply),
        },
      }) + "\n",
    );
  }
}
process.on("SIGTERM", () => {
  clearInterval(timer);
  process.exit(0);
});
