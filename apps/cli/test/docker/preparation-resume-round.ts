import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const base = process.cwd();
const output = join(base, "evidence");
await mkdir(output, { recursive: true });
const { image: nodeImage } = JSON.parse(
  await readFile(join(base, "base-image.json"), "utf8"),
) as { image: string };
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
await writeFile(
  join(base, "consumer", "package.json"),
  JSON.stringify({
    private: true,
    dependencies: { "@ykdz/reins": "file:../candidate.tgz" },
  }),
);
// 可显式运输独立 npm 消费者的生产安装材料；不是开发 node_modules 或宿主配置。
let installation: Buffer | undefined;
try {
  installation = await readFile(join(base, "consumer-installation.tar"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
if (installation !== undefined) {
  const material = JSON.parse(
    await readFile(join(base, "consumer-installation.json"), "utf8"),
  ) as { packedSha256: string; archiveSha256: string };
  assert.equal(
    createHash("sha256").update(installation).digest("hex"),
    material.archiveSha256,
  );
  assert.equal(
    createHash("sha256")
      .update(await readFile(join(base, "candidate.tgz")))
      .digest("hex"),
    material.packedSha256,
  );
  await requireCommand("tar", [
    "-xf",
    join(base, "consumer-installation.tar"),
    "-C",
    join(base, "consumer"),
  ]);
  await record("independentConsumerInstallation", material);
} else {
  await requireCommand(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    join(base, "consumer"),
  );
}
const installed = join(base, "consumer", "node_modules", "@ykdz", "reins");
const context = join(base, "image-context");
await mkdir(context);
// 直接将独立消费者的安装树作为 build context，避免在慢文件系统逐文件再复制一遍。
await writeFile(
  join(base, ".dockerignore"),
  "tools/docker\ntools/docker-native\ncandidate.tgz\nconsumer-installation.tar\nconsumer-installation.json\nevidence\n",
);
await writeFile(
  join(context, "codex"),
  '#!/usr/bin/env node\nimport fs from "node:fs";import path from "node:path";const kind=path.basename(process.argv[1])==="codex"?"codex":"qoder";const root=path.resolve("../.reins");fs.appendFileSync(path.join(root,"version-"+kind),"1\\n");console.log(kind==="codex"?"codex-cli 0.149.0":fs.existsSync(path.join(root,"qoder-valid"))?"qoder-cli 0.1.0":"qoder-cli 0.0.0");\n',
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
  join(payload, "opt", "reins", "codex-adapter.ts"),
  await readFile(join(base, "codex-adapter.ts")),
);
await writeFile(
  join(payload, "opt", "reins", "harnesses", "codex", "bin", "codex"),
  await readFile(join(context, "codex")),
  { mode: 0o755 },
);
await mkdir(join(payload, "opt", "reins", "harnesses", "qoder", "bin"), {
  recursive: true,
});
await writeFile(
  join(payload, "opt", "reins", "harnesses", "qoder", "bin", "qoderclicn"),
  await readFile(join(context, "codex")),
  { mode: 0o755 },
);
await writeFile(
  join(payload, "opt", "reins", "harnesses", "codex", "value"),
  "initial installed material",
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
const preflight = join(base, "fixture-preflight");
await mkdir(join(preflight, "src"), { recursive: true });
await mkdir(join(preflight, ".reins"));
await writeFile(join(preflight, ".reins", "allow-version"), "fixture check\n");
assert.equal(
  await requireCommand(
    join(payload, "opt", "reins", "harnesses", "codex", "bin", "codex"),
    ["--version"],
    join(preflight, "src"),
  ),
  "codex-cli 0.149.0",
);
await writeFile(join(preflight, ".reins", "qoder-valid"), "fixture check");
assert.equal(
  await requireCommand(
    join(payload, "opt", "reins", "harnesses", "qoder", "bin", "qoderclicn"),
    ["--version"],
    join(preflight, "src"),
  ),
  "qoder-cli 0.1.0",
);
await writeFile(
  join(context, "Dockerfile"),
  `FROM ${nodeImage}\nCOPY image-context/payload /\nENV REINS_ADAPTERS_MODULE=/opt/reins/codex-adapter.ts\n`,
);
const imageTag = `reins-wrr10-material-${process.pid}:candidate`;
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
// harness 材料只用于真实 docker cp；独立小 OCI 避免重复装载整套开发环境。
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
const materialTag = imageTag + "-runtime";
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
await record("runtimeMaterialFiles", {
  codex: createHash("sha256")
    .update(
      await readFile(
        join(materialContext, "harnesses", "codex", "bin", "codex"),
      ),
    )
    .digest("hex"),
  qoder: createHash("sha256")
    .update(
      await readFile(
        join(materialContext, "harnesses", "qoder", "bin", "qoderclicn"),
      ),
    )
    .digest("hex"),
  value: createHash("sha256")
    .update(
      await readFile(join(materialContext, "harnesses", "codex", "value")),
    )
    .digest("hex"),
});

const worktree = join(base, "project");
await mkdir(join(worktree, "src"), { recursive: true });
await requireCommand("git", ["init", "--quiet"], worktree);
await mkdir(join(worktree, ".reins"));
await writeFile(join(worktree, "value.txt"), "caller value\n");
const configuration = {
  environments: [{ provider: "docker", image }],
  runtimes: [
    { harness: "codex", version: "0.149.0", image: runtimeImage },
    { harness: "qoder", version: "0.1.0", image: runtimeImage },
  ],
  bindings: [
    { ref: "code", harness: "codex" },
    { ref: "qoder", harness: "qoder" },
  ],
};
await writeFile(
  join(worktree, ".reins", "workspace.json"),
  JSON.stringify(configuration),
);
const env = {
  REINS_CONSUMER_CONTEXT: "reins-wrr10-owner",
  REINS_WORKSPACE_MANAGER_SOCKET: join(base, "manager.sock"),
  REINS_WORKSPACE_MANAGER_STATE_DIR: join(base, "manager-state"),
  REINS_WORKSPACE_RESOURCE_PREFIX: "reins-wrr10-runtime",
};
const cli = async (args: string[]) => {
  const result = await command(
    process.execPath,
    [
      join(installed, "dist", "reins.js"),
      "workspace",
      ...args,
      "-C",
      join(worktree, "src"),
    ],
    base,
    env,
  );
  await record("cli " + args.join(" "), result);
  return {
    ...result,
    value: JSON.parse(result.stdout) as Record<string, unknown>,
  };
};
async function waitForRuntime(expected: string) {
  for (;;) {
    const observed = await cli(["status"]);
    assert.equal(observed.status, 0);
    const runtime = observed.value.runtime as {
      status: string;
      error?: { code: string };
    };
    if (runtime.status === expected) return observed.value;
    assert.equal(runtime.status, "preparing", JSON.stringify(observed));
    await delay(500);
  }
}
try {
  const first = await cli([
    "attach",
    "--binding",
    "code",
    "--binding",
    "qoder",
  ]);
  assert.equal(first.status, 0);
  const failed = await waitForRuntime("failed");
  assert.deepEqual(failed.runtime, {
    status: "failed",
    error: { code: "runtime_entry_invalid" },
  });
  const harnesses = failed.harnesses as { ref: string; stage: string }[];
  assert.equal(harnesses.find((x) => x.ref === "code")?.stage, "ready");
  assert.equal(harnesses.find((x) => x.ref === "qoder")?.stage, "failed");
  const container = await requireCommand("docker", [
    "ps",
    "-q",
    "--filter",
    "label=reins.workspace.managed=true",
  ]);
  assert.ok(container.length > 0);
  const originalContainer = await requireCommand("docker", [
    "inspect",
    "--format",
    "{{.Id}}",
    container,
  ]);
  await requireCommand("docker", [
    "exec",
    container,
    "node",
    "-e",
    "const fs=require('node:fs');fs.writeFileSync('/opt/reins/harnesses/codex/value','keep installed success');fs.writeFileSync(process.env.HOME+'/valuable','keep private state')",
  ]);
  assert.equal(
    await readFile(join(worktree, ".reins", "version-codex"), "utf8"),
    "1\n",
  );
  await writeFile(
    join(worktree, ".reins", "qoder-valid"),
    "caller repaired runtime condition\n",
  );
  const retry = await cli([
    "attach",
    "--binding",
    "qoder",
    "--binding",
    "code",
  ]);
  assert.equal(retry.status, 0, "Identical intent must resume failed stage");
  assert.equal((retry.value.runtime as { status: string }).status, "preparing");
  const ready = await waitForRuntime("ready");
  assert.equal(
    await requireCommand("docker", [
      "inspect",
      "--format",
      "{{.Id}}",
      container,
    ]),
    originalContainer,
  );
  await record(
    "codexVersionCallsAfterResume",
    await readFile(join(worktree, ".reins", "version-codex"), "utf8"),
  );
  assert.equal(
    await requireCommand("docker", [
      "exec",
      container,
      "node",
      "-e",
      "const fs=require('node:fs');console.log(fs.readFileSync('/opt/reins/harnesses/codex/value','utf8')+'|'+fs.readFileSync(process.env.HOME+'/valuable','utf8'))",
    ]),
    "keep installed success|keep private state",
  );
  await record("readyAfterExplicitResume", ready);
  const detached = await cli([
    "detach",
    "--session-disposition",
    "require_none",
  ]);
  assert.equal(detached.status, 0);
  assert.equal(
    (detached.value.runtime as { status: string }).status,
    "released",
  );

  const registry = join(base, "registry");
  await mkdir(registry);
  await writeFile(
    join(registry, "server.ts"),
    await readFile(join(base, "material-digest-registry.ts")),
  );
  const helper = "reins-wrr10-registry-" + process.pid;
  await requireCommand("docker", [
    "run",
    "-d",
    "--name",
    helper,
    "--network",
    "host",
    "--mount",
    "type=bind,source=" + registry + ",target=" + registry,
    "--workdir",
    registry,
    "--entrypoint",
    "node",
    nodeImage,
    "server.ts",
  ]);
  try {
    let observedRegistry: { port: number; actualDigest: string } | undefined;
    const registryDeadline = Date.now() + 180_000;
    while (observedRegistry === undefined) {
      try {
        observedRegistry = JSON.parse(
          await readFile(join(registry, "ready.json"), "utf8"),
        );
      } catch {
        assert.ok(
          Date.now() < registryDeadline,
          "Registry helper did not start",
        );
        await delay(100);
      }
    }
    const rejectedImage =
      "127.0.0.1:" +
      observedRegistry.port +
      "/fixture@sha256:" +
      "a".repeat(64);
    await record("registryFixture", {
      image: rejectedImage,
      ...observedRegistry,
    });
    const raw = await command("docker", ["pull", rejectedImage]);
    await record("rawDigestRejection", raw);
    assert.equal(raw.status, 1);
    await writeFile(
      join(worktree, ".reins", "workspace.json"),
      JSON.stringify({
        ...configuration,
        environments: [{ provider: "docker", image: rejectedImage }],
      }),
    );
    assert.equal((await cli(["attach", "--binding", "code"])).status, 0);
    const rejected = await waitForRuntime("failed");
    assert.deepEqual(rejected.runtime, {
      status: "failed",
      error: { code: "material_digest_mismatch" },
    });
    await record("persistentDigestFailure", rejected);
  } finally {
    await record(
      "registryRemoval",
      await command("docker", ["rm", "-f", helper]),
    );
  }

  await record("result", "passed");
} finally {
  await record(
    "runtimeMaterialImageRemoval",
    await command("docker", ["image", "rm", materialTag]),
  );
  await record(
    "fixtureImageRemoval",
    await command("docker", ["image", "rm", imageTag]),
  );
}
