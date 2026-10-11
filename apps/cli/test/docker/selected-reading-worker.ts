import { appendFile, readFile, lstat, readlink } from "node:fs/promises";
import { createInterface } from "node:readline";

await appendFile(".worker-started", `${process.pid}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  void (async () => {
    const input = JSON.parse(line) as {
      sessionId: string;
      turnId: string;
      message: string;
    } & Record<string, unknown>;
    const task = JSON.parse(input.message) as {
      path: string;
      paths?: string[];
    };
    const files =
      task.paths === undefined
        ? undefined
        : await Promise.all(
            task.paths.map(async (path) => {
              try {
                const info = await lstat(path);
                return {
                  path,
                  mode: info.mode & 0o777,
                  kind: info.isSymbolicLink() ? "symlink" : "file",
                  bytes: info.isSymbolicLink()
                    ? await readlink(path)
                    : (await readFile(path)).toString("base64"),
                };
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT")
                  return { path, missing: true };
                throw error;
              }
            }),
          );
    const content = await readFile(task.path, "utf8");
    const options = Object.fromEntries(
      ["model", "reasoning", "authorizationMode", "sandbox", "agent"]
        .filter((key) => key in input)
        .map((key) => [key, input[key]]),
    );
    const finalReply = JSON.stringify({
      cwd: process.cwd(),
      content,
      files,
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
