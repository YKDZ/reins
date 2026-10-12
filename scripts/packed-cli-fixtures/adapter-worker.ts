// 该进程树只供正式制品验收：每个真实子进程各自持有一个追加文件描述符。
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

type ActivityWriter = {
  close(): void;
};

function openActivity(path: string, role: string): ActivityWriter {
  if (path === "") return { close() {} };
  mkdirSync(dirname(path), { recursive: true });
  const descriptor = openSync(path, "a", 0o600);
  const write = (type: string) => {
    writeSync(
      descriptor,
      `${JSON.stringify({ type, role, pid: process.pid })}\n`,
    );
  };
  write("opened");
  const interval = setInterval(() => write("heartbeat"), 50);
  return {
    close() {
      clearInterval(interval);
      write("closed");
      closeSync(descriptor);
    },
  };
}

async function runWorker(activityPath: string): Promise<void> {
  const activity = openActivity(activityPath, "worker");
  const descendant = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "descendant", activityPath],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const descendantClosed = new Promise<void>((resolve) => {
    descendant.once("close", () => resolve());
  });
  descendant.stdout?.setEncoding("utf8");
  descendant.stdout?.on("data", (data: string) => {
    if (data.includes("ready")) {
      process.send?.({
        descendantPid: descendant.pid,
        workerCwd: process.cwd(),
      });
      descendant.stdout?.destroy();
    }
  });
  let stopping = false;
  process.once("SIGTERM", () => {
    if (stopping) return;
    stopping = true;
    activity.close();
    descendant.kill("SIGTERM");
    void descendantClosed.then(() => process.exit(0));
  });
}

function runDescendant(activityPath: string): void {
  const activity = openActivity(activityPath, "descendant");
  process.stdout.write("ready\n");
  process.once("SIGTERM", () => {
    activity.close();
    process.exit(0);
  });
}

const [mode, activityPath = ""] = process.argv.slice(2);
if (mode === "worker") {
  void runWorker(activityPath);
} else if (mode === "descendant") {
  runDescendant(activityPath);
} else {
  throw new Error("Invalid fixture worker mode");
}
