import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { loadAnchoredRecordedQoderFixtureSource } from "#/testing";

import { prepareFixtureCandidate } from "../scripts/fixture-candidate.ts";
import { installRecordedFixtureCandidates } from "../scripts/fixture-install.ts";
import {
  readImmutableGitSource,
  runFixtureMigration,
} from "../scripts/migrate-fixtures.ts";
import { runFixtureRecording } from "../scripts/record-fixture.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function recordingSource(): Promise<{
  sourceRaw: string;
  recordedAt: string;
}> {
  const recordedAt = "2026-08-25T18:10:33.366Z";
  const projectedRaw = await readFile(
    new URL("../fixtures/two-tools.jsonl", import.meta.url),
    "utf8",
  );
  const [init, ...rest] = projectedRaw.trimEnd().split("\n");
  if (init === undefined) throw new Error("Fixture init is missing");
  return {
    sourceRaw: `${JSON.stringify({
      ...(JSON.parse(init) as object),
      timestamp: recordedAt,
    })}\n${rest.join("\n")}\n`,
    recordedAt,
  };
}

async function isolatedFixtureDirectory(): Promise<{
  directory: string;
  anchorsRaw: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "reins-qoder-entrypoint-"));
  temporaryDirectories.push(directory);
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
  return {
    directory,
    anchorsRaw: await readFile(join(directory, "anchors.json"), "utf8"),
  };
}

async function fixtureDigests(directory: string): Promise<string[]> {
  return Promise.all(
    [
      "anchors.json",
      "list-and-tool.jsonl",
      "list-and-tool.metadata.json",
      "two-tools.jsonl",
      "two-tools.metadata.json",
    ].map(async (file) =>
      createHash("sha256")
        .update(await readFile(join(directory, file)))
        .digest("hex"),
    ),
  );
}

describe("Qoder fixture writer entrypoints", () => {
  test("正式record runner用recording provenance安装可由anchored loader读取的资产", async () => {
    const source = await recordingSource();
    const fixture = await isolatedFixtureDirectory();
    let preparedInput:
      | Parameters<typeof prepareFixtureCandidate>[0]
      | undefined;

    await runFixtureRecording(
      {
        name: "two-tools",
        fixtureDirectory: fixture.directory,
        anchorsRaw: fixture.anchorsRaw,
      },
      {
        record: async () => ({ ...source, timedOut: false }),
        installedSdkVersion: async () => "1.0.23",
        prepare: async (input) => {
          preparedInput = input;
          return prepareFixtureCandidate(input);
        },
      },
    );

    expect(preparedInput).toMatchObject({
      name: "two-tools",
      recordedAt: source.recordedAt,
      sdkVersion: "1.0.23",
      installedSdkVersion: "1.0.23",
      minimumNativeToolCount: 2,
      timedOut: false,
    });
    expect(preparedInput).not.toHaveProperty("sourceMetadataRaw");
    expect(
      createHash("sha256").update(preparedInput!.sourceRaw).digest("hex"),
    ).toBe(createHash("sha256").update(source.sourceRaw).digest("hex"));

    const [raw, metadataRaw, anchorsRaw] = await Promise.all([
      readFile(join(fixture.directory, "two-tools.jsonl"), "utf8"),
      readFile(join(fixture.directory, "two-tools.metadata.json"), "utf8"),
      readFile(join(fixture.directory, "anchors.json"), "utf8"),
    ]);
    expect(() =>
      loadAnchoredRecordedQoderFixtureSource(
        "two-tools",
        { raw, metadataRaw, sdkVersion: "1.0.23" },
        anchorsRaw,
      ),
    ).not.toThrow();
  });

  test("recording-only provenance损坏时正式runner在installer前失败且目标不变", async () => {
    const source = await recordingSource();
    const fixture = await isolatedFixtureDirectory();
    const before = await fixtureDigests(fixture.directory);
    let installCalls = 0;

    await expect(
      runFixtureRecording(
        {
          name: "two-tools",
          fixtureDirectory: fixture.directory,
          anchorsRaw: fixture.anchorsRaw,
        },
        {
          record: async () => ({
            ...source,
            recordedAt: "2026-08-25T18:10:34.366Z",
            timedOut: false,
          }),
          installedSdkVersion: async () => "1.0.23",
          install: async () => {
            installCalls += 1;
            throw new Error("Installer must not run");
          },
        },
      ),
    ).rejects.toThrow("Recorded Qoder source timestamp mismatch");
    expect(installCalls).toBe(0);
    expect(await fixtureDigests(fixture.directory)).toEqual(before);
  });

  test("default migration从固定Git对象准备两套资产并以单次事务幂等安装", async () => {
    const fixture = await isolatedFixtureDirectory();
    let installCalls = 0;
    const install: typeof installRecordedFixtureCandidates = async (
      options,
    ) => {
      installCalls += 1;
      return installRecordedFixtureCandidates(options);
    };

    await runFixtureMigration({
      fixtureDirectory: fixture.directory,
      install,
    });
    expect(installCalls).toBe(1);
    const first = await fixtureDigests(fixture.directory);
    const firstAnchors = await readFile(
      join(fixture.directory, "anchors.json"),
      "utf8",
    );
    for (const name of ["list-and-tool", "two-tools"] as const) {
      const [raw, metadataRaw] = await Promise.all([
        readFile(join(fixture.directory, `${name}.jsonl`), "utf8"),
        readFile(join(fixture.directory, `${name}.metadata.json`), "utf8"),
      ]);
      expect(() =>
        loadAnchoredRecordedQoderFixtureSource(
          name,
          { raw, metadataRaw, sdkVersion: "1.0.23" },
          firstAnchors,
        ),
      ).not.toThrow();
    }

    await runFixtureMigration({
      fixtureDirectory: fixture.directory,
      install,
    });
    expect(installCalls).toBe(2);
    expect(await fixtureDigests(fixture.directory)).toEqual(first);
  });

  test("default migration的immutable source不可用时installer调用为零且目标不变", async () => {
    const fixture = await isolatedFixtureDirectory();
    const before = await fixtureDigests(fixture.directory);
    let installCalls = 0;

    await expect(
      runFixtureMigration({
        fixtureDirectory: fixture.directory,
        readSource: (revision, path) =>
          readImmutableGitSource(revision, path, async () => {
            throw new Error("offline immutable source unavailable");
          }),
        install: async () => {
          installCalls += 1;
          throw new Error("Installer must not run");
        },
      }),
    ).rejects.toMatchObject({
      code: "fixture_source_unavailable",
      revision: "e3b522c4adc037319bf065590b2faab616ca47c6",
      reason: "git_failed",
    });
    expect(installCalls).toBe(0);
    expect(await fixtureDigests(fixture.directory)).toEqual(before);
  });

  test("default migration的candidate准备失败时installer调用为零且目标不变", async () => {
    const fixture = await isolatedFixtureDirectory();
    const before = await fixtureDigests(fixture.directory);
    let installCalls = 0;

    await expect(
      runFixtureMigration({
        fixtureDirectory: fixture.directory,
        installedSdkVersion: async () => "9.9.9",
        install: async () => {
          installCalls += 1;
          throw new Error("Installer must not run");
        },
      }),
    ).rejects.toThrow("Recorded Qoder SDK version mismatch");
    expect(installCalls).toBe(0);
    expect(await fixtureDigests(fixture.directory)).toEqual(before);
  });
});
