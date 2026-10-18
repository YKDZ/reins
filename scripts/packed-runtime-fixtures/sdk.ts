// 从已安装发行包上下文按正常模块解析定位 Qoder SDK 与安装脚本额外取得的运行时，
// 不假设 npm 式扁平布局（pnpm 的 .pnpm/<name>@<ver> 目录同样可解析）。
// 额外运行时由 SDK 安装脚本在线下载，不在包锁冻结范围；本模块只记录实际身份。
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const qoderSdkPackageName = "@qodercn-ai/qodercn-agent-sdk";

export type InstalledSdkIdentity = {
  readonly sdkPackage: string;
  readonly sdkVersion: string;
  readonly sdkEntryPath: string;
  readonly runtimeInfoPath: string;
  readonly runtimeEntrypointPath: string;
  readonly runtimeEntrypointBytes: number;
  readonly runtimeInfoSha256: string;
  readonly runtimeEntrypointSha256: string;
  // runtime-info.json 中实际记录的字段原样保留（缺失即不记录，不编造）。
  readonly runtimeInfo: Record<string, unknown>;
};

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readManifestNameAndVersion(path: string): {
  name: string;
  version: string;
} {
  const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    typeof (manifest as { name?: unknown }).name !== "string" ||
    typeof (manifest as { version?: unknown }).version !== "string"
  ) {
    throw new Error(`Installed package manifest is not readable: ${path}`);
  }
  return {
    name: (manifest as { name: string }).name,
    version: (manifest as { version: string }).version,
  };
}

// installedPackageDirectory 是发行包（如 node_modules/@ykdz/reins）的真实目录，
// npm 与 pnpm 安装均适用：解析基准来自该包自身上下文，而不是硬编码的顶层路径。
export function locateInstalledSdk(
  installedPackageDirectory: string,
  sdkPackage: string = qoderSdkPackageName,
): InstalledSdkIdentity {
  const packageManifest = join(installedPackageDirectory, "package.json");
  const requireFromPackage = createRequire(
    join(dirname(packageManifest), "resolve-anchor.js"),
  );
  let sdkEntryPath: string;
  try {
    sdkEntryPath = requireFromPackage.resolve(sdkPackage);
  } catch (error) {
    throw new Error(
      `Normal module resolution from the installed distribution failed for ${sdkPackage}: ${String(error)}`,
    );
  }
  const sdkRoot = dirname(dirname(sdkEntryPath));
  const sdkManifest = readManifestNameAndVersion(join(sdkRoot, "package.json"));
  const workerDirectory = join(sdkRoot, "dist", "_worker");
  const runtimeInfoPath = join(workerDirectory, "runtime-info.json");
  const runtimeEntrypointPath = join(
    workerDirectory,
    "qoder-worker-runtime.obf.mjs",
  );
  for (const path of [runtimeInfoPath, runtimeEntrypointPath]) {
    try {
      statSync(path);
    } catch {
      throw new Error(
        `Qoder postinstall did not provision its worker runtime: missing ${path}`,
      );
    }
  }
  const runtimeInfo: unknown = JSON.parse(
    readFileSync(runtimeInfoPath, "utf8"),
  );
  return {
    sdkPackage: sdkManifest.name,
    sdkVersion: sdkManifest.version,
    sdkEntryPath,
    runtimeInfoPath,
    runtimeEntrypointPath,
    runtimeEntrypointBytes: statSync(runtimeEntrypointPath).size,
    runtimeInfoSha256: sha256File(runtimeInfoPath),
    runtimeEntrypointSha256: sha256File(runtimeEntrypointPath),
    runtimeInfo:
      typeof runtimeInfo === "object" && runtimeInfo !== null
        ? (runtimeInfo as Record<string, unknown>)
        : {},
  };
}
