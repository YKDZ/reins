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

async function immutableSourceWithoutFinalEndTurn(): Promise<{
  sourceRaw: string;
  sourceMetadataRaw: string;
  recordedAt: string;
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
    sourceRaw: raw,
    sourceMetadataRaw: `${JSON.stringify(
      {
        ...metadata,
        lineCount: retained.length,
        sha256: createHash("sha256").update(raw).digest("hex"),
      },
      null,
      2,
    )}\n`,
    recordedAt: metadata.recordedAt as string,
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

  test("正式record runner在installer前拒绝正式loader不接受的source", async () => {
    const source = await immutableSourceWithoutFinalEndTurn();
    const fixture = await isolatedFixtureDirectory();
    const before = await fixtureDigests(fixture.directory);
    let installCalls = 0;

    const error = await runFixtureRecording(
      {
        name: "two-tools",
        fixtureDirectory: fixture.directory,
        anchorsRaw: fixture.anchorsRaw,
      },
      {
        record: async () => ({
          sourceRaw: source.sourceRaw,
          recordedAt: source.recordedAt,
          timedOut: false,
        }),
        installedSdkVersion: async () => "1.0.23",
        install: async () => {
          installCalls += 1;
          throw new Error("Installer must not run");
        },
      },
    ).catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "fixture_candidate_rejected",
      message: "Recorded Qoder candidate was rejected by the fixture loader",
    });
    expect(JSON.stringify(error)).not.toMatch(
      /message_delta|end_turn|Both commands|first|second/u,
    );
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

  test("default migration走真实candidate并在installer前拒绝loader不接受的source", async () => {
    const source = await immutableSourceWithoutFinalEndTurn();
    const fixture = await isolatedFixtureDirectory();
    const before = await fixtureDigests(fixture.directory);
    const anchors = JSON.parse(fixture.anchorsRaw) as {
      fixtures: { "two-tools": { sourceSha256: string } };
    };
    anchors.fixtures["two-tools"].sourceSha256 = createHash("sha256")
      .update(source.sourceRaw)
      .digest("hex");
    const candidateAnchorsRaw = `${JSON.stringify(anchors, null, 2)}\n`;
    let installCalls = 0;

    const error = await runFixtureMigration({
      fixtureDirectory: fixture.directory,
      anchorsRaw: candidateAnchorsRaw,
      readSource: async (revision, path) => {
        if (path.endsWith("two-tools.jsonl")) return source.sourceRaw;
        if (path.endsWith("two-tools.metadata.json")) {
          return source.sourceMetadataRaw;
        }
        return readImmutableGitSource(revision, path);
      },
      install: async () => {
        installCalls += 1;
        throw new Error("Installer must not run");
      },
    }).catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "fixture_candidate_rejected",
      message: "Recorded Qoder candidate was rejected by the fixture loader",
    });
    expect(JSON.stringify(error)).not.toMatch(
      /message_delta|end_turn|Both commands|first|second/u,
    );
    expect(installCalls).toBe(0);
    expect(await fixtureDigests(fixture.directory)).toEqual(before);
  });
});
