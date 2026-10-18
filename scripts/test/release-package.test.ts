import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  assertReleaseVersionAuthority,
  parseReleaseNotes,
  releaseTarballName,
} from "../release-package.ts";
import { validateReleasePackages } from "../validate-release-package.ts";

void test("版本说明只读取唯一匹配版本的日期和正文", () => {
  assert.deepEqual(
    parseReleaseNotes(
      "# 变更记录\n\n## [1.2.3] - 2026-10-18\n\n- 修复连接恢复。\n\n## [1.2.2] - 2026-10-17\n\n- 既有变更。\n",
      "1.2.3",
    ),
    {
      releaseDate: "2026-10-18",
      releaseNotes: "- 修复连接恢复。",
    },
  );
});

void test("版本说明缺少唯一有效日期或正文时拒绝", () => {
  for (const changelog of [
    "# 变更记录\n\n## [1.2.2] - 2026-10-18\n\n- 旧版本。\n",
    "# 变更记录\n\n## [1.2.3] - 2026-02-30\n\n- 修复。\n",
    "# 变更记录\n\n## [1.2.3] - 2026-10-18\n\n## [1.2.3] - 2026-10-17\n\n- 重复版本。\n",
    "# 变更记录\n\n## [1.2.3] - 2026-10-18\n\n",
  ]) {
    assert.throws(() => parseReleaseNotes(changelog, "1.2.3"));
  }
});

void test("双包验收接受同版本制品并拒绝错版 SDK", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reins-release-package-"));
  const artifactDirectory = join(directory, "release");
  try {
    const built = spawnSync(
      process.execPath,
      ["--conditions=source", "scripts/build-distribution.ts"],
      {
        env: { ...process.env, REINS_ARTIFACTS_DIR: directory },
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    assert.equal(built.status, 0, built.stderr);

    const { name, version } = assertReleaseVersionAuthority(process.cwd());
    const runtimeFile = releaseTarballName(name, version);
    const sdkFile = releaseTarballName("@ykdz/reins-sdk", version);
    assert.deepEqual(
      (await readdir(artifactDirectory)).toSorted(),
      [runtimeFile, sdkFile].toSorted(),
    );
    const accepted = validateReleasePackages({
      repository: process.cwd(),
      artifactDirectory,
    });
    assert.deepEqual(
      accepted.artifacts.map(({ packageName, version: artifactVersion }) => [
        packageName,
        artifactVersion,
      ]),
      [
        ["@ykdz/reins-sdk", version],
        [name, version],
      ],
    );
    const extraFile = join(artifactDirectory, "unexpected.txt");
    await writeFile(extraFile, "extra");
    assert.throws(
      () =>
        validateReleasePackages({
          repository: process.cwd(),
          artifactDirectory,
        }),
      /Expected exactly both same-version tarballs/u,
    );
    await unlink(extraFile);

    const extracted = spawnSync(
      "tar",
      ["-xzf", join(artifactDirectory, sdkFile), "-C", directory],
      { encoding: "utf8" },
    );
    assert.equal(extracted.status, 0, extracted.stderr);
    const sdkManifestPath = join(directory, "package", "package.json");
    const sdkManifest = JSON.parse(await readFile(sdkManifestPath, "utf8")) as {
      version: string;
    };
    sdkManifest.version = version === "0.0.0" ? "0.0.1" : "0.0.0";
    await writeFile(sdkManifestPath, `${JSON.stringify(sdkManifest)}\n`);
    const repacked = spawnSync(
      "tar",
      ["-czf", join(artifactDirectory, sdkFile), "-C", directory, "package"],
      { encoding: "utf8" },
    );
    assert.equal(repacked.status, 0, repacked.stderr);
    assert.throws(
      () =>
        validateReleasePackages({
          repository: process.cwd(),
          artifactDirectory,
        }),
      /does not match the release version/u,
    );
    await rm(join(directory, "package"), { recursive: true, force: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
