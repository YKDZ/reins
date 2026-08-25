import { access, rename, rm, writeFile } from "node:fs/promises";

export type FixturePair = {
  jsonlPath: string;
  metadataPath: string;
  jsonl: string;
  metadata: string;
};

type RenameFile = (source: string, destination: string) => Promise<void>;
type FixturePairReplacementErrorCode =
  | "fixture_pair_replace_failed"
  | "fixture_pair_rollback_failed";

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

async function removeArtifacts(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { force: true })));
}

/**
 * Replaces the two fixture files as one compensating operation. This restores
 * the previous pair after ordinary in-process failures; it is not a durable
 * transaction across SIGKILL or host/filesystem failure.
 */
export async function replaceFixturePair(
  pair: FixturePair,
  dependencies: { renameFile?: RenameFile } = {},
): Promise<void> {
  const renameFile = dependencies.renameFile ?? rename;
  const suffix = `${process.pid}.${Date.now()}.${replacementSequence++}`;
  const entries = [
    {
      target: pair.jsonlPath,
      content: pair.jsonl,
      temp: `${pair.jsonlPath}.${suffix}.tmp`,
      backup: `${pair.jsonlPath}.${suffix}.backup`,
      hadOriginal: false,
      backupCreated: false,
      installed: false,
    },
    {
      target: pair.metadataPath,
      content: pair.metadata,
      temp: `${pair.metadataPath}.${suffix}.tmp`,
      backup: `${pair.metadataPath}.${suffix}.backup`,
      hadOriginal: false,
      backupCreated: false,
      installed: false,
    },
  ];
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
    await removeArtifacts(artifacts);
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
          await rm(entry.target, { force: true });
          entry.installed = false;
        }
        if (entry.backupCreated) {
          await renameFile(entry.backup, entry.target);
          entry.backupCreated = false;
        }
      }
      await removeArtifacts(artifacts);
    } catch (rollbackCause) {
      await removeArtifacts(artifacts).catch(() => {});
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

  await removeArtifacts(artifacts);
}

export class KnownCredentialPolicyError extends Error {
  readonly code = "known_credential_pattern";

  constructor(message: string) {
    super(message);
    this.name = "KnownCredentialPolicyError";
  }
}

const prohibitedNormalizedKeys = new Set([
  "password",
  "privatekey",
  "clientsecret",
  "sessiontoken",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "authorization",
  "cookie",
  "secret",
]);

const knownCredentialString = new RegExp(
  [
    "Bearer\\s+[A-Za-z0-9._~+/=-]{16,}",
    "\\bsk-[A-Za-z0-9_-]{16,}",
    "\\bghp_[A-Za-z0-9]{20,}",
    "\\bgithub_pat_[A-Za-z0-9_]{20,}",
    "\\beyJ[A-Za-z0-9_-]*\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\b",
    "-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----",
  ].join("|"),
  "u",
);

function normalizedKey(key: string): string {
  return key
    .normalize("NFKC")
    .replaceAll(/[^A-Za-z0-9]/g, "")
    .toLowerCase();
}

/** Rejects known credential shapes; this is a policy, not a proof of secrecy. */
export function assertMatchesKnownCredentialPolicy(value: unknown): void {
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      if (knownCredentialString.test(candidate)) {
        throw new KnownCredentialPolicyError(
          "Fixture matches a known credential string pattern",
        );
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (typeof candidate !== "object" || candidate === null) return;
    for (const [key, item] of Object.entries(candidate)) {
      if (prohibitedNormalizedKeys.has(normalizedKey(key))) {
        throw new KnownCredentialPolicyError(
          "Fixture matches a known credential policy key",
        );
      }
      visit(item);
    }
  };
  visit(value);
}
