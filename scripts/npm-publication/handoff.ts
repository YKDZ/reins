import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { isJsonObject } from "../release-package.ts";
import {
  validateReleasePackages,
  type ReleaseArtifact,
  type ReleasePackageGroup,
} from "../validate-release-package.ts";

export class PublicationFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function fail(code: string, message: string): never {
  throw new PublicationFailure(code, message);
}

type ArtifactIdentity = Omit<ReleaseArtifact, "path" | "manifest">;

export type PublicationReceipt = {
  readonly schemaVersion: 1;
  readonly publication: {
    readonly version: string;
    readonly repository: string;
    readonly releaseDate: string;
    readonly releaseNotes: string;
  };
  readonly source: {
    readonly commit: string;
    readonly tree: string;
    readonly dirty: boolean;
  };
  readonly producer: {
    readonly runId: string | null;
    readonly runAttempt: string | null;
    readonly workflow: string | null;
  };
  readonly packages: readonly ArtifactIdentity[];
  readonly verification: {
    readonly kind: "reins-formal-consumer";
    readonly evidenceSha256: string;
  };
};

export type AcceptedPublicationGroup = ReleasePackageGroup & {
  readonly directory: string;
  readonly receipt: PublicationReceipt;
  readonly receiptSha256: string;
};

const receiptFile = "verified-publication-artifact.json";

function git(repository: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], {
    cwd: repository,
    encoding: "utf8",
  });
  if (result.error !== undefined || result.status !== 0)
    fail("source-unavailable", "无法确认候选源码身份");
  return result.stdout.trim();
}

function artifactIdentities(
  group: ReleasePackageGroup,
): readonly ArtifactIdentity[] {
  return group.artifacts.map(
    ({ path: _path, manifest: _manifest, ...identity }) => identity,
  );
}

