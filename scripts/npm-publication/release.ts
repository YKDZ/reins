import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { isJsonObject } from "../release-package.ts";
import { fail, PublicationFailure } from "./handoff.ts";
import { readJsonResult, runProcess } from "./process.ts";
import { verifyPublishedGroup, type PublicationOptions } from "./publish.ts";

// 发布前重新核实 npm 两包；GitHub 写权限不等于 npm 发布成功。
export async function runImmutableGithubRelease(
  options: PublicationOptions,
): Promise<void> {
  const group = await verifyPublishedGroup(options);
  if (!options.environment.GH_TOKEN)
    fail("github-token-missing", "Release 步骤缺少 GitHub 授权");
  const run = options.run ?? runProcess;
  const environment: NodeJS.ProcessEnv = {
    PATH: options.environment.PATH,
    HOME: options.environment.HOME,
    GH_TOKEN: options.environment.GH_TOKEN,
    GH_PROMPT_DISABLED: "1",
  };
  const repo = group.receipt.publication.repository;
  const tag = `v${group.version}`;
  const annotation = `Reins candidate SHA-256: ${group.receiptSha256}\nPublication run: ${options.environment.GITHUB_RUN_ID}`;
  const directory = await mkdtemp(
    join(options.environment.RUNNER_TEMP ?? tmpdir(), "reins-release-"),
  );
  const gh = async (args: readonly string[]) =>
    await run(
      "gh",
      [...args, ...(args[0] === "release" ? ["--repo", repo] : [])],
      { cwd: options.repository, env: environment },
    );
  const json = async (args: readonly string[]) =>
    readJsonResult(await gh(args), "release-remote-unavailable");
  const api = async (path: string) => await json(["api", path]);
  const write = async (args: readonly string[]) => {
    const result = await gh(args);
    if (result.exitCode !== 0)
      fail(
        "release-write-failed",
        "Release 步骤失败；保留原候选与公开状态后重跑",
      );
    return result;
  };
  try {
    const assertImmutableSetting = async () => {
      const value = await api(`repos/${repo}/immutable-releases`);
      if (!isJsonObject(value) || value.enabled !== true)
        fail("release-immutability-unproven", "仓库必须先启用不可变 Release");
    };
    await assertImmutableSetting();
    const files = (await readdir(group.directory)).toSorted();
    const bytes = new Map(
      await Promise.all(
        files.map(
          async (name) =>
            [name, await readFile(join(group.directory, name))] as const,
        ),
      ),
    );
    const readTag = async (): Promise<Record<string, unknown> | undefined> => {
      const result = await gh([
        "api",
        "--include",
        `repos/${repo}/git/ref/tags/${tag}`,
      ]);
      if (result.exitCode !== 0) {
        if (/^HTTP\/\S+ 404(?:\s|$)/mu.test(result.stdout)) return undefined;
        fail("release-remote-unavailable", "无法读取远端 tag");
      }
      const body = result.stdout
        .split(/\r?\n\r?\n/u)
        .slice(1)
        .join("\n\n");
      const ref: unknown = JSON.parse(body);
      if (
        !isJsonObject(ref) ||
        !isJsonObject(ref.object) ||
        ref.object.type !== "tag" ||
        typeof ref.object.sha !== "string"
      )
        fail("release-tag-conflict", "发布 tag 必须是已绑定候选的注解 tag");
      const value = await api(`repos/${repo}/git/tags/${ref.object.sha}`);
      if (
        !isJsonObject(value) ||
        value.tag !== tag ||
        value.message !== annotation ||
        !isJsonObject(value.object) ||
        value.object.type !== "commit" ||
        value.object.sha !== group.receipt.source.commit
      )
        fail("release-tag-conflict", "tag 的源码、候选或发布运行发生冲突");
      return value;
    };
    const readRelease = async (): Promise<
      Record<string, unknown> | undefined
    > => {
      const pages = await json([
        "api",
        "--paginate",
        "--slurp",
        `repos/${repo}/releases?per_page=100`,
      ]);
      if (!Array.isArray(pages) || !pages.every(Array.isArray))
        fail("release-remote-unavailable", "Release 清单无效");
      const matches = pages
        .flat()
        .filter((value) => isJsonObject(value) && value.tag_name === tag);
      if (matches.length > 1) fail("release-conflict", "存在重复的 Release");
      const value: unknown = matches[0];
      if (value === undefined) return undefined;
      if (
        !isJsonObject(value) ||
        value.name !== tag ||
        value.body !== group.receipt.publication.releaseNotes ||
        typeof value.draft !== "boolean" ||
        typeof value.immutable !== "boolean" ||
        !Array.isArray(value.assets)
      )
        fail("release-conflict", "Release 身份与原候选不一致");
      return value;
    };
    let reference = await readTag();
    let release = await readRelease();
    if (
      Number(options.environment.GITHUB_RUN_ATTEMPT) === 1 &&
      (reference !== undefined || release !== undefined)
    )
      fail("fresh-release-conflict", "新发布不能复用已有 tag 或 Release");
    if (reference === undefined && release !== undefined)
      fail("release-tag-conflict", "Release 的 tag 缺失");
    if (reference === undefined) {
      const created = readJsonResult(
        await write([
          "api",
          "--method",
          "POST",
          `repos/${repo}/git/tags`,
          "-f",
          `tag=${tag}`,
          "-f",
          `message=${annotation}`,
          "-f",
          `object=${group.receipt.source.commit}`,
          "-f",
          "type=commit",
        ]),
        "release-write-failed",
      );
      if (!isJsonObject(created) || typeof created.sha !== "string")
        fail("release-write-failed", "未返回 tag 身份");
      await write([
        "api",
        "--method",
        "POST",
        `repos/${repo}/git/refs`,
        "-f",
        `ref=refs/tags/${tag}`,
        "-f",
        `sha=${created.sha}`,
      ]);
      reference = await readTag();
      if (reference === undefined)
        fail("release-write-failed", "创建的 tag 尚不可见");
    }
    if (release === undefined) {
      const notes = join(directory, "notes.md");
      await writeFile(notes, group.receipt.publication.releaseNotes);
      await write([
        "release",
        "create",
        tag,
        ...files.map((name) => join(group.directory, name)),
        "--draft",
        "--verify-tag",
        "--title",
        tag,
        "--notes-file",
        notes,
      ]);
      release = await readRelease();
      if (release === undefined)
        fail("release-write-failed", "创建的草稿尚不可见");
    }
    const assets = release.assets;
    if (!Array.isArray(assets)) fail("release-conflict", "Release 附件无效");
    const seen = new Set<string>();
    for (const value of assets) {
      if (
        !isJsonObject(value) ||
        typeof value.name !== "string" ||
        !Number.isSafeInteger(value.id) ||
        typeof value.id !== "number" ||
        seen.has(value.name) ||
        !bytes.has(value.name) ||
        value.size !== bytes.get(value.name)!.length
      )
        fail("release-asset-conflict", "Release 附件与原候选不一致");
      seen.add(value.name);
      const output = join(directory, value.name);
      const result = await gh([
        "release",
        "download",
        tag,
        "--pattern",
        value.name,
        "--dir",
        directory,
      ]);
      if (
        result.exitCode !== 0 ||
        !createHash("sha256")
          .update(await readFile(output))
          .digest()
          .equals(createHash("sha256").update(bytes.get(value.name)!).digest())
      )
        fail("release-asset-conflict", "Release 附件字节与候选不一致");
    }
    const missing = files.filter((name) => !seen.has(name));
    if (release.draft === true) {
      // 失败的上传可补齐缺项；既有附件已逐字节核实，绝不覆盖。
      if (missing.length > 0)
        await write([
          "release",
          "upload",
          tag,
          ...missing.map((name) => join(group.directory, name)),
        ]);
      if ((await readTag()) === undefined)
        fail("release-tag-conflict", "发布前 tag 缺失");
      await assertImmutableSetting();
      await write(["release", "edit", tag, "--draft=false"]);
      release = await readRelease();
    } else if (missing.length > 0)
      fail("release-asset-conflict", "公开 Release 缺少附件");
    if (
      release === undefined ||
      release.draft !== false ||
      release.immutable !== true ||
      typeof release.published_at !== "string" ||
      !Array.isArray(release.assets) ||
      release.assets.length !== files.length
    )
      fail("release-immutability-unproven", "无法证实完整的不可变 Release");
    await readTag();
    for (const args of [
      ["release", "verify", tag],
      ...files.map((name) => [
        "release",
        "verify-asset",
        tag,
        join(group.directory, name),
      ]),
    ]) {
      if ((await gh(args)).exitCode !== 0)
        fail("release-attestation-invalid", "Release 或附件证明核验失败");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    await runImmutableGithubRelease({
      repository: process.cwd(),
      artifactDirectory: resolve(
        process.env.PUBLICATION_ARTIFACT_DIRECTORY ?? ".artifacts/release",
      ),
      environment: process.env,
    });
    process.stdout.write("同组双包的不可变 Release 已核验\n");
  } catch (error) {
    if (!(error instanceof PublicationFailure)) throw error;
    process.stderr.write(`${error.code}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
