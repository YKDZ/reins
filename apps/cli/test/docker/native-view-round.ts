import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  copyFile,
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
  fault?: "move" | "replace" | "remove" | "split" | "session-cwd-replace";
};
const expectUndetected =
  process.env.REINS_WRR09_EXPECT_UNDETECTED === "1" &&
  fault === "session-cwd-replace";
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
if (fault === "session-cwd-replace" && !expectUndetected) {
  const daemon = join(payload, "opt", "reins", "dist", "reins-daemon.js");
  const originalDaemon = join(
    payload,
    "opt",
    "reins",
    "dist",
    "reins-daemon-original.js",
  );
  await copyFile(daemon, originalDaemon);
  await rm(daemon);
  await copyFile(join(base, "restart-supervisor.ts"), daemon);
  await record("supervisedDaemonPayload", {
    originalSha256: createHash("sha256")
      .update(await readFile(originalDaemon))
      .digest("hex"),
    supervisorSha256: createHash("sha256")
      .update(await readFile(daemon))
      .digest("hex"),
    meaning:
      "Test supervisor restarts original distribution daemon bytes after SIGKILL; it does not stop orphaned sessions",
  });
}
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
if (fault === "session-cwd-replace") await mkdir(join(worktree, "other"));
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
let splitHelper: string | undefined;
let splitMounted = false;
let orphanWriter: { container: string; pid: string } | undefined;
const splitEnter = [
  "nsenter",
  "--target",
  "1",
  "--mount",
  "--root=/proc/1/root",
  "--wd=/",
];
const cleanupOrphanWriter = async () => {
  if (orphanWriter === undefined) return;
  const { container, pid } = orphanWriter;
  const result = await command(
    "docker",
    [
      "exec",
      "-w",
      "/",
      container,
      "node",
      "-e",
      "const fs=require('node:fs'),pid=Number(process.argv[1]),read=()=>{try{const value=fs.readFileSync('/proc/'+pid+'/stat','utf8');return value.slice(value.lastIndexOf(')')+2).split(' ')[0]}catch(e){if(e.code==='ENOENT')return 'absent';throw e}};try{process.kill(pid,'SIGTERM')}catch(e){if(e.code!=='ESRCH')throw e};(async()=>{let state=read();for(let i=0;i<80&&!['absent','Z','X'].includes(state);i++){await new Promise(r=>setTimeout(r,25));state=read()}console.log(JSON.stringify({pid,state}));if(!['absent','Z','X'].includes(state))process.exitCode=1})().catch(e=>{console.error(e);process.exitCode=1})",
      pid,
    ],
    base,
  );
  await record("fixture-orphan-writer-cleanup", result);
  if (result.status !== 0) {
    const running = await command(
      "docker",
      ["inspect", "--format", "{{.State.Running}}", container],
      base,
    );
    await record("fixture-orphan-container-state", running);
    assert.equal(running.stdout, "false", JSON.stringify({ result, running }));
  }
  orphanWriter = undefined;
};
try {
  const attachmentCwd =
    fault === "session-cwd-replace" ? worktree : join(worktree, "src");
  const attached = await cli([
    "attach",
    "-C",
    attachmentCwd,
    "--binding",
    "code",
  ]);
  if (attached.status !== 0) {
    const containers = await command(
      "docker",
      ["ps", "-aq", "--filter", "name=reins-wrr09-runtime-"],
      base,
    );
    await record("runtime-start-failure-containers", containers);
    for (const container of containers.stdout.split("\n").filter(Boolean)) {
      const [state, logs] = await Promise.all([
        command(
          "docker",
          ["inspect", "--format", "{{json .State}}", container],
          base,
        ),
        command("docker", ["logs", "--tail", "100", container], base),
      ]);
      await record("runtime-start-failure-diagnostics", {
        container,
        state,
        logs,
      });
    }
  }
  assert.equal(attached.status, 0, JSON.stringify(attached));
  await waitForRuntime("ready");
  const message = JSON.stringify({
    heldFile: "held.txt",
    relativeFile: "relative.txt",
    intervalMs: 25,
  });
  const originalSpawnArgs = [
    "spawn",
    "codex",
    message,
    "--name",
    "original-writer",
  ];
  let secondarySpawned: Awaited<ReturnType<typeof control>> | undefined;
  let spawned: Awaited<ReturnType<typeof control>>;
  if (fault === "session-cwd-replace") {
    [spawned, secondarySpawned] = await Promise.all([
      control(originalSpawnArgs),
      control(
        ["spawn", "codex", message, "--name", "secondary-writer"],
        join(worktree, "other"),
      ),
    ]);
    assert.equal(spawned.status, 0, JSON.stringify(spawned));
    assert.equal(secondarySpawned.status, 0, JSON.stringify(secondarySpawned));
  } else {
    spawned = await control(originalSpawnArgs);
    assert.equal(spawned.status, 0, JSON.stringify(spawned));
  }
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
  let secondaryWriter: Record<string, unknown> | undefined;
  if (secondarySpawned !== undefined) {
    for (;;) {
      try {
        secondaryWriter = JSON.parse(
          await readFile(join(worktree, "other", "writer.json"), "utf8"),
        );
        break;
      } catch {
        await delay(25);
      }
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
  if (fault === "session-cwd-replace" && !expectUndetected)
    orphanWriter = { container: originalContainer, pid: String(writer.pid) };
  const processState = async (attempts = 0, pid = writer.pid) =>
    JSON.parse(
      await requireCommand("docker", [
        "exec",
        "-w",
        "/",
        originalContainer,
        "node",
        "-e",
        "const fs=require('node:fs');const read=()=>{try{const s=fs.readFileSync('/proc/'+process.argv[1]+'/stat','utf8');return s.slice(s.lastIndexOf(')')+2).split(' ')[0]}catch(e){if(e.code!=='ENOENT')throw e;return 'absent'}};(async()=>{let state=read();for(let i=0;i<Number(process.argv[2])&&!['absent','Z','X'].includes(state);i++){await new Promise(r=>setTimeout(r,250));state=read()}console.log(JSON.stringify({state}))})().catch(e=>{console.error(e);process.exitCode=1})",
        String(pid),
        String(attempts),
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
    if (secondarySpawned !== undefined) {
      const secondaryProcess = await processState(0, secondaryWriter!.pid);
      assert.ok(!["absent", "Z", "X"].includes(secondaryProcess.state));
      const killed = await control([
        "kill",
        String(secondarySpawned.value.sessionId),
      ]);
      assert.equal(killed.status, 0, JSON.stringify(killed));
      const stoppedSecondary = await processState(40, secondaryWriter!.pid);
      assert.ok(["absent", "Z", "X"].includes(stoppedSecondary.state));
      await rm(join(worktree, "other"), { recursive: true });
      const afterKill = await cli(["status", "-C", join(worktree, "src")]);
      assert.equal(afterKill.status, 0, JSON.stringify(afterKill));
      assert.equal(
        (afterKill.value.runtime as { status: string }).status,
        "ready",
      );
      const afterKillGrowth = {
        held: (await held.stat()).size,
        relative: (await relative.stat()).size,
      };
      await delay(150);
      assert.ok((await held.stat()).size > afterKillGrowth.held);
      assert.ok((await relative.stat()).size > afterKillGrowth.relative);
      await record("secondary-session-kill-and-cwd-removal", {
        sessionId: secondarySpawned.value.sessionId,
        writer: secondaryWriter,
        processBeforeKill: secondaryProcess,
        kill: killed.value,
        processAfterKill: stoppedSecondary,
        survivingWriter: {
          pid: writer.pid,
          cwd: writer.cwd,
          heldGrowth: (await held.stat()).size - afterKillGrowth.held,
          relativeGrowth:
            (await relative.stat()).size - afterKillGrowth.relative,
        },
      });
      if (fault === "session-cwd-replace" && !expectUndetected) {
        const daemonProcess = async () =>
          JSON.parse(
            await requireCommand("docker", [
              "exec",
              originalContainer,
              "cat",
              "/tmp/reins-daemon-process.json",
            ]),
          ) as { pid: number; startedAt: string };
        const oldDaemon = await daemonProcess();
        await record("daemon-before-ungraceful-restart", oldDaemon);
        await requireCommand("docker", [
          "exec",
          originalContainer,
          "node",
          "-e",
          "process.kill(Number(process.argv[1]), 'SIGKILL')",
          String(oldDaemon.pid),
        ]);
        const stoppedDaemon = await processState(40, oldDaemon.pid);
        assert.ok(["absent", "Z", "X"].includes(stoppedDaemon.state));
        let newDaemon = oldDaemon;
        for (let attempt = 0; attempt < 200; attempt++) {
          await delay(25);
          newDaemon = await daemonProcess();
          if (
            newDaemon.pid !== oldDaemon.pid &&
            newDaemon.startedAt !== oldDaemon.startedAt
          )
            break;
        }
        assert.notEqual(newDaemon.pid, oldDaemon.pid);
        assert.notEqual(newDaemon.startedAt, oldDaemon.startedAt);
        await requireCommand("docker", [
          "exec",
          originalContainer,
          "node",
          "-e",
          'const net=require("node:net"),socket=process.env.REINS_SOCKET;(async()=>{for(let i=0;i<400;i++){const ok=await new Promise(r=>{const c=net.createConnection(socket);c.once("connect",()=>{c.end();r(true)});c.once("error",()=>r(false))});if(ok){console.log("daemon socket ready");return}await new Promise(r=>setTimeout(r,25))}throw new Error("daemon socket did not return")})().catch(e=>{console.error(e);process.exitCode=1})',
        ]);
        const restarted = await cli(["status", "-C", join(worktree, "src")]);
        assert.equal(restarted.status, 0, JSON.stringify(restarted));
        assert.equal(
          (restarted.value.runtime as { status: string }).status,
          "ready",
        );
        assert.equal(
          (restarted.value.source as { status: string }).status,
          "verified",
        );
        assert.deepEqual((await control(["list"])).value, []);
        const survivingProcess = await processState(0);
        assert.ok(!["absent", "Z", "X"].includes(survivingProcess.state));
        const beforeRestartGrowth = {
          held: (await held.stat()).size,
          relative: (await relative.stat()).size,
        };
        await delay(150);
        const afterRestartGrowth = {
          held: (await held.stat()).size,
          relative: (await relative.stat()).size,
        };
        assert.ok(afterRestartGrowth.held > beforeRestartGrowth.held);
        assert.ok(afterRestartGrowth.relative > beforeRestartGrowth.relative);
        await record("daemon-restart-keeps-original-writer", {
          oldDaemon,
          stoppedDaemon,
          newDaemon,
          emptyNewGenerationList: true,
          source: restarted.value.source,
          originalWriter: survivingProcess,
          growth: {
            held: afterRestartGrowth.held - beforeRestartGrowth.held,
            relative:
              afterRestartGrowth.relative - beforeRestartGrowth.relative,
          },
        });
      }
    }
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
      const passiveProcess = await processState(40);
      passiveStopped = ["absent", "Z", "X"].includes(passiveProcess.state);
      const originalHeldContent = await held.readFile("utf8");
      const relativeErrorObserved = originalHeldContent.includes(
        '"relativeError":"ENOENT"',
      );
      if (!passiveStopped) assert.ok(relativeErrorObserved);
      await record("remove-without-caller-action", {
        originalContainer,
        pid: writer.pid,
        originalRoot,
        originalGitDir,
        process: passiveProcess,
        stopped: passiveStopped,
        relativeError: relativeErrorObserved ? "ENOENT" : undefined,
        before: removedSizes,
        after: {
          held: (await held.stat()).size,
          relative: (await relative.stat()).size,
        },
      });
    } else if (fault === "split") {
      const other = join(worktree, ".split-B");
      await requireCommand(
        "git",
        ["worktree", "add", "--quiet", "--detach", other, "HEAD"],
        git,
      );
      await mkdir(join(other, "src"));
      const otherRoot = await nativeIdentity(other);
      assert.notDeepEqual(otherRoot, originalRoot);
      splitHelper = await requireCommand("docker", [
        "run",
        "-d",
        "--name",
        `reins-wrr09-split-helper-${process.pid}`,
        "--pull=never",
        "--network=none",
        "--privileged",
        `--pid=container:${originalContainer}`,
        "--entrypoint",
        "sleep",
        nodeImage,
        "infinity",
      ]);
      await requireCommand("docker", [
        "exec",
        splitHelper,
        ...splitEnter,
        "mount",
        "--bind",
        other,
        worktree,
      ]);
      splitMounted = true;
      const outerRoot = await nativeIdentity(worktree);
      const inner = JSON.parse(
        await requireCommand("docker", [
          "exec",
          "-w",
          "/",
          originalContainer,
          "node",
          "-e",
          "const fs=require('node:fs');const id=p=>{const s=fs.statSync(p,{bigint:true});return {dev:String(s.dev),ino:String(s.ino)}};let cwd;try{cwd=id('/proc/'+process.argv[2]+'/cwd')}catch(e){if(e.code!=='ENOENT')throw e}console.log(JSON.stringify({root:id(process.argv[1]),cwd,mountNamespace:fs.readlinkSync('/proc/self/ns/mnt')}))",
          worktree,
          String(writer.pid),
        ]),
      ) as { root: { dev: string; ino: string }; cwd?: unknown };
      assert.deepEqual(outerRoot, originalRoot);
      assert.deepEqual(inner.root, otherRoot);
      if (inner.cwd !== undefined) {
        const originalCwd = writer.cwdIdentity as { dev: number; ino: number };
        assert.deepEqual(inner.cwd, {
          dev: String(originalCwd.dev),
          ino: String(originalCwd.ino),
        });
      }
      const runtime = JSON.parse(
        await requireCommand("docker", [
          "inspect",
          "--format",
          "{{json .}}",
          originalContainer,
        ]),
      ) as {
        Id: string;
        RestartCount: number;
        State: { Running: boolean };
        HostConfig: { Privileged: boolean; PidMode: string };
      };
      assert.equal(runtime.Id, originalContainer);
      assert.equal(runtime.RestartCount, 0);
      assert.equal(runtime.State.Running, true);
      assert.equal(runtime.HostConfig.Privileged, false);
      await record("split-original-runtime", {
        originalContainer,
        pid: writer.pid,
        outerRoot,
        otherRoot,
        inner,
        runtime: {
          id: runtime.Id,
          restartCount: runtime.RestartCount,
          running: runtime.State.Running,
          privileged: runtime.HostConfig.Privileged,
          pidMode: runtime.HostConfig.PidMode,
        },
      });
    } else if (fault === "move" || fault === "replace") {
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
    let movedSessionCwd: string | undefined;
    if (fault === "session-cwd-replace") {
      movedSessionCwd = join(worktree, "moved-src");
      await rename(join(worktree, "src"), movedSessionCwd);
      await mkdir(join(worktree, "src"));
      const originalCwd = writer.cwdIdentity as { dev: number; ino: number };
      const replacementCwd = await nativeIdentity(join(worktree, "src"));
      assert.notDeepEqual(replacementCwd, {
        dev: String(originalCwd.dev),
        ino: String(originalCwd.ino),
      });
    }
    const target = fault === "move" ? moved : worktree;
    const expectedLoss =
      fault === "session-cwd-replace"
        ? { reason: "unreachable" }
        : fault === "replace"
          ? { reason: "replaced" }
          : fault === "remove"
            ? { reason: "removed" }
            : fault === "split"
              ? { reason: "split" }
              : { reason: "moved", currentRoot: moved };
    const attempted = await control(
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
    if (expectUndetected) {
      assert.equal(attempted.status, 0, JSON.stringify(attempted));
      assert.equal(attempted.value.code, undefined);
      const stillRunning = await processState();
      assert.ok(!["absent", "Z", "X"].includes(stillRunning.state));
      const continued = {
        held: (await held.stat()).size,
        relative: (await relative.stat()).size,
      };
      await delay(150);
      assert.ok((await held.stat()).size > continued.held);
      assert.ok((await relative.stat()).size > continued.relative);
      await record("session-cwd-replacement-undetected", {
        originalContainer,
        pid: writer.pid,
        writer,
        movedSessionCwd,
        replacementCwd: join(worktree, "src"),
        originalSessionStillRunning: stillRunning,
        replacementSpawn: attempted.value,
      });
      const killedOriginal = await control([
        "kill",
        String(spawned.value.sessionId),
      ]);
      assert.equal(killedOriginal.status, 0, JSON.stringify(killedOriginal));
      const killedReplacement = await control([
        "kill",
        String(attempted.value.sessionId),
      ]);
      assert.equal(
        killedReplacement.status,
        0,
        JSON.stringify(killedReplacement),
      );
      const cleanedProcess = await processState(40);
      assert.ok(["absent", "Z", "X"].includes(cleanedProcess.state));
      await record("session-cwd-replacement-red-cleanup", {
        original: killedOriginal.value,
        replacement: killedReplacement.value,
        originalProcess: cleanedProcess,
      });
    }
    if (!expectUndetected) {
      assert.equal(attempted.status, 65, JSON.stringify(attempted));
      const rejected = attempted;
      const detected = {
        held: (await held.stat()).size,
        relative: (await relative.stat()).size,
      };
      const unknownAfterRestart =
        fault === "session-cwd-replace" && !expectUndetected;
      const originalProcess = await processState(unknownAfterRestart ? 0 : 40);
      const stopped = ["absent", "Z", "X"].includes(originalProcess.state);
      const sizesAfterDetection = {
        held: (await held.stat()).size,
        relative: (await relative.stat()).size,
      };
      let stable: boolean | undefined;
      let continued: { heldGrowth: number; relativeGrowth: number } | undefined;
      if (unknownAfterRestart) {
        assert.ok(!stopped);
        await delay(150);
        const current = {
          held: (await held.stat()).size,
          relative: (await relative.stat()).size,
        };
        continued = {
          heldGrowth: current.held - sizesAfterDetection.held,
          relativeGrowth: current.relative - sizesAfterDetection.relative,
        };
        assert.ok(continued.heldGrowth > 0);
        assert.ok(continued.relativeGrowth > 0);
      } else {
        await delay(1000);
        stable =
          sizesAfterDetection.held === (await held.stat()).size &&
          sizesAfterDetection.relative === (await relative.stat()).size;
      }
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
        after: sizesAfterDetection,
        stable,
        continued,
      });
      if (fault === "remove")
        assert.equal(
          passiveStopped,
          true,
          "Original writer must stop after actual removal without a new caller action",
        );
      if (unknownAfterRestart) {
        assert.equal(
          stopped,
          false,
          "The replacement daemon cannot prove the old writer stopped",
        );
      } else {
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
      }
      assert.equal(rejected.value.code, "native_view_lost");
      assert.deepEqual(rejected.value.nativeView, expectedLoss);
      let lost: Awaited<ReturnType<typeof cli>> | undefined;
      for (let attempt = 0; attempt < 40; attempt++) {
        lost = await cli(["status", "-C", join(target, "src")]);
        assert.equal(lost.status, 0);
        const source = lost.value.source as {
          termination?: { status: string };
        };
        if (source.termination?.status !== "stopping") break;
        await delay(25);
      }
      assert.ok(lost);
      const source = lost.value.source as {
        status: string;
        error: { code: string; nativeView: unknown };
        termination: {
          status: string;
          via?: string;
          sessions: { sessionId: string; outcome: string }[];
        };
      };
      assert.equal(source.status, "failed");
      assert.equal(source.error.code, "native_view_lost");
      assert.deepEqual(source.error.nativeView, expectedLoss);
      assert.equal(
        source.termination.status,
        unknownAfterRestart ? "unknown" : "stopped",
      );
      if (!unknownAfterRestart) assert.equal(source.termination.via, "harness");
      assert.deepEqual(
        source.termination.sessions.toSorted((left, right) =>
          left.sessionId.localeCompare(right.sessionId),
        ),
        unknownAfterRestart
          ? [
              {
                sessionId: String(spawned.value.sessionId),
                outcome: "unknown",
              },
            ]
          : [
              {
                sessionId: String(spawned.value.sessionId),
                outcome: "confirmed",
              },
              ...(secondarySpawned === undefined
                ? []
                : [
                    {
                      sessionId: String(secondarySpawned.value.sessionId),
                      outcome: "confirmed",
                    },
                  ]),
            ].toSorted((left, right) =>
              left.sessionId.localeCompare(right.sessionId),
            ),
      );
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
      if (unknownAfterRestart) {
        assert.equal(terminal.status, 65, JSON.stringify(terminal));
        assert.equal(terminal.value.code, "session_not_found");
      } else {
        assert.equal(terminal.status, 3, JSON.stringify(terminal));
        assert.equal(
          (terminal.value.completed as { stopReason: string }[])[0]!.stopReason,
          "killed",
        );
      }
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
      await record("original-stop-facts", {
        source,
        terminal: terminal.value,
        outcome: unknownAfterRestart
          ? "daemon cannot prove the orphaned writer stopped"
          : "original session kill confirmed",
      });
      if (unknownAfterRestart) await cleanupOrphanWriter();
    }
  } finally {
    await held.close();
    await relative.close();
  }
  await record("result", "passed");
} finally {
  await cleanupOrphanWriter();
  if (splitHelper !== undefined) {
    if (splitMounted) {
      const unmount = await command("docker", [
        "exec",
        splitHelper,
        ...splitEnter,
        "umount",
        worktree,
      ]);
      await record("splitUnmount", unmount);
      assert.equal(unmount.status, 0);
    }
    const removed = await command("docker", ["rm", "-f", splitHelper]);
    await record("splitHelperRemoval", removed);
    assert.equal(removed.status, 0);
  }
  // 保留本票同一 Engine 的 build cache；最终由公开 platform destroy 回收。
  await record("fixtureImageCleanupOwner", {
    owner: "test-platform",
    images: [image, runtimeImage],
  });
}
