import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertReleaseVersionAuthority,
  readJsonObject,
  releaseTarballName,
} from "./release-package.ts";

// 正式候选的独立验收输入组准备入口。
// 输入是本 worktree 刚构建的正式发行目录（.artifacts/release，恰好 tarball 与 SHA256SUMS）；
// 候选须先通过复用现有 validate-release-package.ts 的正式发行校验，校验通过前不删除旧输入组。
// 输出是独立于正式发行目录的验收输入组（.artifacts/acceptance-input）：
//   candidate/<name>.tgz、candidate/SHA256SUMS、
//   consumer/package.json、consumer/pnpm-workspace.yaml、consumer/pnpm-lock.yaml、
//   fixtures/<场景选定文件>、input.json。
// 消费者锁由项目声明的固定 pnpm 版本在源码 workspace 之外原生生成（consumer 目录以
// 自身 pnpm-workspace.yaml 成为独立 workspace 根）；不裁剪根锁、不自制 resolver。
// fixtures/ 只携带本场景显式选定的文件（回合入口 + 正式类型 adapter + 其窄共享支持），
// 按仓库内同样的相对结构放置，让入口的 ./packed-cli-fixtures/* 导入在组内直接可解析；
// 不复制整仓、不复制生产源码、不新增产品 hook。
// input.json 绑定组内每个文件的 SHA-256 与 pnpm 版本；任何一项变化都代表新的输入身份。
// 组内不记录时间戳，也不记录安装脚本额外下载的厂商运行时，保持同一输入的可重放性。

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const qoderSdkPackage = "@qodercn-ai/qodercn-agent-sdk";

// 本场景选定文件（相对仓库根）：入口 + 场景 adapter + 入口真正需要的共享夹具。
const scenarioRoundEntry = "scripts/check-pnpm-consumer-round.ts";
const scenarioAdapterModule =
  "scripts/packed-cli-fixtures/simulated-adapter.ts";
const scenarioSharedFixtures: readonly string[] = [
  "scripts/packed-cli-fixtures/daemon.ts",
  "scripts/packed-cli-fixtures/evidence.ts",
  "scripts/packed-cli-fixtures/process.ts",
  "scripts/packed-cli-fixtures/sdk.ts",
  "scripts/packed-cli-fixtures/types.ts",
];
const scenarioFixtureFiles: readonly string[] = [
  scenarioRoundEntry,
  scenarioAdapterModule,
  ...scenarioSharedFixtures,
];

