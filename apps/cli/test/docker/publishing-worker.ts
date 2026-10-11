import { execFileSync } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";

createInterface({ input: process.stdin }).on("line", (line) => {
  void (async () => {
    const input = JSON.parse(line) as {
      sessionId: string;
      turnId: string;
      message: string;
    } & Record<string, unknown>;
    const task = JSON.parse(input.message) as {
      path: string;
      content?: string;
      publish?: boolean;
      remove?: boolean;
      args?: string[];
      requestEnvironment?: boolean;
    };
    if (task.content !== undefined) await writeFile(task.path, task.content);
    if (task.remove) await rm(task.path);
    let result: unknown = { path: task.path };
    if (task.requestEnvironment) {
      result = await new Promise((resolve, reject) => {
        const connection = createConnection(
          process.env.REINS_PUBLICATION_SOCKET!,
        );
        connection.once("error", reject);
        connection.once("connect", () =>
          connection.write(
            JSON.stringify({
              kind: "request",
              requestId: "unsupported",
              method: "workspace.attach",
              params: { cwd: process.cwd(), bindings: ["code"] },
            }) + "\n",
          ),
        );
        createInterface({ input: connection }).once("line", (reply) => {
          connection.end();
          resolve(JSON.parse(reply));
        });
      });
    }
    if (task.publish || task.args) {
      try {
        const stdout = execFileSync(
          "reins",
          task.args ?? ["publish", "--", task.path],
          { encoding: "utf8" },
        );
        result = { status: 0, stdout: stdout.trim() };
      } catch (error) {
        const failure = error as { status: number; stdout: string | Buffer };
        result = {
          status: failure.status,
          stdout: String(failure.stdout).trim(),
        };
      }
    }
    const options = Object.fromEntries(
      ["model", "reasoning", "authorizationMode", "sandbox", "agent"]
        .filter((key) => key in input)
        .map((key) => [key, input[key]]),
    );
    const finalReply = JSON.stringify({
      result,
      message: input.message,
      options,
    });
    const output = (value: unknown) =>
      process.stdout.write(JSON.stringify(value) + "\n");
    output({ kind: "accepted", turnId: input.turnId });
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
