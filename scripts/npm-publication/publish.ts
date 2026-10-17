import { join, resolve } from "node:path";

import { isJsonObject } from "../release-package.ts";
import {
  acceptPublicationGroup,
  fail,
  PublicationFailure,
  type AcceptedPublicationGroup,
} from "./handoff.ts";
import {
  assertPublicationContext,
  npmSession,
  type ProcessRunner,
} from "./process.ts";
import {
  inspectRegistryPackage,
  isInitialSdk,
  verifyPublishedPackage,
  type RegistryState,
} from "./registry.ts";

export type PublicationOptions = {
  readonly repository: string;
  readonly artifactDirectory: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly run?: ProcessRunner;
};

type PublishedPackage = {
  readonly name: string;
  readonly version: string;
  readonly origin: "oidc" | "manual-sdk-bootstrap";
};
export type PublicationResult = {
  readonly candidate: string;
  readonly commit: string;
  readonly runId: string;
  readonly packages: readonly PublishedPackage[];
};

function manualSdk(state: RegistryState): boolean {
  const dist = state.metadata?.dist;
  return (
    isInitialSdk(state) && isJsonObject(dist) && dist.attestations === undefined
  );
}

function candidate(options: PublicationOptions): AcceptedPublicationGroup {
  return acceptPublicationGroup({
    repository: options.repository,
    artifactDirectory: options.artifactDirectory,
    expectedCommit: options.environment.GITHUB_SHA ?? "",
    githubRepository: options.environment.GITHUB_REPOSITORY ?? "",
    requireClean: true,
  });
}

// 两包先核对已有事实，再按 SDK、运行包执行；每一步都使用已接受的原始字节。
export async function runDirectOidcPublication(
  options: PublicationOptions,
): Promise<PublicationResult> {
  assertPublicationContext(options.environment, true);
  const group = candidate(options);
  const session = await npmSession(options);
  try {
    const states = await Promise.all(
      group.artifacts.map((artifact) =>
        inspectRegistryPackage(session, artifact),
      ),
    );
    const sdk = states[0]!;
    const runtime = states[1]!;
    const bootstrap = manualSdk(sdk);
    const attempt = Number(options.environment.GITHUB_RUN_ATTEMPT);
    if (runtime.metadata !== undefined && sdk.metadata === undefined)
      fail(
        "publication-order-conflict",
        "运行包已经存在但同版本 SDK 缺失，不能按正常顺序恢复",
      );
    for (const state of states) {
      if (
        state.metadata !== undefined &&
        attempt === 1 &&
        !(state === sdk && bootstrap && runtime.metadata === undefined)
      )
        fail(
          "fresh-version-exists",
          "新发布不能复用既有版本；仅允许已核验的 SDK 人工首发接续",
        );
    }
    // 任一既有版本冲突时，先停止，不能先发布另一包再发现冲突。
    for (const state of states) {
      if (state.metadata !== undefined)
        await verifyPublishedPackage(
          session,
          state,
          group,
          options.environment,
          state === sdk && bootstrap,
        );
    }
    const packages: PublishedPackage[] = [];
    for (const state of states) {
      let current = state;
      if (current.metadata === undefined) {
        const published = await session.npm([
          "publish",
          current.artifact.path,
          "--access=public",
          "--provenance",
        ]);
        if (published.exitCode !== 0)
          fail(
            "publish-failed",
            `${current.artifact.packageName} 发布未完成；保留原候选并重跑失败步骤`,
          );
        current = await inspectRegistryPackage(session, current.artifact);
        await verifyPublishedPackage(
          session,
          current,
          group,
          options.environment,
          false,
        );
      }
      const origin =
        current === sdk && bootstrap ? "manual-sdk-bootstrap" : "oidc";
      packages.push({
        name: current.artifact.packageName,
        version: current.artifact.version,
        origin,
      });
    }
    return {
      candidate: group.receiptSha256,
      commit: group.receipt.source.commit,
      runId: options.environment.GITHUB_RUN_ID!,
      packages,
    };
  } finally {
    await session.cleanup();
  }
}

// Release 拥有独立的只读复核，不依赖可被本地伪造的发布成功标记。
export async function verifyPublishedGroup(
  options: PublicationOptions,
): Promise<AcceptedPublicationGroup> {
  assertPublicationContext(options.environment, false);
  const group = candidate(options);
  const session = await npmSession(options);
  try {
    for (const artifact of group.artifacts) {
      const state = await inspectRegistryPackage(session, artifact);
      await verifyPublishedPackage(
        session,
        state,
        group,
        options.environment,
        manualSdk(state),
      );
    }
    return group;
  } finally {
    await session.cleanup();
  }
}

if (import.meta.main) {
  try {
    const repository = process.cwd();
    const result = await runDirectOidcPublication({
      repository,
      artifactDirectory: resolve(
        process.env.PUBLICATION_ARTIFACT_DIRECTORY ??
          join(repository, ".artifacts", "release"),
      ),
      environment: process.env,
    });
    process.stdout.write(JSON.stringify(result) + "\n");
    process.stdout.write("同组双包已公开并完成字节、签名和来源核验\n");
  } catch (error) {
    if (!(error instanceof PublicationFailure)) throw error;
    process.stderr.write(`${error.code}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
