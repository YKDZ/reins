import { readFileSync } from "node:fs";
import { join } from "node:path";

export type JsonObject = Record<string, unknown>;

const releaseAuthorityDirectory = "apps/cli";
const distributionEntryDirectories = [
  releaseAuthorityDirectory,
  "packages/daemon",
] as const;
const workspacePackageDirectories = [
  releaseAuthorityDirectory,
  "packages/protocol",
  "packages/adapter-kit",
  "packages/core",
  "packages/transport",
  "packages/daemon",
  "packages/typescript-config",
  "adapters/codex",
  "adapters/dsh",
  "adapters/qoder",
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

function readManifest(repository: string, directory: string): JsonObject {
  return readJsonObject(join(repository, directory, "package.json"));
}

export function assertReleaseVersionAuthority(repository: string): {
  authority: JsonObject;
  name: string;
  version: string;
} {
  const authority = readManifest(repository, releaseAuthorityDirectory);
  if (
    authority.name !== "reins" ||
    authority.private !== true ||
    typeof authority.version !== "string" ||
    !stableVersionPattern.test(authority.version)
  ) {
    throw new Error("apps/cli must be the versioned reins release authority");
  }
  for (const directory of unversionedPrivateManifestDirectories) {
    const manifest = readManifest(repository, directory);
    if (manifest.private !== true || "version" in manifest) {
      throw new Error(
        `Private manifest must omit version: ${join(directory, "package.json")}`,
      );
    }
  }
  return {
    authority,
    name: authority.name,
    version: authority.version,
  };
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

  const pending: string[] = [...distributionEntryDirectories];
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
      if (workspaceDirectory !== undefined) {
        if (
          typeof specifier !== "string" ||
          !specifier.startsWith("workspace:")
        ) {
          throw new Error(`Internal dependency must use workspace: ${name}`);
        }
        pending.push(workspaceDirectory);
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
  return [...releaseExternalDependencyOwners(repository).keys()].sort((a, b) =>
    a.localeCompare(b),
  );
}

export function resolveReleaseRuntimeDependencies(
  repository: string,
): Record<string, string> {
  const resolved = new Map<string, string>();
  for (const [name, owners] of releaseExternalDependencyOwners(repository)) {
    for (const owner of owners) {
      const version = installedDependencyVersion(repository, owner, name);
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
  return manifest;
}
