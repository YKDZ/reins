import { appendFile, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

await appendFile(".worker-started", `${process.pid}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  void (async () => {
    const input = JSON.parse(line) as {
      sessionId: string;
      turnId: string;
      message: string;
    } & Record<string, unknown>;
    const task = JSON.parse(input.message) as { path: string };
    const content = await readFile(task.path, "utf8");
    const options = Object.fromEntries(
      ["model", "reasoning", "authorizationMode", "sandbox", "agent"]
        .filter((key) => key in input)
        .map((key) => [key, input[key]]),
    );
    const finalReply = JSON.stringify({
      cwd: process.cwd(),
      content,
      message: input.message,
      options,
      pid: process.pid,
    });
    const output = (value: unknown) =>
      process.stdout.write(JSON.stringify(value) + "\n");
    output({ kind: "accepted", turnId: input.turnId });
    output({
      kind: "event",
      event: {
        type: "message",
        sessionId: input.sessionId,
        turnId: input.turnId,
        messageId: "read",
        role: "worker",
        content: finalReply,
      },
    });
    output({
      kind: "event",
      event: {
        type: "turn.completed",
        sessionId: input.sessionId,
        turnId: input.turnId,
        stopReason: "end_turn",
        finalReply,
      },
    });
  })().catch((error) => {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 1;
  });
});
