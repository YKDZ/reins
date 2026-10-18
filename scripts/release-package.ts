import { readFileSync } from "node:fs";
import { join } from "node:path";

export type JsonObject = Record<string, unknown>;

const releaseAuthorityDirectory = "packages/runtime";
const runtimeDistributionEntryDirectories = [
  releaseAuthorityDirectory,
  "packages/daemon",
] as const;
const sdkDistributionEntryDirectories = ["packages/sdk"] as const;
const sdkPackageName = "@ykdz/reins-sdk";
const workspacePackageDirectories = [
  releaseAuthorityDirectory,
  "packages/protocol",
  "packages/adapter-kit",
  "packages/client",
  "packages/sdk",
  "packages/core",
  "packages/event-journal",
  "packages/transport",
  "packages/daemon",
  "packages/typescript-config",
  "adapters/codex",
  "adapters/dsh",
  "adapters/qoder",
  "packages/conformance",
] as const;
const unversionedPrivateManifestDirectories = [
  ".",
  ...workspacePackageDirectories.filter(
    (directory) => directory !== releaseAuthorityDirectory,
  ),
] as const;

const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const installedVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const releasePackageName = "@ykdz/reins";

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonObject(text: string, source: string): JsonObject {
  const value: unknown = JSON.parse(text);
  if (!isJsonObject(value))
    throw new Error(`Expected a JSON object: ${source}`);
  return value;
}

export function readJsonObject(path: string): JsonObject {
  return parseJsonObject(readFileSync(path, "utf8"), path);
}

export function parseReleaseNotes(
  changelog: string,
  version: string,
): { readonly releaseDate: string; readonly releaseNotes: string } {
  const sections = changelog
    .split(/^## /mu)
    .filter((section) => section.startsWith(`[${version}] - `));
  const section = sections[0];
  const header = section?.split("\n", 1)[0];
  const match =
    header === undefined
      ? undefined
      : /^\[\d+\.\d+\.\d+\] - (\d{4}-\d{2}-\d{2})$/u.exec(header);
  const releaseDate = match?.[1];
  const parsedDate =
    releaseDate === undefined
      ? undefined
      : new Date(`${releaseDate}T00:00:00.000Z`);
  const bodyStart = section?.indexOf("\n") ?? -1;
  const notes = bodyStart < 0 ? "" : section?.slice(bodyStart + 1).trim();
  if (
    sections.length !== 1 ||
    releaseDate === undefined ||
    parsedDate === undefined ||
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== releaseDate ||
    !notes
  ) {
    throw new Error("变更说明须包含唯一的当前版本、有效日期与实际发布内容");
  }
  return { releaseDate, releaseNotes: notes };
}

function readManifest(repository: string, directory: string): JsonObject {
  return readJsonObject(join(repository, directory, "package.json"));
}

export function assertReleaseVersionAuthority(repository: string): {
  authority: JsonObject;
  name: string;
  version: string;
  releaseDate: string;
  releaseNotes: string;
} {
  const authority = readManifest(repository, releaseAuthorityDirectory);
  if (
    authority.name !== releasePackageName ||
    authority.private !== true ||
    typeof authority.version !== "string" ||
    !stableVersionPattern.test(authority.version)
  ) {
    throw new Error(
      "packages/runtime must be the versioned reins release authority",
    );
  }
  const sdkSource = readManifest(repository, "packages/sdk");
  if (sdkSource.name !== sdkPackageName || sdkSource.private !== true) {
    throw new Error(
      "packages/sdk must be the private reins SDK source package",
    );
  }
  for (const directory of unversionedPrivateManifestDirectories) {
    const manifest = readManifest(repository, directory);
    if (manifest.private !== true || "version" in manifest) {
      throw new Error(
        `Private manifest must omit version: ${join(directory, "package.json")}`,
      );
    }
  }
  const releaseNotes = parseReleaseNotes(
    readFileSync(join(repository, "CHANGELOG.md"), "utf8"),
    authority.version,
  );
  return {
    authority,
    name: authority.name,
    version: authority.version,
    ...releaseNotes,
  };
}

export function releaseTarballName(name: string, version: string): string {
  if (
    (name !== releasePackageName && name !== sdkPackageName) ||
    !stableVersionPattern.test(version)
  ) {
    throw new Error("Invalid reins release identity");
  }
  return `${name.slice(1).replace("/", "-")}-${version}.tgz`;
}

function dependenciesOf(
  manifest: JsonObject,
  directory: string,
): Record<string, unknown> {
  const dependencies = manifest.dependencies;
  if (dependencies === undefined) return {};
  if (!isJsonObject(dependencies)) {
    throw new Error(`Expected dependencies object: ${directory}/package.json`);
  }
  return dependencies;
}

function installedDependencyVersion(
  repository: string,
  ownerDirectory: string,
  dependencyName: string,
): string {
  const installed = readJsonObject(
    join(
      repository,
      ownerDirectory,
      "node_modules",
      ...dependencyName.split("/"),
      "package.json",
    ),
  );
  if (
    installed.name !== dependencyName ||
    typeof installed.version !== "string" ||
    !installedVersionPattern.test(installed.version)
  ) {
    throw new Error(
      `Installed dependency has invalid identity: ${dependencyName} from ${ownerDirectory}`,
    );
  }
  return installed.version;
}

function releaseExternalDependencyOwners(
  repository: string,
  entryDirectories: readonly string[],
): Map<string, Set<string>> {
  const packagesByName = new Map<string, string>();
  for (const directory of workspacePackageDirectories) {
    const manifest = readManifest(repository, directory);
    if (typeof manifest.name !== "string") {
      throw new Error(`Workspace manifest omitted name: ${directory}`);
    }
    if (packagesByName.has(manifest.name)) {
      throw new Error(`Duplicate workspace package name: ${manifest.name}`);
    }
    packagesByName.set(manifest.name, directory);
  }

  const pending: string[] = [...entryDirectories];
  const visited = new Set<string>();
  const owners = new Map<string, Set<string>>();
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined || visited.has(directory)) continue;
    visited.add(directory);

    const manifest = readManifest(repository, directory);
    for (const [name, specifier] of Object.entries(
      dependenciesOf(manifest, directory),
    )) {
      const workspaceDirectory = packagesByName.get(name);
      const publishedRuntimeSdk =
        name === sdkPackageName &&
        entryDirectories.includes(releaseAuthorityDirectory);
      if (workspaceDirectory !== undefined && !publishedRuntimeSdk) {
        if (
          typeof specifier !== "string" ||
          !specifier.startsWith("workspace:")
        ) {
          throw new Error(`Internal dependency must use workspace: ${name}`);
        }
        pending.push(workspaceDirectory);
        continue;
      }
      if (publishedRuntimeSdk) {
        if (
          typeof specifier !== "string" ||
          !specifier.startsWith("workspace:")
        )
          throw new Error(`Runtime SDK dependency must use workspace: ${name}`);
        const dependencyOwners = owners.get(name) ?? new Set<string>();
        dependencyOwners.add(directory);
        owners.set(name, dependencyOwners);
        continue;
      }
      if (
        typeof specifier !== "string" ||
        (specifier !== "catalog:" &&
          !specifier.startsWith("^") &&
          !specifier.startsWith("~"))
      ) {
        throw new Error(
          `Runtime source dependency must use a compatibility range: ${name}`,
        );
      }

      const dependencyOwners = owners.get(name) ?? new Set<string>();
      dependencyOwners.add(directory);
      owners.set(name, dependencyOwners);
    }
  }
  if (owners.size === 0) {
    throw new Error("Release dependency closure has no runtime externals");
  }
  return owners;
}

