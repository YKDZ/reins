import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
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
await requireCommand("mv", [
  join(base, "tools", "docker"),
  join(base, "tools", "docker-real"),
]);
await writeFile(
  join(base, "tools", "docker"),
  `#!/bin/sh\nexec node "${join(base, "capacity-docker.ts")}" "$@"\n`,
  { mode: 0o755 },
);
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
  '#!/usr/bin/env node\nimport fs from "node:fs";import path from "node:path";const kind=path.basename(process.argv[1])==="codex"?"codex":"qoder";const root=path.resolve(process.cwd()==="/"?fs.readlinkSync("/proc/1/cwd"):process.cwd(),"../.reins");fs.appendFileSync(path.join(root,"version-"+kind),"1\\n");console.log(kind==="codex"?"codex-cli 0.149.0":fs.existsSync(path.join(root,"qoder-valid"))?"qoder-cli 0.1.0":"qoder-cli 0.0.0");\n',
  { mode: 0o755 },
);
// 硬链接组装同文件系统内的夹具 payload，避免重复复制消费者依赖及逐 COPY 层提交。
const payload = join(context, "payload");
await mkdir(join(payload, "opt", "reins", "harnesses", "codex", "bin"), {
  recursive: true,
});
// 精确缓存只复用同版本依赖与工具，发行 dist 始终由本轮覆盖。
if (
  nodeImage !==
  "sha256:42166530c7fc76804e18fb5bfbdec7a6dde41ffd1e6746155d7e5f0ba16babe4"
) {
  await mkdir(join(payload, "usr", "local"), { recursive: true });
  await requireCommand("cp", [
    "-al",
    join(base, "tools"),
    join(payload, "usr", "local", "bin"),
  ]);
  await rm(join(payload, "usr", "local", "bin", "docker"));
  await rm(join(payload, "usr", "local", "bin", "docker-native"));
  await rm(join(payload, "usr", "local", "bin", "docker-real"));
  await requireCommand("cp", [
    "-al",
    join(base, "consumer", "node_modules"),
    join(payload, "opt", "reins", "node_modules"),
  ]);
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
await mkdir(join(payload, "opt/reins/harnesses/qoder/worker"));
await writeFile(
  join(
    payload,
    "opt/reins/harnesses/qoder/worker/qoder-worker-runtime.obf.mjs",
  ),
  'import fs from "node:fs";import path from "node:path";console.log(fs.existsSync(path.resolve(process.cwd()==="/"?fs.readlinkSync("/proc/1/cwd"):process.cwd(),"../.reins/qoder-valid"))?"0.1.0":"0.0.0");\n',
);

// 在昂贵镜像提交前实际执行发行 CLI，验证夹具闭包的本地入口。
await requireCommand(process.execPath, [
  join(installed, "dist", "reins.js"),
  "--version",
]);
await requireCommand(process.execPath, [
  join(installed, "dist", "reins.js"),
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
const imageTag = `reins-wrr11-material-${process.pid}:candidate`;
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
await writeFile(
  join(materialContext, "harnesses", "qoder", "capacity-payload"),
  Buffer.alloc(6 * 1024 * 1024, 0x71),
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
await writeFile(
  join(worktree, ".reins", "qoder-valid"),
  "explicit fixture condition",
);
const scenario = (await readFile("/etc/hostname", "utf8")).trim();
const env = {
  REINS_CONSUMER_CONTEXT: "reins-wrr11-owner",
  REINS_WORKSPACE_MANAGER_SOCKET: join(base, "m.sock"),
  REINS_WORKSPACE_MANAGER_STATE_DIR: join(base, "m-state"),
  REINS_WORKSPACE_RESOURCE_PREFIX: "reins-wrr11-runtime",
};
let manager: ReturnType<typeof spawn> | undefined;
let managerError = "";
let stopped = false;
let helper: string | undefined;
let capacityDirectory: string | undefined;
let lastStatus: string | undefined;
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
  if (args[0] !== "status" || result.stdout !== lastStatus)
    await record("cli " + args.join(" "), result);
  if (args[0] === "status") lastStatus = result.stdout;
  assert.equal(result.status, 0);
  return JSON.parse(result.stdout);
};
const accept = async (args: string[]) => {
  // 沿共享 client 保留持久受理/Preparing 的原始可观察行为，CLI 自身等待终态。
  await cli(["harnesses"]);
  const result = await command(
    process.execPath,
    [
      join(base, "workspace-attach-client.js"),
      JSON.stringify({
        socket: env.REINS_WORKSPACE_MANAGER_SOCKET,
        cwd: join(worktree, "src"),
        consumer: env.REINS_CONSUMER_CONTEXT,
        bindings: args.filter(
          (value, index) => index > 0 && args[index - 1] === "--binding",
        ),
      }),
    ],
    base,
    env,
  );
  await record("shared client attach", result);
  assert.equal(result.status, 0);
  return JSON.parse(result.stdout);
};
async function observeRuntime() {
  for (;;) {
    const info = await cli(["status"]);
    if (info.runtime.status !== "preparing") return info;
    await delay(1000);
  }
}
async function capacity() {
  const identity = await stat(capacityDirectory!, { bigint: true });
  const marker = await stat(join(capacityDirectory!, "marker"), {
    bigint: true,
  });
  const mount = (await readFile("/proc/self/mountinfo", "utf8"))
    .split("\n")
    .find((line) => line.split(" ")[4] === capacityDirectory);
  return {
    root: { dev: String(identity.dev), ino: String(identity.ino) },
    marker: {
      dev: String(marker.dev),
      ino: String(marker.ino),
      content: await readFile(join(capacityDirectory!, "marker"), "utf8"),
    },
    fs: await statfs(capacityDirectory!),
    mount,
  };
}
const inNamespace = async (args: string[]) =>
  requireCommand("docker", [
    "exec",
    helper!,
    "nsenter",
    "--target",
    "1",
    "--mount",
    "--root=/proc/1/root",
    "--wd=/",
    ...args,
  ]);
helper = await requireCommand("docker", [
  "create",
  "--name",
  `reins-wrr11-capacity-${process.pid}`,
  "--network",
  "none",
  "--privileged",
  "--pid",
  `container:${scenario}`,
  "--pull",
  "never",
  "--entrypoint",
  "node",
  nodeImage,
  "-e",
  "setInterval(()=>{},1000)",
]);
await requireCommand("docker", ["start", helper]);
try {
  manager = spawn(
    process.execPath,
    [join(installed, "dist", "reins-workspace-manager.js")],
    {
      cwd: base,
      env: { ...process.env, ...env },
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  manager.stderr!.on("data", (chunk: Buffer) => {
    managerError += chunk.toString();
  });
  let hold: ReturnType<typeof createConnection>;
  for (;;) {
    if (manager.exitCode !== null)
      throw new Error("Owned Manager failed to listen: " + managerError);
    try {
      hold = await new Promise((resolve, reject) => {
        const socket = createConnection(env.REINS_WORKSPACE_MANAGER_SOCKET);
        socket.once("connect", () => resolve(socket));
        socket.once("error", (error) => {
          socket.destroy();
          reject(error);
        });
      });
      break;
    } catch {
      await delay(25);
    }
  }
  const first = await accept([
    "attach",
    "--binding",
    "code",
    "--binding",
    "qoder",
  ]);
  assert.equal(first.runtime.status, "preparing");
  process.kill(manager.pid!, "SIGSTOP");
  stopped = true;
  hold.destroy();
  // 故障设置只读自有受理记录以定位真实接收目录；业务结果从公开 CLI 读取。
  const attachment = (
    await readdir(env.REINS_WORKSPACE_MANAGER_STATE_DIR)
  ).find((name) => /^[a-f0-9-]{36}$/u.test(name));
  assert.ok(attachment);
  const directory = join(env.REINS_WORKSPACE_MANAGER_STATE_DIR, attachment);
  await mkdir(join(directory, "home"), { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "home", "valuable"), "keep private home");
  capacityDirectory = join(directory, "material-qoder");
  await mkdir(capacityDirectory, { recursive: true });
  await inNamespace([
    "mount",
    "-t",
    "tmpfs",
    "-o",
    "size=4m,nr_inodes=256,mode=0700",
    "reins-wrr11-capacity",
    capacityDirectory,
  ]);
  await writeFile(join(capacityDirectory, "marker"), "keep capacity marker");
  const initial = await capacity();
  assert.equal(initial.fs.blocks * initial.fs.bsize, 4 * 1024 * 1024);
  await record("boundedActualMaterialDestination", {
    directory: capacityDirectory,
    initial,
    scenario,
    helper,
  });
  process.kill(manager.pid!, "SIGCONT");
  stopped = false;
  const failed = await observeRuntime();
  const copies = (await readFile(join(output, "docker-copies.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const nativeFailure = copies.find(
    (copy) => copy.args[2] === capacityDirectory && copy.code !== 0,
  );
  assert.ok(
    nativeFailure,
    "Actual product Docker copy must fail at bounded destination",
  );
  assert.match(nativeFailure.stderr, /no space left on device/u);
  assert.equal(nativeFailure.after.bavail, 0);
  assert.ok(nativeFailure.after.ffree > 0);
  await record("actualNativeCapacityFailure", {
    copy: nativeFailure,
    capacity: await capacity(),
    product: failed,
  });
  assert.equal(
    await readFile(join(directory, "home", "valuable"), "utf8"),
    "keep private home",
  );
  assert.equal(
    await readFile(join(worktree, "value.txt"), "utf8"),
    "caller value\n",
  );
  assert.deepEqual(failed.runtime, {
    status: "failed",
    error: { code: "capacity_exhausted" },
  });
  assert.equal(
    failed.harnesses.find((binding: { ref: string }) => binding.ref === "code")
      .stage,
    "ready",
  );
  const own = JSON.parse(
    await readFile(join(directory, "attachment.json"), "utf8"),
  );
  const originalContainer = await requireCommand("docker", [
    "inspect",
    "--format",
    "{{.Id}}",
    own.container,
  ]);
  await requireCommand("docker", [
    "exec",
    originalContainer,
    "node",
    "-e",
    "const fs=require('node:fs');if(fs.readFileSync(process.env.HOME+'/valuable','utf8')!=='keep private home')process.exit(1);fs.writeFileSync('/opt/reins/harnesses/codex/value','keep completed material')",
  ]);
  await inNamespace(["mount", "-o", "remount,size=16m", capacityDirectory]);
  const enlarged = await capacity();
  assert.deepEqual(enlarged.root, initial.root);
  assert.deepEqual(enlarged.marker, initial.marker);
  assert.equal(enlarged.mount!.split(" ")[0], initial.mount!.split(" ")[0]);
  assert.equal(enlarged.fs.blocks * enlarged.fs.bsize, 16 * 1024 * 1024);
  await record("sameMountCapacityImproved", enlarged);
  const next = await accept([
    "attach",
    "--binding",
    "qoder",
    "--binding",
    "code",
  ]);
  assert.equal(next.runtime.status, "preparing");
  const ready = await observeRuntime();
  assert.equal(ready.runtime.status, "ready");
  assert.deepEqual(
    ready.preparation.attempts.map(
      (attempt: { status: string; error?: { code: string } }) => ({
        status: attempt.status,
        error: attempt.error?.code,
      }),
    ),
    [
      { status: "failed", error: "capacity_exhausted" },
      { status: "ready", error: undefined },
    ],
  );
  assert.equal(
    await requireCommand("docker", [
      "inspect",
      "--format",
      "{{.Id}}",
      own.container,
    ]),
    originalContainer,
  );
  assert.equal(
    await requireCommand("docker", [
      "exec",
      originalContainer,
      "node",
      "-e",
      "const fs=require('node:fs');console.log(fs.readFileSync('/opt/reins/harnesses/codex/value','utf8')+'|'+fs.readFileSync(process.env.HOME+'/valuable','utf8'));const b=fs.readFileSync('/opt/reins/harnesses/qoder/capacity-payload');if(b.length!==6*1024*1024||b.some(x=>x!==0x71))process.exit(1)",
    ]),
    "keep completed material|keep private home",
  );
  assert.equal(
    await readFile(join(worktree, "value.txt"), "utf8"),
    "caller value\n",
  );
  const final = await capacity();
  assert.deepEqual(final.root, initial.root);
  assert.deepEqual(final.marker, initial.marker);
  await record("sameAttemptLineageReady", {
    info: ready,
    containerId: originalContainer,
    capacity: final,
  });
  await cli(["detach", "--session-disposition", "require_none"]);
  await record("result", "passed");
} finally {
  if (stopped) process.kill(manager!.pid!, "SIGCONT");
  if (manager?.exitCode === null && manager.signalCode === null) {
    const exited = new Promise((resolve) =>
      manager!.once("close", (code, signal) => resolve({ code, signal })),
    );
    manager.kill("SIGTERM");
    await record("ownedManagerCleanup", await exited);
  }
  await record("ownedManagerStderr", managerError);
  if (helper !== undefined) {
    if (capacityDirectory !== undefined)
      await record(
        "capacityUnmount",
        await inNamespace(["umount", capacityDirectory]),
      );
    await record(
      "capacityHelperRemoval",
      await requireCommand("docker", ["rm", "-f", helper]),
    );
  }
  await record(
    "runtimeMaterialImageRemoval",
    await command("docker", ["image", "rm", materialTag]),
  );
  await record(
    "fixtureImageRemoval",
    await command("docker", ["image", "rm", imageTag]),
  );
}
