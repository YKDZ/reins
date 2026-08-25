import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { parseRecordedQoderFixtureAnchors } from "../../src/fixture-anchors.ts";
import type { RecordedQoderFixtureName } from "../../src/fixture-projection.ts";
import { prepareFixtureCandidate } from "./fixture-candidate.ts";
import { installRecordedFixtureCandidates } from "./fixture-install.ts";

const execFile = promisify(execFileCallback);
const sourceRevision = "e3b522c4adc037319bf065590b2faab616ca47c6";
const fixtures = {
  "list-and-tool": { minimumNativeToolCount: 1 },
  "two-tools": { minimumNativeToolCount: 2 },
} as const;

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
    anchorsRaw?: string;
    prepare?: (name: RecordedQoderFixtureName) => Promise<PreparedFixture>;
    readSource?: typeof readImmutableGitSource;
    installedSdkVersion?: () => Promise<string>;
    install?: (
      options: Parameters<typeof installRecordedFixtureCandidates>[0],
    ) => Promise<unknown>;
  } = {},
): Promise<void> {
  const fixtureDirectory =
    options.fixtureDirectory ??
    fileURLToPath(new URL("../fixtures", import.meta.url));
  const anchorsRaw =
    options.anchorsRaw ??
    (await readFile(
      new URL("../fixtures/anchors.json", import.meta.url),
      "utf8",
    ));
  const anchors = parseRecordedQoderFixtureAnchors(anchorsRaw);
  const prepare =
    options.prepare ??
    ((name: RecordedQoderFixtureName) =>
      prepareFromImmutableSource(
        name,
        anchors.fixtures[name].sourceSha256,
        options.readSource ?? readImmutableGitSource,
        options.installedSdkVersion ?? installedQoderSdkVersion,
      ));
  const names = Object.keys(fixtures) as RecordedQoderFixtureName[];
  const prepared = await Promise.all(
    names.map(async (name) => ({ name, candidate: await prepare(name) })),
  );
  await (options.install ?? installRecordedFixtureCandidates)({
    fixtureDirectory,
    anchorsRaw,
    candidates: prepared.map(({ name, candidate }) => ({ name, ...candidate })),
  });
}

async function prepareFromImmutableSource(
  name: RecordedQoderFixtureName,
  expectedSourceSha256: string,
  readSource: typeof readImmutableGitSource,
  readInstalledSdkVersion: () => Promise<string>,
): Promise<PreparedFixture> {
  const fixture = fixtures[name];
  const base = `adapters/qoder/test/fixtures/${name}`;
  const [sourceRaw, sourceMetadataRaw, installedSdkVersion] = await Promise.all(
    [
      readSource(sourceRevision, `${base}.jsonl`),
      readSource(sourceRevision, `${base}.metadata.json`),
      readInstalledSdkVersion(),
    ],
  );
  const sourceSha256 = createHash("sha256").update(sourceRaw).digest("hex");
  if (sourceSha256 !== expectedSourceSha256) {
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
