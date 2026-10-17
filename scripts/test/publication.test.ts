import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  acceptPublicationGroup,
  sealPublicationGroup,
} from "../npm-publication/handoff.ts";

void test("双包候选回执绑定实际字节，替换其中一个包后拒绝", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reins-publication-"));
  const artifacts = join(directory, "build", "release");
  try {
    const built = spawnSync(
      process.execPath,
      ["--conditions=source", "scripts/build-distribution.ts"],
      {
        env: {
          ...process.env,
          REINS_ARTIFACTS_DIR: join(directory, "build"),
          REINS_RELEASE_CANDIDATE_DIR: "",
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.equal(built.status, 0, built.stderr);
    const manifest = JSON.parse(
      await readFile("apps/cli/package.json", "utf8"),
    ) as { version: string };
    const sdkFile = `ykdz-reins-sdk-${manifest.version}.tgz`;
    const runtimeFile = `ykdz-reins-${manifest.version}.tgz`;
    const digest = async (file: string) =>
      createHash("sha256")
        .update(await readFile(join(artifacts, file)))
        .digest("hex");
    const evidence = join(directory, "evidence.ndjson");
    await writeFile(
      evidence,
      [
        {
          label: "release_candidate",
          fact: {
            runtime: { file: runtimeFile, sha256: await digest(runtimeFile) },
            sdk: { file: sdkFile, sha256: await digest(sdkFile) },
          },
        },
        { label: "smoke_result", fact: { status: "passed" } },
      ]
        .map((value) => JSON.stringify(value))
        .join("\n") + "\n",
    );
    sealPublicationGroup({
      repository: process.cwd(),
      artifactDirectory: artifacts,
      evidenceFile: evidence,
    });
    const accepted = acceptPublicationGroup({
      repository: process.cwd(),
      artifactDirectory: artifacts,
    });
    assert.deepEqual(
      accepted.artifacts.map((item) => item.packageName),
      ["@ykdz/reins-sdk", "@ykdz/reins"],
    );
    await writeFile(
      join(artifacts, sdkFile),
      Buffer.concat([
        await readFile(join(artifacts, sdkFile)),
        Buffer.from("altered"),
      ]),
    );
    assert.throws(
      () =>
        acceptPublicationGroup({
          repository: process.cwd(),
          artifactDirectory: artifacts,
        }),
      /SHA256|tarball|packed manifest|候选/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
