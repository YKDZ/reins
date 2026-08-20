// 录制真实 codex app-server 的入站消息为 fixture（ADR-0010）。
// 前置：本机 codex 登录态；模型可经 REINS_LIVE_SMOKE_MODEL 覆盖。
import { mkdirSync, writeFileSync } from "node:fs";

import { createCodexTransport } from "#/transport";

const name = process.argv[2] ?? "list-and-tool";
const model = process.env.REINS_LIVE_SMOKE_MODEL ?? "gpt-5.3-codex-spark";
const transport = createCodexTransport({});
transport.start();

const lines: unknown[] = [];
const timeout = setTimeout(() => {
  console.error("录制超时，中止");
  void transport.close();
}, 120_000);

try {
  await transport.request("initialize", {
    clientInfo: { name: "reins-record", title: null, version: "0.0.0" },
    capabilities: null,
  });
  transport.notify("initialized", {});
  const thread = (await transport.request("thread/start", {
    ephemeral: true,
    cwd: process.cwd(),
    approvalPolicy: "on-request",
    model,
  })) as { thread: { id: string } };
  await transport.request("turn/start", {
    threadId: thread.thread.id,
    input: [
      {
        type: "text",
        text: "用一条 shell 命令列出当前目录的内容",
        text_elements: [],
      },
    ],
    model,
  });
  for await (const message of transport.messages) {
    lines.push(message);
    if (
      message.kind === "request" &&
      (message.method === "item/commandExecution/requestApproval" ||
        message.method === "item/fileChange/requestApproval")
    ) {
      transport.respond(message.id, { decision: "accept" });
    }
    if (
      message.kind === "notification" &&
      message.method === "turn/completed"
    ) {
      break;
    }
  }
  const fixturesDir = new URL("../fixtures/", import.meta.url);
  mkdirSync(fixturesDir, { recursive: true });
  writeFileSync(
    new URL(`${name}.jsonl`, fixturesDir),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );
  console.log(`已录制 ${lines.length} 条消息 → test/fixtures/${name}.jsonl`);
} finally {
  clearTimeout(timeout);
  await transport.close();
  process.exit(0);
}
