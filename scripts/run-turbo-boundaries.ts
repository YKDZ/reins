import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type InterruptSignal = "SIGINT" | "SIGTERM";

function exitStatus(
  code: number | null,
  signal: NodeJS.Signals | null,
  interruptedBy: InterruptSignal | undefined,
  spawnFailed: boolean,
): number {
  if (interruptedBy !== undefined) {
    return interruptedBy === "SIGINT" ? 130 : 143;
  }
  if (spawnFailed) return 1;
  if (code !== null) return code;
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

export async function runTurboBoundaries(cwd = process.cwd()): Promise<number> {
  const turbo = spawn("pnpm", ["exec", "turbo", "boundaries", "--no-color"], {
    cwd,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  let interruptedBy: InterruptSignal | undefined;
  let spawnFailed = false;

  const forwardSignal = (signal: InterruptSignal): void => {
    if (turbo.exitCode !== null || turbo.signalCode !== null) return;

    interruptedBy ??= signal;
    if (turbo.pid === undefined) return;
    try {
      if (process.platform !== "win32") {
        process.kill(-turbo.pid, signal);
      } else {
        turbo.kill(signal);
      }
    } catch {
      turbo.kill(signal);
    }
  };
  const forwardInterrupt = (): void => forwardSignal("SIGINT");
  const forwardTerminate = (): void => forwardSignal("SIGTERM");

  process.on("SIGINT", forwardInterrupt);
  process.on("SIGTERM", forwardTerminate);

  return await new Promise<number>((resolveStatus) => {
    turbo.once("spawn", () => {
      if (interruptedBy !== undefined) forwardSignal(interruptedBy);
    });
    turbo.once("error", (error) => {
      spawnFailed = true;
      process.stderr.write(`无法运行 Turbo boundaries：${error.message}\n`);
    });
    turbo.once("close", (code, signal) => {
      process.off("SIGINT", forwardInterrupt);
      process.off("SIGTERM", forwardTerminate);
      resolveStatus(exitStatus(code, signal, interruptedBy, spawnFailed));
    });
  });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = await runTurboBoundaries();
}
