import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  assertReleaseVersionAuthority,
  createReleaseStagingManifest,
  createSdkReleaseStagingManifest,
  isExactPackageVersion,
  isJsonObject,
  parseJsonObject,
  releaseRuntimeDependencyNames,
  releaseSdkDependencyNames,
  releaseTarballName,
} from "./release-package.ts";

const repository = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
const artifactDirectory = join(repository, ".artifacts", "release");
const entries = readdirSync(artifactDirectory, { withFileTypes: true });
if (entries.some((entry) => !entry.isFile())) {
  throw new Error("Release artifact directory must contain only files");
}
const files = entries.map((entry) => entry.name).sort();

const { authority, name, version } = assertReleaseVersionAuthority(repository);
const runtimeTarballName = releaseTarballName(name, version);
const sdkTarballName = releaseTarballName("@ykdz/reins-sdk", version);
const expectedFiles = ["SHA256SUMS", runtimeTarballName, sdkTarballName].sort();
if (!isDeepStrictEqual(files, expectedFiles)) {
  throw new Error(
    `Expected both same-version tarballs and SHA256SUMS; found: ${files.join(", ")}`,
  );
}

function packedManifest(tarballName: string): Record<string, unknown> {
  const extracted = spawnSync(
    "tar",
    ["-xOf", join(artifactDirectory, tarballName), "package/package.json"],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    },
  );
  if (extracted.error !== undefined) throw extracted.error;
  if (extracted.status !== 0) {
    throw new Error(
      `Unable to read the packed manifest for ${tarballName}\n${extracted.stdout}${extracted.stderr}`,
    );
  }
  return parseJsonObject(extracted.stdout, `${tarballName}:package.json`);
}

function exactDependencies(
  packed: Record<string, unknown>,
  expectedNames: string[],
  packageLabel: string,
): Record<string, string> {
  if (!isJsonObject(packed.dependencies)) {
    throw new Error(`${packageLabel} packed manifest omitted dependencies`);
  }
  const actualNames = Object.keys(packed.dependencies).sort((a, b) =>
    a.localeCompare(b),
  );
  if (!isDeepStrictEqual(actualNames, expectedNames)) {
    throw new Error(
      `${packageLabel} dependency names do not match its source graph`,
    );
  }
  const dependencies: Record<string, string> = {};
  for (const dependencyName of actualNames) {
    const dependencyVersion = packed.dependencies[dependencyName];
    if (!isExactPackageVersion(dependencyVersion)) {
      throw new Error(
        `${packageLabel} dependency must use an exact version: ${dependencyName}`,
      );
    }
    dependencies[dependencyName] = dependencyVersion;
  }
  return dependencies;
}

function assertManifest(
  tarballName: string,
  expected: Record<string, unknown>,
  expectedPackageName: string,
): void {
  const packed = packedManifest(tarballName);
  if (packed.name !== expectedPackageName || packed.version !== version) {
    throw new Error(`${tarballName} does not match the release version`);
  }
  if (!isDeepStrictEqual(packed, expected)) {
    throw new Error(
      `${tarballName} manifest diverged from its staging contract`,
    );
  }
}

const runtimeDependencies = exactDependencies(
  packedManifest(runtimeTarballName),
  releaseRuntimeDependencyNames(repository),
  "Runtime package",
);
assertManifest(
  runtimeTarballName,
  createReleaseStagingManifest(authority, runtimeDependencies),
  name,
);

const sdkDependencies = exactDependencies(
  packedManifest(sdkTarballName),
  releaseSdkDependencyNames(repository),
  "SDK package",
);
assertManifest(
  sdkTarballName,
  createSdkReleaseStagingManifest(authority, sdkDependencies),
  "@ykdz/reins-sdk",
);

const expectedTag = process.env.EXPECTED_TAG ?? "";
if (expectedTag !== "" && expectedTag !== `v${version}`) {
  throw new Error(
    `Tag ${expectedTag} does not match manifest version ${version}`,
  );
}

function sha256File(tarballName: string): string {
  return createHash("sha256")
    .update(readFileSync(join(artifactDirectory, tarballName)))
    .digest("hex");
}

const runtimeSha256 = sha256File(runtimeTarballName);
const sdkSha256 = sha256File(sdkTarballName);
const runtimeSha512 = createHash("sha512")
  .update(readFileSync(join(artifactDirectory, runtimeTarballName)))
  .digest("hex");
const sdkSha512 = createHash("sha512")
  .update(readFileSync(join(artifactDirectory, sdkTarballName)))
  .digest("hex");
const checksums = readFileSync(join(artifactDirectory, "SHA256SUMS"), "utf8");
const expectedChecksums = [
  `${runtimeSha256}  ${runtimeTarballName}`,
  `${sdkSha256}  ${sdkTarballName}`,
]
  .sort((left, right) => left.localeCompare(right))
  .join("\n");
if (checksums !== `${expectedChecksums}\n`) {
  throw new Error("SHA256SUMS does not exactly match both release tarballs");
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
    `tarball=${join(artifactDirectory, runtimeTarballName)}`,
    `tarball-name=${runtimeTarballName}`,
    `sha256=${runtimeSha256}`,
    `sha512=${runtimeSha512}`,
    `sdk-name=@ykdz/reins-sdk`,
    `sdk-version=${version}`,
    `sdk-tarball=${join(artifactDirectory, sdkTarballName)}`,
    `sdk-tarball-name=${sdkTarballName}`,
    `sdk-sha256=${sdkSha256}`,
    `sdk-sha512=${sdkSha512}`,
    "",
  ].join("\n"),
);
