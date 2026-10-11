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
let permissionFile: string | undefined;
createInterface({ input: process.stdin }).on("line", (line) => {
  const input = JSON.parse(line) as {
    kind?: "resolution";
    sessionId: string;
    turnId: string;
    message: string;
    resolution?: unknown;
  };
  if (input.kind === "resolution") {
    if (permissionFile !== undefined)
      writeFileSync(permissionFile, JSON.stringify(input.resolution));
    return;
  }
  const task = JSON.parse(input.message) as {
    heldFile: string;
    relativeFile: string;
    intervalMs: number;
    permissionFile?: string;
    recordFile?: string;
    value?: string;
    acknowledge?: boolean;
  };
  const output = (event: unknown) =>
    process.stdout.write(JSON.stringify(event) + "\n");
  if (held !== undefined) {
    writeFileSync(task.recordFile!, task.value!);
    if (task.acknowledge !== false)
      output({ kind: "accepted", turnId: input.turnId });
    return;
  }
  held = openSync(task.heldFile, "a");
  closeSync(openSync(task.relativeFile, "a"));
  permissionFile = task.permissionFile;
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
  if (permissionFile !== undefined)
    output({
      kind: "event",
      event: {
        type: "permission.requested",
        sessionId: input.sessionId,
        turnId: input.turnId,
        permissionId: "writer-permission",
        kind: "write",
        input: { path: permissionFile },
        options: [{ outcome: "allow", scope: "once" }],
      },
    });
});
process.on("SIGTERM", () => {
  clearInterval(timer);
  if (held !== undefined) closeSync(held);
  process.exit(0);
});
