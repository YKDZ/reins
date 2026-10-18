import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
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
  createSdkReleaseStagingManifest,
  readJsonObject,
  releaseTarballName,
  resolveReleaseRuntimeDependencies,
  resolveReleaseSdkDependencies,
} from "./release-package.ts";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactsDirectory = resolve(
  process.env.REINS_ARTIFACTS_DIR ?? join(repository, ".artifacts"),
);
const releaseDirectory = join(artifactsDirectory, "release");
const stagingRoot = join(artifactsDirectory, "staging");
const runtimeStagingDirectory = join(stagingRoot, "reins");
const sdkStagingDirectory = join(stagingRoot, "reins-sdk");
const runtimeDistributionDirectory = join(runtimeStagingDirectory, "dist");
const sdkDistributionDirectory = join(sdkStagingDirectory, "dist");

function packageName(specifier: string): string {
  if (!specifier.startsWith("@"))
    return specifier.split("/", 1)[0] ?? specifier;
  return specifier.split("/", 2).join("/");
}

function isExternalDependency(
  specifier: string,
  dependencies: readonly string[],
): boolean {
  return dependencies.includes(packageName(specifier));
}

function verifyBundle(
  chunks: readonly OutputChunk[],
  expectedDependencies: readonly string[],
  expectedEntries: readonly string[],
  requireSharedChunk = false,
): void {
  const entries = new Set(
    chunks.filter((chunk) => chunk.isEntry).map((chunk) => chunk.fileName),
  );
  if (expectedEntries.some((entry) => !entries.has(entry))) {
    throw new Error(
      `Bundle omitted expected entries: ${expectedEntries.join(", ")}`,
    );
  }
  if (requireSharedChunk && !chunks.some((chunk) => !chunk.isEntry))
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

function verifySourceMaps(distributionDirectory: string): void {
  const javascript = filesRecursively(distributionDirectory).filter((path) =>
    path.endsWith(".js"),
  );
  const maps = filesRecursively(distributionDirectory).filter((path) =>
    path.endsWith(".js.map"),
  );
  if (maps.length === 0) throw new Error("Distribution omitted source maps");
  const mappedJavaScript = new Set(
    maps.map((path) => path.slice(0, -".map".length)),
  );
  const unmappedJavaScript = javascript.filter(
    (path) => !mappedJavaScript.has(path),
  );
  // Rolldown 可为共享代码拆分产生仅做 import/export 的无逻辑 facade；
  // 实际代码块必须带 source map，这类 facade 无 authored statement 可映射。
  for (const path of unmappedJavaScript) {
    const authoredLines = readFileSync(path, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(
        (line) =>
          line !== "" &&
          !line.startsWith("import ") &&
          !line.startsWith("export ") &&
          !line.startsWith("#!/usr/bin/env node"),
      );
    if (authoredLines.length > 0) {
      throw new Error(`JavaScript output omitted a source map: ${path}`);
    }
  }
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

function pack(stagingDirectory: string, expectedTarball: string): string {
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
  const tarball = join(releaseDirectory, expectedTarball);
  if (!readdirSync(releaseDirectory).includes(expectedTarball)) {
    throw new Error(`Pack omitted expected tarball: ${expectedTarball}`);
  }
  return tarball;
}

const { authority } = assertReleaseVersionAuthority(repository);
const runtimeDependencies = resolveReleaseRuntimeDependencies(repository);
const runtimeManifest = createReleaseStagingManifest(
  authority,
  runtimeDependencies,
);
const sdkDependencies = resolveReleaseSdkDependencies(repository);
const sdkManifest = createSdkReleaseStagingManifest(authority, sdkDependencies);
const expectedRuntimeTarball = releaseTarballName(
  String(authority.name),
  String(authority.version),
);
const expectedSdkTarball = releaseTarballName(
  "@ykdz/reins-sdk",
  String(authority.version),
);

rmSync(join(artifactsDirectory, "release"), { recursive: true, force: true });
rmSync(join(artifactsDirectory, "staging"), { recursive: true, force: true });
mkdirSync(runtimeDistributionDirectory, { recursive: true });
mkdirSync(sdkDistributionDirectory, { recursive: true });
mkdirSync(releaseDirectory, { recursive: true });

writeFileSync(
  join(runtimeStagingDirectory, "package.json"),
  `${JSON.stringify(runtimeManifest, null, 2)}\n`,
);
writeFileSync(
  join(sdkStagingDirectory, "package.json"),
  `${JSON.stringify(sdkManifest, null, 2)}\n`,
);
for (const name of ["README.md", "LICENSE"] as const) {
  copyFileSync(join(repository, name), join(runtimeStagingDirectory, name));
  copyFileSync(join(repository, name), join(sdkStagingDirectory, name));
}

const runtimeBundle = await rolldown({
  cwd: repository,
  input: {
    "reins-daemon": "packages/daemon/src/main.ts",
    index: "packages/runtime/src/index.ts",
    "stdio-main": "packages/runtime/src/stdio-main.ts",
    "control-entry": "packages/runtime/src/control-entry.ts",
  },
  platform: "node",
  external: (specifier) =>
    isExternalDependency(specifier, Object.keys(runtimeDependencies)),
  resolve: {
    conditionNames: ["source", "import", "node", "default"],
  },
});
const runtimeOutput = await runtimeBundle.write({
  dir: runtimeDistributionDirectory,
  format: "esm",
  codeSplitting: true,
  sourcemap: true,
  entryFileNames: "[name].js",
  chunkFileNames: "chunks/[name]-[hash].js",
});
await runtimeBundle.close();

const runtimeChunks = runtimeOutput.output.filter(
  (entry): entry is OutputChunk => entry.type === "chunk",
);
verifyBundle(
  runtimeChunks,
  Object.keys(runtimeDependencies),
  ["reins-daemon.js", "index.js", "stdio-main.js", "control-entry.js"],
  true,
);
for (const name of ["reins-daemon.js", "stdio-main.js"] as const) {
  const path = join(runtimeDistributionDirectory, name);
  if (!readFileSync(path, "utf8").startsWith("#!/usr/bin/env node\n")) {
    throw new Error(`Executable omitted shebang: ${path}`);
  }
  chmodSync(path, 0o755);
  if ((statSync(path).mode & 0o777) !== 0o755)
    throw new Error(`Executable mode is not 0755: ${path}`);
}
for (const name of [
  "index.d.ts",
  "application-contracts.d.ts",
  "control-entry.d.ts",
] as const) {
  const declaration = join(repository, "packages", "runtime", "dist", name);
  if (!readFileSync(declaration, "utf8")) {
    throw new Error(`Application declaration is empty: ${declaration}`);
  }
  copyFileSync(declaration, join(runtimeDistributionDirectory, name));
}
verifySourceMaps(runtimeDistributionDirectory);

const runtimeTarball = pack(runtimeStagingDirectory, expectedRuntimeTarball);
if (relative(releaseDirectory, runtimeTarball) !== expectedRuntimeTarball) {
  throw new Error(`Unexpected runtime tarball name: ${runtimeTarball}`);
}
const sdkBundle = await rolldown({
  cwd: repository,
  input: { index: "packages/sdk/src/index.ts" },
  platform: "node",
  external: (specifier) =>
    isExternalDependency(specifier, Object.keys(sdkDependencies)),
  resolve: {
    conditionNames: ["source", "import", "node", "default"],
  },
});
const sdkOutput = await sdkBundle.write({
  dir: sdkDistributionDirectory,
  format: "esm",
  codeSplitting: true,
  sourcemap: true,
  entryFileNames: "[name].js",
  chunkFileNames: "chunks/[name]-[hash].js",
});
await sdkBundle.close();
verifyBundle(
  sdkOutput.output.filter(
    (entry): entry is OutputChunk => entry.type === "chunk",
  ),
  Object.keys(sdkDependencies),
  ["index.js"],
);
verifySourceMaps(sdkDistributionDirectory);

// SDK 声明由常规包构建生成；发布的 JavaScript 与运行包共用依赖打包流程。
cpSync(join(repository, "packages/sdk/dist"), sdkDistributionDirectory, {
  recursive: true,
  filter: (source) =>
    statSync(source).isDirectory() || source.endsWith(".d.ts"),
});

const sdkTarball = pack(sdkStagingDirectory, expectedSdkTarball);
if (relative(releaseDirectory, sdkTarball) !== expectedSdkTarball) {
  throw new Error(`Unexpected SDK tarball name: ${sdkTarball}`);
}
process.stdout.write(
  `${relative(repository, runtimeTarball)}\n${relative(repository, sdkTarball)}\n`,
);
