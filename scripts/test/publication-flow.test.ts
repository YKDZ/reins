import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";

import { selectPublicationCandidate } from "../npm-publication/candidate.ts";
import {
  sealPublicationGroup,
  type AcceptedPublicationGroup,
} from "../npm-publication/handoff.ts";
import { runProcess, type ProcessRunner } from "../npm-publication/process.ts";
import { runDirectOidcPublication } from "../npm-publication/publish.ts";
import { runImmutableGithubRelease } from "../npm-publication/release.ts";
import {
  prepareSdkBootstrap,
  runSdkBootstrap,
} from "../npm-publication/setup.ts";

async function fixture() {
  const repository = await mkdtemp(join(tmpdir(), "reins-publication-flow-"));
  const artifactDirectory = join(repository, ".artifacts", "release");
  const git = (args: string[]) => {
    const result = spawnSync("git", args, {
      cwd: repository,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    const paths = spawnSync(
      "git",
      ["ls-files", "package.json", "**/package.json"],
      { encoding: "utf8" },
    )
      .stdout.trim()
      .split("\n");
    for (const path of [...paths, "CHANGELOG.md"]) {
      await mkdir(dirname(join(repository, path)), { recursive: true });
      await cp(path, join(repository, path));
    }
    await writeFile(join(repository, ".gitignore"), ".artifacts/\n");
    git(["init", "--initial-branch=main"]);
    git(["add", "."]);
    git([
      "-c",
      "user.name=Publication fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    ]);
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/main",
      GITHUB_DEFAULT_BRANCH: "main",
      GITHUB_REPOSITORY: "YKDZ/reins",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY_ID: "1342443187",
      GITHUB_REPOSITORY_OWNER_ID: "69898831",
      RUNNER_ENVIRONMENT: "github-hosted",
      GITHUB_SHA: git(["rev-parse", "HEAD"]),
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_WORKFLOW_REF:
        "YKDZ/reins/.github/workflows/release.yml@refs/heads/main",
      GH_TOKEN: "fixture",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid/oidc",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture",
    };
    const built = spawnSync(
      process.execPath,
      ["--conditions=source", "scripts/build-distribution.ts"],
      {
        env: {
          ...process.env,
          REINS_ARTIFACTS_DIR: join(repository, ".artifacts"),
          REINS_RELEASE_CANDIDATE_DIR: "",
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.equal(built.status, 0, built.stderr);
    const { version } = JSON.parse(
      await readFile("apps/cli/package.json", "utf8"),
    ) as { version: string };
    const runtimeFile = `ykdz-reins-${version}.tgz`;
    const sdkFile = `ykdz-reins-sdk-${version}.tgz`;
    const digest = async (file: string) =>
      createHash("sha256")
        .update(await readFile(join(artifactDirectory, file)))
        .digest("hex");
    const evidenceFile = join(repository, ".artifacts", "evidence.ndjson");
    await writeFile(
      evidenceFile,
      [
        {
          label: "release_candidate",
          fact: {
            runtime: { file: runtimeFile, sha256: await digest(runtimeFile) },
            sdk: { file: sdkFile, sha256: await digest(sdkFile) },
          },
        },
        { label: "smoke_result", fact: { status: "passed" } },
      ]
        .map((value) => JSON.stringify(value))
        .join("\n") + "\n",
    );
    const group = sealPublicationGroup({
      repository,
      artifactDirectory,
      evidenceFile,
      environment: {
        ...environment,
        GITHUB_WORKFLOW_REF:
          "YKDZ/reins/.github/workflows/check.yml@refs/heads/main",
      },
    });
    return {
      repository,
      artifactDirectory,
      environment,
      group,
      cleanup: async () =>
        await rm(repository, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(repository, { recursive: true, force: true });
    throw error;
  }
}

// 只替换注册表、签名服务和 GitHub 的进程边界；制品及回执仍走正式实现。
function externalServices(
  group: AcceptedPublicationGroup,
  environment: NodeJS.ProcessEnv,
  manualSdk = false,
) {
  const published = new Map<string, number>();
  if (manualSdk) published.set("@ykdz/reins-sdk", 0);
  const writes: { name: string; bytes: Buffer }[] = [];
  const githubWrites: string[] = [];
  let failRuntime = false;
  let failRelease = false;
  let sdkMissing = false;
  let wrongProvenance = false;
  let wrongIntegrity = false;
  let tag: Record<string, unknown> | undefined;
  let ref = false;
  let release: Record<string, unknown> | undefined;
  const assets = new Map<number, { name: string; bytes: Buffer }>();
  const ok = (value: unknown = {}) => ({
    exitCode: 0,
    stdout: JSON.stringify(value),
    stderr: "",
  });
  const notFound = () => ({
    exitCode: 1,
    stdout: JSON.stringify({ error: { code: "E404" } }),
    stderr: "",
  });
  const bundle = (name: string) => {
    const artifact = group.artifacts.find((item) => item.packageName === name)!;
    const repo = "https://github.com/YKDZ/reins";
    const statement = {
      _type: "https://in-toto.io/Statement/v1",
      subject: [
        {
          name: `pkg:npm/${name.replace("@", "%40")}@${group.version}`,
          digest: { sha512: artifact.sha512 },
        },
      ],
      predicateType: "https://slsa.dev/provenance/v1",
      predicate: {
        buildDefinition: {
          externalParameters: {
            workflow: {
              repository: repo,
              path: ".github/workflows/release.yml",
              ref: "refs/heads/main",
            },
          },
          internalParameters: { github: { event_name: "workflow_dispatch" } },
          resolvedDependencies: [
            {
              uri: `git+${repo}@refs/heads/main`,
              digest: {
                gitCommit: wrongProvenance
                  ? "0".repeat(40)
                  : group.receipt.source.commit,
              },
            },
          ],
        },
        runDetails: {
          builder: { id: "https://github.com/actions/runner/github-hosted" },
          metadata: {
            invocationId: `${repo}/actions/runs/123/attempts/${published.get(name)}`,
          },
        },
      },
    };
    return {
      predicateType: statement.predicateType,
      bundle: {
        dsseEnvelope: {
          payloadType: "application/vnd.in-toto+json",
          payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
        },
      },
    };
  };
  const metadata = (name: string) => {
    const artifact = group.artifacts.find((item) => item.packageName === name)!;
    return {
      name,
      version: group.version,
      dist: {
        integrity: wrongIntegrity ? "wrong" : artifact.integrity,
        tarball: `https://registry.npmjs.org/${name}/-/${artifact.file}`,
        ...(published.get(name) === 0 ? {} : { attestations: {} }),
      },
    };
  };
  const run: ProcessRunner = async (command, args, options) => {
    if (basename(command) === "npm") {
      if (args[0] === "view") {
        const name = args[1]!.startsWith("@ykdz/reins-sdk")
          ? "@ykdz/reins-sdk"
          : "@ykdz/reins";
        if (sdkMissing && name === "@ykdz/reins-sdk") return notFound();
        if (args[2] === "versions")
          return ok(
            published.get(name) === 0
              ? [group.version]
              : published.has(name)
                ? ["0.1.1", group.version]
                : ["0.1.1"],
          );
        if (args[2] === "dist-tags")
          return ok([
            { latest: published.has(name) ? group.version : "0.1.1" },
          ]);
        return published.has(name) ? ok([metadata(name)]) : notFound();
      }
      if (args[0] === "publish") {
        assert.equal(options.env.RUNNER_ENVIRONMENT, "github-hosted");
        assert.equal(options.env.GITHUB_SERVER_URL, "https://github.com");
        assert.equal(
          options.env.GITHUB_REPOSITORY_ID,
          environment.GITHUB_REPOSITORY_ID,
        );
        assert.equal(
          options.env.GITHUB_REPOSITORY_OWNER_ID,
          environment.GITHUB_REPOSITORY_OWNER_ID,
        );
        assert.equal(
          options.env.GITHUB_WORKFLOW_REF,
          environment.GITHUB_WORKFLOW_REF,
        );
        const artifact = group.artifacts.find((item) => item.path === args[1])!;
        assert.ok(artifact, "发布必须使用原始候选路径");
        writes.push({
          name: artifact.packageName,
          bytes: await readFile(args[1]!),
        });
        if (failRuntime && artifact.packageName === "@ykdz/reins") {
          failRuntime = false;
          return { exitCode: 1, stdout: "", stderr: "fixture failure" };
        }
        published.set(
          artifact.packageName,
          Number(environment.GITHUB_RUN_ATTEMPT),
        );
        return ok();
      }
      if (args[0] === "install") {
        const manifest = JSON.parse(
          await readFile(join(options.cwd, "package.json"), "utf8"),
        ) as { dependencies: Record<string, string> };
        const name = Object.keys(manifest.dependencies)[0]!;
        const artifact = group.artifacts.find(
          (item) => item.packageName === name,
        )!;
        await writeFile(
          join(options.cwd, "package-lock.json"),
          JSON.stringify({
            packages: {
              [`node_modules/${name}`]: {
                version: group.version,
                integrity: artifact.integrity,
                resolved: `https://registry.npmjs.org/${name}/-/${artifact.file}`,
              },
            },
          }),
        );
        return ok();
      }
      if (args[0] === "audit") {
        const manifest = JSON.parse(
          await readFile(join(options.cwd, "package.json"), "utf8"),
        ) as { dependencies: Record<string, string> };
        const name = Object.keys(manifest.dependencies)[0]!;
        return ok({
          invalid: [],
          missing: [],
          verified: [
            {
              name,
              version: group.version,
              attestationBundles:
                published.get(name) === 0 ? [] : [bundle(name)],
            },
          ],
        });
      }
      throw new Error(`非预期 npm 命令 ${args.join(" ")}`);
    }
    if (command === "curl") {
      const artifact = group.artifacts.find((item) =>
        args.at(-1)!.endsWith(item.file),
      )!;
      await cp(artifact.path, args[args.indexOf("--output") + 1]!);
      return ok();
    }
    assert.equal(command, "gh");
    if (args[0] === "api") {
      const path = args.find((arg) => arg.startsWith("repos/"))!;
      if (args.includes("POST")) {
        githubWrites.push(path);
        if (path.endsWith("/git/tags")) {
          tag = {
            tag: `v${group.version}`,
            message: args.find((arg) => arg.startsWith("message="))!.slice(8),
            object: { type: "commit", sha: group.receipt.source.commit },
          };
          return ok({ sha: "tag-object" });
        }
        if (path.endsWith("/git/refs")) {
          ref = true;
          return ok();
        }
      }
      if (path.includes("/git/ref/tags/"))
        return ref
          ? {
              exitCode: 0,
              stdout: `HTTP/2 200 OK\n\n${JSON.stringify({ object: { type: "tag", sha: "tag-object" } })}`,
              stderr: "",
            }
          : { exitCode: 1, stdout: "HTTP/2 404 Not Found\n\n{}", stderr: "" };
      if (path.endsWith("/git/tags/tag-object")) return ok(tag);
      if (path.includes("/releases?"))
        return ok([release === undefined ? [] : [release]]);
      if (path === "repos/YKDZ/reins") return ok({ default_branch: "main" });
      if (path === "repos/YKDZ/reins/immutable-releases")
        return ok({ enabled: true, enforced_by_owner: false });
      if (path.endsWith("/commits/main"))
        return ok({ sha: group.receipt.source.commit });
      if (path.includes("/actions/runs/"))
        return ok({
          head_sha: group.receipt.source.commit,
          conclusion: "success",
          event: "push",
          path: ".github/workflows/check.yml",
        });
    }
    if (args[0] === "release") {
      if (args[1] === "download") {
        const name = args[args.indexOf("--pattern") + 1]!;
        const destination = args[args.indexOf("--dir") + 1]!;
        const asset = [...assets.values()].find(
          (value) => value.name === name,
        )!;
        await writeFile(join(destination, name), asset.bytes);
        return ok();
      }
      if (args[1] === "create") {
        githubWrites.push("create-release");
        for (const path of args.slice(3, args.indexOf("--draft")))
          assets.set(assets.size + 1, {
            name: basename(path),
            bytes: await readFile(path),
          });
        release = {
          tag_name: `v${group.version}`,
          name: `v${group.version}`,
          body: group.receipt.publication.releaseNotes,
          draft: true,
          immutable: false,
          published_at: null,
          assets: [...assets].map(([id, asset]) => ({
            id,
            name: asset.name,
            size: asset.bytes.length,
          })),
        };
        return ok();
      }
      if (args[1] === "edit") {
        githubWrites.push("publish-release");
        if (failRelease) {
          failRelease = false;
          return { exitCode: 1, stdout: "", stderr: "fixture failure" };
        }
        release!.draft = false;
        release!.immutable = true;
        release!.published_at = "2026-10-17T00:00:00Z";
        return ok();
      }
      if (args[1] === "verify" || args[1] === "verify-asset") return ok();
    }
    throw new Error(`非预期外部命令 ${command} ${args.join(" ")}`);
  };
  return {
    run,
    published,
    writes,
    githubWrites,
    failRuntime: () => {
      failRuntime = true;
    },
    failRelease: () => {
      failRelease = true;
    },
    sdkMissing: () => {
      sdkMissing = true;
    },
    wrongProvenance: () => {
      wrongProvenance = true;
    },
    wrongIntegrity: () => {
      wrongIntegrity = true;
    },
  };
}

void test("人工 SDK 首发后，首次正常发布只写运行包并保留同组原字节", async () => {
  const f = await fixture();
  try {
    const service = externalServices(f.group, f.environment, true);
    const result = await runDirectOidcPublication({ ...f, run: service.run });
    assert.deepEqual(
      service.writes.map((item) => item.name),
      ["@ykdz/reins"],
    );
    assert.deepEqual(
      result.packages.map((item) => item.origin),
      ["manual-sdk-bootstrap", "oidc"],
    );
    assert.deepEqual(
      service.writes[0]!.bytes,
      await readFile(f.group.artifacts[1]!.path),
    );
  } finally {
    await f.cleanup();
  }
});

void test("SDK 首个真实版本可接续 npm 暂存占位，但不能忽略真实旧版本", async () => {
  const f = await fixture();
  try {
    for (const stub of [true, false]) {
      const service = externalServices(f.group, f.environment, true);
      const run: ProcessRunner = async (command, args, options) => {
        if (basename(command) === "npm" && args[0] === "view") {
          if (args[1] === "@ykdz/reins-sdk" && args[2] === "versions")
            return {
              exitCode: 0,
              stdout: JSON.stringify(["0.0.0-stage", f.group.version]),
              stderr: "",
            };
          if (args[1] === "@ykdz/reins-sdk@0.0.0-stage")
            return {
              exitCode: 0,
              stdout: JSON.stringify([
                {
                  name: "@ykdz/reins-sdk",
                  version: "0.0.0-stage",
                  stub,
                },
              ]),
              stderr: "",
            };
        }
        return await service.run(command, args, options);
      };
      if (stub) {
        const result = await runDirectOidcPublication({ ...f, run });
        assert.equal(result.packages[0]!.origin, "manual-sdk-bootstrap");
        assert.deepEqual(
          service.writes.map((item) => item.name),
          ["@ykdz/reins"],
        );
      } else {
        await assert.rejects(
          runDirectOidcPublication({ ...f, run }),
          /新发布不能复用/u,
        );
        assert.equal(service.writes.length, 0);
      }
    }
  } finally {
    await f.cleanup();
  }
});

void test("SDK 成功、运行包失败后，同一候选重跑核实 SDK 并继续；来源冲突停止", async () => {
  const f = await fixture();
  try {
    const service = externalServices(f.group, f.environment);
    service.failRuntime();
    await assert.rejects(
      runDirectOidcPublication({ ...f, run: service.run }),
      /发布未完成/u,
    );
    assert.deepEqual(
      service.writes.map((item) => item.name),
      ["@ykdz/reins-sdk", "@ykdz/reins"],
    );
    f.environment.GITHUB_RUN_ATTEMPT = "2";
    await runDirectOidcPublication({ ...f, run: service.run });
    assert.deepEqual(
      service.writes.map((item) => item.name),
      ["@ykdz/reins-sdk", "@ykdz/reins", "@ykdz/reins"],
    );
    for (const item of service.writes)
      assert.deepEqual(
        item.bytes,
        await readFile(
          f.group.artifacts.find(
            (artifact) => artifact.packageName === item.name,
          )!.path,
        ),
      );
    service.wrongProvenance();
    await assert.rejects(
      runDirectOidcPublication({ ...f, run: service.run }),
      /来源证明/u,
    );
    assert.equal(service.writes.length, 3);
  } finally {
    await f.cleanup();
  }
});

void test("缺 SDK、非默认分支、既有版本及摘要冲突均阻止公开写入", async () => {
  const f = await fixture();
  try {
    const missing = externalServices(f.group, f.environment);
    missing.sdkMissing();
    await assert.rejects(
      runDirectOidcPublication({ ...f, run: missing.run }),
      /尚未初始化/u,
    );
    assert.equal(missing.writes.length, 0);
    await assert.rejects(
      runDirectOidcPublication({
        ...f,
        environment: { ...f.environment, GITHUB_REF: "refs/heads/feature" },
        run: missing.run,
      }),
      /默认分支/u,
    );
    const existing = externalServices(f.group, f.environment);
    existing.published.set("@ykdz/reins-sdk", 1);
    await assert.rejects(
      runDirectOidcPublication({ ...f, run: existing.run }),
      /新发布不能复用/u,
    );
    assert.equal(existing.writes.length, 0);
    const conflict = externalServices(f.group, f.environment, true);
    conflict.wrongIntegrity();
    await assert.rejects(
      runDirectOidcPublication({ ...f, run: conflict.run }),
      /摘要/u,
    );
    assert.equal(conflict.writes.length, 0);
  } finally {
    await f.cleanup();
  }
});

void test("双包未核验时不创建 Release；双包成功而 Release 失败可原候选续跑", async () => {
  const f = await fixture();
  try {
    const service = externalServices(f.group, f.environment);
    await assert.rejects(runImmutableGithubRelease({ ...f, run: service.run }));
    assert.equal(service.githubWrites.length, 0);
    await runDirectOidcPublication({ ...f, run: service.run });
    service.failRelease();
    await assert.rejects(
      runImmutableGithubRelease({ ...f, run: service.run }),
      /Release 步骤失败/u,
    );
    f.environment.GITHUB_RUN_ATTEMPT = "2";
    await runImmutableGithubRelease({ ...f, run: service.run });
    assert.equal(
      service.githubWrites.filter((item) => item === "create-release").length,
      1,
    );
    assert.equal(
      service.githubWrites.filter((item) => item.endsWith("/git/refs")).length,
      1,
    );
    const count = service.githubWrites.length;
    await runImmutableGithubRelease({ ...f, run: service.run });
    assert.equal(service.githubWrites.length, count);
  } finally {
    await f.cleanup();
  }
});

void test("首发准备无外部写入，人工确认拒绝时不登录；缺原候选不能重建已公开 SDK", async () => {
  const f = await fixture();
  try {
    const service = externalServices(f.group, f.environment, true);
    await prepareSdkBootstrap({ ...f, run: service.run });
    await assert.rejects(
      runSdkBootstrap({
        ...f,
        run: service.run,
        confirm: async () => {
          throw new Error("维护者取消");
        },
      }),
      /维护者取消/u,
    );
    assert.equal(service.writes.length, 0);
    const run: ProcessRunner = async (command, args, options) =>
      command === "gh" && args[0] === "run"
        ? { exitCode: 0, stdout: "[]", stderr: "" }
        : await service.run(command, args, options);
    await assert.rejects(
      selectPublicationCandidate({ ...f, run }),
      /原候选不可用/u,
    );
    assert.equal(service.writes.length, 0);
    await rm(f.group.artifacts[0]!.path);
    await assert.rejects(prepareSdkBootstrap(f), /校验失败/u);
  } finally {
    await f.cleanup();
  }
});

void test("选择原候选时真实 gh 的本地状态不会污染源码工作区", async () => {
  const f = await fixture();
  let selected: string | undefined;
  try {
    f.environment.HOME = join(f.repository, ".artifacts", "gh-home");
    await mkdir(f.environment.HOME, { recursive: true });
    const run: ProcessRunner = async (command, args, options) => {
      assert.equal(command, "gh");
      const configured = await runProcess(
        command,
        ["config", "get", "editor"],
        options,
      );
      assert.equal(configured.exitCode, 0, configured.stderr);
      if (args[1] === "list")
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              databaseId: Number(f.group.receipt.producer.runId),
              headSha: f.environment.GITHUB_SHA,
              conclusion: "success",
              event: "push",
            },
          ]),
          stderr: "",
        };
      assert.equal(args[1], "download");
      await cp(f.artifactDirectory, args[args.indexOf("--dir") + 1]!, {
        recursive: true,
      });
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    selected = await selectPublicationCandidate({ ...f, run });
    assert.ok(selected);
  } finally {
    if (selected !== undefined)
      await rm(selected, { recursive: true, force: true });
    await f.cleanup();
  }
});

void test("首发向导接受锁定 npm 的真实授权预览，并在维护者取消时停止写入", async () => {
  const f = await fixture();
  try {
    const service = externalServices(f.group, f.environment, true);
    const confirmations: string[] = [];
    const writes: string[][] = [];
    const run: ProcessRunner = async (command, args, options) => {
      if (basename(command) === "npm") {
        if (["login", "whoami", "logout"].includes(args[0]!))
          return { exitCode: 0, stdout: "fixture\n", stderr: "" };
        if (args[0] === "trust" && args[1] === "list")
          return { exitCode: 0, stdout: "\n", stderr: "" };
        if (args[0] === "trust" && args.includes("--dry-run")) {
          return await runProcess(
            join(process.cwd(), "node_modules", ".bin", "npm"),
            args,
            options,
          );
        }
        if (args[0] === "publish" || args[0] === "trust") {
          writes.push([...args]);
          throw new Error("维护者确认之前发生公开写入");
        }
      }
      return await service.run(command, args, options);
    };
    await assert.rejects(
      runSdkBootstrap({
        ...f,
        run,
        confirm: async (phrase) => {
          confirmations.push(phrase);
          if (phrase.startsWith("授权 ")) throw new Error("维护者取消授权");
        },
      }),
      /维护者取消授权/u,
    );
    assert.deepEqual(confirmations, [
      "确认 npm 2FA 和恢复码已准备",
      "授权 @ykdz/reins-sdk YKDZ/reins release.yml createPackage",
    ]);
    assert.equal(writes.length, 0);
    assert.equal(service.writes.length, 0);
  } finally {
    await f.cleanup();
  }
});
