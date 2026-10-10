import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

process.on("SIGTERM", () => {});
if (process.argv[2] === "descendant") {
  process.send?.("ready");
} else {
  const descendant = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "descendant"],
    {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  // PID 文件必须晚于后代安装 TERM handler，避免早发 TERM 造成假覆盖。
  await new Promise<void>((resolve) =>
    descendant.once("message", () => resolve()),
  );
  await writeFile(
    process.argv[2]!,
    JSON.stringify({ parent: process.pid, descendant: descendant.pid }),
  );
}
setInterval(() => {}, 1000);
