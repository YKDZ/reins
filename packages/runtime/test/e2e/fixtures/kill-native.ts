import { spawn } from "node:child_process";
import { existsSync, openSync, writeSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

if (process.argv[2] === "writer") {
  process.on("SIGTERM", () => {});
  const root = process.argv[3]!;
  const held = openSync(join(root, "held.txt"), "a");
  const named = openSync(join(root, "named.txt"), "a");
  const write = () => {
    writeSync(held, "held\n");
    writeSync(named, "named\n");
  };
  write();
  setInterval(write, 10);
  process.send?.({ pid: process.pid });
} else {
  process.on("SIGTERM", () => {});
  let message = "";
  let cwd = "";
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line) as {
      id?: number;
      method?: string;
      params?: { cwd?: string; input?: { text: string }[] };
    };
    if (request.id === undefined) continue;
    if (request.method === "thread/start") {
      const root = request.params!.cwd!;
      cwd = root;
      const writer = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), "writer", root],
        {
          stdio: ["ignore", "inherit", "inherit", "ipc"],
        },
      );
      await new Promise<void>((resolve) =>
        writer.once("message", () => resolve()),
      );
      writeFileSync(
        join(root, "pids.json"),
        JSON.stringify({ parent: process.pid, writer: writer.pid }),
      );
    }
    if (request.method === "turn/start") {
      message = request.params?.input?.[0]?.text ?? "";
      writeFileSync(join(cwd, "turn-started.txt"), message);
    }
    if (request.method === "turn/steer" && message === "hold steer for kill") {
      writeFileSync(join(cwd, "steer-started.txt"), "started");
      while (!existsSync(join(cwd, "release-steer.txt")))
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    if (
      request.method === "thread/delete" &&
      message === "complete during kill"
    ) {
      process.stdout.write(
        JSON.stringify({
          method: "turn/completed",
          params: {
            threadId: "native-thread",
            turn: {
              id: "native-turn",
              status: "completed",
              error: null,
              items: [],
            },
          },
        }) + "\n",
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    const result =
      request.method === "thread/start"
        ? { thread: { id: "native-thread" } }
        : request.method === "turn/start"
          ? { turn: { id: "native-turn" } }
          : request.method === "turn/steer"
            ? { turnId: "native-turn" }
            : {};
    process.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
    if (request.method === "turn/start" && message === "complete naturally") {
      process.stdout.write(
        JSON.stringify({
          method: "turn/completed",
          params: {
            threadId: "native-thread",
            turn: {
              id: "native-turn",
              status: "completed",
              error: null,
              items: [],
            },
          },
        }) + "\n",
      );
    }
  }
}
