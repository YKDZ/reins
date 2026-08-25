import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

type JsonObject = Record<string, unknown>;

const expectedDependencies = new Map([
  ["@reins/client", { directory: "packages/client", tag: "client" }],
  ["@reins/daemon", { directory: "packages/daemon", tag: "daemon" }],
  ["@reins/protocol", { directory: "packages/protocol", tag: "protocol" }],
  ["@reins/qoder", { directory: "adapters/qoder", tag: "adapter" }],
]);

const expectedDevDependencies = {
  "@reins/typescript-config": "workspace:*",
  "@types/node": "catalog:",
  oxfmt: "catalog:",
  oxlint: "catalog:",
  "oxlint-tsgolint": "catalog:",
  "typescript-7": "catalog:",
  vitest: "catalog:",
};

const expectedDependenciesMeta = Object.fromEntries(
  [...expectedDependencies.keys()].map((name) => [name, { injected: false }]),
);

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertConformanceDependencyContract(
  manifest: unknown,
  targetTags: ReadonlyMap<string, readonly string[]>,
): void {
  if (!isJsonObject(manifest) || !isJsonObject(manifest.dependencies)) {
    throw new Error("Conformance manifest dependencies must be an object");
  }
  const names = Object.keys(manifest.dependencies).sort();
  const expectedNames = [...expectedDependencies.keys()].sort();
  if (
    names.length !== expectedNames.length ||
    names.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error("Conformance dependencies must be exact");
  }
  for (const [name, specification] of Object.entries(manifest.dependencies)) {
    if (specification !== "workspace:*") {
      throw new Error("Conformance dependency must use workspace:*");
    }
    const target = expectedDependencies.get(name);
    const tags = targetTags.get(name);
    if (target === undefined || tags === undefined) {
      throw new Error("Conformance dependency target is unknown");
    }
    if (!tags.includes(target.tag)) {
      throw new Error("Conformance dependency target has an unexpected tag");
    }
  }
  if (!isDeepStrictEqual(manifest.devDependencies, expectedDevDependencies)) {
    throw new Error("Conformance devDependencies must be exact");
  }
  if (!isDeepStrictEqual(manifest.dependenciesMeta, expectedDependenciesMeta)) {
    throw new Error("Conformance dependenciesMeta must be exact");
  }
  for (const section of ["optionalDependencies", "peerDependencies"] as const) {
    const value = manifest[section];
    if (
      value !== undefined &&
      (!isJsonObject(value) || Object.keys(value).length > 0)
    ) {
      throw new Error(`Conformance ${section} must be exact`);
    }
  }
  for (const section of [
    "bundledDependencies",
    "bundleDependencies",
  ] as const) {
    const bundled = manifest[section];
    if (
      bundled !== undefined &&
      (!Array.isArray(bundled) || bundled.length > 0)
    ) {
      throw new Error(`Conformance ${section} must be absent or empty`);
    }
  }
}

function readObject(path: string): JsonObject {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isJsonObject(parsed)) throw new Error("Expected a JSON object");
  return parsed;
}

export function checkConformanceDependencyContract(repository: string): void {
  const targetTags = new Map<string, readonly string[]>();
  for (const [name, target] of expectedDependencies) {
    const manifest = readObject(
      join(repository, target.directory, "package.json"),
    );
    if (manifest.name !== name) {
      throw new Error("Conformance dependency target name mismatch");
    }
    const turbo = readObject(join(repository, target.directory, "turbo.json"));
    if (
      !Array.isArray(turbo.tags) ||
      !turbo.tags.every((tag) => typeof tag === "string")
    ) {
      throw new Error("Conformance dependency target tags are invalid");
    }
    targetTags.set(name, turbo.tags);
  }
  const manifest = readObject(
    join(repository, "packages/conformance/package.json"),
  );
  assertConformanceDependencyContract(manifest, targetTags);
}
