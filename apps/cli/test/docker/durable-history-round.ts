import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
const base = process.cwd();
const output = join(base, "evidence");
await mkdir(output, { recursive: true });
const {
  image: nodeImage,
  consumerSha256,
  environmentBase = nodeImage,
} = JSON.parse(await readFile(join(base, "base-image.json"), "utf8")) as {
  image: string;
  consumerSha256: string;
  environmentBase?: string;
};
async function command(
  binary: string,
  args: string[],
  cwd = base,
  env: NodeJS.ProcessEnv = {},
) {
  await appendFile(
    join(output, "commands.ndjson"),
    `${JSON.stringify({ event: "start", binary, args, cwd, at: new Date().toISOString() })}\n`,
  );
  return await new Promise<{ status: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(binary, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        process.stdout.write(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        process.stderr.write(chunk);
      });
      child.once("error", reject);
      child.once("close", (status) => {
        const result = { status: status ?? 1, stdout: stdout.trim(), stderr };
        void appendFile(
          join(output, "commands.ndjson"),
          `${JSON.stringify({ event: "end", binary, args, status: result.status, at: new Date().toISOString() })}\n`,
        ).then(() => resolve(result), reject);
      });
    },
  );
}
async function requireCommand(binary: string, args: string[], cwd = base) {
  const result = await command(binary, args, cwd);
  assert.equal(result.status, 0, JSON.stringify({ binary, args, ...result }));
  return result.stdout;
}
const facts: unknown[] = [];
let recording = Promise.resolve();
const record = async (name: string, value: unknown) => {
  facts.push({ name, value });
  const snapshot = JSON.stringify(facts, null, 2);
  recording = recording.then(() =>
    writeFile(join(output, "workspace-facts.json"), snapshot),
  );
  await recording;
};
// 固定工具夹具仍执行真实 Git 与 Docker，省去每轮与业务无关的系统包安装。
process.env.PATH = `${join(base, "tools")}:${process.env.PATH ?? ""}`;
await record("gitVersion", await requireCommand("git", ["--version"]));
await record("dockerVersion", await requireCommand("docker", ["--version"]));
await mkdir(join(base, "consumer"));
assert.equal(
  createHash("sha256")
    .update(await readFile(join(base, "consumer.tar")))
    .digest("hex"),
  consumerSha256,
);
await requireCommand("tar", [
  "-xf",
  join(base, "consumer.tar"),
  "-C",
  join(base, "consumer"),
]);
const installed = join(base, "consumer", "node_modules", "@ykdz", "reins");
const context = join(base, "image-context");
await mkdir(context);
// 直接将独立消费者的安装树作为 build context，避免在慢文件系统逐文件再复制一遍。
await writeFile(
  join(base, ".dockerignore"),
  "tools\nconsumer\ncandidate.tgz\nconsumer.tar\nevidence\n",
);
await writeFile(
  join(context, "codex"),
  '#!/usr/bin/env node\nconsole.log("codex-cli 0.162.0");\n',
  { mode: 0o755 },
);
// 硬链接组装同文件系统内的夹具 payload，避免重复复制消费者依赖及逐 COPY 层提交。
const payload = join(context, "payload");
await mkdir(join(payload, "opt", "reins", "harnesses", "codex", "bin"), {
  recursive: true,
});
await mkdir(join(payload, "usr", "local"), { recursive: true });
// 缓存环境只提供不变系统工具；发行代码与测试注册表始终覆盖为本轮固定候选。
if (environmentBase === nodeImage) {
  await requireCommand("cp", [
    "-al",
    join(base, "tools"),
    join(payload, "usr", "local", "bin"),
  ]);
  await rm(join(payload, "usr", "local", "bin", "docker"));
  await rm(join(payload, "usr", "local", "bin", "docker-native"));
}
if (environmentBase === nodeImage) {
  await requireCommand("cp", [
    "-al",
    join(base, "consumer", "node_modules"),
    join(payload, "opt", "reins", "node_modules"),
  ]);
} else {
  // 显式缓存基底只复用已固定且未改变的第三方闭包；本仓库所有代码都在下面的 dist 覆盖层。
  await record("cachedRuntimeDependencies", {
    environmentBase,
    dependencies: JSON.parse(
      await readFile(join(installed, "package.json"), "utf8"),
    ).dependencies,
  });
}
await requireCommand("cp", [
  "-al",
  join(installed, "dist"),
  join(payload, "opt", "reins", "dist"),
]);
await writeFile(
  join(payload, "opt", "reins", "package.json"),
  await readFile(join(installed, "package.json")),
);
await writeFile(
  join(payload, "opt", "reins", "native-view-adapter.ts"),
  await readFile(join(base, "native-view-adapter.ts")),
);
await writeFile(
  join(payload, "opt", "reins", "workspace-reading-worker.ts"),
  await readFile(join(base, "workspace-reading-worker.ts")),
);
await writeFile(
  join(payload, "opt", "reins", "native-view-worker.ts"),
  await readFile(join(base, "native-view-worker.ts")),
);
await writeFile(
  join(payload, "opt", "reins", "harnesses", "codex", "bin", "codex"),
  await readFile(join(context, "codex")),
  { mode: 0o755 },
);
// 在镜像提交前实际执行本轮消费者安装的发行 CLI；容器闭包随后由真实准备核验。
await requireCommand(process.execPath, [
  join(installed, "dist", "reins.js"),
  "--version",
]);
await requireCommand(process.execPath, [
  join(installed, "dist", "reins.js"),
  "list",
  "--help",
]);
assert.equal(
  await requireCommand(
    join(payload, "opt", "reins", "harnesses", "codex", "bin", "codex"),
    ["--version"],
    base,
  ),
  "codex-cli 0.162.0",
);
await writeFile(
  join(context, "Dockerfile"),
  `FROM ${environmentBase}\nCOPY image-context/payload /\nENV REINS_ADAPTERS_MODULE=/opt/reins/native-view-adapter.ts\n`,
);
const imageTag = `reins-wrr22-material-${process.pid}:candidate`;
await requireCommand("docker", [
  "build",
  "--quiet",
  "-t",
  imageTag,
  "-f",
  join(context, "Dockerfile"),
  base,
]);
const image = await requireCommand("docker", [
  "image",
  "inspect",
  "--format",
  "{{.Id}}",
  imageTag,
]);
await record("fixedFixtureImage", image);
// runtime 材料只供真实 docker cp；独立小镜像保留同一版本的原始 bin 字节。
const materialContext = join(base, "runtime-material");
await mkdir(materialContext);
await requireCommand("cp", [
  "-al",
  join(payload, "opt", "reins", "harnesses"),
  join(materialContext, "harnesses"),
]);
await writeFile(
  join(materialContext, "Dockerfile"),
  "FROM scratch\nCOPY harnesses /opt/reins/harnesses\n",
);
const materialTag = `reins-wrr22-runtime-${process.pid}:candidate`;
await requireCommand("docker", [
  "build",
  "--quiet",
  "-t",
  materialTag,
  materialContext,
]);
const runtimeImage = await requireCommand("docker", [
  "image",
  "inspect",
  "--format",
  "{{.Id}}",
  materialTag,
]);
await record("fixedRuntimeMaterialImage", runtimeImage);
await record("runtimeMaterialFiles", [
  {
    path: "codex/bin/codex",
    sha256: createHash("sha256")
      .update(
        await readFile(
          join(materialContext, "harnesses", "codex", "bin", "codex"),
        ),
      )
      .digest("hex"),
  },
]);
const git = join(base, "project");
await mkdir(git);
await requireCommand("git", ["init", "--quiet"], git);
await writeFile(join(git, "tracked.txt"), "native worktree\n");
await requireCommand("git", ["add", "tracked.txt"], git);
await requireCommand(
  "git",
  [
    "-c",
    "user.name=Reins Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ],
  git,
);
const worktree = join(base, "linked-worktree");
await requireCommand(
  "git",
  ["worktree", "add", "--quiet", "-b", "native", worktree],
  git,
);
await mkdir(join(worktree, ".reins"));
await mkdir(join(worktree, "src"));
const configuration = {
  environments: [{ provider: "docker", image }],
  runtimes: [{ harness: "codex", version: "0.162.0", image: runtimeImage }],
  bindings: [
    { ref: "code", harness: "codex", credentialBindingRef: "fixture-auth" },
  ],
};
await writeFile(
  join(worktree, ".reins", "workspace.json"),
  JSON.stringify(configuration),
);
// 此状态目录也承载 runtime 的 bind 源，必须位于场景与真实 Docker 主机共享的原生目录。
const managerState = join(base, "manager-state");
const callerHome = join(base, "caller-home");
await mkdir(join(callerHome, ".codex"), { recursive: true });
await writeFile(
  join(callerHome, ".codex", "AGENTS.md"),
  "unselected host instructions\n",
);
const authFile = join(base, "synthetic-auth.json");
await writeFile(
  authFile,
  JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: "fixture-id",
      access_token: "fixture-access",
      refresh_token: "fixture-refresh",
      account_id: "fixture-account",
    },
  }),
  { mode: 0o600 },
);
const env = {
  REINS_CODEX_AUTH_BINDINGS: JSON.stringify({ "fixture-auth": authFile }),
  HOME: callerHome,
  CODEX_HOME: join(callerHome, ".codex"),
  REINS_CONSUMER_CONTEXT: "reins-wrr22-owner-a",
  REINS_WORKSPACE_MANAGER_SOCKET: join(base, "manager.sock"),
  REINS_WORKSPACE_MANAGER_STATE_DIR: managerState,
  REINS_WORKSPACE_RESOURCE_PREFIX: "reins-wrr22-runtime",
};
const cli = async (args: string[], overrides: NodeJS.ProcessEnv = {}) => {
  const result = await command(
    process.execPath,
    [join(installed, "dist", "reins.js"), "workspace", ...args],
    base,
    { ...env, ...overrides },
  );
  await record(`cli ${args.join(" ")}`, result);
  return {
    ...result,
    value: (result.stdout === "" ? {} : JSON.parse(result.stdout)) as Record<
      string,
      unknown
    >,
  };
};
const bootstrap = await cli(["harnesses", "-C", worktree]);
assert.equal(bootstrap.status, 0);
const scenario = await command(
  process.execPath,
  [
    join(base, "durable-history-client.js"),
    JSON.stringify({ base, installed, worktree, git, env }),
  ],
  base,
  env,
);
await record("historyScenario", scenario);
assert.equal(scenario.status, 0, scenario.stderr);
