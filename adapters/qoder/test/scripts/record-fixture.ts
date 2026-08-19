// 录制真实 qoder 消息流为 fixture（ADR-0010 的"录制转写"层）。
// 运行前置：本机 qodercn 登录态 + QODERCLI_PATH 指向 CN CLI。
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { qodercliAuth, query } from "@qodercn-ai/qodercn-agent-sdk";

const name = process.argv[2] ?? "list-and-tool";
const workdir = await mkdtemp(join(tmpdir(), "reins-fixture-"));
await writeFile(join(workdir, "alpha.txt"), "alpha\n");
await writeFile(join(workdir, "beta.md"), "# beta\n");

const abortController = new AbortController();
const q = query({
  prompt: "用一条 shell 命令列出当前目录的内容",
  options: {
    auth: qodercliAuth(),
    cwd: workdir,
    model: "qwen3.7-flash",
    persistSession: false,
    includePartialMessages: true,
    permissionMode: "default",
    canUseTool: async (toolName, input, options) => ({
      behavior: "allow",
      updatedInput: input,
      toolUseID: options.toolUseID,
    }),
    abortController,
  },
});

const timeout = setTimeout(() => {
  console.error("录制超时，中止");
  abortController.abort();
}, 120_000);

try {
  const lines: string[] = [];
  for await (const message of q) {
    lines.push(JSON.stringify(message));
    if (message.type === "result") break;
  }
  const fixturesDir = new URL("../fixtures/", import.meta.url);
  mkdirSync(fixturesDir, { recursive: true });
  writeFileSync(new URL(`${name}.jsonl`, fixturesDir), `${lines.join("\n")}\n`);
  console.log(`已录制 ${lines.length} 条消息 → test/fixtures/${name}.jsonl`);
} finally {
  clearTimeout(timeout);
  abortController.abort();
  await rm(workdir, { recursive: true, force: true }).catch(() => {});
  process.exit(0);
}
