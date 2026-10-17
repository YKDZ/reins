import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { isJsonObject } from "../release-package.ts";
import { acceptPublicationGroup, fail, PublicationFailure } from "./handoff.ts";
import {
  explicitNotFound,
  npmSession,
  readJsonResult,
  type ProcessRunner,
} from "./process.ts";
import {
  inspectRegistryPackage,
  isInitialSdk,
  verifyPublishedPackage,
} from "./registry.ts";

type SetupOptions = {
  readonly repository: string;
  readonly artifactDirectory: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly run?: ProcessRunner;
  readonly confirm?: (phrase: string) => Promise<void>;
};

// npm 12 的 trust list 输出由空白分隔的 JSON 对象组成，空清单为空字符串。
function trustRecords(source: string): readonly Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (depth === 0 && /\s/u.test(char)) continue;
    if (depth === 0) {
      if (char !== "{") fail("trust-invalid", "npm trust 未返回对象清单");
      start = i;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) {
        const value: unknown = JSON.parse(source.slice(start, i + 1));
        if (!isJsonObject(value)) fail("trust-invalid", "npm trust 对象无效");
        records.push(value);
      }
    }
  }
  if (depth !== 0 || quoted) fail("trust-invalid", "npm trust 对象不完整");
  return records;
}

export async function prepareSdkBootstrap(
  options: SetupOptions,
): Promise<void> {
  const group = acceptPublicationGroup({ ...options, requireClean: true });
  const sdk = group.artifacts[0]!;
  process.stdout.write(
    `候选 ${group.receipt.source.commit}\nSDK ${sdk.packageName}@${sdk.version}\nSHA-512 ${sdk.sha512}\n仓库 ${group.receipt.publication.repository}\n首发只使用这份原始 tgz；不会创建 Release。\n`,
  );
}

