import { appendFile, readFile, access } from "node:fs/promises";
import { createInterface } from "node:readline";

await appendFile(".worker-started", `${process.pid}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  void (async () => {
    const input = JSON.parse(line) as {
      sessionId: string;
      turnId: string;
      message: string;
    } & Record<string, unknown>;
    const task = JSON.parse(input.message) as { path: string; gate?: string };
    const kind = process.env.REINS_FIXTURE_HARNESS!;
    let credential = "omitted";
    try {
      if (kind === "codex") {
        const login = JSON.parse(
          await readFile(process.env.CODEX_HOME + "/auth.json", "utf8"),
        );
        credential =
          login.tokens.access_token === "fixture-codex-valid"
            ? "correct"
            : "expired";
      } else {
        credential =
          (await readFile(
            process.env.QODERCN_CONFIG_DIR + "/.auth/user",
            "utf8",
          )) === "fixture-qoder-valid"
            ? "correct"
            : "expired";
      }
    } catch {}
    if (task.gate !== undefined) {
      for (;;) {
        try {
          await access(task.gate);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    }
    const content = await readFile(task.path, "utf8");
    const options = Object.fromEntries(
      ["model", "reasoning", "authorizationMode", "sandbox", "agent"]
        .filter((key) => key in input)
        .map((key) => [key, input[key]]),
    );
    const finalReply = JSON.stringify({
      credential,
      harness: kind,
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
        stopReason: credential === "expired" ? "failed" : "end_turn",
        ...(credential === "expired"
          ? {
              failure: {
                failureCategory: "credential_rejected",
                retryDisposition: "external_state_change",
              },
            }
          : {}),
        finalReply,
      },
    });
  })().catch((error) => {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 1;
  });
});
