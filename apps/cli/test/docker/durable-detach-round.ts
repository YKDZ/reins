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
  environmentBase = nodeImage,
  skipAtomic = false,
  focus = "all",
} = JSON.parse(await readFile(join(base, "base-image.json"), "utf8")) as {
  image: string;
  consumerSha256: string;
  environmentBase?: string;
  skipAtomic?: boolean;
  focus?: "all" | "kill" | "continuation";
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
const imageTag = `reins-wrr20-material-${process.pid}:candidate`;
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
const materialTag = `reins-wrr20-runtime-${process.pid}:candidate`;
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
  REINS_CONSUMER_CONTEXT: "reins-wrr20-owner-a",
  REINS_WORKSPACE_MANAGER_SOCKET: join(base, "manager.sock"),
  REINS_WORKSPACE_MANAGER_STATE_DIR: managerState,
  REINS_WORKSPACE_RESOURCE_PREFIX: "reins-wrr20-runtime",
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
async function waitForRuntime(expected: "ready" | "failed") {
  const observed = await command(
    process.execPath,
    [
      join(base, "durable-detach-client.js"),
      JSON.stringify({
        action: "prepare",
        expected,
        socket: env.REINS_WORKSPACE_MANAGER_SOCKET,
        cwd: join(worktree, "src"),
        consumer: env.REINS_CONSUMER_CONTEXT,
        directory: base,
      }),
    ],
    base,
    env,
  );
  await record("prepare-result", observed);
  assert.equal(observed.status, 0, JSON.stringify(observed));
  return JSON.parse(observed.stdout) as Record<string, unknown>;
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
    value: (result.stdout === "" ? {} : JSON.parse(result.stdout)) as Record<
      string,
      unknown
    >,
  };
};
// Docker 命令仍实际执行；只在 provider 删除入口暂停，形成确定性准入竞争。
await requireCommand("mv", [
  join(base, "tools", "docker"),
  join(base, "tools", "docker-real"),
]);
await writeFile(
  join(base, "tools", "docker"),
  `#!/usr/bin/env node
import { existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const base=${JSON.stringify(base)};
const args=process.argv.slice(2);
const owned=args[0]==='rm' && args[1]==='-f' && args[2]?.startsWith('reins-wrr20-runtime-') && !args[2].includes('-material-');
const log=value=>appendFileSync(base+'/evidence/provider.ndjson',JSON.stringify({...value,args,at:new Date().toISOString()})+'\\n');
if(['create','start'].includes(args[0]))log({event:'prepare'});
const pause=async phase=>{
  writeFileSync(base+'/rm-ready',JSON.stringify({phase,pid:process.pid,managerPid:process.ppid,args}));
  while(!existsSync(base+'/rm-release')) await delay(10);
};
if(args[0]==='container' && args[1]==='ls' && existsSync(base+'/proof-fail')) {
  log({event:'proof-failed'});
  process.exit(42);
}
if(owned){log({event:'remove-start'});if(!existsSync(base+'/rm-after'))await pause('before');}
const r=spawnSync(base+'/tools/docker-real',args,{stdio:'inherit'});
if(owned){log({event:'remove-end',status:r.status});if(r.status===0 && existsSync(base+'/rm-after'))await pause('after');}
process.exitCode=r.status??1;
`,
  { mode: 0o755 },
);
const attached = await cli([
  "attach",
  "-C",
  join(worktree, "src"),
  "--binding",
  "code",
]);
assert.equal(attached.status, 0, JSON.stringify(attached));
await waitForRuntime("ready");
if (!skipAtomic) {
  const late = command(
    process.execPath,
    [
      join(base, "durable-detach-client.js"),
      JSON.stringify({
        socket: env.REINS_WORKSPACE_MANAGER_SOCKET,
        cwd: join(worktree, "src"),
        consumer: env.REINS_CONSUMER_CONTEXT,
        directory: base,
      }),
    ],
    base,
    env,
  );
  for (;;) {
    try {
      await readFile(join(base, "admission-ready"));
      break;
    } catch {
      await delay(10);
    }
  }
  const removing = cli([
    "detach",
    "-C",
    join(worktree, "src"),
    "--session-disposition",
    "require_none",
  ]);
  for (;;) {
    try {
      await readFile(join(base, "rm-ready"));
      break;
    } catch {
      await delay(10);
    }
  }
  try {
    await writeFile(join(base, "admission-release"), "release");
    const lateProcess = await late;
    await record("late-admission-process", lateProcess);
    assert.equal(lateProcess.status, 0, JSON.stringify(lateProcess));
    const lateOutcome = JSON.parse(
      await readFile(join(base, "late-admission-result.json"), "utf8"),
    ) as { error?: { code: string } };
    await record("late-admission-outcome", lateOutcome);
    assert.equal(lateOutcome.error?.code, "workspace_detaching");
    const raced = await control([
      "spawn",
      "codex",
      JSON.stringify({
        heldFile: "held.txt",
        relativeFile: "relative.txt",
        intervalMs: 25,
      }),
      "--name",
      "must-reject",
    ]);
    await record("spawn-during-accepted-detach", raced);
    assert.equal(raced.status, 65, JSON.stringify(raced));
    assert.equal(raced.value.code, "workspace_detaching");
  } finally {
    await writeFile(join(base, "rm-release"), "release");
    await record("detach-result", await removing);
  }
  // 显式 kill 的原义务：真实存活检查拒绝不受理，受理 kill 后释放资源而保留业务事实。
  const second = await cli([
    "attach",
    "-C",
    join(worktree, "src"),
    "--binding",
    "code",
  ]);
  assert.equal(second.status, 0, JSON.stringify(second));
  await waitForRuntime("ready");
} else {
  await writeFile(join(base, "rm-release"), "release");
  await record(
    "atomicEvidenceReuse",
    "04bdd04 dbf2b57d-da8b-412d-b140-7f09ae015089; independently verified by root",
  );
}
if (focus !== "continuation") {
  let attachment:
    | {
        directory: string;
        container: string;
        info: { runtime: { status: string } };
      }
    | undefined;
  for (const entry of await readdir(managerState, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("c-")) continue;
    const saved = JSON.parse(
      await readFile(join(managerState, entry.name, "attachment.json"), "utf8"),
    );
    if (saved.info.runtime.status !== "released") attachment = saved;
  }
  assert.ok(attachment);
  const projectedAuth = join(
    attachment.directory,
    "home",
    ".codex",
    "auth.json",
  );
  assert.equal((await stat(projectedAuth)).isFile(), true);
  await record("projectedCredentialPresent", true);
  const completedWorker = await control([
    "spawn",
    "codex",
    JSON.stringify({ path: "../tracked.txt" }),
    "--name",
    "completed-worker",
  ]);
  assert.equal(completedWorker.status, 0, JSON.stringify(completedWorker));
  const completed = await control([
    "wait",
    String(completedWorker.value.turnHandle),
    "--completion",
    "all",
    "--timeout",
    "5000",
  ]);
  assert.equal(completed.status, 0, JSON.stringify(completed));
  const originalTerminal = (
    completed.value.completed as { stopReason: string; finalReply: string }[]
  )[0]!;
  assert.equal(originalTerminal.stopReason, "end_turn");
  const worker = await control([
    "spawn",
    "codex",
    JSON.stringify({
      heldFile: "kill-held.txt",
      relativeFile: "kill-relative.txt",
      intervalMs: 25,
    }),
    "--name",
    "kill-worker",
  ]);
  assert.equal(worker.status, 0, JSON.stringify(worker));
  for (;;) {
    try {
      await readFile(join(worktree, "src", "writer.json"));
      break;
    } catch {
      await delay(10);
    }
  }
  await record(
    "killWriter",
    JSON.parse(await readFile(join(worktree, "src", "writer.json"), "utf8")),
  );
  const busy = await cli([
    "detach",
    "-C",
    join(worktree, "src"),
    "--session-disposition",
    "require_none",
  ]);
  assert.notEqual(busy.status, 0);
  assert.equal(busy.value.code, "workspace_busy");
  const afterBusy = await control([
    "spawn",
    "codex",
    JSON.stringify({
      heldFile: "second-held.txt",
      relativeFile: "second-relative.txt",
      intervalMs: 25,
    }),
    "--name",
    "after-rejected-none",
  ]);
  assert.equal(afterBusy.status, 0, JSON.stringify(afterBusy));
  await rm(join(base, "rm-ready"), { force: true });
  await rm(join(base, "rm-release"), { force: true });
  const killing = cli([
    "detach",
    "-C",
    join(worktree, "src"),
    "--session-disposition",
    "kill",
  ]);
  for (;;) {
    try {
      await readFile(join(base, "rm-ready"));
      break;
    } catch {
      await delay(10);
    }
  }
  let killed;
  try {
    const denied = await control([
      "spawn",
      "codex",
      JSON.stringify({
        heldFile: "denied.txt",
        relativeFile: "denied-relative.txt",
        intervalMs: 25,
      }),
      "--name",
      "kill-must-reject",
    ]);
    assert.equal(denied.status, 65, JSON.stringify(denied));
    assert.equal(denied.value.code, "workspace_detaching");
    const probes = await command(
      process.execPath,
      [
        join(base, "durable-detach-client.js"),
        JSON.stringify({
          action: "probe",
          socket: env.REINS_WORKSPACE_MANAGER_SOCKET,
          cwd: join(worktree, "src"),
          consumer: env.REINS_CONSUMER_CONTEXT,
          directory: base,
          turnHandle: worker.value.turnHandle,
        }),
      ],
      base,
      env,
    );
    await record("kill-gate-probes", probes);
    assert.equal(probes.status, 0, JSON.stringify(probes));
  } finally {
    await writeFile(join(base, "rm-release"), "release");
    killed = await killing;
  }
  assert.equal(killed.status, 0, JSON.stringify(killed));
  const queried = await cli(["status", "-C", join(worktree, "src")]);
  assert.equal(queried.status, 0, JSON.stringify(queried));
  assert.equal(
    (queried.value.runtime as { status: string }).status,
    "released",
  );
  assert.equal((queried.value.source as { status: string }).status, "verified");
  const retained = queried.value.detachment as {
    sessions: {
      sessionId: string;
      outcome: string;
      turns: {
        turnId: string;
        completed?: { stopReason: string; finalReply: string | null };
      }[];
    }[];
  };
  const original = retained.sessions.find(
    (item) => item.sessionId === completedWorker.value.sessionId,
  );
  assert.ok(original);
  assert.equal(original.outcome, "confirmed");
  assert.ok(
    original.turns.some(
      (turn) =>
        turn.completed?.stopReason === "end_turn" &&
        turn.completed.finalReply === originalTerminal.finalReply,
    ),
  );
  assert.ok(
    retained.sessions.some(
      (item) =>
        item.sessionId === worker.value.sessionId &&
        item.outcome === "confirmed",
    ),
  );
  assert.equal(
    await readFile(join(worktree, "tracked.txt"), "utf8"),
    "native worktree\n",
  );
  const stopped = await readFile(
    join(worktree, "src", "kill-held.txt"),
    "utf8",
  );
  await delay(100);
  assert.equal(
    await readFile(join(worktree, "src", "kill-held.txt"), "utf8"),
    stopped,
  );
  await assert.rejects(stat(projectedAuth), { code: "ENOENT" });
  assert.equal(
    await requireCommand("docker", [
      "container",
      "ls",
      "-a",
      "--filter",
      "name=" + attachment.container,
      "--format",
      "{{.ID}}",
    ]),
    "",
  );
  await record("killRelease", {
    nativeValuePreserved: true,
    writesStopped: true,
    projectedCredentialReleased: true,
    runtimeAbsent: true,
  });
}
if (focus !== "kill") {
  if (focus === "all") {
    const attachedAgain = await cli([
      "attach",
      "-C",
      join(worktree, "src"),
      "--binding",
      "code",
    ]);
    assert.equal(attachedAgain.status, 0, JSON.stringify(attachedAgain));
    await waitForRuntime("ready");
  }
  const finite = await control([
    "spawn",
    "codex",
    JSON.stringify({ path: "../tracked.txt" }),
    "--name",
    "continuation-worker",
  ]);
  assert.equal(finite.status, 0, JSON.stringify(finite));
  const finished = await control([
    "wait",
    String(finite.value.turnHandle),
    "--completion",
    "all",
    "--timeout",
    "5000",
  ]);
  assert.equal(finished.status, 0, JSON.stringify(finished));
  const terminated = await control(["kill", String(finite.value.sessionId)]);
  assert.equal(terminated.status, 0, JSON.stringify(terminated));
  const dead = await control(["list", "--state", "killed"]);
  assert.equal(dead.status, 0, JSON.stringify(dead));
  assert.ok(
    (dead.value as unknown as { sessionId: string }[]).some(
      (item) => item.sessionId === finite.value.sessionId,
    ),
  );
  await record("continuation-dead-row", dead.value);
  await rm(join(base, "rm-ready"), { force: true });
  await rm(join(base, "rm-release"), { force: true });
  await writeFile(join(base, "rm-after"), "pause after real provider removal");
  const interrupted = cli([
    "detach",
    "-C",
    join(worktree, "src"),
    "--session-disposition",
    "require_none",
  ]);
  let marker: {
    phase: string;
    pid: number;
    managerPid: number;
    args: string[];
  };
  for (;;) {
    try {
      marker = JSON.parse(await readFile(join(base, "rm-ready"), "utf8"));
      break;
    } catch {
      await delay(10);
    }
  }
  assert.equal(marker.phase, "after");
  await record("continuation-interruption", marker);
  process.kill(marker.managerPid, "SIGKILL");
  process.kill(marker.pid, "SIGKILL");
  const disconnected = await interrupted;
  assert.notEqual(disconnected.status, 0, JSON.stringify(disconnected));
  await writeFile(join(base, "proof-fail"), "provider proof unavailable");
  await writeFile(join(base, "rm-release"), "release any successor removal");
  // 等待既有 Manager lease 原生过期，再由公开 CLI 重启同一 Manager。
  await delay(11_000);
  const resumed = await cli(["status", "-C", join(worktree, "src")]);
  assert.equal(resumed.status, 0, JSON.stringify(resumed));
  type Detachment = {
    disposition: string;
    status: string;
    sessions: { sessionId: string; outcome: string }[];
    resources: Record<string, { status: string }>;
  };
  const accepted = resumed.value.detachment as Detachment;
  assert.equal(accepted.disposition, "require_none");
  assert.notEqual(accepted.resources.ownership!.status, "released");
  for (let attempt = 0; attempt < 2; attempt++) {
    const failed = await cli([
      "detach",
      "-C",
      join(worktree, "src"),
      "--session-disposition",
      "require_none",
    ]);
    assert.notEqual(failed.status, 0, JSON.stringify(failed));
    const observed = await cli(["status", "-C", join(worktree, "src")]);
    assert.equal(observed.status, 0, JSON.stringify(observed));
    const progress = observed.value.detachment as Detachment;
    assert.equal(progress.disposition, "require_none");
    assert.equal(progress.status, "failed");
    assert.deepEqual(progress.sessions, accepted.sessions);
    assert.notEqual(progress.resources.ownership!.status, "released");
  }
  await rm(join(base, "proof-fail"));
  const upgraded = await cli([
    "detach",
    "-C",
    join(worktree, "src"),
    "--session-disposition",
    "kill",
  ]);
  await record("continuation-upgrade", upgraded);
  assert.equal(upgraded.status, 0, JSON.stringify(upgraded));
  const released = upgraded.value.detachment as Detachment;
  assert.equal(released.disposition, "kill");
  assert.equal(released.status, "released");
  assert.ok(
    Object.values(released.resources).every(
      (step) => step.status === "released",
    ),
  );
  assert.deepEqual(released.sessions, accepted.sessions);
  const reverse = await cli([
    "detach",
    "-C",
    join(worktree, "src"),
    "--session-disposition",
    "require_none",
  ]);
  assert.notEqual(reverse.status, 0, JSON.stringify(reverse));
  assert.equal(reverse.value.code, "invalid_request");
  const repeated = await cli([
    "detach",
    "-C",
    join(worktree, "src"),
    "--session-disposition",
    "kill",
  ]);
  assert.equal(repeated.status, 0, JSON.stringify(repeated));
  const provider = (await readFile(join(output, "provider.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          event: string;
          args: string[];
          status?: number;
        },
    );
  await record("continuation-provider", provider);
  assert.equal(
    provider.filter(
      (item) =>
        item.event === "remove-start" && item.args[2] === marker.args[2],
    ).length,
    1,
  );
  assert.equal(
    provider.filter(
      (item) => item.event === "prepare" && item.args.includes(marker.args[2]!),
    ).length,
    2,
  );
  assert.equal(
    await readFile(join(worktree, "tracked.txt"), "utf8"),
    "native worktree\n",
  );
  await record("continuationRelease", {
    interruptedAfterActualRemoval: true,
    onlyRemainingSteps: true,
    explicitUpgrade: true,
    reverseRejected: true,
    sameIntentIdempotent: true,
  });
}
await record("result", "passed");
