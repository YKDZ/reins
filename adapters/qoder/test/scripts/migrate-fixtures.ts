import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import type { RecordedQoderFixtureName } from "../../src/fixture-projection.ts";
import {
  recordedQoderFixtureRegistry,
  recordedQoderFixtureSourceRevision,
} from "../../src/fixture-registry.ts";
import { prepareFixtureCandidate } from "./fixture-candidate.ts";
import { replaceFixturePairs, type FixturePair } from "./fixture-files.ts";

const execFile = promisify(execFileCallback);

type GitSourceExecutor = (revision: string, path: string) => Promise<string>;

export class FixtureSourceUnavailableError extends Error {
  readonly code = "fixture_source_unavailable";
  readonly reason = "git_failed";
  readonly revision: string;
  readonly path: string;

  constructor(revision: string, path: string) {
    super(
      `Immutable Qoder fixture source is unavailable: ${revision}:${path} (git_failed)`,
    );
    this.name = "FixtureSourceUnavailableError";
    this.revision = revision;
    this.path = path;
  }
}

const executeGitSource: GitSourceExecutor = async (revision, path) => {
  const result = await execFile("git", ["show", `${revision}:${path}`], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout;
};

export async function readImmutableGitSource(
  revision: string,
  path: string,
  execute: GitSourceExecutor = executeGitSource,
): Promise<string> {
  try {
    return await execute(revision, path);
  } catch {
    throw new FixtureSourceUnavailableError(revision, path);
  }
}

type PreparedFixture = { jsonl: string; metadata: string };

export async function runFixtureMigration(
  options: {
    fixtureDirectory?: string;
    prepare?: (name: RecordedQoderFixtureName) => Promise<PreparedFixture>;
    install?: (pairs: readonly FixturePair[]) => Promise<void>;
  } = {},
): Promise<void> {
  const fixtureDirectory =
    options.fixtureDirectory ??
    fileURLToPath(new URL("../fixtures", import.meta.url));
  const prepare = options.prepare ?? prepareFromImmutableSource;
  const install = options.install ?? replaceFixturePairs;
  const names = Object.keys(
    recordedQoderFixtureRegistry,
  ) as RecordedQoderFixtureName[];
  const prepared = await Promise.all(
    names.map(async (name) => ({ name, candidate: await prepare(name) })),
  );
  const pairs = prepared.map(({ name, candidate }) => ({
    jsonlPath: join(fixtureDirectory, `${name}.jsonl`),
    metadataPath: join(fixtureDirectory, `${name}.metadata.json`),
    jsonl: candidate.jsonl,
    metadata: candidate.metadata,
  }));
  await install(pairs);
}

async function prepareFromImmutableSource(
  name: RecordedQoderFixtureName,
): Promise<PreparedFixture> {
  const fixture = recordedQoderFixtureRegistry[name];
  const base = `adapters/qoder/test/fixtures/${name}`;
  const [sourceRaw, sourceMetadataRaw, installedSdkVersion] = await Promise.all(
    [
      readImmutableGitSource(
        recordedQoderFixtureSourceRevision,
        `${base}.jsonl`,
      ),
      readImmutableGitSource(
        recordedQoderFixtureSourceRevision,
        `${base}.metadata.json`,
      ),
      installedQoderSdkVersion(),
    ],
  );
  const sourceSha256 = createHash("sha256").update(sourceRaw).digest("hex");
  if (sourceSha256 !== fixture.sourceSha256) {
    throw new Error("Immutable Qoder fixture source digest mismatch");
  }
  return prepareFixtureCandidate({
    name,
    sourceRaw,
    sourceMetadataRaw,
    installedSdkVersion,
    minimumNativeToolCount: fixture.minimumNativeToolCount,
  });
}

async function installedQoderSdkVersion(): Promise<string> {
  const sdkPackage = JSON.parse(
    await readFile(
      new URL(
        "../package.json",
        import.meta.resolve("@qodercn-ai/qodercn-agent-sdk"),
      ),
      "utf8",
    ),
  ) as { version?: unknown };
  if (typeof sdkPackage.version !== "string") {
    throw new Error("Installed Qoder SDK package has no version");
  }
  return sdkPackage.version;
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(invokedPath).href === import.meta.url
) {
  try {
    await runFixtureMigration();
  } catch (error) {
    if (error instanceof FixtureSourceUnavailableError) {
      console.error(
        `${error.code}: revision=${error.revision} path=${error.path} reason=${error.reason}`,
      );
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
