import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { rolldown, type OutputChunk } from "rolldown";

import {
  assertReleaseVersionAuthority,
  createReleaseStagingManifest,
  readJsonObject,
  resolveReleaseRuntimeDependencies,
} from "./release-package.ts";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactsDirectory = join(repository, ".artifacts");
const releaseDirectory = join(artifactsDirectory, "release");
const stagingDirectory = join(artifactsDirectory, "staging", "reins");
const distributionDirectory = join(stagingDirectory, "dist");

function packageName(specifier: string): string {
  if (!specifier.startsWith("@"))
    return specifier.split("/", 1)[0] ?? specifier;
  return specifier.split("/", 2).join("/");
}

function verifyBundle(
  chunks: readonly OutputChunk[],
  expectedDependencies: readonly string[],
): void {
  const entries = new Set(
    chunks.filter((chunk) => chunk.isEntry).map((chunk) => chunk.fileName),
  );
  if (!entries.has("reins.js") || !entries.has("reins-daemon.js")) {
    throw new Error(
      `Bundle omitted executable entries: ${[...entries].join(", ")}`,
    );
  }
  if (!chunks.some((chunk) => !chunk.isEntry))
    throw new Error("Bundle omitted the shared chunk");

  const importedPackages = new Set<string>();
  const emittedChunks = new Set(chunks.map((chunk) => chunk.fileName));
  for (const chunk of chunks) {
    for (const moduleId of Object.keys(chunk.modules)) {
      if (moduleId.includes("/node_modules/")) {
        throw new Error(`Third-party module was bundled: ${moduleId}`);
      }
    }
    for (const specifier of [...chunk.imports, ...chunk.dynamicImports]) {
      if (emittedChunks.has(specifier)) continue;
      if (
        specifier.startsWith(".") ||
        specifier.startsWith("/") ||
        specifier.startsWith("node:")
      ) {
        continue;
      }
      const name = packageName(specifier);
      if (name.startsWith("@reins/") || name.startsWith("#")) {
        throw new Error(`Internal import escaped the bundle: ${specifier}`);
      }
      importedPackages.add(name);
    }
  }
  const actual = [...importedPackages].sort();
  const expected = [...expectedDependencies].sort();
  if (actual.join("\n") !== expected.join("\n")) {
    throw new Error(
      `Runtime external mismatch\nexpected: ${expected.join(", ")}\nactual: ${actual.join(", ")}`,
    );
  }
}

function filesRecursively(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesRecursively(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function verifySourceMaps(): void {
  const javascript = filesRecursively(distributionDirectory).filter((path) =>
    path.endsWith(".js"),
  );
  const maps = filesRecursively(distributionDirectory).filter((path) =>
    path.endsWith(".js.map"),
  );
  if (maps.length !== javascript.length)
    throw new Error("Every JavaScript output must have a source map");
  for (const path of maps) {
    const sourceMap = readJsonObject(path);
    const sources = sourceMap.sources;
    const sourcesContent = sourceMap.sourcesContent;
    if (
      !Array.isArray(sources) ||
      !Array.isArray(sourcesContent) ||
      sources.length === 0 ||
      sourcesContent.length !== sources.length ||
      !sourcesContent.every((content) => typeof content === "string")
    ) {
      throw new Error(`Source map omitted sourcesContent: ${path}`);
    }
  }
}

function pack(): string {
  const result = spawnSync(
    "pnpm",
    ["pack", "--pack-destination", releaseDirectory],
    {
      cwd: stagingDirectory,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `pnpm pack failed with exit ${result.status ?? 1}\n${result.stdout}${result.stderr}`,
    );
  }
  const tarballs = readdirSync(releaseDirectory).filter((name) =>
    name.endsWith(".tgz"),
  );
  if (tarballs.length !== 1)
    throw new Error(`Expected one release tarball, found ${tarballs.length}`);
  return join(releaseDirectory, tarballs[0] ?? "");
}

const { authority } = assertReleaseVersionAuthority(repository);
const dependencies = resolveReleaseRuntimeDependencies(repository);
const manifest = createReleaseStagingManifest(authority, dependencies);
const expectedTarball = `reins-${String(authority.version)}.tgz`;

rmSync(join(artifactsDirectory, "release"), { recursive: true, force: true });
rmSync(join(artifactsDirectory, "staging"), { recursive: true, force: true });
mkdirSync(distributionDirectory, { recursive: true });
mkdirSync(releaseDirectory, { recursive: true });

writeFileSync(
  join(stagingDirectory, "package.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
for (const name of ["README.md", "LICENSE"] as const) {
  copyFileSync(join(repository, name), join(stagingDirectory, name));
}

const bundle = await rolldown({
  cwd: repository,
  input: {
    reins: "apps/cli/src/cli.ts",
    "reins-daemon": "packages/daemon/src/main.ts",
  },
  platform: "node",
  external: Object.keys(dependencies),
  resolve: {
    conditionNames: ["source", "import", "node", "default"],
  },
});
const output = await bundle.write({
  dir: distributionDirectory,
  format: "esm",
  codeSplitting: true,
  sourcemap: true,
  entryFileNames: "[name].js",
  chunkFileNames: "chunks/[name]-[hash].js",
});
await bundle.close();

verifyBundle(
  output.output.filter((entry): entry is OutputChunk => entry.type === "chunk"),
  Object.keys(dependencies),
);
for (const name of ["reins.js", "reins-daemon.js"] as const) {
  const path = join(distributionDirectory, name);
  if (!readFileSync(path, "utf8").startsWith("#!/usr/bin/env node\n")) {
    throw new Error(`Executable omitted shebang: ${path}`);
  }
  chmodSync(path, 0o755);
  if ((statSync(path).mode & 0o777) !== 0o755)
    throw new Error(`Executable mode is not 0755: ${path}`);
}
verifySourceMaps();

const tarball = pack();
if (relative(releaseDirectory, tarball) !== expectedTarball) {
  throw new Error(`Unexpected tarball name: ${tarball}`);
}
const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
writeFileSync(
  join(releaseDirectory, "SHA256SUMS"),
  `${digest}  ${expectedTarball}\n`,
);

process.stdout.write(`${relative(repository, tarball)}\n`);
