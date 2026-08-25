// 录制真实 qoder 消息流为 fixture（ADR-0010 的“录制转写”层）。
// 运行前置：本机 qodercn 登录态 + QODERCLI_PATH 指向 CN CLI。
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  qodercliAuth,
  query,
  type SDKMessage,
} from "@qodercn-ai/qodercn-agent-sdk";

const scenarios = {
  "list-and-tool": {
    prompt: "用一条 shell 命令列出当前目录的内容",
    description:
      "One Bash tool request and result followed by a streamed text reply",
    minimumNativeToolCount: 1,
  },
  "two-tools": {
    prompt:
      "必须在同一个回合中按顺序且不可合并地调用 Bash 工具恰好两次：第一次只执行 printf first，第二次只执行 printf second；两次工具完成后再总结结果。",
    description:
      "Two sequential non-combined Bash tool requests and results followed by a streamed text reply",
    minimumNativeToolCount: 2,
  },
} as const;

type ScenarioName = keyof typeof scenarios;
type FixtureMetadata = {
  fixture: string;
  recordedAt: string;
  sdkVersion: string;
  qoderCliVersion: string;
  protocolVersion: string;
  lineCount: number;
  uniqueNativeToolCount: number;
  sha256: string;
  scenario: string;
};

function isScenarioName(value: string): value is ScenarioName {
  return Object.hasOwn(scenarios, value);
}

function sanitizeMessage(message: SDKMessage): SDKMessage {
  if (message.type === "system" && message.subtype === "init") {
    return { ...message, cwd: "<fixture-cwd>" };
  }
  return message;
}

function inspectTools(messages: readonly SDKMessage[]): {
  requestIds: Set<string>;
  resultIds: Set<string>;
} {
  const requestIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const message of messages) {
    if (message.type === "stream_event") {
      const event = message.event;
      const block = event.content_block;
      if (
        event.type === "content_block_start" &&
        block?.type === "tool_use" &&
        typeof block.id === "string" &&
        block.id.length > 0
      ) {
        requestIds.add(block.id);
      }
      continue;
    }
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (
          block.type === "tool_use" &&
          typeof block.id === "string" &&
          block.id.length > 0
        ) {
          requestIds.add(block.id);
        }
      }
      continue;
    }
    if (message.type === "user" && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (
          block.type === "tool_result" &&
          typeof block.tool_use_id === "string" &&
          block.tool_use_id.length > 0
        ) {
          resultIds.add(block.tool_use_id);
        }
      }
    }
  }
  return { requestIds, resultIds };
}

function assertNoCredentialMaterial(value: unknown): void {
  const sensitiveKey =
    /^(?:access[_-]?token|refresh[_-]?token|authorization|cookie|secret|api[_-]?key)$/iu;
  const sensitiveString =
    /(?:Bearer\s+[A-Za-z0-9._~+/=-]{16,}|\bsk-[A-Za-z0-9_-]{16,})/u;
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      if (sensitiveString.test(candidate)) {
        throw new Error("Fixture contains prohibited credential material");
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (typeof candidate !== "object" || candidate === null) return;
    for (const [key, item] of Object.entries(candidate)) {
      if (
        sensitiveKey.test(key) &&
        item !== undefined &&
        item !== null &&
        item !== "none"
      ) {
        throw new Error("Fixture contains prohibited credential material");
      }
      visit(item);
    }
  };
  visit(value);
}

async function sdkVersion(): Promise<string> {
  const entry = import.meta.resolve("@qodercn-ai/qodercn-agent-sdk");
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", entry), "utf8"),
  ) as { version?: unknown };
  if (typeof packageJson.version !== "string") {
    throw new Error("Installed Qoder SDK package has no version");
  }
  return packageJson.version;
}

function buildMetadata(
  name: ScenarioName,
  scenario: (typeof scenarios)[ScenarioName],
  messages: readonly SDKMessage[],
  jsonl: string,
  uniqueNativeToolCount: number,
  installedSdkVersion: string,
): FixtureMetadata {
  const init = messages.find(
    (message) => message.type === "system" && message.subtype === "init",
  );
  if (init?.type !== "system" || init.subtype !== "init") {
    throw new Error("Recorded stream has no init message");
  }
  if (
    typeof init.protocol_version !== "string" ||
    init.protocol_version.length === 0
  ) {
    throw new Error("Recorded stream has no protocol version");
  }
  const recordedAt = messages
    .flatMap((message) =>
      "timestamp" in message && typeof message.timestamp === "string"
        ? [message.timestamp]
        : [],
    )
    .at(0);
  if (recordedAt === undefined) {
    throw new Error("Recorded stream has no source timestamp");
  }
  return {
    fixture: `${name}.jsonl`,
    recordedAt,
    sdkVersion: installedSdkVersion,
    qoderCliVersion: init.qodercli_version,
    protocolVersion: init.protocol_version,
    lineCount: messages.length,
    uniqueNativeToolCount,
    sha256: createHash("sha256").update(jsonl).digest("hex"),
    scenario: scenario.description,
  };
}

const requestedName =
  process.argv.slice(2).find((value) => value !== "--") ?? "list-and-tool";
if (!isScenarioName(requestedName)) {
  throw new Error(`Unknown fixture scenario: ${requestedName}`);
}
const scenario = scenarios[requestedName];
const workdir = await mkdtemp(join(tmpdir(), "reins-fixture-"));
await writeFile(join(workdir, "alpha.txt"), "alpha\n");
await writeFile(join(workdir, "beta.md"), "# beta\n");

const abortController = new AbortController();
const q = query({
  prompt: scenario.prompt,
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
  console.error("Fixture recording timed out; aborting");
  abortController.abort();
}, 120_000);

try {
  const messages: SDKMessage[] = [];
  for await (const message of q) {
    messages.push(sanitizeMessage(message));
    if (message.type === "result") break;
  }
  const { requestIds, resultIds } = inspectTools(messages);
  const missingResults = [...requestIds].filter((id) => !resultIds.has(id));
  if (
    requestIds.size < scenario.minimumNativeToolCount ||
    missingResults.length > 0
  ) {
    throw new Error(
      `Fixture acceptance failed: requests=${requestIds.size}, contentResults=${resultIds.size}, unmatchedRequests=${missingResults.length}`,
    );
  }
  assertNoCredentialMaterial(messages);
  const jsonl = `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
  const metadata = buildMetadata(
    requestedName,
    scenario,
    messages,
    jsonl,
    requestIds.size,
    await sdkVersion(),
  );
  const fixturesDir = new URL("../fixtures/", import.meta.url);
  await mkdir(fixturesDir, { recursive: true });
  const jsonlTemp = new URL(
    `${requestedName}.jsonl.${process.pid}.tmp`,
    fixturesDir,
  );
  const metadataTemp = new URL(
    `${requestedName}.metadata.json.${process.pid}.tmp`,
    fixturesDir,
  );
  await Promise.all([
    writeFile(jsonlTemp, jsonl),
    writeFile(metadataTemp, `${JSON.stringify(metadata, null, 2)}\n`),
  ]);
  await rename(jsonlTemp, new URL(`${requestedName}.jsonl`, fixturesDir));
  await rename(
    metadataTemp,
    new URL(`${requestedName}.metadata.json`, fixturesDir),
  );
  console.log(
    `Recorded fixture ${requestedName}: lines=${metadata.lineCount}, nativeTools=${metadata.uniqueNativeToolCount}, sha256=${metadata.sha256}`,
  );
} finally {
  clearTimeout(timeout);
  abortController.abort();
  await rm(workdir, { recursive: true, force: true }).catch(() => {});
}