export function releaseRuntimeDependencyNames(repository: string): string[] {
  return [
    ...releaseExternalDependencyOwners(
      repository,
      runtimeDistributionEntryDirectories,
    ).keys(),
  ].sort((a, b) => a.localeCompare(b));
}

export function resolveReleaseRuntimeDependencies(
  repository: string,
): Record<string, string> {
  const { version: releaseVersion } = assertReleaseVersionAuthority(repository);
  const resolved = new Map<string, string>();
  for (const [name, owners] of releaseExternalDependencyOwners(
    repository,
    runtimeDistributionEntryDirectories,
  )) {
    for (const owner of owners) {
      const version =
        name === sdkPackageName
          ? releaseVersion
          : installedDependencyVersion(repository, owner, name);
      const previous = resolved.get(name);
      if (previous !== undefined && previous !== version) {
        throw new Error(
          `Runtime dependency resolved to multiple versions: ${name} (${previous}, ${version})`,
        );
      }
      resolved.set(name, version);
    }
  }
  return Object.fromEntries(
    [...resolved.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

export function releaseSdkDependencyNames(repository: string): string[] {
  return [
    ...releaseExternalDependencyOwners(
      repository,
      sdkDistributionEntryDirectories,
    ).keys(),
  ].sort((a, b) => a.localeCompare(b));
}

export function resolveReleaseSdkDependencies(
  repository: string,
): Record<string, string> {
  const resolved = new Map<string, string>();
  for (const [name, owners] of releaseExternalDependencyOwners(
    repository,
    sdkDistributionEntryDirectories,
  )) {
    for (const owner of owners) {
      const version = installedDependencyVersion(repository, owner, name);
      const previous = resolved.get(name);
      if (previous !== undefined && previous !== version) {
        throw new Error(
          `SDK dependency resolved to multiple versions: ${name} (${previous}, ${version})`,
        );
      }
      resolved.set(name, version);
    }
  }
  return Object.fromEntries(
    [...resolved.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

export function isExactPackageVersion(value: unknown): value is string {
  return typeof value === "string" && installedVersionPattern.test(value);
}

export function createReleaseStagingManifest(
  authority: JsonObject,
  dependencies: Record<string, string>,
): JsonObject {
  const fields = [
    "name",
    "version",
    "description",
    "license",
    "repository",
    "homepage",
    "bugs",
    "keywords",
    "type",
    "bin",
    "files",
    "publishConfig",
    "os",
    "cpu",
    "engines",
  ] as const;
  const manifest: JsonObject = {};
  for (const field of fields) {
    const value = authority[field];
    if (value === undefined) {
      throw new Error(`Release authority omitted field: ${field}`);
    }
    manifest[field] = value;
  }
  manifest.dependencies = dependencies;
  manifest.exports = {
    "./application": {
      types: "./dist/application.d.ts",
      default: "./dist/application.js",
    },
  };
  return manifest;
}

export function createSdkReleaseStagingManifest(
  authority: JsonObject,
  dependencies: Record<string, string>,
): JsonObject {
  if (typeof authority.version !== "string") {
    throw new Error("packages/runtime must provide the SDK release version");
  }
  return {
    name: sdkPackageName,
    version: authority.version,
    description: "Lightweight SDK for the Reins control plane.",
    license: authority.license,
    repository: authority.repository,
    homepage: authority.homepage,
    keywords: ["agent", "harness", "sdk"],
    type: "module",
    types: "./dist/index.d.ts",
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
    },
    files: ["dist"],
    publishConfig: { access: "public" },
    dependencies,
    engines: { node: ">=24" },
  };
}
