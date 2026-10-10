import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const base = process.cwd();
const output = join(base, "evidence");
await mkdir(output, { recursive: true });
const nodeImage =
  "node@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";
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
await requireCommand(
  "npm",
  ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
  join(base, "consumer"),
);
const installed = join(base, "consumer", "node_modules", "@ykdz", "reins");
const context = join(base, "image-context");
await mkdir(context);
// 直接将独立消费者的安装树作为 build context，避免在慢文件系统逐文件再复制一遍。
await writeFile(
  join(base, ".dockerignore"),
  "tools/docker\ntools/docker-native\ncandidate.tgz\nevidence\n",
);
await writeFile(
  join(context, "codex"),
  '#!/usr/bin/env node\nconst fs=require("node:fs"),path=require("node:path");const timer=setInterval(()=>{if(fs.existsSync(path.resolve("../.reins/allow-version"))){clearInterval(timer);console.log("codex-cli 0.149.0")}},25);\n',
  { mode: 0o755 },
);
await writeFile(
  join(context, "Dockerfile"),
  `FROM ${nodeImage}\nCOPY tools /usr/local/bin\nCOPY consumer/node_modules /opt/reins/node_modules\nCOPY consumer/node_modules/@ykdz/reins/dist /opt/reins/dist\nCOPY codex-adapter.ts /opt/reins/codex-adapter.ts\nCOPY image-context/codex /opt/reins/harnesses/codex/bin/codex\nENV REINS_ADAPTERS_MODULE=/opt/reins/codex-adapter.ts\n`,
);
const imageTag = `reins-wrr02-material-${process.pid}:candidate`;
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
  runtimes: [{ harness: "codex", version: "0.149.0", image }],
  bindings: [{ ref: "code", harness: "codex" }],
};
await writeFile(
  join(worktree, ".reins", "workspace.json"),
  JSON.stringify(configuration),
);
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
  REINS_CONSUMER_CONTEXT: "reins-wrr02-owner-a",
  REINS_WORKSPACE_MANAGER_SOCKET: join(base, "manager.sock"),
  REINS_WORKSPACE_MANAGER_STATE_DIR: managerState,
  REINS_WORKSPACE_RESOURCE_PREFIX: "reins-wrr02-runtime",
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
try {
  const catalog = await cli(["harnesses", "-C", join(worktree, "src")]);
  assert.equal(catalog.status, 0);
  const attachment = cli([
    "attach",
    "-C",
    join(worktree, "src"),
    "--binding",
    "code",
  ]);
  let preparing;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const observed = await cli(["status", "-C", join(worktree, "src")]);
    if (observed.status === 0) {
      preparing = observed;
      break;
    }
    assert.equal(observed.value.code, "attachment_not_found");
    await delay(25);
  }
  assert.equal(
    (preparing?.value.runtime as { status: string } | undefined)?.status,
    "preparing",
  );
  await writeFile(
    join(worktree, ".reins", "allow-version"),
    "explicit fixture barrier release\n",
  );
  const attached = await attachment;
  assert.equal(attached.status, 0, JSON.stringify(attached));
  assert.equal((attached.value.runtime as { status: string }).status, "ready");
  assert.equal(attached.value.cwd, join(worktree, "src"));
  const forbidden = await cli(["status", "-C", worktree], {
    REINS_CONSUMER_CONTEXT: "reins-wrr02-owner-b",
  });
  assert.equal(forbidden.status, 1);
  assert.equal(forbidden.value.code, "attachment_owned");
  const queried = await cli(["status", "-C", join(worktree, "src")]);
  assert.equal(queried.status, 0);
  assert.equal((queried.value.runtime as { status: string }).status, "ready");
  const containers = (
    await requireCommand("docker", [
      "ps",
      "-q",
      "--filter",
      "label=reins.workspace.managed=true",
    ])
  )
    .split("\n")
    .filter(Boolean);
  assert.equal(containers.length, 1);
  const container = containers[0]!;
  const repeated = await cli([
    "attach",
    "-C",
    join(worktree, "src"),
    "--binding",
    "code",
  ]);
  assert.equal(repeated.status, 0);
  assert.equal((repeated.value.runtime as { status: string }).status, "ready");
  assert.equal(
    await requireCommand("docker", [
      "ps",
      "-q",
      "--filter",
      "label=reins.workspace.managed=true",
    ]),
    container,
  );
  const sessions = await requireCommand("docker", [
    "exec",
    "--env",
    `REINS_CONSUMER_CONTEXT=${env.REINS_CONSUMER_CONTEXT}`,
    container,
    "node",
    "/opt/reins/dist/reins.js",
    "list",
  ]);
  await record("readySessions", JSON.parse(sessions));
  assert.deepEqual(JSON.parse(sessions), []);
  const privateHome = await requireCommand("docker", [
    "exec",
    container,
    "node",
    "-e",
    "const fs=require('node:fs');console.log(JSON.stringify({home:process.env.HOME,codexHome:process.env.CODEX_HOME,unselectedInstructions:fs.existsSync(process.env.CODEX_HOME+'/AGENTS.md')}))",
  ]);
  const homeFacts = JSON.parse(privateHome) as {
    home: string;
    codexHome: string;
    unselectedInstructions: boolean;
  };
  await record("privateHome", homeFacts);
  assert.notEqual(homeFacts.home, callerHome);
  assert.notEqual(homeFacts.codexHome, env.CODEX_HOME);
  assert.equal(homeFacts.unselectedInstructions, false);
  await record(
    "container",
    JSON.parse(await requireCommand("docker", ["inspect", container])),
  );
  const gitDir = await requireCommand(
    "git",
    ["rev-parse", "--absolute-git-dir"],
    worktree,
  );
  const commonDir = resolve(
    worktree,
    await requireCommand("git", ["rev-parse", "--git-common-dir"], worktree),
  );
  for (const path of [
    join(worktree, "tracked.txt"),
    join(worktree, ".git"),
    gitDir,
    commonDir,
  ]) {
    const actual = await requireCommand("docker", [
      "exec",
      container,
      "node",
      "-e",
      "const s=require('node:fs').statSync(process.argv[1],{bigint:true});console.log(JSON.stringify({dev:String(s.dev),ino:String(s.ino)}))",
      path,
    ]);
    const expected = await stat(path, { bigint: true });
    assert.deepEqual(JSON.parse(actual), {
      dev: String(expected.dev),
      ino: String(expected.ino),
    });
    await record("nativeIdentity", { path, actual: JSON.parse(actual) });
  }
  await requireCommand("docker", [
    "exec",
    container,
    "node",
    "-e",
    "const f=require('node:fs');f.writeFileSync(process.env.HOME+'/writable','private');console.log(process.env.HOME)",
  ]);
  const runtimeProcesses = await requireCommand("docker", ["top", container]);
  await record("readyProcesses", runtimeProcesses);
  assert.match(runtimeProcesses, /reins-daemon/u);
  assert.doesNotMatch(runtimeProcesses, /codex app-server/u);
  await rename(worktree, `${worktree}-original`);
  const movedForeign = await cli(
    ["attach", "-C", `${worktree}-original`, "--binding", "code"],
    { REINS_CONSUMER_CONTEXT: "reins-wrr02-owner-b" },
  );
  assert.equal(movedForeign.status, 1);
  assert.equal(movedForeign.value.code, "attachment_owned");
  const movedOwner = await cli([
    "attach",
    "-C",
    `${worktree}-original`,
    "--binding",
    "code",
  ]);
  assert.equal(movedOwner.status, 1);
  assert.equal(movedOwner.value.code, "native_view_mismatch");
  await mkdir(worktree);
  await requireCommand("git", ["init", "--quiet"], worktree);
  const replacement = await cli(["status", "-C", worktree]);
  assert.equal(replacement.status, 1);
  assert.equal(replacement.value.code, "native_view_mismatch");
  await rm(worktree, { recursive: true });
  await rename(`${worktree}-original`, worktree);
  const detached = await cli([
    "detach",
    "-C",
    worktree,
    "--session-disposition",
    "require_none",
  ]);
  assert.equal(detached.status, 0, JSON.stringify(detached));
  assert.equal(
    (detached.value.runtime as { status: string }).status,
    "released",
  );
  assert.equal(
    await requireCommand("docker", [
      "ps",
      "-aq",
      "--filter",
      "label=reins.workspace.managed=true",
    ]),
    "",
  );
  assert.equal(
    await readFile(join(worktree, "tracked.txt"), "utf8"),
    "native worktree\n",
  );
  configuration.runtimes[0]!.version = "9.9.9";
  await writeFile(
    join(worktree, ".reins", "workspace.json"),
    JSON.stringify(configuration),
  );
  const mismatch = await cli([
    "attach",
    "-C",
    join(worktree, "src"),
    "--binding",
    "code",
  ]);
  assert.equal(mismatch.status, 1);
  assert.equal(mismatch.value.code, "runtime_entry_invalid");
  const failed = await cli(["status", "-C", worktree]);
  assert.equal(failed.status, 0);
  assert.equal((failed.value.runtime as { status: string }).status, "failed");
  const failedDetached = await cli([
    "detach",
    "-C",
    worktree,
    "--session-disposition",
    "require_none",
  ]);
  assert.equal(failedDetached.status, 0);
  assert.equal(
    (failedDetached.value.runtime as { status: string }).status,
    "released",
  );
  assert.equal(
    await requireCommand("docker", [
      "ps",
      "-aq",
      "--filter",
      "label=reins.workspace.managed=true",
    ]),
    "",
  );
  await record("result", "passed");
} finally {
  // 平台还会在场景外按新增资源清单兜底；这里只收尾本场景显式创建的镜像。
  await record(
    "fixtureImageRemoval",
    await command("docker", ["image", "rm", imageTag]),
  );
}
