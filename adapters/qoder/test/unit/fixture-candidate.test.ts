import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { loadAnchoredRecordedQoderFixtureSource } from "#/testing";

import { prepareFixtureCandidate } from "../scripts/fixture-candidate.ts";
import {
  replaceFixturePair,
  replaceFixturePairs,
} from "../scripts/fixture-files.ts";
import { installRecordedFixtureCandidates } from "../scripts/fixture-install.ts";
import { readImmutableGitSource } from "../scripts/migrate-fixtures.ts";

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

async function immutableSourceWithoutFinalEndTurn(): Promise<{
  raw: string;
  metadataRaw: string;
}> {
  const revision = "e3b522c4adc037319bf065590b2faab616ca47c6";
  const base = "adapters/qoder/test/fixtures/two-tools";
  const [sourceRaw, sourceMetadataRaw] = await Promise.all([
    readImmutableGitSource(revision, `${base}.jsonl`),
    readImmutableGitSource(revision, `${base}.metadata.json`),
  ]);
  const messages = sourceRaw
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const retained = messages.filter((message) => {
    if (message.type !== "stream_event") return true;
    const event = message.event as
      | { type?: unknown; delta?: { stop_reason?: unknown } }
      | undefined;
    return !(
      event?.type === "message_delta" && event.delta?.stop_reason === "end_turn"
    );
  });
  expect(messages).toHaveLength(retained.length + 1);
  const raw = `${retained.map((message) => JSON.stringify(message)).join("\n")}\n`;
  const metadata = JSON.parse(sourceMetadataRaw) as Record<string, unknown>;
  return {
    raw,
    metadataRaw: metadataBytes({
      ...metadata,
      lineCount: retained.length,
      sha256: createHash("sha256").update(raw).digest("hex"),
    }),
  };
}

describe("Qoder fixture candidate acceptance", () => {
  test("正式loader拒绝的缺失end-turn source不能成为candidate", async () => {
    const source = await immutableSourceWithoutFinalEndTurn();

    await expect(
      prepareFixtureCandidate({
        name: "two-tools",
        sourceRaw: source.raw,
        sourceMetadataRaw: source.metadataRaw,
        installedSdkVersion: "1.0.23",
        minimumNativeToolCount: 2,
      }),
    ).rejects.toMatchObject({ code: "fixture_candidate_rejected" });
  });

  test("record-mode原子安装pair与独立anchor后内置loader立即接受", async () => {
    const fixture = await source();
    const candidate = await prepareFixtureCandidate({
      name: "two-tools",
      sourceRaw: fixture.raw,
      sourceMetadataRaw: metadataBytes(fixture.metadata),
      installedSdkVersion: "1.0.23",
      minimumNativeToolCount: 2,
    });
    const directory = await mkdtemp(join(tmpdir(), "reins-qoder-record-"));
    temporaryDirectories.push(directory);
    const anchorsRaw = await readFile(
      new URL("../fixtures/anchors.json", import.meta.url),
      "utf8",
    );
    for (const file of [
      "anchors.json",
      "list-and-tool.jsonl",
      "list-and-tool.metadata.json",
      "two-tools.jsonl",
      "two-tools.metadata.json",
    ]) {
      await writeFile(
        join(directory, file),
        await readFile(new URL(`../fixtures/${file}`, import.meta.url), "utf8"),
      );
    }

    await installRecordedFixtureCandidates({
      fixtureDirectory: directory,
      anchorsRaw,
      candidates: [{ name: "two-tools", ...candidate }],
    });
    const installedRaw = await readFile(
      join(directory, "two-tools.jsonl"),
      "utf8",
    );
    const installedMetadata = await readFile(
      join(directory, "two-tools.metadata.json"),
      "utf8",
    );
    const installedAnchors = await readFile(
      join(directory, "anchors.json"),
      "utf8",
    );
    expect(() =>
      loadAnchoredRecordedQoderFixtureSource(
        "two-tools",
        {
          raw: installedRaw,
          metadataRaw: installedMetadata,
          sdkVersion: "1.0.23",
        },
        installedAnchors,
      ),
    ).not.toThrow();
    expect(installedAnchors).not.toBe(anchorsRaw);
  });

  test("record-mode任一资产安装失败时pair与anchor全部回滚", async () => {
    const fixture = await source();
    const candidate = await prepareFixtureCandidate({
      name: "two-tools",
      sourceRaw: fixture.raw,
      sourceMetadataRaw: metadataBytes(fixture.metadata),
      installedSdkVersion: "1.0.23",
      minimumNativeToolCount: 2,
    });
    const directory = await mkdtemp(join(tmpdir(), "reins-qoder-record-"));
    temporaryDirectories.push(directory);
    const originals = new Map<string, string>();
    for (const file of [
      "anchors.json",
      "two-tools.jsonl",
      "two-tools.metadata.json",
    ]) {
      const content = await readFile(
        new URL(`../fixtures/${file}`, import.meta.url),
        "utf8",
      );
      originals.set(file, content);
      await writeFile(join(directory, file), content);
    }
    let installs = 0;
    await expect(
      installRecordedFixtureCandidates({
        fixtureDirectory: directory,
        anchorsRaw: originals.get("anchors.json")!,
        candidates: [{ name: "two-tools", ...candidate }],
        install: async (pairs, options) =>
          replaceFixturePairs(pairs, {
            ...options,
            renameFile: async (source, destination) => {
              if (source.endsWith(".tmp") && ++installs === 3) {
                throw new Error("anchor install failed");
              }
              await rename(source, destination);
            },
          }),
      }),
    ).rejects.toMatchObject({ code: "fixture_pair_replace_failed" });
    for (const [file, content] of originals) {
      await expect(readFile(join(directory, file), "utf8")).resolves.toBe(
        content,
      );
    }
    expect(
      (await readdir(directory)).some((file) =>
        /\.(?:tmp|backup)$/u.test(file),
      ),
    ).toBe(false);
  });

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
      projectionVersion: 4,
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
