import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { SDKMessage } from "@qodercn-ai/qodercn-agent-sdk";

import {
  parseCanonicalRecordedQoderJsonl,
  parseCanonicalRecordedQoderMetadata,
  projectRecordedQoderMessages,
  recordedQoderScenarios,
  RECORDED_QODER_PROJECTION_VERSION,
  serializeRecordedQoderMessages,
  serializeRecordedQoderMetadata,
  toQoderSdkMessages,
  type RecordedQoderFixtureName,
} from "../../src/fixture-projection.ts";
import {
  assertMatchesKnownCredentialPolicy,
  replaceFixturePair,
} from "./fixture-files.ts";
import { assertQoderProjectionSemanticEquivalence } from "./fixture-fingerprint.ts";
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
  const source = parseCanonicalRecordedQoderJsonl(raw);
  const parsedMetadata = parseCanonicalRecordedQoderMetadata(metadataRaw);
  if (
    typeof parsedMetadata !== "object" ||
    parsedMetadata === null ||
    Array.isArray(parsedMetadata)
  ) {
    throw new Error("Recorded Qoder fixture metadata mismatch");
  }
  const previous = parsedMetadata as Record<string, unknown>;
  assertMatchesKnownCredentialPolicy(source);
  const projected = projectRecordedQoderMessages(source);
  assertMatchesKnownCredentialPolicy(projected);
  await assertQoderProjectionSemanticEquivalence(source as SDKMessage[]);
  const facts = validateRecordedFixture(toQoderSdkMessages(projected), {
    timedOut: false,
    minimumNativeToolCount: minimumTools[name],
  });
  const jsonl = serializeRecordedQoderMessages(projected);
  const init = projected[0];
  if (
    typeof previous.recordedAt !== "string" ||
    typeof previous.sdkVersion !== "string" ||
    init?.type !== "system"
  ) {
    throw new Error("Recorded Qoder fixture metadata mismatch");
  }
  const metadata = {
    fixture: `${name}.jsonl`,
    recordedAt: previous.recordedAt,
    sdkVersion: previous.sdkVersion,
    qoderCliVersion: init.qodercli_version,
    protocolVersion: init.protocol_version,
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
    metadata: serializeRecordedQoderMetadata(metadata),
  });
}