// 入口的相对导入必须全部落在选定文件里：漏一个就会让组内入口无法执行，
// 而这一失败只会在后续场景真正消费输入时才暴露，因此在准备时就要失败。
function assertScenarioEntryImportClosure(entryPath: string): void {
  const source = readFileSync(entryPath, "utf8");
  const required = new Set<string>();
  for (const match of source.matchAll(/from "(\.\/[^"]+)"/g)) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    required.add(join(scenarioRoundEntry, "..", specifier));
  }
  const missing = [...required]
    .filter((path) => !scenarioFixtureFiles.includes(path))
    .sort((left, right) => left.localeCompare(right));
  if (missing.length !== 0) {
    throw new Error(
      `Scenario fixtures omit imports required by ${scenarioRoundEntry}: ${missing.join(", ")}`,
    );
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runPnpm(cwd: string, args: readonly string[]): string {
  const result = spawnSync("pnpm", [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `pnpm ${args.join(" ")} failed with exit ${result.status ?? 1}\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

function collectFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const { name, version } = assertReleaseVersionAuthority(repository);
const runtimeTarball = releaseTarballName(name, version);
const sdkTarball = releaseTarballName("@ykdz/reins-sdk", version);
const expectedTarballs = [runtimeTarball, sdkTarball].sort((a, b) =>
  a.localeCompare(b),
);

// 只接受匹配校验的正式 tarball：目录必须恰好是 SHA256SUMS 加唯一 tarball，
// 且 SHA256SUMS 与实际重算的摘要逐字符一致。
const releaseDirectory = join(repository, ".artifacts", "release");
const releaseFiles = readdirSync(releaseDirectory, { withFileTypes: true });
if (releaseFiles.some((entry) => !entry.isFile())) {
  throw new Error("Release artifact directory must contain only files");
}
const releaseNames = releaseFiles
  .map((entry) => entry.name)
  .sort((a, b) => a.localeCompare(b));
if (
  releaseNames.length !== 3 ||
  !releaseNames.includes("SHA256SUMS") ||
  expectedTarballs.some((tarball) => !releaseNames.includes(tarball))
) {
  throw new Error(
    `Expected both same-version tarballs and SHA256SUMS; found: ${releaseNames.join(", ")}`,
  );
}
const candidateDigests = new Map(
  expectedTarballs.map((tarball) => [
    tarball,
    sha256File(join(releaseDirectory, tarball)),
  ]),
);
const checksumsPath = join(releaseDirectory, "SHA256SUMS");
const expectedChecksums = [...candidateDigests.entries()]
  .map(([tarball, digest]) => `${digest}  ${tarball}`)
  .sort((left, right) => left.localeCompare(right))
  .join("\n");
if (readFileSync(checksumsPath, "utf8") !== `${expectedChecksums}\n`) {
  throw new Error("SHA256SUMS does not exactly match both release tarballs");
}

// 复用现有正式发行校验：摘要自洽的同名 tarball 仍可能是 validator 会拒绝的包。
// 子进程调用时 cwd 与 GITHUB_WORKSPACE 显式指向本仓库，并剥离 GITHUB_OUTPUT，
// 避免外部取值（例如指向主仓）让 validator 检查错误目录；校验通过前不得删除旧输入组。
const validatorEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GITHUB_WORKSPACE: repository,
};
delete validatorEnv.GITHUB_OUTPUT;
const validation = spawnSync(
  process.execPath,
  [
    "--conditions=source",
    join(repository, "scripts", "validate-release-package.ts"),
  ],
  {
    cwd: repository,
    env: validatorEnv,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  },
);
if (validation.error !== undefined) throw validation.error;
if (validation.status !== 0) {
  throw new Error(
    `Release validation rejected the candidate before output replacement (exit ${validation.status ?? 1})\n${validation.stdout}${validation.stderr}`,
  );
}

// 固定 pnpm 版本：以根 package.json 的 packageManager 声明为准，实际版本不一致即失败。
const rootManifest = readJsonObject(join(repository, "package.json"));
const declaredPackageManager = rootManifest.packageManager;
if (typeof declaredPackageManager !== "string") {
  throw new Error("Root manifest must declare packageManager");
}
const pnpmVersion = runPnpm(repository, ["--version"]).trim();
const expectedPnpmVersion = declaredPackageManager.slice("pnpm@".length);
if (pnpmVersion !== expectedPnpmVersion) {
  throw new Error(
    `Preparation requires pnpm ${expectedPnpmVersion}; found ${pnpmVersion}`,
  );
}

const acceptanceDirectory = join(repository, ".artifacts", "acceptance-input");
const candidateDirectory = join(acceptanceDirectory, "candidate");
const consumerDirectory = join(acceptanceDirectory, "consumer");
rmSync(acceptanceDirectory, { recursive: true, force: true });
mkdirSync(candidateDirectory, { recursive: true });
mkdirSync(consumerDirectory, { recursive: true });

for (const tarball of expectedTarballs) {
  copyFileSync(
    join(releaseDirectory, tarball),
    join(candidateDirectory, tarball),
  );
}
copyFileSync(checksumsPath, join(candidateDirectory, "SHA256SUMS"));

// 消费者以稳定相对路径同时引用同版运行包与 SDK，随组移动后仍可解析。
const consumerManifest = {
  name: "reins-acceptance-consumer",
  version: "0.0.0",
  private: true,
  dependencies: {
    [name]: `file:../candidate/${runtimeTarball}`,
    "@ykdz/reins-sdk": `file:../candidate/${sdkTarball}`,
  },
};
writeFileSync(
  join(consumerDirectory, "package.json"),
  `${JSON.stringify(consumerManifest, null, 2)}\n`,
);

// 只保留消费者所需配置：显式允许 Qoder SDK 的必需安装脚本。
writeFileSync(
  join(consumerDirectory, "pnpm-workspace.yaml"),
  `allowBuilds:\n  "${qoderSdkPackage}": true\n`,
);

// 在 consumer 独立 workspace 根内用原生 pnpm 自然生成消费者锁。
runPnpm(consumerDirectory, ["install", "--lockfile-only"]);
const lockPath = join(consumerDirectory, "pnpm-lock.yaml");
if (relative(consumerDirectory, lockPath) !== "pnpm-lock.yaml") {
  throw new Error("Consumer lock was not generated");
}

// 场景选定文件按仓库内同样的相对结构进入 fixtures/，让入口的相对导入在组内直接可解析。
const fixturesDirectory = join(acceptanceDirectory, "fixtures");
assertScenarioEntryImportClosure(join(repository, scenarioRoundEntry));
for (const file of scenarioFixtureFiles) {
  const source = join(repository, file);
  if (!existsSync(source)) {
    throw new Error(`Scenario fixture is missing: ${file}`);
  }
  const target = join(fixturesDirectory, file);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

const fileDigests: Record<string, string> = {};
for (const path of collectFiles(acceptanceDirectory).sort((a, b) =>
  a.localeCompare(b),
)) {
  fileDigests[relative(acceptanceDirectory, path)] = sha256File(path);
}
writeFileSync(
  join(acceptanceDirectory, "input.json"),
  `${JSON.stringify({ pnpmVersion, files: fileDigests }, null, 2)}\n`,
);

process.stdout.write(
  `Acceptance input prepared: ${relative(repository, acceptanceDirectory)} (pnpm ${pnpmVersion}, runtime sha256 ${candidateDigests.get(runtimeTarball)}, SDK sha256 ${candidateDigests.get(sdkTarball)})\n`,
);
