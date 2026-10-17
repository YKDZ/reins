import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertReleaseVersionAuthority,
  isJsonObject,
} from "../release-package.ts";
import { acceptPublicationGroup, fail, PublicationFailure } from "./handoff.ts";
import {
  assertPublicationContext,
  explicitNotFound,
  npmSession,
  readJsonResult,
  runProcess,
  type ProcessRunner,
} from "./process.ts";

// 只读取默认分支同提交的成功 Check；没有原候选时不得接续已经公开的 SDK。
export async function selectPublicationCandidate(options: {
  readonly repository: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly run?: ProcessRunner;
}): Promise<string | undefined> {
  assertPublicationContext(options.environment, false);
  const env = options.environment;
  const run = options.run ?? runProcess;
  const ghEnv = {
    PATH: env.PATH,
    GH_TOKEN: env.GH_TOKEN,
    GH_PROMPT_DISABLED: "1",
  };
  const gh = async (args: readonly string[]) =>
    await run("gh", args, { cwd: options.repository, env: ghEnv });
  const runs = readJsonResult(
    await gh([
      "run",
      "list",
      "--repo",
      env.GITHUB_REPOSITORY!,
      "--workflow",
      "check.yml",
      "--branch",
      env.GITHUB_DEFAULT_BRANCH!,
      "--commit",
      env.GITHUB_SHA!,
      "--status",
      "success",
      "--event",
      "push",
      "--json",
      "databaseId,headSha,conclusion,event",
      "--limit",
      "20",
    ]),
    "candidate-source-unavailable",
  );
  if (!Array.isArray(runs))
    fail("candidate-source-unavailable", "无法读取成功的主分支验收");
  const successful = runs.filter(
    (value) =>
      isJsonObject(value) &&
      Number.isSafeInteger(value.databaseId) &&
      value.headSha === env.GITHUB_SHA &&
      value.conclusion === "success" &&
      value.event === "push",
  );
  for (const record of successful) {
    const directory = await mkdtemp(
      join(env.RUNNER_TEMP ?? tmpdir(), "reins-original-candidate-"),
    );
    const downloaded = await gh([
      "run",
      "download",
      String(record.databaseId),
      "--repo",
      env.GITHUB_REPOSITORY!,
      "--name",
      "release-package",
      "--dir",
      directory,
    ]);
    if (downloaded.exitCode !== 0) {
      await rm(directory, { recursive: true, force: true });
      continue;
    }
    const group = acceptPublicationGroup({
      repository: options.repository,
      artifactDirectory: directory,
      expectedCommit: env.GITHUB_SHA!,
      githubRepository: env.GITHUB_REPOSITORY!,
      requireClean: true,
    });
    if (
      group.receipt.producer.runId !== String(record.databaseId) ||
      group.receipt.producer.workflow !==
        `${env.GITHUB_REPOSITORY}/.github/workflows/check.yml@refs/heads/${env.GITHUB_DEFAULT_BRANCH}`
    )
      fail(
        "candidate-source-conflict",
        "候选回执不是此主分支 Check 产生的材料",
      );
    return directory;
  }
  const session = await npmSession(options);
  try {
    const { version } = assertReleaseVersionAuthority(options.repository);
    const existing = await session.npm([
      "view",
      `@ykdz/reins-sdk@${version}`,
      "--json",
    ]);
    if (!explicitNotFound(existing)) {
      readJsonResult(existing, "registry-unavailable");
      fail(
        "original-candidate-required",
        "SDK 已存在而原候选不可用；不能重新打包，请恢复原候选或准备新版本",
      );
    }
    return undefined;
  } finally {
    await session.cleanup();
  }
}

if (import.meta.main) {
  try {
    const directory = await selectPublicationCandidate({
      repository: process.cwd(),
      environment: process.env,
    });
    if (directory !== undefined) {
      if (!process.env.GITHUB_ENV)
        fail("candidate-environment-missing", "工作流环境文件缺失");
      await appendFile(
        process.env.GITHUB_ENV,
        `REINS_RELEASE_CANDIDATE_DIR=${directory}\n`,
      );
      process.stdout.write("已选择同提交成功验收产生的原候选\n");
    } else
      process.stdout.write(
        "尚无已接受候选且 SDK 未公开；本次正式完整验收将产生候选\n",
      );
  } catch (error) {
    if (!(error instanceof PublicationFailure)) throw error;
    process.stderr.write(`${error.code}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
