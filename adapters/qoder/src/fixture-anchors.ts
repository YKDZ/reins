import { isDeepStrictEqual } from "node:util";

import {
  parseCanonicalRecordedQoderMetadata,
  type RecordedQoderFixtureMetadata,
  type RecordedQoderFixtureName,
} from "./fixture-projection.ts";

export type RecordedQoderFixtureAnchor = {
  sourceSha256: string;
  artifactSha256: string;
  projectionVersion: number;
};

export type RecordedQoderFixtureAnchors = {
  version: 1;
  fixtures: Record<RecordedQoderFixtureName, RecordedQoderFixtureAnchor>;
};

const fixtureNames = ["list-and-tool", "two-tools"] as const;
const anchorKeys = [
  "artifactSha256",
  "projectionVersion",
  "sourceSha256",
] as const;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Recorded Qoder fixture anchor mismatch");
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    isDeepStrictEqual(actual, [...expected].sort())
  );
}

export function parseRecordedQoderFixtureAnchors(
  raw: string,
): RecordedQoderFixtureAnchors {
  const parsed = parseCanonicalRecordedQoderMetadata(raw);
  const manifest = record(parsed);
  const fixtures = record(manifest.fixtures);
  if (
    !exactKeys(manifest, ["fixtures", "version"]) ||
    manifest.version !== 1 ||
    !exactKeys(fixtures, fixtureNames)
  ) {
    throw new Error("Recorded Qoder fixture anchor mismatch");
  }
  for (const name of fixtureNames) {
    const anchor = record(fixtures[name]);
    if (
      !exactKeys(anchor, anchorKeys) ||
      typeof anchor.sourceSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(anchor.sourceSha256) ||
      typeof anchor.artifactSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(anchor.artifactSha256) ||
      !Number.isSafeInteger(anchor.projectionVersion) ||
      (anchor.projectionVersion as number) < 1
    ) {
      throw new Error("Recorded Qoder fixture anchor mismatch");
    }
  }
  return parsed as RecordedQoderFixtureAnchors;
}

export function serializeRecordedQoderFixtureAnchors(
  anchors: RecordedQoderFixtureAnchors,
): string {
  const raw = `${JSON.stringify(anchors, null, 2)}\n`;
  parseRecordedQoderFixtureAnchors(raw);
  return raw;
}

export function updateRecordedQoderFixtureAnchors(
  raw: string,
  updates: ReadonlyMap<RecordedQoderFixtureName, RecordedQoderFixtureMetadata>,
): string {
  const current = parseRecordedQoderFixtureAnchors(raw);
  const fixtures = { ...current.fixtures };
  for (const [name, metadata] of updates) {
    fixtures[name] = {
      sourceSha256: metadata.sourceSha256,
      artifactSha256: metadata.artifactSha256,
      projectionVersion: metadata.projectionVersion,
    };
  }
  return serializeRecordedQoderFixtureAnchors({ version: 1, fixtures });
}
