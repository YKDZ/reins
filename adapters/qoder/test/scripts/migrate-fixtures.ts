import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { prepareFixtureCandidate } from "./fixture-candidate.ts";
import { replaceFixturePair } from "./fixture-files.ts";

const execFile = promisify(execFileCallback);
const sourceRevision = "e3b522c4adc037319bf065590b2faab616ca47c6";
const fixtures = {
  "list-and-tool": {
    minimumNativeToolCount: 1,
    sourceSha256:
      "c5ee314bd0db8fd340fd3b811600399b1319a04e0277f3b89488614a6a72c4b0",
  },
  "two-tools": {
    minimumNativeToolCount: 2,
    sourceSha256:
      "58e8d23afce4c0aa2cd8b5293f2b06dee2be3f4c968f01acc6391f1c327b4be8",
  },
} as const;

class FixtureSourceUnavailableError extends Error {
  readonly code = "fixture_source_unavailable";

  constructor(options?: ErrorOptions) {
    super("Immutable Qoder fixture source is unavailable", options);
    this.name = "FixtureSourceUnavailableError";
  }
}

async function gitSource(path: string): Promise<string> {
  try {
    const result = await execFile(
      "git",
      ["show", `${sourceRevision}:${path}`],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return result.stdout;
  } catch (cause) {
    throw new FixtureSourceUnavailableError({ cause });
  }
}

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
const installedSdkVersion = sdkPackage.version;

const prepared = await Promise.all(
  (Object.keys(fixtures) as Array<keyof typeof fixtures>).map(async (name) => {
    const fixture = fixtures[name];
    const base = `adapters/qoder/test/fixtures/${name}`;
    const [sourceRaw, sourceMetadataRaw] = await Promise.all([
      gitSource(`${base}.jsonl`),
      gitSource(`${base}.metadata.json`),
    ]);
    const sourceSha256 = createHash("sha256").update(sourceRaw).digest("hex");
    if (sourceSha256 !== fixture.sourceSha256) {
      throw new Error("Immutable Qoder fixture source digest mismatch");
    }
    const candidate = await prepareFixtureCandidate({
      name,
      sourceRaw,
      sourceMetadataRaw,
      installedSdkVersion,
      minimumNativeToolCount: fixture.minimumNativeToolCount,
    });
    return { name, candidate };
  }),
);

for (const { name, candidate } of prepared) {
  const jsonlUrl = new URL(`../fixtures/${name}.jsonl`, import.meta.url);
  const metadataUrl = new URL(
    `../fixtures/${name}.metadata.json`,
    import.meta.url,
  );
  await replaceFixturePair({
    jsonlPath: fileURLToPath(jsonlUrl),
    metadataPath: fileURLToPath(metadataUrl),
    jsonl: candidate.jsonl,
    metadata: candidate.metadata,
  });
}
