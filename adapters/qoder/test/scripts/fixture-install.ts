import { join } from "node:path";

import {
  parseRecordedQoderFixtureAnchors,
  updateRecordedQoderFixtureAnchors,
  type RecordedQoderFixtureAnchors,
} from "../../src/fixture-anchors.ts";
import type {
  RecordedQoderFixtureMetadata,
  RecordedQoderFixtureName,
} from "../../src/fixture-projection.ts";
import { parseCanonicalRecordedQoderMetadata } from "../../src/fixture-projection.ts";
import { replaceFixturePairs, type FixturePair } from "./fixture-files.ts";

type InstallCandidate = {
  name: RecordedQoderFixtureName;
  jsonl: string;
  metadata: string;
};

export async function installRecordedFixtureCandidates(options: {
  fixtureDirectory: string;
  anchorsRaw: string;
  candidates: readonly InstallCandidate[];
  install?: typeof replaceFixturePairs;
}): Promise<RecordedQoderFixtureAnchors> {
  const updates = new Map<
    RecordedQoderFixtureName,
    RecordedQoderFixtureMetadata
  >();
  for (const { name, metadata } of options.candidates) {
    const value = parseCanonicalRecordedQoderMetadata(metadata);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Recorded Qoder fixture metadata mismatch");
    }
    updates.set(name, value as RecordedQoderFixtureMetadata);
  }
  const anchors = updateRecordedQoderFixtureAnchors(
    options.anchorsRaw,
    updates,
  );
  const pairs: FixturePair[] = options.candidates.map(
    ({ name, jsonl, metadata }) => ({
      jsonlPath: join(options.fixtureDirectory, `${name}.jsonl`),
      metadataPath: join(options.fixtureDirectory, `${name}.metadata.json`),
      jsonl,
      metadata,
    }),
  );
  await (options.install ?? replaceFixturePairs)(pairs, {
    additionalFiles: [
      {
        path: join(options.fixtureDirectory, "anchors.json"),
        content: anchors,
      },
    ],
  });
  return parseRecordedQoderFixtureAnchors(anchors);
}
