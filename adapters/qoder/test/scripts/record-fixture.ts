// 录制真实 qoder 消息流为 fixture（ADR-0010 的“录制转写”层）。
// 运行前置：本机 qodercn 登录态 + QODERCLI_PATH 指向 CN CLI。
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  qodercliAuth,
  query,
  type SDKMessage,
} from "@qodercn-ai/qodercn-agent-sdk";

import { prepareFixtureCandidate } from "./fixture-candidate.ts";
import { installRecordedFixtureCandidates } from "./fixture-install.ts";

const scenarios = {
  "list-and-tool": {
    prompt: "用一条 shell 命令列出当前目录的内容",
    minimumNativeToolCount: 1,
  },
  "two-tools": {
    prompt:
      "必须在同一个回合中按顺序且不可合并地调用 Bash 工具恰好两次：第一次只执行 printf first，第二次只执行 printf second；两次工具完成后再总结结果。",
    minimumNativeToolCount: 2,
  },
} as const;

type ScenarioName = keyof typeof scenarios;
function isScenarioName(value: string): value is ScenarioName {
  return Object.hasOwn(scenarios, value);
}

async function installedQoderSdkVersion(): Promise<string> {
  const entry = import.meta.resolve("@qodercn-ai/qodercn-agent-sdk");
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", entry), "utf8"),
  ) as { version?: unknown };
  if (typeof packageJson.version !== "string") {
    throw new Error("Installed Qoder SDK package has no version");
  }
  return packageJson.version;
}

type FixtureRecording = {
  sourceRaw: string;
  recordedAt: string;
  timedOut: boolean;
};

async function recordQoderFixture(
  scenario: (typeof scenarios)[ScenarioName],
): Promise<FixtureRecording> {
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
      sourceRaw: `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
      recordedAt,
      timedOut,
    };
  } finally {
    clearTimeout(timeout);
    abortController.abort();
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function runFixtureRecording(
  options: {
    name: ScenarioName;
    fixtureDirectory?: string;
    anchorsRaw?: string;
  },
  dependencies: {
    record?: (
      scenario: (typeof scenarios)[ScenarioName],
    ) => Promise<FixtureRecording>;
    installedSdkVersion?: () => Promise<string>;
    prepare?: typeof prepareFixtureCandidate;
    install?: typeof installRecordedFixtureCandidates;
  } = {},
): Promise<{ uniqueNativeToolCount: number; contentResultCount: number }> {
  const scenario = scenarios[options.name];
  const recording = await (dependencies.record ?? recordQoderFixture)(scenario);
  const installedSdkVersion = await (
    dependencies.installedSdkVersion ?? installedQoderSdkVersion
  )();
  const candidate = await (dependencies.prepare ?? prepareFixtureCandidate)({
    name: options.name,
    sourceRaw: recording.sourceRaw,
    recordedAt: recording.recordedAt,
    sdkVersion: installedSdkVersion,
    installedSdkVersion,
    minimumNativeToolCount: scenario.minimumNativeToolCount,
    timedOut: recording.timedOut,
  });
  const fixtureDirectory =
    options.fixtureDirectory ??
    fileURLToPath(new URL("../fixtures/", import.meta.url));
  await mkdir(fixtureDirectory, { recursive: true });
  const anchorsRaw =
    options.anchorsRaw ??
    (await readFile(join(fixtureDirectory, "anchors.json"), "utf8"));
  await (dependencies.install ?? installRecordedFixtureCandidates)({
    fixtureDirectory,
    anchorsRaw,
    candidates: [{ name: options.name, ...candidate }],
  });
  return candidate.facts;
}

async function main(): Promise<void> {
  const requestedName =
    process.argv.slice(2).find((value) => value !== "--") ?? "list-and-tool";
  if (!isScenarioName(requestedName)) {
    throw new Error(`Unknown fixture scenario: ${requestedName}`);
  }
  const facts = await runFixtureRecording({ name: requestedName });
  console.log(
    `Recorded fixture ${requestedName}: nativeTools=${facts.uniqueNativeToolCount}`,
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(invokedPath).href === import.meta.url
) {
  await main();
}
