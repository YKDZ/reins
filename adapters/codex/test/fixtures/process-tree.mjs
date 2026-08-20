import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

process.on("SIGTERM", () => {});
const descendant = spawn(
  process.execPath,
  ["-e", 'process.on("SIGTERM",()=>{}); setInterval(()=>{}, 1000)'],
  { stdio: "ignore" },
);
await writeFile(
  process.argv[2],
  JSON.stringify({ parent: process.pid, descendant: descendant.pid }),
);
setInterval(() => {}, 1000);
