import { spawn } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";

// 仅测试部署的 PID 1；真实 daemon 保持发行字节，允许单独重启其进程。
let stopping = false;
function start() {
  const socket = process.env.REINS_SOCKET;
  if (socket !== undefined) {
    try {
      unlinkSync(socket);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
    }
  }
  const child = spawn(
    process.execPath,
    ["/opt/reins/dist/reins-daemon-original.js"],
    {
      stdio: "inherit",
    },
  );
  writeFileSync(
    "/tmp/reins-daemon-process.json",
    JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }),
  );
  const stop = () => {
    stopping = true;
    child.kill("SIGTERM");
  };
  process.once("SIGTERM", stop);
  child.once("close", () => {
    process.off("SIGTERM", stop);
    if (stopping) process.exit(0);
    start();
  });
}
start();
