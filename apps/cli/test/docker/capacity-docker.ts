import { spawn } from "node:child_process";
import { appendFileSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 透明执行固定原生 Docker 工具，只额外保全实际复制的双流、退出和文件系统事实。
const base = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const destination = args[0] === "cp" ? args[2] : undefined;
const observe = () => {
  if (destination === undefined || destination.includes(":")) return null;
  try {
    return statfsSync(destination);
  } catch {
    return null;
  }
};
const before = observe();
const child = spawn(join(base, "tools", "docker-real"), args, {
  stdio: ["inherit", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk: Buffer) => {
  stdout += chunk.toString();
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk: Buffer) => {
  stderr += chunk.toString();
  process.stderr.write(chunk);
});
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => child.kill(signal));
child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("close", (code, signal) => {
  if (args[0] === "cp")
    appendFileSync(
      join(base, "evidence", "docker-copies.ndjson"),
      JSON.stringify({
        args,
        code,
        signal,
        stdout,
        stderr,
        before,
        after: observe(),
        at: new Date().toISOString(),
      }) + "\n",
    );
  if (signal !== null) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
