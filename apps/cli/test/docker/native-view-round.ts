import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const base = process.cwd();
const output = join(base, "evidence");
await mkdir(output, { recursive: true });
const {
  image: nodeImage,
  consumerSha256,
  fault = "move",
} = JSON.parse(await readFile(join(base, "base-image.json"), "utf8")) as {
  image: string;
  consumerSha256: string;
  fault?: "move" | "replace" | "remove";
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
  join(payload, "opt", "reins", "native-view-adapter.ts"),
  await readFile(join(base, "native-view-adapter.ts")),
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
await writeFile(
  join(context, "Dockerfile"),
  `FROM ${nodeImage}\nCOPY image-context/payload /\nENV REINS_ADAPTERS_MODULE=/opt/reins/native-view-adapter.ts\n`,
);
const imageTag = `reins-wrr09-material-${process.pid}:candidate`;
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
const materialTag = `reins-wrr09-runtime-${process.pid}:candidate`;
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
  runtimes: [{ harness: "codex", version: "0.149.0", image: runtimeImage }],
  bindings: [{ ref: "code", harness: "codex" }],
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
const env = {
  HOME: callerHome,
  CODEX_HOME: join(callerHome, ".codex"),
  REINS_CONSUMER_CONTEXT: "reins-wrr09-owner-a",
  REINS_WORKSPACE_MANAGER_SOCKET: join(base, "manager.sock"),
  REINS_WORKSPACE_MANAGER_STATE_DIR: managerState,
  REINS_WORKSPACE_RESOURCE_PREFIX: "reins-wrr09-runtime",
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
    value: JSON.parse(result.stdout) as Record<string, unknown>,
  };
};
async function waitForRuntime(expected: "ready" | "failed") {
  for (;;) {
    const observed = await cli(["status", "-C", join(worktree, "src")]);
    assert.equal(observed.status, 0);
    const runtime = observed.value.runtime as {
      status: string;
      error?: { code: string };
    };
    if (runtime.status === expected) return runtime;
    assert.equal(runtime.status, "preparing", JSON.stringify(observed));
    await delay(500);
  }
}
const control = async (args: string[], cwd = join(worktree, "src")) => {
  const result = await command(
    process.execPath,
    [join(installed, "dist", "reins.js"), ...args],
    cwd,
    env,
  );
  await record("control " + args.join(" "), result);
  return {
    ...result,
    value: JSON.parse(result.stdout) as Record<string, unknown>,
  };
};
try {
  const attached = await cli([
    "attach",
    "-C",
    join(worktree, "src"),
    "--binding",
    "code",
  ]);
  assert.equal(attached.status, 0, JSON.stringify(attached));
  await waitForRuntime("ready");
  const message = JSON.stringify({
    heldFile: "held.txt",
    relativeFile: "relative.txt",
    intervalMs: 25,
  });
  const spawned = await control([
    "spawn",
    "codex",
    message,
    "--name",
    "original-writer",
  ]);
  assert.equal(spawned.status, 0, JSON.stringify(spawned));
  let writer: Record<string, unknown>;
  for (;;) {
    try {
      writer = JSON.parse(
        await readFile(join(worktree, "src", "writer.json"), "utf8"),
      );
      break;
    } catch {
      await delay(25);
    }
  }
  const containers = (
    await requireCommand("docker", [
      "ps",
      "--filter",
      "name=reins-wrr09-runtime-",
      "--format",
      "{{.ID}}",
    ])
  )
    .split("\n")
    .filter(Boolean);
  assert.equal(containers.length, 1);
  const originalContainer = await requireCommand("docker", [
    "inspect",
    "--format",
    "{{.Id}}",
    containers[0]!,
  ]);
  const processState = async () =>
    JSON.parse(
      await requireCommand("docker", [
        "exec",
        "-w",
        "/",
        originalContainer,
        "node",
        "-e",
        "const fs=require('node:fs');try{const s=fs.readFileSync('/proc/'+process.argv[1]+'/stat','utf8');console.log(JSON.stringify({state:s.slice(s.lastIndexOf(')')+2).split(' ')[0]}))}catch(e){if(e.code!=='ENOENT')throw e;console.log(JSON.stringify({state:'absent'}))}",
        String(writer.pid),
      ]),
    ) as { state: string };
  const initialProcess = await processState();
  assert.ok(!["absent", "Z", "X"].includes(initialProcess.state));
  const held = await open(join(worktree, "src", "held.txt"), "r");
  const relative = await open(join(worktree, "src", "relative.txt"), "r");
  try {
    await delay(200);
    const before = { held: await held.stat(), relative: await relative.stat() };
    await writeFile(
      join(worktree, "src", "ordinary.txt"),
      "normal caller edit\n",
    );
    const normal = await cli(["status", "-C", join(worktree, "src")]);
    assert.equal(normal.status, 0);
    assert.equal((normal.value.runtime as { status: string }).status, "ready");
    await delay(150);
    assert.ok((await held.stat()).size > before.held.size);
    assert.ok((await relative.stat()).size > before.relative.size);
    if (fault === "remove") {
      const beforeDrift = {
        held: (await held.stat()).size,
        relative: (await relative.stat()).size,
      };
      await writeFile(
        join(worktree, ".reins", "workspace.json"),
        JSON.stringify({
          ...configuration,
          environments: [
            { provider: "docker", image: `sha256:${"0".repeat(64)}` },
          ],
        }),
      );
      const drift = await cli(["status", "-C", join(worktree, "src")]);
      assert.equal(drift.status, 0);
      assert.equal(
        (drift.value.definition as { status: string }).status,
        "drifted",
      );
      assert.equal((drift.value.runtime as { status: string }).status, "ready");
      assert.equal(
        (drift.value.source as { status: string }).status,
        "verified",
      );
      await delay(150);
      const afterDrift = {
        held: (await held.stat()).size,
        relative: (await relative.stat()).size,
      };
      assert.ok(afterDrift.held > beforeDrift.held);
      assert.ok(afterDrift.relative > beforeDrift.relative);
      await record("definition-drift-original-writer", {
        originalContainer,
        pid: writer.pid,
        before: beforeDrift,
        after: afterDrift,
        status: drift.value,
      });
    }
    const nativeIdentity = async (path: string) => {
      const value = await stat(path, { bigint: true });
      return { dev: String(value.dev), ino: String(value.ino) };
    };
    const originalRoot = await nativeIdentity(worktree);
    const originalHead = await requireCommand(
      "git",
      ["rev-parse", "HEAD"],
      worktree,
    );
    const moved = join(base, "moved-worktree");
    let movedRoot: { dev: string; ino: string } | undefined;
    let passiveStopped: boolean | undefined;
    if (fault === "remove") {
      const originalGitDir = await requireCommand(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-dir"],
        worktree,
      );
      await requireCommand(
        "git",
        ["worktree", "remove", "--force", worktree],
        git,
      );
      await assert.rejects(stat(worktree), { code: "ENOENT" });
      await assert.rejects(stat(originalGitDir), { code: "ENOENT" });
      const removedSizes = {
        held: (await held.stat()).size,
        relative: (await relative.stat()).size,
      };
      let passiveProcess = await processState();
      for (
        let attempt = 0;
        attempt < 40 && !["absent", "Z", "X"].includes(passiveProcess.state);
        attempt++
      ) {
        await delay(250);
        passiveProcess = await processState();
      }
      passiveStopped = ["absent", "Z", "X"].includes(passiveProcess.state);
      await record("remove-without-caller-action", {
        originalContainer,
        pid: writer.pid,
        originalRoot,
        originalGitDir,
        process: passiveProcess,
        stopped: passiveStopped,
        before: removedSizes,
        after: {
          held: (await held.stat()).size,
          relative: (await relative.stat()).size,
        },
      });
    } else {
      await rename(worktree, moved);
      movedRoot = await nativeIdentity(moved);
      assert.deepEqual(movedRoot, originalRoot);
    }
    let replacementRoot: { dev: string; ino: string } | undefined;
    if (fault === "replace") {
      await requireCommand("git", ["worktree", "repair", moved], git);
      await requireCommand(
        "git",
        ["worktree", "add", "--quiet", "--detach", worktree, "HEAD"],
        git,
      );
      await mkdir(join(worktree, "src"));
      await mkdir(join(worktree, ".reins"));
      await writeFile(
        join(worktree, ".reins", "workspace.json"),
        JSON.stringify(configuration),
      );
      replacementRoot = await nativeIdentity(worktree);
      assert.notDeepEqual(replacementRoot, originalRoot);
      assert.equal(
        await requireCommand("git", ["rev-parse", "HEAD"], worktree),
        originalHead,
      );
    }
    const target = fault === "move" ? moved : worktree;
    const expectedLoss =
      fault === "replace"
        ? { reason: "replaced" }
        : fault === "remove"
          ? { reason: "removed" }
          : { reason: "moved", currentRoot: moved };
    const rejected = await control(
      fault === "remove"
        ? [
            "-C",
            join(target, "src"),
            "send",
            String(spawned.value.turnHandle),
            message,
            "--placement",
            "active_turn",
          ]
        : [
            "-C",
            join(target, "src"),
            "spawn",
            "codex",
            message,
            "--name",
            "must-reject",
          ],
      base,
    );
    assert.equal(rejected.status, 65, JSON.stringify(rejected));
    const detected = {
      held: (await held.stat()).size,
      relative: (await relative.stat()).size,
    };
    let originalProcess = await processState();
    for (
      let attempt = 0;
      attempt < 40 && !["absent", "Z", "X"].includes(originalProcess.state);
      attempt++
    ) {
      await delay(250);
      originalProcess = await processState();
    }
    const stopped = ["absent", "Z", "X"].includes(originalProcess.state);
    const stoppedSizes = {
      held: (await held.stat()).size,
      relative: (await relative.stat()).size,
    };
    await delay(1000);
    const stable =
      stoppedSizes.held === (await held.stat()).size &&
      stoppedSizes.relative === (await relative.stat()).size;
    await record(`${fault}-original-writer`, {
      originalRoot,
      movedRoot,
      replacementRoot,
      originalHead,
      writer,
      originalContainer,
      initialProcess,
      originalProcess,
      stopped,
      spawn: spawned.value,
      rejection: rejected.value,
      before: detected,
      after: {
        held: (await held.stat()).size,
        relative: (await relative.stat()).size,
      },
      stable,
    });
    if (fault === "remove")
      assert.equal(
        passiveStopped,
        true,
        "Original writer must stop after actual removal without a new caller action",
      );
    assert.equal(
      stopped,
      true,
      "Original writer process must stop after native view loss is detected",
    );
    assert.equal(
      stable,
      true,
      "Original held-FD and cwd-relative writer must stop after native view loss is detected",
    );
    assert.equal(rejected.value.code, "native_view_lost");
    assert.deepEqual(rejected.value.nativeView, expectedLoss);
    const lost = await cli(["status", "-C", join(target, "src")]);
    assert.equal(lost.status, 0);
    const source = lost.value.source as {
      status: string;
      error: { code: string; nativeView: unknown };
      termination: { status: string; via: string; sessions: unknown[] };
    };
    assert.equal(source.status, "failed");
    assert.equal(source.error.code, "native_view_lost");
    assert.deepEqual(source.error.nativeView, expectedLoss);
    assert.deepEqual(source.termination, {
      status: "stopped",
      via: "harness",
      sessions: [{ sessionId: spawned.value.sessionId, outcome: "confirmed" }],
    });
    const terminal = await control(
      [
        "-C",
        join(target, "src"),
        "wait",
        String(spawned.value.turnHandle),
        "--completion",
        "all",
        "--timeout",
        "0",
      ],
      base,
    );
    assert.equal(terminal.status, 3, JSON.stringify(terminal));
    assert.equal(
      (terminal.value.completed as { stopReason: string }[])[0]!.stopReason,
      "killed",
    );
    if (fault === "replace") {
      for (const name of ["held.txt", "relative.txt", "writer.json"])
        await assert.rejects(readFile(join(worktree, "src", name)), {
          code: "ENOENT",
        });
      assert.equal(
        await readFile(join(worktree, "tracked.txt"), "utf8"),
        "native worktree\n",
      );
    }
    await record("original-stop-facts", { source, terminal: terminal.value });
  } finally {
    await held.close();
    await relative.close();
  }
  await record("result", "passed");
} finally {
  // 保留本票同一 Engine 的 build cache；最终由公开 platform destroy 回收。
  await record("fixtureImageCleanupOwner", {
    owner: "test-platform",
    images: [image, runtimeImage],
  });
}
