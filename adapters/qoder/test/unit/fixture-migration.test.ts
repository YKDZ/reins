import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import {
  FixtureSourceUnavailableError,
  readImmutableGitSource,
  runFixtureMigration,
} from "../scripts/migrate-fixtures.ts";

const directories: string[] = [];
const execFile = promisify(execFileCallback);

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Qoder fixture migration orchestration", () => {
  test("git source failure only exposes a closed safe classification", async () => {
    const error = await readImmutableGitSource(
      "safe-revision",
      "safe/path.jsonl",
      async () => {
        throw Object.assign(new Error("SECRET_BODY"), {
          stdout: "SECRET_STDOUT",
          stderr: "SECRET_STDERR",
        });
      },
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(FixtureSourceUnavailableError);
    expect(error).toMatchObject({
      code: "fixture_source_unavailable",
      revision: "safe-revision",
      path: "safe/path.jsonl",
      reason: "git_failed",
    });
    expect(JSON.stringify(error)).not.toMatch(/SECRET|stdout|stderr|cause/u);
    expect((error as Error).stack).not.toMatch(/SECRET/u);
  });

  test("命令入口不把失败git进程的正文写入stderr", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-fixture-git-"));
    directories.push(directory);
    const gitPath = join(directory, "git");
    await writeFile(
      gitPath,
      "#!/bin/sh\nprintf SECRET_BODY\nprintf SECRET_STDERR >&2\nexit 1\n",
    );
    await chmod(gitPath, 0o755);
    const script = fileURLToPath(
      new URL("../scripts/migrate-fixtures.ts", import.meta.url),
    );
    const failure = await execFile(
      process.execPath,
      ["--conditions=source", script],
      { env: { ...process.env, PATH: directory }, encoding: "utf8" },
    ).catch((cause: unknown) => cause as { stderr?: string; stdout?: string });
    expect(failure.stderr).toContain("fixture_source_unavailable");
    expect(failure.stderr).not.toMatch(/SECRET|stdout|cause/u);
    expect(failure.stdout).toBe("");
  });

  test("runner在第二个pair安装失败时恢复两套fixture且不遗留artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-fixture-migrate-"));
    directories.push(directory);
    const names = ["list-and-tool", "two-tools"] as const;
    const anchorsRaw = await readFile(
      new URL("../fixtures/anchors.json", import.meta.url),
      "utf8",
    );
    await writeFile(join(directory, "anchors.json"), anchorsRaw);
    for (const name of names) {
      await writeFile(join(directory, `${name}.jsonl`), `old-${name}-jsonl\n`);
      await writeFile(
        join(directory, `${name}.metadata.json`),
        `old-${name}-metadata\n`,
      );
    }

    await expect(
      runFixtureMigration({
        fixtureDirectory: directory,
        anchorsRaw,
        prepare: async (name) => ({
          jsonl: `new-${name}-jsonl\n`,
          metadata: `new-${name}-metadata\n`,
        }),
        install: async (options) => {
          const { replaceFixturePairs } =
            await import("../scripts/fixture-files.ts");
          let installs = 0;
          await replaceFixturePairs(
            options.candidates.map(({ name, jsonl, metadata }) => ({
              jsonlPath: join(directory, `${name}.jsonl`),
              metadataPath: join(directory, `${name}.metadata.json`),
              jsonl,
              metadata,
            })),
            {
              additionalFiles: [
                {
                  path: join(directory, "anchors.json"),
                  content: "new-anchors\n",
                },
              ],
              renameFile: async (source, destination) => {
                if (source.includes(".tmp") && ++installs === 4) {
                  throw new Error("second pair install failed");
                }
                const { rename } = await import("node:fs/promises");
                await rename(source, destination);
              },
            },
          );
        },
      }),
    ).rejects.toMatchObject({ code: "fixture_pair_replace_failed" });

    for (const name of names) {
      await expect(
        readFile(join(directory, `${name}.jsonl`), "utf8"),
      ).resolves.toBe(`old-${name}-jsonl\n`);
      await expect(
        readFile(join(directory, `${name}.metadata.json`), "utf8"),
      ).resolves.toBe(`old-${name}-metadata\n`);
    }
    await expect(
      readFile(join(directory, "anchors.json"), "utf8"),
    ).resolves.toBe(anchorsRaw);
    expect(
      (await readdir(directory)).some((file) =>
        /\.(?:tmp|backup)$/u.test(file),
      ),
    ).toBe(false);
  });
});