function repositoryName(group: ReleasePackageGroup): string {
  const manifest = group.artifacts.find(
    (item) => item.packageName === group.name,
  )?.manifest;
  const repository = manifest?.repository;
  if (!isJsonObject(repository) || typeof repository.url !== "string")
    fail("identity-invalid", "运行包缺少仓库身份");
  const match =
    /^(?:git\+)?https:\/\/github\.com\/([^/]+\/[^/#]+?)(?:\.git)?$/u.exec(
      repository.url,
    );
  if (match?.[1] === undefined)
    fail("identity-invalid", "候选仓库须为明确的 GitHub 仓库");
  return match[1];
}

function readGroup(repository: string, directory: string): ReleasePackageGroup {
  try {
    return validateReleasePackages({
      repository,
      artifactDirectory: directory,
    });
  } catch (error) {
    return fail(
      "artifact-invalid",
      `候选制品校验失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function releaseNotes(
  repository: string,
  version: string,
): { readonly releaseDate: string; readonly releaseNotes: string } {
  const changelog = readFileSync(join(repository, "CHANGELOG.md"), "utf8");
  const sections = changelog
    .split(/^## /mu)
    .filter((value) => value.startsWith(`[${version}] - `));
  const section = sections[0];
  const releaseDate = section?.split("\n")[0]?.slice(`[${version}] - `.length);
  const notes = section?.slice(section.indexOf("\n") + 1).trim();
  if (
    sections.length !== 1 ||
    releaseDate === undefined ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(releaseDate) ||
    !notes
  )
    fail(
      "changelog-invalid",
      "变更说明须包含唯一的当前版本、日期与实际发布内容",
    );
  return { releaseDate, releaseNotes: notes };
}

export function acceptPublicationGroup(options: {
  readonly repository: string;
  readonly artifactDirectory: string;
  readonly expectedCommit?: string;
  readonly githubRepository?: string;
  readonly requireClean?: boolean;
}): AcceptedPublicationGroup {
  const group = readGroup(options.repository, options.artifactDirectory);
  const source = readFileSync(
    join(options.artifactDirectory, receiptFile),
    "utf8",
  );
  const value: unknown = JSON.parse(source);
  if (
    !isJsonObject(value) ||
    value.schemaVersion !== 1 ||
    !isJsonObject(value.publication) ||
    !isJsonObject(value.source) ||
    !isJsonObject(value.producer) ||
    !isJsonObject(value.verification)
  )
    fail("receipt-invalid", "候选回执结构无效");
  const publication = value.publication;
  const sourceIdentity = value.source;
  const verification = value.verification;
  const actualCommit = git(options.repository, ["rev-parse", "HEAD"]);
  const expectedCommit = options.expectedCommit ?? actualCommit;
  const repo = repositoryName(group);
  const notes = releaseNotes(options.repository, group.version);
  if (
    publication.version !== group.version ||
    publication.repository !== repo ||
    publication.releaseDate !== notes.releaseDate ||
    publication.releaseNotes !== notes.releaseNotes ||
    (options.githubRepository !== undefined &&
      publication.repository !== options.githubRepository) ||
    sourceIdentity.commit !== expectedCommit ||
    sourceIdentity.commit !== actualCommit ||
    sourceIdentity.tree !==
      git(options.repository, ["rev-parse", "HEAD^{tree}"]) ||
    typeof sourceIdentity.dirty !== "boolean" ||
    typeof publication.releaseDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(publication.releaseDate) ||
    typeof publication.releaseNotes !== "string" ||
    publication.releaseNotes.trim() === "" ||
    verification.kind !== "reins-formal-consumer" ||
    typeof verification.evidenceSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(verification.evidenceSha256) ||
    !isDeepStrictEqual(value.packages, artifactIdentities(group))
  )
    fail("identity-invalid", "候选回执与源码、版本或双包内容不一致");
  for (const key of ["runId", "runAttempt", "workflow"] as const) {
    if (value.producer[key] !== null && typeof value.producer[key] !== "string")
      fail("receipt-invalid", "候选生产来源无效");
  }
  if (
    options.requireClean === true &&
    (sourceIdentity.dirty ||
      git(options.repository, ["status", "--porcelain"]) !== "")
  )
    fail("source-dirty", "公开发布只接受干净源码提交产生的候选");
  const expectedFiles = [
    ...group.artifacts.map((item) => item.file),
    "SHA256SUMS",
    "SHA512SUMS",
    receiptFile,
  ].toSorted();
  if (
    !isDeepStrictEqual(
      readdirSync(options.artifactDirectory).toSorted(),
      expectedFiles,
    )
  )
    fail("artifact-invalid", "候选目录缺少或混入了制品");
  return {
    ...group,
    directory: options.artifactDirectory,
    receipt: {
      schemaVersion: 1,
      publication: { version: group.version, repository: repo, ...notes },
      source: {
        commit: actualCommit,
        tree: git(options.repository, ["rev-parse", "HEAD^{tree}"]),
        dirty: sourceIdentity.dirty,
      },
      producer: {
        runId:
          typeof value.producer.runId === "string"
            ? value.producer.runId
            : null,
        runAttempt:
          typeof value.producer.runAttempt === "string"
            ? value.producer.runAttempt
            : null,
        workflow:
          typeof value.producer.workflow === "string"
            ? value.producer.workflow
            : null,
      },
      packages: artifactIdentities(group),
      verification: {
        kind: "reins-formal-consumer",
        evidenceSha256: verification.evidenceSha256,
      },
    },
    receiptSha256: createHash("sha256").update(source).digest("hex"),
  };
}

export function sealPublicationGroup(options: {
  readonly repository: string;
  readonly artifactDirectory: string;
  readonly evidenceFile: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
}): AcceptedPublicationGroup {
  const group = readGroup(options.repository, options.artifactDirectory);
  const evidence = readFileSync(options.evidenceFile);
  const facts = evidence
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
  const candidate = facts.findLast(
    (value) => isJsonObject(value) && value.label === "release_candidate",
  );
  const result = facts.findLast(
    (value) => isJsonObject(value) && value.label === "smoke_result",
  );
  const runtime = group.artifacts.find(
    (item) => item.packageName === group.name,
  )!;
  const sdk = group.artifacts.find(
    (item) => item.packageName === "@ykdz/reins-sdk",
  )!;
  if (
    !isJsonObject(candidate) ||
    !isDeepStrictEqual(candidate.fact, {
      runtime: { file: runtime.file, sha256: runtime.sha256 },
      sdk: { file: sdk.file, sha256: sdk.sha256 },
    }) ||
    !isJsonObject(result) ||
    !isJsonObject(result.fact) ||
    result.fact.status !== "passed" ||
    facts.indexOf(candidate) >= facts.indexOf(result)
  )
    fail("consumer-unverified", "缺少与当前双包绑定的正式消费者验收结果");
  if (existsSync(join(options.artifactDirectory, receiptFile)))
    return acceptPublicationGroup(options);
  const notes = releaseNotes(options.repository, group.version);
  const receipt: PublicationReceipt = {
    schemaVersion: 1,
    publication: {
      version: group.version,
      repository: repositoryName(group),
      ...notes,
    },
    source: {
      commit: git(options.repository, ["rev-parse", "HEAD"]),
      tree: git(options.repository, ["rev-parse", "HEAD^{tree}"]),
      dirty: git(options.repository, ["status", "--porcelain"]) !== "",
    },
    producer: {
      runId: (options.environment ?? process.env).GITHUB_RUN_ID ?? null,
      runAttempt:
        (options.environment ?? process.env).GITHUB_RUN_ATTEMPT ?? null,
      workflow:
        (options.environment ?? process.env).GITHUB_WORKFLOW_REF ?? null,
    },
    packages: artifactIdentities(group),
    verification: {
      kind: "reins-formal-consumer",
      evidenceSha256: createHash("sha256").update(evidence).digest("hex"),
    },
  };
  writeFileSync(
    join(options.artifactDirectory, "SHA512SUMS"),
    group.sha512Sums,
  );
  writeFileSync(
    join(options.artifactDirectory, receiptFile),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  return acceptPublicationGroup(options);
}

if (import.meta.main) {
  const repository = process.cwd();
  const accepted = sealPublicationGroup({
    repository,
    artifactDirectory: join(repository, ".artifacts", "release"),
    evidenceFile: join(
      process.env.REINS_SMOKE_EVIDENCE_DIR ??
        join(repository, ".artifacts", "packed-cli-smoke"),
      "npm-smoke-facts.ndjson",
    ),
  });
  process.stdout.write(
    `双包候选已固定：${accepted.version}，源码 ${accepted.receipt.source.commit}${accepted.receipt.source.dirty ? "（含未提交改动，不能公开发布）" : ""}\n`,
  );
}
