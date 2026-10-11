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
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
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
  join(base, "restart-client.js"),
  join(installed, "restart-client.js"),
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
  join(payload, "opt", "reins", "restart-replacement-adapter.ts"),
  await readFile(join(base, "restart-replacement-adapter.ts")),
);
await writeFile(
  join(payload, "opt", "reins", "restart-replacement-worker.ts"),
  await readFile(join(base, "restart-replacement-worker.ts")),
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
await record("supervisedDaemonPayload", {
  originalSha256: createHash("sha256")
    .update(
      await readFile(join(payload, "opt", "reins", "dist", "reins-daemon.js")),
    )
    .digest("hex"),
  supervisorSha256: createHash("sha256")
    .update(await readFile(join(base, "restart-supervisor.ts")))
    .digest("hex"),
  meaning:
    "Test deployment supervisor runs original distribution daemon bytes; no automatic task replay",
});
await copyFile(
  join(payload, "opt", "reins", "dist", "reins-daemon.js"),
  join(payload, "opt", "reins", "dist", "reins-daemon-original.js"),
);
await copyFile(
  join(base, "restart-supervisor.ts"),
  join(payload, "opt", "reins", "dist", "reins-daemon.js"),
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
    ? `FROM ${nodeImage}\nCOPY payload /\nENV REINS_ADAPTERS_MODULE=/opt/reins/restart-replacement-adapter.ts\n`
    : `FROM ${fixtureBaseImage}\nCOPY payload/opt/reins /opt/reins\n`,
);
const imageTag = `reins-wrr21-material-${process.pid}:candidate`;
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
const materialTag = `reins-wrr21-runtime-${process.pid}:candidate`;
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
  REINS_CONSUMER_CONTEXT: "reins-wrr21-owner-a",
  REINS_WORKSPACE_MANAGER_SOCKET: join(base, "manager.sock"),
  REINS_WORKSPACE_MANAGER_STATE_DIR: managerState,
  REINS_WORKSPACE_RESOURCE_PREFIX: "reins-wrr21-runtime",
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
    if (observed.status !== 0 && observed.value.code === "manager_timeout") {
      await record("readOnlyStatusTimeout", observed.value);
      await delay(2000);
      continue;
    }
    assert.equal(observed.status, 0);
    const runtime = observed.value.runtime as {
      status: string;
      error?: { code: string };
    };
    if (runtime.status === expected) return runtime;
    assert.equal(runtime.status, "preparing", JSON.stringify(observed));
    await delay(2000);
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
const cwd = join(worktree, "src");
await writeFile(
  join(cwd, "target.txt"),
  "original source survives runtime restart\n",
);
const attached = await cli(["attach", "-C", cwd, "--binding", "code"]);
assert.equal(attached.status, 0, JSON.stringify(attached));
await waitForRuntime("ready");
const container = await requireCommand("docker", [
  "ps",
  "-q",
  "--filter",
  "name=reins-wrr21-runtime-",
]);
assert.match(container, /^[a-f0-9]{12}$/u);
const inspected = async () =>
  JSON.parse(
    await requireCommand("docker", [
      "inspect",
      "--format",
      "{{json .}}",
      container,
    ]),
  ) as {
    Id: string;
    State: { Pid: number; StartedAt: string; Running: boolean };
  };
const daemon = async () =>
  JSON.parse(
    await requireCommand("docker", [
      "exec",
      container,
      "cat",
      "/tmp/reins-daemon-process.json",
    ]),
  ) as { pid: number; startedAt: string };
const starts = async () =>
  (await readFile(join(cwd, "worker-starts.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          pid: number;
          cwd: string;
          message: string;
          content: string;
        },
    );
const workerState = async (pid: number) =>
  await requireCommand("docker", [
    "exec",
    container,
    "node",
    "-e",
    "const fs=require('node:fs');try{const v=fs.readFileSync('/proc/'+process.argv[1]+'/stat','utf8');console.log(v.slice(v.lastIndexOf(')')+2).split(' ')[0])}catch(e){if(e.code!=='ENOENT')throw e;console.log('absent')}",
    String(pid),
  ]);
const held = spawn(
  process.execPath,
  [join(installed, "restart-client.js"), cwd],
  { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"] },
);
const lines = createInterface({ input: held.stdout })[Symbol.asyncIterator]();
const admission = async (name: string) => {
  held.stdin.write(
    JSON.stringify({ name, message: JSON.stringify({ path: "target.txt" }) }) +
      "\n",
  );
  const line = await lines.next();
  assert.equal(line.done, false);
  return JSON.parse(line.value!) as {
    result?: unknown;
    error?: { code: string };
  };
};
try {
  assert.ok((await admission("before-restarts")).result);
  for (const kind of ["daemon", "container"] as const) {
    const preservedSource = await readFile(join(cwd, "target.txt"), "utf8");
    await rm(join(cwd, "active-writer.json"), { force: true });
    const oldMessage = JSON.stringify({ path: "target.txt", hold: true });
    const original = await control([
      "spawn",
      "codex",
      oldMessage,
      "--name",
      `original-${kind}`,
    ]);
    assert.equal(original.status, 0, JSON.stringify(original));
    let writer: { pid: number };
    for (;;) {
      try {
        writer = JSON.parse(
          await readFile(join(cwd, "active-writer.json"), "utf8"),
        );
        break;
      } catch {
        await delay(25);
      }
    }
    const oldContainer = await inspected();
    const oldDaemon = await daemon();
    const originalWorker = await workerState(writer.pid);
    assert.ok(!["absent", "Z", "X"].includes(originalWorker));
    if (kind === "daemon")
      await requireCommand("docker", [
        "exec",
        container,
        "node",
        "-e",
        "process.kill(Number(process.argv[1]), 'SIGTERM')",
        String(oldDaemon.pid),
      ]);
    else await requireCommand("docker", ["restart", container]);
    let newDaemon: Awaited<ReturnType<typeof daemon>>;
    for (;;) {
      newDaemon = await daemon();
      if (newDaemon.startedAt !== oldDaemon.startedAt) break;
      await delay(25);
    }
    await requireCommand("docker", [
      "exec",
      container,
      "node",
      "-e",
      'const net=require("node:net");(async()=>{for(;;){const ok=await new Promise(r=>{const c=net.createConnection(process.env.REINS_SOCKET);c.once("connect",()=>{c.end();r(true)});c.once("error",()=>r(false))});if(ok)break;await new Promise(r=>setTimeout(r,25))}console.log("daemon socket ready")})()',
    ]);
    const newContainer = await inspected();
    assert.equal(
      await readFile(join(cwd, "target.txt"), "utf8"),
      preservedSource,
    );
    assert.equal(newContainer.Id, oldContainer.Id);
    if (kind === "daemon") {
      assert.equal(newContainer.State.Pid, oldContainer.State.Pid);
      assert.equal(newContainer.State.StartedAt, oldContainer.State.StartedAt);
    } else
      assert.notEqual(
        newContainer.State.StartedAt,
        oldContainer.State.StartedAt,
      );
    const actualWorker = await workerState(writer.pid);
    assert.ok(
      ["absent", "Z", "X"].includes(actualWorker),
      "Original worker process must actually stop",
    );
    const writesBefore = await readFile(join(cwd, "old-writes.txt"), "utf8");
    await delay(150);
    assert.equal(
      await readFile(join(cwd, "old-writes.txt"), "utf8"),
      writesBefore,
    );
    const oldReference = await control([
      "send",
      String(original.value.sessionId),
      "The caller explicitly targets the old identity",
      "--placement",
      "new_turn",
    ]);
    assert.equal(oldReference.status, 65, JSON.stringify(oldReference));
    assert.equal(oldReference.value.code, "session_not_found");
    const oldTurn = await control([
      "wait",
      String(original.value.turnHandle),
      "--completion",
      "all",
      "--timeout",
      "0",
    ]);
    assert.equal(oldTurn.status, 65, JSON.stringify(oldTurn));
    const after = await cli(["status", "-C", cwd]);
    assert.equal(after.status, 0, JSON.stringify(after));
    assert.equal((after.value.runtime as { status: string }).status, "ready");
    assert.equal((after.value.source as { status: string }).status, "verified");
    assert.equal(after.value.cwd, cwd);
    assert.deepEqual((await control(["list"])).value, []);
    assert.equal(
      (await starts()).filter((item) => item.message === oldMessage).length,
      kind === "daemon" ? 1 : 2,
    );
    const newContent = `caller edit after ${kind} restart\n`;
    await writeFile(join(cwd, "target.txt"), newContent);
    const newMessage = JSON.stringify({
      path: "target.txt",
      output: `replacement-${kind}.txt`,
    });
    const replacement = await control([
      "spawn",
      "codex",
      newMessage,
      "--name",
      `replacement-${kind}`,
    ]);
    assert.equal(replacement.status, 0, JSON.stringify(replacement));
    assert.notEqual(replacement.value.sessionId, original.value.sessionId);
    const completed = await control([
      "wait",
      String(replacement.value.turnHandle),
      "--completion",
      "all",
    ]);
    assert.equal(completed.status, 0, JSON.stringify(completed));
    const reply = JSON.parse(
      (completed.value.completed as { finalReply: string }[])[0]!.finalReply,
    ) as { cwd: string; message: string; content: string };
    assert.deepEqual(
      { cwd: reply.cwd, message: reply.message, content: reply.content },
      { cwd, message: newMessage, content: newContent },
    );
    assert.equal(
      await readFile(join(cwd, `replacement-${kind}.txt`), "utf8"),
      newContent,
    );
    await record(`${kind}-restart-replacement`, {
      oldContainer,
      newContainer,
      oldDaemon,
      newDaemon,
      original: original.value,
      originalWorker,
      actualWorker,
      originalTurnResult: oldTurn.value,
      originalTaskOutcome: "unknown_after_control_loss",
      nativeProcess: "stopped",
      revalidated: after.value,
      replacement: replacement.value,
      completed: completed.value,
      noAutomaticReplay: true,
    });
  }
  // 同一公开共享客户端连接先取得准入；随后入口材料失效，旧 ready 事实必须失效。
  assert.ok((await admission("before-loss")).result);
  const executable = "/opt/reins/harnesses/codex/bin/codex";
  const originalBytes = await requireCommand("docker", [
    "exec",
    container,
    "cat",
    executable,
  ]);
  await requireCommand("docker", [
    "exec",
    container,
    "node",
    "-e",
    "require('node:fs').writeFileSync(process.argv[1], '#!/usr/bin/env node\\nconsole.log(\"codex-cli 0.0.0\");\\n')",
    executable,
  ]);
  const rejected = await admission("must-reject-stale-admission");
  await record("stale-binding-admission", rejected);
  assert.equal(rejected.error?.code, "runtime_entry_invalid");
  await requireCommand("docker", [
    "exec",
    container,
    "node",
    "-e",
    "require('node:fs').writeFileSync(process.argv[1],process.argv[2]+'\\n')",
    executable,
    originalBytes,
  ]);
  const retry = await cli(["attach", "-C", cwd, "--binding", "code"]);
  assert.equal(retry.status, 0, JSON.stringify(retry));
  await waitForRuntime("ready");
  await rename(worktree, join(base, "moved-worktree"));
  const sourceLoss = await admission("must-reject-invalid-view");
  await record("stale-native-view-admission", sourceLoss);
  assert.equal(sourceLoss.error?.code, "native_view_lost");
} finally {
  held.stdin.end();
  await new Promise<void>((resolve) => held.once("close", () => resolve()));
}
await record("result", "passed");