export async function runSdkBootstrap(options: SetupOptions): Promise<void> {
  if (options.confirm === undefined)
    fail("confirmation-required", "人工首发必须由维护者交互确认");
  await prepareSdkBootstrap(options);
  const group = acceptPublicationGroup({ ...options, requireClean: true });
  const repo = group.receipt.publication.repository;
  const session = await npmSession(options);
  let loginStarted = false;
  try {
    const github = async (path: string) =>
      readJsonResult(
        await session.run("gh", ["api", path], {
          cwd: options.repository,
          env: {
            PATH: options.environment.PATH,
            GH_TOKEN: options.environment.GH_TOKEN,
            HOME: options.environment.HOME,
          },
        }),
        "github-unavailable",
      );
    const repository = await github(`repos/${repo}`);
    if (
      !isJsonObject(repository) ||
      typeof repository.default_branch !== "string"
    )
      fail("github-invalid", "无法确认默认分支");
    const commit = await github(
      `repos/${repo}/commits/${repository.default_branch}`,
    );
    if (
      !isJsonObject(commit) ||
      commit.sha !== group.receipt.source.commit ||
      group.receipt.producer.workflow !==
        `${repo}/.github/workflows/check.yml@refs/heads/${repository.default_branch}` ||
      group.receipt.producer.runId === null
    )
      fail(
        "bootstrap-source-conflict",
        "首发必须使用已推送到默认分支并通过 Check 的原候选",
      );
    const check = await github(
      `repos/${repo}/actions/runs/${group.receipt.producer.runId}`,
    );
    if (
      !isJsonObject(check) ||
      check.head_sha !== group.receipt.source.commit ||
      check.conclusion !== "success" ||
      check.event !== "push" ||
      check.path !== ".github/workflows/check.yml"
    )
      fail("bootstrap-source-conflict", "候选对应的主分支验收未通过");
    process.stdout.write(
      "阶段 1/3：在 npm 自己的终端流程中登录；不向代理发送凭据。\n",
    );
    await options.confirm("确认 npm 2FA 和恢复码已准备");
    loginStarted = true;
    if (
      (await session.npm(["login", "--auth-type=web"], session.directory, true))
        .exitCode !== 0
    )
      fail("npm-login-failed", "npm 登录未完成");
    if ((await session.npm(["whoami"])).exitCode !== 0)
      fail("npm-login-failed", "无法确认登录会话");
    const sdk = group.artifacts[0]!;
    const existing = await session.npm([
      "view",
      sdk.packageName,
      "versions",
      "--json",
    ]);
    process.stdout.write(
      "阶段 2/3：首发真实 SDK 候选；已存在的首发只能逐字节核验后接续。\n",
    );
    if (explicitNotFound(existing)) {
      await options.confirm(
        `发布 ${sdk.packageName}@${sdk.version} SHA512 ${sdk.sha512}`,
      );
      // 人工认证首发没有 GitHub OIDC provenance，后续核验单独记录这一事实。
      if (
        (
          await session.npm(
            ["publish", sdk.path, "--access=public"],
            session.directory,
            true,
          )
        ).exitCode !== 0
      )
        fail("sdk-bootstrap-failed", "SDK 首发未完成；保留原候选后重试");
    } else readJsonResult(existing, "registry-unavailable");
    const state = await inspectRegistryPackage(session, sdk);
    if (!isInitialSdk(state))
      fail("sdk-bootstrap-conflict", "此向导只处理 SDK 的第一个真实版本");
    await verifyPublishedPackage(
      session,
      state,
      group,
      options.environment,
      true,
    );
    process.stdout.write(
      "阶段 3/3：为双包配置 release.yml 的直接发布权限，不使用 Environment 或暂存发布权限。\n",
    );
    for (const artifact of group.artifacts) {
      const readTrust = async () => {
        const result = await session.npm([
          "trust",
          "list",
          artifact.packageName,
          "--json",
        ]);
        if (result.exitCode !== 0)
          fail("trust-unavailable", "无法读取 trusted publisher");
        return trustRecords(result.stdout);
      };
      const exact = (value: Record<string, unknown>, preview: boolean) =>
        (preview ? !Object.hasOwn(value, "type") : value.type === "github") &&
        value.repository === repo &&
        value.file === "release.yml" &&
        !Object.hasOwn(value, "environment") &&
        Array.isArray(value.permissions) &&
        value.permissions.length === 1 &&
        value.permissions[0] === "createPackage" &&
        (preview
          ? value.package === artifact.packageName
          : typeof value.id === "string") &&
        Object.keys(value).every((key) =>
          [
            preview ? "package" : "id",
            ...(preview ? [] : ["type"]),
            "repository",
            "file",
            "permissions",
          ].includes(key),
        );
      const records = await readTrust();
      if (records.length === 1 && exact(records[0]!, false)) continue;
      if (records.length !== 0)
        fail(
          "trust-conflict",
          `请在 https://www.npmjs.com/package/${artifact.packageName}/access 审核并移除旧的或冲突的 trusted publisher，然后使用原候选重试；向导不会删除授权`,
        );
      const args = [
        "trust",
        "github",
        artifact.packageName,
        `--repository=${repo}`,
        "--file=release.yml",
        "--allow-publish",
      ];
      const preview = readJsonResult(
        await session.npm([...args, "--dry-run", "--json"]),
        "trust-preview-invalid",
      );
      if (!isJsonObject(preview) || !exact(preview, true))
        fail("trust-preview-invalid", "trusted publisher 预览与约定不一致");
      await options.confirm(
        `授权 ${artifact.packageName} ${repo} release.yml createPackage`,
      );
      if ((await readTrust()).length !== 0)
        fail("trust-conflict", "确认期间授权发生变化，请重新审核");
      if (
        (await session.npm([...args, "--yes"], session.directory, true))
          .exitCode !== 0
      )
        fail("trust-write-failed", "授权写入未完成");
      const confirmed = await readTrust();
      if (confirmed.length !== 1 || !exact(confirmed[0]!, false))
        fail("trust-readback-failed", "授权读回与约定不一致");
    }
    process.stdout.write(
      "SDK 人工首发及双包直接发布授权已核验；请保留原候选，再从默认分支手动触发发布工作流。\n",
    );
  } finally {
    try {
      if (loginStarted) await session.npm(["logout"]);
    } finally {
      await session.cleanup();
    }
  }
}

if (import.meta.main) {
  const options = {
    repository: process.cwd(),
    artifactDirectory: resolve(
      process.env.PUBLICATION_ARTIFACT_DIRECTORY ?? ".artifacts/release",
    ),
    environment: process.env,
  };
  try {
    if (process.argv.includes("--execute")) {
      if (!process.stdin.isTTY || !process.stdout.isTTY)
        fail("tty-required", "人工首发需要交互终端");
      const prompt = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        await runSdkBootstrap({
          ...options,
          confirm: async (phrase) => {
            if ((await prompt.question(`请输入「${phrase}」继续：`)) !== phrase)
              fail("cancelled", "维护者取消操作");
          },
        });
      } finally {
        prompt.close();
      }
    } else await prepareSdkBootstrap(options);
  } catch (error) {
    if (!(error instanceof PublicationFailure)) throw error;
    process.stderr.write(`${error.code}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
