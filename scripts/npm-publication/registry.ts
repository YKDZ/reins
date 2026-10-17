import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { gt, valid, prerelease } from "semver";

import { isJsonObject } from "../release-package.ts";
import type { ReleaseArtifact } from "../validate-release-package.ts";
import { fail, type AcceptedPublicationGroup } from "./handoff.ts";
import {
  explicitNotFound,
  readJsonResult,
  type npmSession,
} from "./process.ts";

type Session = Awaited<ReturnType<typeof npmSession>>;
export type RegistryState = {
  readonly artifact: ReleaseArtifact;
  readonly versions: readonly string[];
  readonly latest: string;
  readonly metadata: Record<string, unknown> | undefined;
};

function object(value: unknown, code: string): Record<string, unknown> {
  if (!isJsonObject(value)) fail(code, "外部响应缺少必要对象");
  return value;
}

export async function inspectRegistryPackage(
  session: Session,
  artifact: ReleaseArtifact,
): Promise<RegistryState> {
  const versionsResult = await session.npm([
    "view",
    artifact.packageName,
    "versions",
    "--json",
  ]);
  if (explicitNotFound(versionsResult))
    fail(
      artifact.packageName === "@ykdz/reins-sdk"
        ? "sdk-bootstrap-required"
        : "registry-package-missing",
      "公开包尚未初始化；SDK 首发须由维护者完成",
    );
  const versions = readJsonResult(versionsResult, "registry-unavailable");
  if (
    !Array.isArray(versions) ||
    !versions.every((value) => typeof value === "string")
  )
    fail("registry-invalid", "注册表版本清单无效");
  const tags = object(
    readJsonResult(
      await session.npm(["view", artifact.packageName, "dist-tags", "--json"]),
      "registry-unavailable",
    ),
    "registry-invalid",
  );
  if (
    typeof tags.latest !== "string" ||
    valid(tags.latest) === null ||
    prerelease(tags.latest) !== null
  )
    fail("registry-latest-invalid", "正常发布需要明确的稳定 latest");
  const exact = await session.npm([
    "view",
    `${artifact.packageName}@${artifact.version}`,
    "--json",
  ]);
  const metadata = explicitNotFound(exact)
    ? undefined
    : object(readJsonResult(exact, "registry-unavailable"), "registry-invalid");
  if (metadata === undefined && !gt(artifact.version, tags.latest))
    fail("candidate-not-newer", "新候选版本必须高于注册表 latest");
  return { artifact, versions, latest: tags.latest, metadata };
}

export function isInitialSdk(state: RegistryState): boolean {
  return (
    state.artifact.packageName === "@ykdz/reins-sdk" &&
    state.versions.length === 1 &&
    state.versions[0] === state.artifact.version
  );
}

function verifyProvenance(
  bundle: unknown,
  artifact: ReleaseArtifact,
  group: AcceptedPublicationGroup,
  environment: Readonly<NodeJS.ProcessEnv>,
): void {
  const record = object(bundle, "provenance-invalid");
  const envelope = object(
    object(record.bundle, "provenance-invalid").dsseEnvelope,
    "provenance-invalid",
  );
  if (
    envelope.payloadType !== "application/vnd.in-toto+json" ||
    typeof envelope.payload !== "string"
  )
    fail("provenance-invalid", "来源证明的封装无效");
  const statement = object(
    JSON.parse(
      Buffer.from(envelope.payload, "base64").toString("utf8"),
    ) as unknown,
    "provenance-invalid",
  );
  if (
    statement["_type"] !== "https://in-toto.io/Statement/v1" ||
    statement.predicateType !== "https://slsa.dev/provenance/v1" ||
    !Array.isArray(statement.subject) ||
    statement.subject.length !== 1
  )
    fail("provenance-invalid", "来源证明缺少唯一包主体");
  const subject = object(statement.subject[0], "provenance-invalid");
  if (
    subject.name !== `pkg:npm/${artifact.packageName}@${artifact.version}` ||
    object(subject.digest, "provenance-invalid").sha512 !== artifact.sha512
  )
    fail("provenance-invalid", "来源证明未绑定候选包字节");
  const predicate = object(statement.predicate, "provenance-invalid");
  const definition = object(predicate.buildDefinition, "provenance-invalid");
  const workflow = object(
    object(definition.externalParameters, "provenance-invalid").workflow,
    "provenance-invalid",
  );
  const github = object(
    object(definition.internalParameters, "provenance-invalid").github,
    "provenance-invalid",
  );
  const run = object(predicate.runDetails, "provenance-invalid");
  const metadata = object(run.metadata, "provenance-invalid");
  const repo = `https://github.com/${group.receipt.publication.repository}`;
  const invocationPrefix = `${repo}/actions/runs/${environment.GITHUB_RUN_ID}/attempts/`;
  const invocation = metadata.invocationId;
  const attempt =
    typeof invocation === "string" && invocation.startsWith(invocationPrefix)
      ? invocation.slice(invocationPrefix.length)
      : "";
  const dependencies = definition.resolvedDependencies;
  if (
    workflow.repository !== repo ||
    workflow.path !== ".github/workflows/release.yml" ||
    workflow.ref !== environment.GITHUB_REF ||
    github.event_name !== "workflow_dispatch" ||
    object(run.builder, "provenance-invalid").id !==
      "https://github.com/actions/runner/github-hosted" ||
    !/^[1-9]\d*$/u.test(attempt) ||
    Number(attempt) > Number(environment.GITHUB_RUN_ATTEMPT) ||
    !Array.isArray(dependencies) ||
    !dependencies.some(
      (value) =>
        isJsonObject(value) &&
        value.uri === `git+${repo}@${environment.GITHUB_REF}` &&
        isJsonObject(value.digest) &&
        value.digest.gitCommit === group.receipt.source.commit,
    )
  )
    fail(
      "provenance-invalid",
      "来源证明未绑定本次发布的仓库、源码、工作流和运行身份",
    );
}

