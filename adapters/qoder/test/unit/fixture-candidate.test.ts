import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { prepareFixtureCandidate } from "../scripts/fixture-candidate.ts";
import { replaceFixturePair } from "../scripts/fixture-files.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function source(): Promise<{ raw: string; metadata: object }> {
  const projectedRaw = await readFile(
    new URL("../fixtures/two-tools.jsonl", import.meta.url),
    "utf8",
  );
  const [init, ...rest] = projectedRaw.trimEnd().split("\n");
  if (init === undefined) throw new Error("Fixture init is missing");
  const raw = `${JSON.stringify({
    ...(JSON.parse(init) as object),
    timestamp: "2026-08-25T18:10:33.366Z",
  })}\n${rest.join("\n")}\n`;
  return {
    raw,
    metadata: {
      fixture: "two-tools.jsonl",
      recordedAt: "2026-08-25T18:10:33.366Z",
      sdkVersion: "1.0.23",
      qoderCliVersion: "1.1.23",
      protocolVersion: "1.2.0",
      lineCount: 34,
      uniqueNativeToolCount: 2,
      sha256: createHash("sha256").update(raw).digest("hex"),
      scenario:
        "Two sequential non-combined Bash tool requests and results followed by a streamed text reply",
    },
  };
}

function metadataBytes(metadata: object): string {
  return `${JSON.stringify(metadata, null, 2)}\n`;
}

describe("Qoder fixture candidate acceptance", () => {
  test("prepares canonical v2 bytes through the single writer-side contract", async () => {
    const fixture = await source();
    const candidate = await prepareFixtureCandidate({
      name: "two-tools",
      sourceRaw: fixture.raw,
      sourceMetadataRaw: metadataBytes(fixture.metadata),
      installedSdkVersion: "1.0.23",
      minimumNativeToolCount: 2,
    });
    expect(JSON.parse(candidate.metadata)).toMatchObject({
      projectionVersion: 2,
      sourceSha256: createHash("sha256").update(fixture.raw).digest("hex"),
      artifactSha256: createHash("sha256")
        .update(candidate.jsonl)
        .digest("hex"),
    });
  });

  test("all provenance failures happen before replacement and preserve the pair", async () => {
    const fixture = await source();
    const directory = await mkdtemp(join(tmpdir(), "reins-qoder-candidate-"));
    temporaryDirectories.push(directory);
    const jsonlPath = join(directory, "fixture.jsonl");
    const metadataPath = join(directory, "fixture.metadata.json");
    await writeFile(jsonlPath, "old-jsonl\n");
    await writeFile(metadataPath, "old-metadata\n");

    const invalidMetadata = [
      { ...fixture.metadata, recordedAt: "Bearer abcdefghijklmnop" },
      { ...fixture.metadata, sdkVersion: "latest" },
      { ...fixture.metadata, runtime: [] },
    ];
    const duplicateMetadata = metadataBytes(fixture.metadata).replace(
      '  "scenario":',
      '  "scenario": "opaque-device-secret",\n  "scenario":',
    );
    const attempts = [
      ...invalidMetadata.map((metadata) => ({
        sourceRaw: fixture.raw,
        sourceMetadataRaw: metadataBytes(metadata),
      })),
      { sourceRaw: fixture.raw, sourceMetadataRaw: duplicateMetadata },
      {
        sourceRaw: fixture.raw,
        sourceMetadataRaw: JSON.stringify(fixture.metadata),
      },
      {
        sourceRaw: fixture.raw.replace(
          '"cwd":"<fixture-cwd>"',
          '"cwd":"opaque","cwd":"<fixture-cwd>"',
        ),
        sourceMetadataRaw: metadataBytes(fixture.metadata),
      },
    ];

    for (const attempt of attempts) {
      let replacementCalled = false;
      await expect(
        (async () => {
          const candidate = await prepareFixtureCandidate({
            name: "two-tools",
            ...attempt,
            installedSdkVersion: "1.0.23",
            minimumNativeToolCount: 2,
          });
          replacementCalled = true;
          await replaceFixturePair({
            jsonlPath,
            metadataPath,
            jsonl: candidate.jsonl,
            metadata: candidate.metadata,
          });
        })(),
      ).rejects.toBeInstanceOf(Error);
      expect(replacementCalled).toBe(false);
      await expect(readFile(jsonlPath, "utf8")).resolves.toBe("old-jsonl\n");
      await expect(readFile(metadataPath, "utf8")).resolves.toBe(
        "old-metadata\n",
      );
    }

    const valid = await prepareFixtureCandidate({
      name: "two-tools",
      sourceRaw: fixture.raw,
      sourceMetadataRaw: metadataBytes(fixture.metadata),
      installedSdkVersion: "1.0.23",
      minimumNativeToolCount: 2,
    });
    for (let run = 0; run < 2; run += 1) {
      await replaceFixturePair({
        jsonlPath,
        metadataPath,
        jsonl: valid.jsonl,
        metadata: valid.metadata,
      });
      await expect(readFile(jsonlPath, "utf8")).resolves.toBe(valid.jsonl);
      await expect(readFile(metadataPath, "utf8")).resolves.toBe(
        valid.metadata,
      );
    }
  });
});
