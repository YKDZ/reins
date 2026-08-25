import { access, rename, rm, writeFile } from "node:fs/promises";

export {
  assertMatchesKnownCredentialPolicy,
  KnownCredentialPolicyError,
} from "../../src/fixture-policy.ts";

export type FixturePair = {
  jsonlPath: string;
  metadataPath: string;
  jsonl: string;
  metadata: string;
};

type RenameFile = (source: string, destination: string) => Promise<void>;
type RemoveFile = (path: string) => Promise<void>;
type FixturePairReplacementErrorCode =
  | "fixture_pair_replace_failed"
  | "fixture_pair_rollback_failed"
  | "fixture_pair_cleanup_failed";

export class FixturePairReplacementError extends Error {
  readonly code: FixturePairReplacementErrorCode;

  constructor(
    code: FixturePairReplacementErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FixturePairReplacementError";
    this.code = code;
  }
}

let replacementSequence = 0;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function removeArtifacts(
  paths: readonly string[],
  removeFile: RemoveFile,
): Promise<void> {
  await Promise.all(paths.map((path) => removeFile(path)));
}

/**
 * Replaces the two fixture files as one compensating operation. This restores
 * the previous pair after ordinary in-process failures; it is not a durable
 * transaction across SIGKILL or host/filesystem failure.
 */
export async function replaceFixturePair(
  pair: FixturePair,
  dependencies: { renameFile?: RenameFile; removeFile?: RemoveFile } = {},
): Promise<void> {
  await replaceFixturePairs([pair], dependencies);
}

/**
 * Replaces every fixture pair as one compensating operation. Ordinary
 * in-process failures restore the complete previous set. This does not claim
 * durable atomicity across SIGKILL or host/filesystem failure.
 */
export async function replaceFixturePairs(
  pairs: readonly FixturePair[],
  dependencies: { renameFile?: RenameFile; removeFile?: RemoveFile } = {},
): Promise<void> {
  const renameFile = dependencies.renameFile ?? rename;
  const removeFile =
    dependencies.removeFile ?? ((path) => rm(path, { force: true }));
  const suffix = `${process.pid}.${Date.now()}.${replacementSequence++}`;
  const entries = pairs.flatMap((pair) =>
    [
      { target: pair.jsonlPath, content: pair.jsonl },
      { target: pair.metadataPath, content: pair.metadata },
    ].map(({ target, content }) => ({
      target,
      content,
      temp: `${target}.${suffix}.tmp`,
      backup: `${target}.${suffix}.backup`,
      hadOriginal: false,
      backupCreated: false,
      installed: false,
    })),
  );
  const temporaryFiles = entries.map(({ temp }) => temp);
  const artifacts = entries.flatMap(({ temp, backup }) => [temp, backup]);

  const stagingResults = await Promise.allSettled(
    entries.map(({ temp, content }) =>
      writeFile(temp, content, { flag: "wx" }),
    ),
  );
  const stagingFailure = stagingResults.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (stagingFailure !== undefined) {
    await removeArtifacts(artifacts, removeFile);
    throw new FixturePairReplacementError(
      "fixture_pair_replace_failed",
      "Fixture pair staging failed",
      { cause: stagingFailure.reason },
    );
  }

  try {
    for (const entry of entries) {
      entry.hadOriginal = await pathExists(entry.target);
      if (entry.hadOriginal) {
        await renameFile(entry.target, entry.backup);
        entry.backupCreated = true;
      }
    }
    for (const entry of entries) {
      await renameFile(entry.temp, entry.target);
      entry.installed = true;
    }
  } catch (cause) {
    try {
      for (const entry of entries.toReversed()) {
        if (entry.installed) {
          await removeFile(entry.target);
          entry.installed = false;
        }
        if (entry.backupCreated) {
          await renameFile(entry.backup, entry.target);
          entry.backupCreated = false;
        }
      }
      await removeArtifacts(artifacts, removeFile);
    } catch (rollbackCause) {
      await removeArtifacts(temporaryFiles, removeFile).catch(() => {});
      throw new FixturePairReplacementError(
        "fixture_pair_rollback_failed",
        "Fixture pair rollback failed",
        { cause: rollbackCause },
      );
    }
    throw new FixturePairReplacementError(
      "fixture_pair_replace_failed",
      "Fixture pair replacement failed and was rolled back",
      { cause },
    );
  }

  try {
    await removeArtifacts(artifacts, removeFile);
  } catch (cause) {
    throw new FixturePairReplacementError(
      "fixture_pair_cleanup_failed",
      "Fixture pair replacement completed but cleanup failed",
      { cause },
    );
  }
}
