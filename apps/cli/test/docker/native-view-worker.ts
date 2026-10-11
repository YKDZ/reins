import {
  closeSync,
  constants,
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
  closeSync(openSync(task.relativeFile, "a"));
  const output = (event: unknown) =>
    process.stdout.write(JSON.stringify(event) + "\n");
  let ticks = 0;
  let published = false;
  let reportedRelativeError = false;
  timer = setInterval(() => {
    writeSync(held!, "h\n");
    let relativeError: string | undefined;
    let relative: number | undefined;
    try {
      relative = openSync(
        task.relativeFile,
        constants.O_WRONLY | constants.O_APPEND,
      );
      writeSync(relative, "r\n");
    } catch (error) {
      relativeError = (error as NodeJS.ErrnoException).code;
      if (!reportedRelativeError) {
        writeSync(held!, JSON.stringify({ relativeError }) + "\n");
        reportedRelativeError = true;
      }
    } finally {
      if (relative !== undefined) closeSync(relative);
    }
    ticks++;
    if (published) return;
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
      published = true;
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
