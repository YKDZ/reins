import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  assertReleaseVersionAuthority,
  createReleaseStagingManifest,
  isExactPackageVersion,
  isJsonObject,
  parseJsonObject,
  releaseRuntimeDependencyNames,
} from "./release-package.ts";

const repository = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
const artifactDirectory = join(repository, ".artifacts", "release");
const entries = readdirSync(artifactDirectory, { withFileTypes: true });
if (entries.some((entry) => !entry.isFile())) {
  throw new Error("Release artifact directory must contain only files");
}
const files = entries.map((entry) => entry.name).sort();
const tarballs = files.filter((name) => name.endsWith(".tgz"));
if (files.length !== 2 || tarballs.length !== 1 || files[0] !== "SHA256SUMS") {
  throw new Error(
    `Expected exactly one tarball and SHA256SUMS; found: ${files.join(", ")}`,
  );
}

const tarballName = tarballs[0];
if (tarballName === undefined) throw new Error("Release tarball is missing");
const tarball = join(artifactDirectory, tarballName);
const extracted = spawnSync("tar", ["-xOf", tarball, "package/package.json"], {
  encoding: "utf8",
  maxBuffer: 1024 * 1024,
});
if (extracted.error !== undefined) throw extracted.error;
if (extracted.status !== 0) {
  throw new Error(
    `Unable to read the packed manifest\n${extracted.stdout}${extracted.stderr}`,
  );
}

const { authority, name, version } = assertReleaseVersionAuthority(repository);
const packed = parseJsonObject(extracted.stdout, `${tarballName}:package.json`);
if (!isJsonObject(packed.dependencies)) {
  throw new Error("Packed manifest omitted runtime dependencies");
}
const expectedDependencyNames = releaseRuntimeDependencyNames(repository);
const actualDependencyNames = Object.keys(packed.dependencies).sort((a, b) =>
  a.localeCompare(b),
);
if (!isDeepStrictEqual(actualDependencyNames, expectedDependencyNames)) {
  throw new Error(
    "Packed runtime dependency names do not match the source graph",
  );
}
const packedDependencies: Record<string, string> = {};
for (const dependencyName of actualDependencyNames) {
  const dependencyVersion = packed.dependencies[dependencyName];
  if (!isExactPackageVersion(dependencyVersion)) {
    throw new Error(
      `Packed runtime dependency must use an exact version: ${dependencyName}`,
    );
  }
  packedDependencies[dependencyName] = dependencyVersion;
}
const expectedManifest = createReleaseStagingManifest(
  authority,
  packedDependencies,
);
if (!isDeepStrictEqual(packed, expectedManifest)) {
  throw new Error(
    "Packed manifest does not match the staging manifest contract",
  );
}
const expectedTag = process.env.EXPECTED_TAG ?? "";
if (expectedTag !== "" && expectedTag !== `v${version}`) {
  throw new Error(
    `Tag ${expectedTag} does not match manifest version ${version}`,
  );
}
const expectedTarballName = `${name}-${version}.tgz`;
if (tarballName !== expectedTarballName) {
  throw new Error(`Unexpected tarball name: ${tarballName}`);
}
const bytes = readFileSync(tarball);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const sha512 = createHash("sha512").update(bytes).digest("hex");
const checksums = readFileSync(join(artifactDirectory, "SHA256SUMS"), "utf8");
if (checksums !== `${sha256}  ${expectedTarballName}\n`) {
  throw new Error("SHA256SUMS does not exactly match the release tarball");
}

const output = process.env.GITHUB_OUTPUT;
if (output === undefined || output === "") {
  process.stdout.write("Release package validation passed\n");
  process.exit(0);
}
appendFileSync(
  output,
  [
    `name=${name}`,
    `version=${version}`,
    `tarball=${tarball}`,
    `tarball-name=${tarballName}`,
    `sha256=${sha256}`,
    `sha512=${sha512}`,
    "",
  ].join("\n"),
);
