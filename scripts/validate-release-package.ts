import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
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
  readonly sha256: string;
  readonly sha512: string;
  readonly integrity: string;
  readonly size: number;
  readonly manifest: Record<string, unknown>;
};
export type ReleasePackageGroup = {
  readonly name: string;
  readonly version: string;
  readonly artifacts: readonly ReleaseArtifact[];
  readonly sha512Sums: string;
};
export function validateReleasePackages(options: {
  readonly repository: string;
  readonly artifactDirectory?: string;
  readonly expectedTag?: string;
}): ReleasePackageGroup {
  const repository = resolve(options.repository);
  const artifactDirectory = resolve(
    options.artifactDirectory ?? join(repository, ".artifacts", "release"),
  );
  const entries = readdirSync(artifactDirectory, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile())) {
    throw new Error("Release artifact directory must contain only files");
  }
  const files = entries
    .map((entry) => entry.name)
    .filter(
      (name) =>
        name !== "SHA512SUMS" && name !== "verified-publication-artifact.json",
    )
    .sort();

  const { authority, name, version } =
    assertReleaseVersionAuthority(repository);
  const runtimeTarballName = releaseTarballName(name, version);
  const sdkTarballName = releaseTarballName("@ykdz/reins-sdk", version);
  const expectedFiles = [
    "SHA256SUMS",
    runtimeTarballName,
    sdkTarballName,
  ].sort();
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

  const expectedTag = options.expectedTag ?? "";
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

  const artifacts = [
    {
      packageName: "@ykdz/reins-sdk",
      file: sdkTarballName,
      sha256: sdkSha256,
      sha512: sdkSha512,
    },
    {
      packageName: name,
      file: runtimeTarballName,
      sha256: runtimeSha256,
      sha512: runtimeSha512,
    },
  ].map((item) => ({
    ...item,
    version,
    path: join(artifactDirectory, item.file),
    integrity: "sha512-" + Buffer.from(item.sha512, "hex").toString("base64"),
    size: readFileSync(join(artifactDirectory, item.file)).length,
    manifest: packedManifest(item.file),
  }));
  const sha512Sums =
    artifacts
      .map((item) => item.sha512 + "  " + item.file)
      .sort((a, b) => a.localeCompare(b))
      .join("\n") + "\n";
  if (
    existsSync(join(artifactDirectory, "SHA512SUMS")) &&
    readFileSync(join(artifactDirectory, "SHA512SUMS"), "utf8") !== sha512Sums
  )
    throw new Error("SHA512SUMS does not match both release artifacts");
  return { name, version, artifacts, sha512Sums };
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const group = validateReleasePackages({
    repository: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    ...(process.env.EXPECTED_TAG === undefined
      ? {}
      : { expectedTag: process.env.EXPECTED_TAG }),
  });
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    appendFileSync(
      output,
      group.artifacts
        .flatMap((item) => {
          const prefix = item.packageName === group.name ? "" : "sdk-";
          return [
            prefix + "name=" + item.packageName,
            prefix + "version=" + item.version,
            prefix + "tarball=" + item.path,
            prefix + "tarball-name=" + item.file,
            prefix + "sha256=" + item.sha256,
            prefix + "sha512=" + item.sha512,
          ];
        })
        .join("\n") + "\n",
    );
  } else process.stdout.write("Release package validation passed\n");
}
