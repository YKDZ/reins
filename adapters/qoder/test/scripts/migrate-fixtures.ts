import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  projectRecordedQoderMessages,
  recordedQoderScenarios,
  RECORDED_QODER_PROJECTION_VERSION,
  toQoderSdkMessages,
  type RecordedQoderFixtureName,
} from "../../src/fixture-projection.ts";
import {
  assertMatchesKnownCredentialPolicy,
  replaceFixturePair,
} from "./fixture-files.ts";
import { validateRecordedFixture } from "./fixture-validation.ts";

const minimumTools = {
  "list-and-tool": 1,
  "two-tools": 2,
} as const satisfies Record<RecordedQoderFixtureName, number>;

for (const name of Object.keys(minimumTools) as RecordedQoderFixtureName[]) {
  const jsonlUrl = new URL(`../fixtures/${name}.jsonl`, import.meta.url);
  const metadataUrl = new URL(
    `../fixtures/${name}.metadata.json`,
    import.meta.url,
  );
  const [raw, metadataRaw] = await Promise.all([
    readFile(jsonlUrl, "utf8"),
    readFile(metadataUrl, "utf8"),
  ]);
  const source: unknown[] = raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
  const previous = JSON.parse(metadataRaw) as Record<string, unknown>;
  assertMatchesKnownCredentialPolicy(source);
  const projected = projectRecordedQoderMessages(source);
  assertMatchesKnownCredentialPolicy(projected);
  const facts = validateRecordedFixture(toQoderSdkMessages(projected), {
    timedOut: false,
    minimumNativeToolCount: minimumTools[name],
  });
  const jsonl = `${projected.map((message) => JSON.stringify(message)).join("\n")}\n`;
  const metadata = {
    fixture: `${name}.jsonl`,
    recordedAt: previous.recordedAt,
    sdkVersion: previous.sdkVersion,
    qoderCliVersion:
      projected[0]?.type === "system"
        ? projected[0].qodercli_version
        : undefined,
    protocolVersion:
      projected[0]?.type === "system"
        ? projected[0].protocol_version
        : undefined,
    projectionVersion: RECORDED_QODER_PROJECTION_VERSION,
    lineCount: projected.length,
    uniqueNativeToolCount: facts.uniqueNativeToolCount,
    sha256: createHash("sha256").update(jsonl).digest("hex"),
    scenario: recordedQoderScenarios[name],
  };
  await replaceFixturePair({
    jsonlPath: fileURLToPath(jsonlUrl),
    metadataPath: fileURLToPath(metadataUrl),
    jsonl,
    metadata: `${JSON.stringify(metadata, null, 2)}\n`,
  });
}
