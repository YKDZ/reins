import { execFileSync } from "node:child_process";
import { writeFile, rm, access } from "node:fs/promises";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

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
      publishAfterFile?: string;
      finishAfterFile?: string;
      publishedFile?: string;
      fail?: boolean;
    };
    const output = (value: unknown) =>
      process.stdout.write(JSON.stringify(value) + "\n");
    output({ kind: "accepted", turnId: input.turnId });
    const gate = async (path: string | undefined) => {
      if (path === undefined) return;
      for (;;) {
        try {
          await access(path);
          return;
        } catch {
          await delay(25);
        }
      }
    };
    await gate(task.publishAfterFile);
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
    if (task.publishedFile)
      await writeFile(
        task.publishedFile,
        JSON.stringify({ pid: process.pid, result }),
      );
    await gate(task.finishAfterFile);
    let failureStatus: number | undefined;
    if (task.fail) {
      try {
        execFileSync(process.execPath, ["-e", "process.exit(7)"]);
      } catch (error) {
        failureStatus = (error as { status: number }).status;
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
      pid: process.pid,
      ...(failureStatus === undefined ? {} : { failureStatus }),
    });
    output({
      kind: "event",
      event: {
        type: "turn.completed",
        sessionId: input.sessionId,
        turnId: input.turnId,
        ...(failureStatus === undefined
          ? { stopReason: "end_turn" }
          : {
              stopReason: "failed",
              failure: {
                failureCategory: "unclassified",
                retryDisposition: "unknown",
              },
            }),
        finalReply,
      },
    });
  })().catch((error) => {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 1;
  });
});
