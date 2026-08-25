// 录制真实 qoder 消息流为 fixture（ADR-0010 的“录制转写”层）。
// 运行前置：本机 qodercn 登录态 + QODERCLI_PATH 指向 CN CLI。
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  qodercliAuth,
  query,
  type SDKMessage,
} from "@qodercn-ai/qodercn-agent-sdk";

import {
  projectRecordedQoderMessages,
  recordedQoderScenarios,
  RECORDED_QODER_PROJECTION_VERSION,
  serializeRecordedQoderMessages,
  serializeRecordedQoderMetadata,
  toQoderSdkMessages,
  type RecordedQoderFixtureMetadata,
  type RecordedQoderMessage,
} from "../../src/fixture-projection.ts";
import {
  assertMatchesKnownCredentialPolicy,
  replaceFixturePair,
} from "./fixture-files.ts";
import { assertQoderProjectionSemanticEquivalence } from "./fixture-fingerprint.ts";
import { validateRecordedFixture } from "./fixture-validation.ts";

const scenarios = {
  "list-and-tool": {
    prompt: "用一条 shell 命令列出当前目录的内容",
    description: recordedQoderScenarios["list-and-tool"],
    minimumNativeToolCount: 1,
  },
  "two-tools": {
    prompt:
      "必须在同一个回合中按顺序且不可合并地调用 Bash 工具恰好两次：第一次只执行 printf first，第二次只执行 printf second；两次工具完成后再总结结果。",
    description: recordedQoderScenarios["two-tools"],
    minimumNativeToolCount: 2,
  },
} as const;

type ScenarioName = keyof typeof scenarios;
function isScenarioName(value: string): value is ScenarioName {
  return Object.hasOwn(scenarios, value);
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
  messages: readonly RecordedQoderMessage[],
  jsonl: string,
  uniqueNativeToolCount: number,
  installedSdkVersion: string,
  recordedAt: string,
): RecordedQoderFixtureMetadata {
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
  return {
    fixture: `${name}.jsonl`,
    recordedAt,
    sdkVersion: installedSdkVersion,
    qoderCliVersion: init.qodercli_version,
    protocolVersion: init.protocol_version,
    projectionVersion: RECORDED_QODER_PROJECTION_VERSION,
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

let timedOut = false;
const timeout = setTimeout(() => {
  timedOut = true;
  console.error("Fixture recording timed out; aborting");
  abortController.abort();
}, 120_000);

try {
  const messages: SDKMessage[] = [];
  for await (const message of q) {
    messages.push(message);
    if (message.type === "result") break;
  }
  assertMatchesKnownCredentialPolicy(messages);
  const projected = projectRecordedQoderMessages(messages);
  assertMatchesKnownCredentialPolicy(projected);
  await assertQoderProjectionSemanticEquivalence(messages);
  const facts = validateRecordedFixture(toQoderSdkMessages(projected), {
    timedOut,
    minimumNativeToolCount: scenario.minimumNativeToolCount,
  });
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
  const jsonl = serializeRecordedQoderMessages(projected);
  const metadata = buildMetadata(
    requestedName,
    scenario,
    projected,
    jsonl,
    facts.uniqueNativeToolCount,
    await sdkVersion(),
    recordedAt,
  );
  const fixturesDir = new URL("../fixtures/", import.meta.url);
  await mkdir(fixturesDir, { recursive: true });
  await replaceFixturePair({
    jsonlPath: fileURLToPath(new URL(`${requestedName}.jsonl`, fixturesDir)),
    metadataPath: fileURLToPath(
      new URL(`${requestedName}.metadata.json`, fixturesDir),
    ),
    jsonl,
    metadata: serializeRecordedQoderMetadata(metadata),
  });
  console.log(
    `Recorded fixture ${requestedName}: lines=${metadata.lineCount}, nativeTools=${metadata.uniqueNativeToolCount}, sha256=${metadata.sha256}`,
  );
} finally {
  clearTimeout(timeout);
  abortController.abort();
  await rm(workdir, { recursive: true, force: true }).catch(() => {});
}
