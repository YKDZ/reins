import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

export type ReleaseArtifact = {
  readonly packageName: string;
  readonly version: string;
  readonly file: string;
  readonly path: string;
  readonly manifest: Record<string, unknown>;
};
export type ReleasePackageGroup = {
  readonly name: string;
  readonly version: string;
  readonly releaseDate: string;
  readonly releaseNotes: string;
  readonly artifacts: readonly ReleaseArtifact[];
};
export function validateReleasePackages(options: {
  readonly repository: string;
  readonly artifactDirectory?: string;
}): ReleasePackageGroup {
  const repository = resolve(options.repository);
  const artifactDirectory = resolve(
    options.artifactDirectory ?? join(repository, ".artifacts", "release"),
  );
  const entries = readdirSync(artifactDirectory, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile())) {
    throw new Error("Release artifact directory must contain only files");
  }
  const files = entries.map((entry) => entry.name).sort();

  const { authority, name, version, releaseDate, releaseNotes } =
    assertReleaseVersionAuthority(repository);
  const runtimeTarballName = releaseTarballName(name, version);
  const sdkTarballName = releaseTarballName("@ykdz/reins-sdk", version);
  const expectedFiles = [runtimeTarballName, sdkTarballName].sort();
  if (!isDeepStrictEqual(files, expectedFiles)) {
    throw new Error(
      `Expected exactly both same-version tarballs; found: ${files.join(", ")}`,
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
  if (runtimeDependencies["@ykdz/reins-sdk"] !== version) {
    throw new Error("Runtime package must depend on the same SDK version");
  }
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

  const artifacts = [
    {
      packageName: "@ykdz/reins-sdk",
      file: sdkTarballName,
    },
    {
      packageName: name,
      file: runtimeTarballName,
    },
  ].map((item) => ({
    ...item,
    version,
    path: join(artifactDirectory, item.file),
    manifest: packedManifest(item.file),
  }));
  return { name, version, releaseDate, releaseNotes, artifacts };
}

export function writeReleaseOutputs(group: ReleasePackageGroup): void {
  const output = process.env.GITHUB_OUTPUT;
  if (output === undefined || output === "") {
    process.stdout.write("Release package validation passed\n");
    return;
  }
  const delimiter = `REINS_RELEASE_NOTES_${randomUUID()}`;
  appendFileSync(
    output,
    [
      `release-version=${group.version}`,
      `release-tag=v${group.version}`,
      `release-notes<<${delimiter}`,
      group.releaseNotes,
      delimiter,
      "",
    ].join("\n"),
  );
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const group = validateReleasePackages({
    repository: process.env.GITHUB_WORKSPACE ?? process.cwd(),
  });
  writeReleaseOutputs(group);
}
