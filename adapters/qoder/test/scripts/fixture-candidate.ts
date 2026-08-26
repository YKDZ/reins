import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { SDKMessage } from "@qodercn-ai/qodercn-agent-sdk";

import {
  assertCanonicalRecordedQoderMessages,
  assertRecordedQoderFixtureMetadata,
  parseCanonicalRecordedQoderJsonl,
  parseCanonicalRecordedQoderMetadata,
  projectRecordedQoderMessages,
  recordedQoderScenarios,
  RECORDED_QODER_PROJECTION_VERSION,
  serializeRecordedQoderMessages,
  serializeRecordedQoderMetadata,
  toQoderSdkMessages,
  type RecordedQoderFixtureMetadata,
  type RecordedQoderFixtureName,
} from "../../src/fixture-projection.ts";
import { loadRecordedQoderFixtureSource } from "../../src/testing.ts";
import { assertMatchesKnownCredentialPolicy } from "./fixture-files.ts";
import { assertQoderProjectionSemanticEquivalence } from "./fixture-fingerprint.ts";
import { validateRecordedFixture } from "./fixture-validation.ts";

const legacyMetadataKeys = [
  "fixture",
  "lineCount",
  "protocolVersion",
  "qoderCliVersion",
  "recordedAt",
  "scenario",
  "sdkVersion",
  "sha256",
  "uniqueNativeToolCount",
] as const;

class FixtureCandidateAcceptanceError extends Error {
  readonly code = "fixture_candidate_rejected";

  constructor() {
    super("Recorded Qoder candidate was rejected by the fixture loader");
    this.name = "FixtureCandidateAcceptanceError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Recorded Qoder source metadata mismatch");
  }
  return value as Record<string, unknown>;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return (
    !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value
  );
}

function semanticVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value)
  );
}

function sourceFacts(options: {
  name: RecordedQoderFixtureName;
  sourceRaw: string;
  sourceMetadataRaw?: string;
  recordedAt?: string;
  sdkVersion?: string;
}): {
  recordedAt: string;
  sdkVersion: string;
  legacyMetadata?: Record<string, unknown>;
} {
  if (options.sourceMetadataRaw === undefined) {
    if (
      !canonicalTimestamp(options.recordedAt) ||
      !semanticVersion(options.sdkVersion)
    ) {
      throw new Error("Recorded Qoder source provenance mismatch");
    }
    assertMatchesKnownCredentialPolicy({
      recordedAt: options.recordedAt,
      sdkVersion: options.sdkVersion,
    });
    return { recordedAt: options.recordedAt, sdkVersion: options.sdkVersion };
  }

  const metadata = record(
    parseCanonicalRecordedQoderMetadata(options.sourceMetadataRaw),
  );
  assertMatchesKnownCredentialPolicy(metadata);
  const metadataKeys = Object.keys(metadata).sort();
  if (
    metadataKeys.length !== legacyMetadataKeys.length ||
    !isDeepStrictEqual(metadataKeys, legacyMetadataKeys) ||
    metadata.fixture !== `${options.name}.jsonl` ||
    !canonicalTimestamp(metadata.recordedAt) ||
    !semanticVersion(metadata.sdkVersion) ||
    metadata.sha256 !== sha256(options.sourceRaw) ||
    metadata.scenario !== recordedQoderScenarios[options.name]
  ) {
    throw new Error("Recorded Qoder source metadata mismatch");
  }
  return {
    recordedAt: metadata.recordedAt,
    sdkVersion: metadata.sdkVersion,
    legacyMetadata: metadata,
  };
}

