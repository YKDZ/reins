import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

createInterface({ input: process.stdin }).on("line", (line) => {
  void (async () => {
    const input = JSON.parse(line);
    const task = JSON.parse(input.message);
    const commands: unknown[] = [];
    for (const [path, content] of Object.entries(task.files ?? {}))
      await writeFile(path, content as string);
    for (const args of task.git ?? [])
      commands.push({
        args,
        stdout: execFileSync("git", args, { encoding: "utf8" }).trim(),
      });
    if (task.truncate !== undefined)
      await writeFile(
        task.path,
        (await readFile(task.path)).subarray(0, task.truncate),
      );
    const publication = execFileSync("reins", ["publish", "--", task.path], {
      encoding: "utf8",
    }).trim();
    const finalReply = JSON.stringify({
      publication: JSON.parse(publication),
      commands,
      pid: process.pid,
      message: input.message,
    });
    process.stdout.write(
      JSON.stringify({ kind: "accepted", turnId: input.turnId }) + "\n",
    );
    process.stdout.write(
      JSON.stringify({
        kind: "event",
        event: {
          type: "turn.completed",
          sessionId: input.sessionId,
          turnId: input.turnId,
          stopReason: "end_turn",
          finalReply,
        },
      }) + "\n",
    );
  })().catch((error) => {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 1;
  });
});