export async function verifyRegistryBytes(
  session: Session,
  state: RegistryState,
): Promise<void> {
  const { artifact, metadata } = state;
  if (
    metadata === undefined ||
    metadata.name !== artifact.packageName ||
    metadata.version !== artifact.version
  )
    fail("registry-identity-conflict", "公开版本与候选身份不一致");
  const dist = object(metadata.dist, "registry-integrity-conflict");
  if (
    dist.integrity !== artifact.integrity ||
    typeof dist.tarball !== "string" ||
    !dist.tarball.startsWith("https://registry.npmjs.org/")
  )
    fail("registry-integrity-conflict", "公开包摘要或来源与候选不一致");
  const downloaded = join(session.directory, artifact.file);
  const fetched = await session.run(
    "curl",
    [
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--output",
      downloaded,
      dist.tarball,
    ],
    { cwd: session.directory, env: session.environment },
  );
  if (fetched.exitCode !== 0)
    fail("registry-unavailable", "无法下载公开包进行逐字节核验");
  const bytes = await readFile(downloaded);
  if (
    bytes.length !== artifact.size ||
    createHash("sha256").update(bytes).digest("hex") !== artifact.sha256 ||
    createHash("sha512").update(bytes).digest("hex") !== artifact.sha512
  )
    fail("registry-byte-conflict", "公开 tarball 与已接受候选字节不一致");
}

export async function verifyPublishedPackage(
  session: Session,
  state: RegistryState,
  group: AcceptedPublicationGroup,
  environment: Readonly<NodeJS.ProcessEnv>,
  manualSdk: boolean,
): Promise<void> {
  await verifyRegistryBytes(session, state);
  if (state.latest !== state.artifact.version)
    fail("registry-latest-conflict", "公开 latest 未指向当前候选");
  if (manualSdk && !isInitialSdk(state))
    fail("sdk-bootstrap-conflict", "人工首发例外仅适用于 SDK 的第一个真实版本");
  const consumer = join(session.directory, `consumer-${state.artifact.file}`);
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: { [state.artifact.packageName]: state.artifact.version },
    }),
  );
  const installed = await session.npm(
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefer-offline",
    ],
    consumer,
  );
  if (installed.exitCode !== 0)
    fail("signature-consumer-failed", "无法安装公开的精确版本进行签名核验");
  const lock = object(
    JSON.parse(
      await readFile(join(consumer, "package-lock.json"), "utf8"),
    ) as unknown,
    "signature-audit-invalid",
  );
  const entry = object(
    object(lock.packages, "signature-audit-invalid")[
      `node_modules/${state.artifact.packageName}`
    ],
    "signature-audit-invalid",
  );
  if (
    entry.version !== state.artifact.version ||
    entry.integrity !== state.artifact.integrity ||
    typeof entry.resolved !== "string" ||
    !entry.resolved.startsWith("https://registry.npmjs.org/")
  )
    fail("signature-audit-invalid", "签名核验未安装候选对应的注册表包");
  const audit = object(
    readJsonResult(
      await session.npm(
        ["audit", "signatures", "--json", "--include-attestations"],
        consumer,
      ),
      "signature-audit-invalid",
    ),
    "signature-audit-invalid",
  );
  if (
    !Array.isArray(audit.invalid) ||
    audit.invalid.length !== 0 ||
    !Array.isArray(audit.missing) ||
    audit.missing.length !== 0 ||
    !Array.isArray(audit.verified)
  )
    fail("signature-audit-invalid", "注册表报告缺失或无效的签名");
  const matches = audit.verified.filter(
    (value) =>
      isJsonObject(value) &&
      value.name === state.artifact.packageName &&
      value.version === state.artifact.version,
  );
  if (matches.length > 1 || (!manualSdk && matches.length !== 1))
    fail("provenance-invalid", "公开包的来源证明缺失或不唯一");
  const verified = matches[0];
  const bundles =
    isJsonObject(verified) && Array.isArray(verified.attestationBundles)
      ? verified.attestationBundles.filter(
          (value) =>
            isJsonObject(value) &&
            value.predicateType === "https://slsa.dev/provenance/v1",
        )
      : [];
  if (bundles.length > 1 || (!manualSdk && bundles.length !== 1))
    fail("provenance-invalid", "公开包缺少唯一的 SLSA 来源证明");
  if (bundles.length === 1)
    verifyProvenance(bundles[0], state.artifact, group, environment);
}
