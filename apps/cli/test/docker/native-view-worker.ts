import {
  appendFileSync,
  closeSync,
  fstatSync,
  openSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createInterface } from "node:readline";
let held: number | undefined;
let timer: NodeJS.Timeout | undefined;
createInterface({ input: process.stdin }).on("line", (line) => {
  const input = JSON.parse(line) as {
    sessionId: string;
    turnId: string;
    message: string;
  };
  const task = JSON.parse(input.message) as {
    heldFile: string;
    relativeFile: string;
    intervalMs: number;
  };
  held = openSync(task.heldFile, "a");
  const output = (event: unknown) =>
    process.stdout.write(JSON.stringify(event) + "\n");
  let ticks = 0;
  timer = setInterval(() => {
    writeSync(held!, "h\n");
    let relativeError: string | undefined;
    try {
      appendFileSync(task.relativeFile, "r\n");
    } catch (error) {
      relativeError = (error as NodeJS.ErrnoException).code;
    }
    ticks++;
    const fd = fstatSync(held!);
    const cwd = statSync(".");
    try {
      writeFileSync(
        "writer.tmp",
        JSON.stringify({
          pid: process.pid,
          ticks,
          cwd: process.cwd(),
          cwdIdentity: { dev: cwd.dev, ino: cwd.ino },
          heldIdentity: { dev: fd.dev, ino: fd.ino },
          heldSize: fd.size,
          relativeError,
        }),
      );
      renameSync("writer.tmp", "writer.json");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }, task.intervalMs);
  output({ kind: "accepted", turnId: input.turnId });
});
process.on("SIGTERM", () => {
  clearInterval(timer);
  if (held !== undefined) closeSync(held);
  process.exit(0);
});
