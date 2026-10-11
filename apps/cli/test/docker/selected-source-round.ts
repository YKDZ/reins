import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  copyFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
const base = process.cwd();
const output = join(base, "evidence");
await mkdir(output, { recursive: true });
const {
  image: nodeImage,
  consumerSha256,
  fixtureBaseImage,
} = JSON.parse(await readFile(join(base, "base-image.json"), "utf8")) as {
  image: string;
  consumerSha256?: string;
  fixtureBaseImage?: string;
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
const installed = join(base, "consumer", "node_modules", "@ykdz", "reins");
await mkdir(join(base, "consumer"));
if (fixtureBaseImage === undefined) {
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
} else {
  // 同一固定依赖清单复用已验安装；只展开新产品包，不再运输或安装依赖。
  await requireCommand("tar", [
    "-xf",
    join(base, "candidate.tgz"),
    "-C",
    join(base, "consumer"),
  ]);
  const next = JSON.parse(
    await readFile(join(base, "consumer", "package", "package.json"), "utf8"),
  ) as { dependencies: unknown };
  const cached = JSON.parse(
    await readFile("/opt/reins/package.json", "utf8"),
  ) as { dependencies: unknown };
  assert.deepEqual(
    next.dependencies,
    cached.dependencies,
    "Cached runtime dependencies must match the new package",
  );
  await mkdir(join(base, "consumer", "node_modules", "@ykdz"), {
    recursive: true,
  });
  await rename(join(base, "consumer", "package"), installed);
  for (const name of await readdir("/opt/reins/node_modules")) {
    if (name === "@ykdz") continue;
    await symlink(
      join("/opt/reins/node_modules", name),
      join(base, "consumer", "node_modules", name),
    );
  }
  await record("consumerDependencyCache", {
    fixtureBaseImage,
    dependencies: next.dependencies,
    productPackageSha256: createHash("sha256")
      .update(await readFile(join(base, "candidate.tgz")))
      .digest("hex"),
    installation:
      "Reused prior fixed dependency installation; extracted new product package",
  });
}
await copyFile(
  join(base, "selected-source-client.js"),
  join(installed, "selected-source-client.js"),
);
const context = join(base, "image-context");
await mkdir(context);
// 直接将独立消费者的安装树作为 build context，避免在慢文件系统逐文件再复制一遍。
await writeFile(
  join(base, ".dockerignore"),
  "tools/docker\ntools/docker-native\ncandidate.tgz\nconsumer.tar\nevidence\n",
);
await writeFile(
  join(context, "codex"),
  '#!/usr/bin/env node\nconsole.log("codex-cli 0.149.0");\n',
  { mode: 0o755 },
);
// 硬链接组装同文件系统内的夹具 payload，避免重复复制消费者依赖及逐 COPY 层提交。
const payload = join(context, "payload");
await mkdir(join(payload, "opt", "reins", "harnesses", "codex", "bin"), {
  recursive: true,
});
await mkdir(join(payload, "usr", "local"), { recursive: true });
await requireCommand("cp", [
  "-al",
  join(base, "tools"),
  join(payload, "usr", "local", "bin"),
]);
await rm(join(payload, "usr", "local", "bin", "docker"));
await rm(join(payload, "usr", "local", "bin", "docker-native"));
await requireCommand("cp", [
  "-al",
  join(base, "consumer", "node_modules"),
  join(payload, "opt", "reins", "node_modules"),
]);
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
  join(payload, "opt", "reins", "workspace-reading-adapter.ts"),
  await readFile(join(base, "workspace-reading-adapter.ts")),
);
await writeFile(
  join(payload, "opt", "reins", "workspace-reading-worker.ts"),
  await readFile(join(base, "selected-reading-worker.ts")),
);
await writeFile(
  join(payload, "opt", "reins", "harnesses", "codex", "bin", "codex"),
  await readFile(join(context, "codex")),
  { mode: 0o755 },
);
// 在昂贵镜像提交前实际执行发行 CLI，验证夹具闭包的本地入口。
await requireCommand(process.execPath, [
  join(payload, "opt", "reins", "dist", "reins.js"),
  "--version",
]);
await requireCommand(process.execPath, [
  join(payload, "opt", "reins", "dist", "reins.js"),
  "list",
  "--help",
]);
assert.equal(
  await requireCommand(
    join(payload, "opt", "reins", "harnesses", "codex", "bin", "codex"),
    ["--version"],
    base,
  ),
  "codex-cli 0.149.0",
);
// 后续候选只覆盖产品与本票夹具；依赖、原生工具沿固定旧材料复用。
if (fixtureBaseImage !== undefined) {
  assert.match(fixtureBaseImage, /^sha256:[a-f0-9]{64}$/u);
  await writeFile(
    join(context, ".dockerignore"),
    "payload/opt/reins/node_modules\npayload/usr\n",
  );
  await record("fixtureCacheReuse", {
    fixtureBaseImage,
    package: JSON.parse(
      await readFile(join(installed, "package.json"), "utf8"),
    ),
  });
}
await writeFile(
  join(context, "Dockerfile"),
  fixtureBaseImage === undefined
    ? `FROM ${nodeImage}\nCOPY payload /\nENV REINS_ADAPTERS_MODULE=/opt/reins/workspace-reading-adapter.ts\n`
    : `FROM ${fixtureBaseImage}\nCOPY payload/opt/reins /opt/reins\nENV REINS_ADAPTERS_MODULE=/opt/reins/workspace-reading-adapter.ts\n`,
);
const imageTag = `reins-wrr25-material-${process.pid}:candidate`;
await requireCommand("docker", [
  "build",
  "--quiet",
  "-t",
  imageTag,
  "-f",
  join(context, "Dockerfile"),
  context,
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
const materialTag = `reins-wrr25-runtime-${process.pid}:candidate`;
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

const env = {
  REINS_CONSUMER_CONTEXT: "reins-wrr25-owner-a",
  REINS_WORKSPACE_MANAGER_SOCKET: join(base, "manager.sock"),
  REINS_WORKSPACE_MANAGER_STATE_DIR: join(base, "manager-state"),
  REINS_WORKSPACE_RESOURCE_PREFIX: "reins-wrr25-runtime",
};
// 首个只读请求启动正式 Manager；CLI 和共享客户端连续投递两次固定提交。
const probe = join(base, "probe");
await mkdir(join(probe, ".reins"), { recursive: true });
await requireCommand("git", ["init", "--quiet"], probe);
await writeFile(
  join(probe, ".reins/workspace.json"),
  JSON.stringify({
    environments: [{ provider: "docker", image }],
    runtimes: [],
    bindings: [],
  }),
);
try {
  const boot = await command(
    process.execPath,
    [join(installed, "dist/reins.js"), "workspace", "harnesses", "-C", probe],
    base,
    env,
  );
  assert.equal(boot.status, 0, JSON.stringify(boot));
  const result = await command(
    process.execPath,
    [
      join(installed, "selected-source-client.js"),
      JSON.stringify({
        base,
        socket: env.REINS_WORKSPACE_MANAGER_SOCKET,
        image,
        runtimeImage,
        cliPath: join(installed, "dist/reins.js"),
      }),
    ],
    base,
    env,
  );
  await record("selected-source-client", result);
  assert.equal(result.status, 0, JSON.stringify(result));
  await record("result", "passed");
} finally {
  await record(
    "fixtureImageRemoval",
    await command("docker", ["image", "rm", imageTag, materialTag]),
  );
}