export async function prepareFixtureCandidate(options: {
  name: RecordedQoderFixtureName;
  sourceRaw: string;
  sourceMetadataRaw?: string;
  recordedAt?: string;
  sdkVersion?: string;
  installedSdkVersion: string;
  minimumNativeToolCount: number;
  timedOut?: boolean;
}): Promise<{
  jsonl: string;
  metadata: string;
  facts: { uniqueNativeToolCount: number; contentResultCount: number };
}> {
  const source = parseCanonicalRecordedQoderJsonl(options.sourceRaw);
  assertMatchesKnownCredentialPolicy(source);
  const provenance = sourceFacts(options);
  const sourceRecordedAt = source
    .flatMap((message) => {
      if (typeof message !== "object" || message === null) return [];
      const timestamp = (message as { timestamp?: unknown }).timestamp;
      return typeof timestamp === "string" ? [timestamp] : [];
    })
    .at(0);
  if (sourceRecordedAt !== provenance.recordedAt) {
    throw new Error("Recorded Qoder source timestamp mismatch");
  }
  if (
    !semanticVersion(options.installedSdkVersion) ||
    provenance.sdkVersion !== options.installedSdkVersion
  ) {
    throw new Error("Recorded Qoder SDK version mismatch");
  }
  const sourceMessages = source as SDKMessage[];
  const sourceValidation = validateRecordedFixture(sourceMessages, {
    timedOut: options.timedOut ?? false,
    minimumNativeToolCount: options.minimumNativeToolCount,
  });
  const sourceInit = source[0];
  if (
    sourceInit === null ||
    typeof sourceInit !== "object" ||
    !("type" in sourceInit) ||
    sourceInit.type !== "system"
  ) {
    throw new Error("Recorded Qoder fixture has no init message");
  }
  const legacy = provenance.legacyMetadata;
  if (
    legacy !== undefined &&
    (legacy.lineCount !== source.length ||
      legacy.uniqueNativeToolCount !== sourceValidation.uniqueNativeToolCount ||
      legacy.qoderCliVersion !==
        (sourceInit as { qodercli_version?: unknown }).qodercli_version ||
      legacy.protocolVersion !==
        (sourceInit as { protocol_version?: unknown }).protocol_version)
  ) {
    throw new Error("Recorded Qoder source metadata mismatch");
  }
  const projected = projectRecordedQoderMessages(source);
  await assertQoderProjectionSemanticEquivalence(sourceMessages);
  assertMatchesKnownCredentialPolicy(projected);
  assertCanonicalRecordedQoderMessages(projected);
  const projectedMessages = toQoderSdkMessages(projected);
  const facts = validateRecordedFixture(projectedMessages, {
    timedOut: false,
    minimumNativeToolCount: options.minimumNativeToolCount,
  });
  const init = projected[0];
  if (init?.type !== "system") {
    throw new Error("Recorded Qoder fixture has no init message");
  }
  const jsonl = serializeRecordedQoderMessages(projected);
  const metadataValue: RecordedQoderFixtureMetadata = {
    fixture: `${options.name}.jsonl`,
    recordedAt: provenance.recordedAt,
    sdkVersion: provenance.sdkVersion,
    qoderCliVersion: init.qodercli_version,
    protocolVersion: init.protocol_version,
    projectionVersion: RECORDED_QODER_PROJECTION_VERSION,
    lineCount: projected.length,
    uniqueNativeToolCount: facts.uniqueNativeToolCount,
    artifactSha256: sha256(jsonl),
    sourceSha256: sha256(options.sourceRaw),
    scenario: recordedQoderScenarios[options.name],
  };
  assertRecordedQoderFixtureMetadata(options.name, metadataValue, {
    recordedAt: provenance.recordedAt,
    sdkVersion: provenance.sdkVersion,
    qoderCliVersion: init.qodercli_version,
    protocolVersion: init.protocol_version,
    lineCount: projected.length,
    uniqueNativeToolCount: facts.uniqueNativeToolCount,
    artifactSha256: sha256(jsonl),
  });
  const metadata = serializeRecordedQoderMetadata(metadataValue);
  if (
    !isDeepStrictEqual(parseCanonicalRecordedQoderJsonl(jsonl), projected) ||
    !isDeepStrictEqual(
      parseCanonicalRecordedQoderMetadata(metadata),
      metadataValue,
    )
  ) {
    throw new Error("Recorded Qoder candidate roundtrip mismatch");
  }
  try {
    loadRecordedQoderFixtureSource(options.name, {
      raw: jsonl,
      metadataRaw: metadata,
      sdkVersion: options.installedSdkVersion,
    });
  } catch {
    throw new FixtureCandidateAcceptanceError();
  }
  return { jsonl, metadata, facts };
}
