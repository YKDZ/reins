import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const base = process.cwd();
const output = join(base, "evidence");
await mkdir(output, { recursive: true });
const { image: nodeImage, independentUse } = JSON.parse(
  await readFile(join(base, "base-image.json"), "utf8"),
) as { image: string; independentUse?: boolean };
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
  '#!/usr/bin/env node\nimport fs from "node:fs";import path from "node:path";const timer=setInterval(()=>{if(fs.existsSync(path.resolve("../.reins/allow-version"))){clearInterval(timer);const version=path.resolve("../.reins/fixture-version");console.log("codex-cli "+(fs.existsSync(version)?fs.readFileSync(version,"utf8").trim():"0.149.0"))}},25);\n',
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
  await readFile(join(base, "workspace-reading-worker.ts")),
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
await writeFile(
  join(context, "Dockerfile"),
  `FROM ${nodeImage}\nCOPY image-context/payload /\nENV REINS_ADAPTERS_MODULE=/opt/reins/workspace-reading-adapter.ts\n`,
);
const imageTag = `reins-wrr08-material-${process.pid}:candidate`;
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
const materialTag = `reins-wrr08-runtime-${process.pid}:candidate`;
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
  REINS_CONSUMER_CONTEXT: "reins-wrr08-owner-a",
  REINS_WORKSPACE_MANAGER_SOCKET: join(base, "manager.sock"),
  REINS_WORKSPACE_MANAGER_STATE_DIR: managerState,
  REINS_WORKSPACE_RESOURCE_PREFIX: "reins-wrr08-runtime",
  REINS_CODEX_AUTH_BINDINGS: JSON.stringify({
    login: join(base, "selected-auth.json"),
    broken: join(base, "broken-auth.json"),
  }),
};
await writeFile(
  join(base, "selected-auth.json"),
  JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: "fixture-id",
      access_token: "fixture-selected-access",
      refresh_token: "fixture-refresh",
      account_id: "fixture-account",
    },
    unselected: "must not be projected",
  }),
);
await writeFile(join(base, "broken-auth.json"), "not a login document");
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
  await writeFile(
    join(worktree, "src", "target.txt"),
    "caller selected real source\n",
  );
  const catalog = await cli(["harnesses", "-C", join(worktree, "src")]);
  assert.equal(catalog.status, 0);
  const accepted = await cli([
    "attach",
    "-C",
    join(worktree, "src"),
    "--binding",
    "code",
  ]);
  assert.equal(accepted.status, 0);
  const premature = await control([
    "spawn",
    "codex",
    JSON.stringify({ path: "target.txt" }),
    "--name",
    "not-ready",
  ]);
  assert.equal(premature.status, 65, JSON.stringify(premature));
  assert.equal(premature.value.code, "workspace_not_ready");
  await writeFile(
    join(worktree, ".reins", "allow-version"),
    "caller releases local material check\n",
  );
  await waitForRuntime("ready");
  const container = await requireCommand("docker", [
    "ps",
    "-q",
    "--filter",
    "label=reins.workspace.managed=true",
  ]);
  assert.match(container, /^[a-f0-9]{12}$/u);
  assert.equal(
    await requireCommand("docker", [
      "exec",
      container,
      "node",
      "-e",
      "const fs=require('node:fs');if(fs.existsSync(process.env.CODEX_HOME+'/auth.json')||fs.existsSync(process.env.CODEX_HOME+'/AGENTS.md'))process.exit(1);console.log('omitted credential stayed absent')",
    ]),
    "omitted credential stayed absent",
  );
  const message = JSON.stringify({ path: "target.txt" });
  const capabilities = await control(["capabilities"]);
  assert.equal(capabilities.status, 0, JSON.stringify(capabilities));
  assert.deepEqual((await control(["list"])).value, []);
  await assert.rejects(readFile(join(worktree, "src", ".worker-started")), {
    code: "ENOENT",
  });
  const unselected = await control([
    "spawn",
    "qoder",
    message,
    "--name",
    "unselected",
  ]);
  assert.equal(unselected.status, 65, JSON.stringify(unselected));
  assert.equal(unselected.value.code, "binding_unknown");
  await assert.rejects(readFile(join(worktree, "src", ".worker-started")), {
    code: "ENOENT",
  });
  const first = await control([
    "-C",
    join(worktree, "src"),
    "spawn",
    "codex",
    message,
    "--name",
    "reader-one",
  ]);
  assert.equal(first.status, 0, JSON.stringify(first));
  assert.equal(first.value.cwd, join(worktree, "src"));
  assert.equal(typeof first.value.sessionId, "string");
  assert.equal(typeof first.value.turnHandle, "string");
  const waited = await control([
    "wait",
    String(first.value.turnHandle),
    "--completion",
    "all",
  ]);
  assert.equal(waited.status, 0, JSON.stringify(waited));
  const completed = (waited.value.completed as { finalReply: string }[])[0]!;
  const actual = JSON.parse(completed.finalReply);
  assert.equal(actual.cwd, join(worktree, "src"));
  assert.equal(actual.content, "caller selected real source\n");
  assert.equal(actual.message, message);
  assert.deepEqual(actual.options, {});
  const second = await control([
    "-C",
    worktree,
    "spawn",
    "codex",
    message,
    "--name",
    "reader-two",
    "--cwd",
    join(worktree, "src"),
  ]);
  assert.equal(second.status, 0, JSON.stringify(second));
  assert.equal(second.value.cwd, join(worktree, "src"));
  assert.notEqual(second.value.sessionId, first.value.sessionId);
  assert.notEqual(second.value.turnHandle, first.value.turnHandle);
  const secondWait = await control([
    "wait",
    String(second.value.turnHandle),
    "--completion",
    "all",
  ]);
  assert.equal(secondWait.status, 0, JSON.stringify(secondWait));
  const secondActual = JSON.parse(
    (secondWait.value.completed as { finalReply: string }[])[0]!.finalReply,
  );
  assert.equal(secondActual.cwd, join(worktree, "src"));
  assert.equal(secondActual.content, "caller selected real source\n");
  const killed = await control(["kill", String(first.value.sessionId)]);
  assert.equal(killed.status, 0, JSON.stringify(killed));
  assert.equal(
    await requireCommand("docker", [
      "ps",
      "-q",
      "--filter",
      "label=reins.workspace.managed=true",
    ]),
    container,
  );
  const still = await control(["list"]);
  assert.equal(still.status, 0);
  const repeated = await cli([
    "attach",
    "-C",
    join(worktree, "src"),
    "--binding",
    "code",
  ]);
  assert.equal(repeated.status, 0);
  assert.equal(
    await requireCommand("docker", [
      "ps",
      "-q",
      "--filter",
      "label=reins.workspace.managed=true",
    ]),
    container,
  );
  await control(["kill", String(second.value.sessionId)]);
  const changed = {
    ...configuration,
    environments: [{ provider: "docker", image: `sha256:${"b".repeat(64)}` }],
  };
  await writeFile(
    join(worktree, ".reins", "workspace.json"),
    JSON.stringify(changed),
  );
  const drift = await cli(["status", "-C", join(worktree, "src")]);
  assert.equal(drift.status, 0, JSON.stringify(drift));
  assert.deepEqual(drift.value.definition, {
    status: "drifted",
    attached: configuration.environments[0],
    current: changed.environments[0],
  });
  assert.equal(
    await requireCommand("docker", [
      "ps",
      "-q",
      "--filter",
      "label=reins.workspace.managed=true",
    ]),
    container,
  );
  assert.equal(
    await readFile(join(worktree, "src", "target.txt"), "utf8"),
    "caller selected real source\n",
  );
  const sdk = await command(
    process.execPath,
    [
      join(base, "workspace-client.js"),
      JSON.stringify({
        socket: env.REINS_WORKSPACE_MANAGER_SOCKET,
        cwd: join(worktree, "src"),
        consumer: env.REINS_CONSUMER_CONTEXT,
        message,
      }),
    ],
    base,
  );
  await record("shared-client", sdk);
  assert.equal(sdk.status, 0, JSON.stringify(sdk));
  // 同一真实 provider 接缝覆盖支持包的最小投影与反例，厂商在线调用另行实测。
  for (const scenario of [
    {
      name: "selected",
      credential: "login",
      version: "0.162.0",
      expected: "ready",
    },
    {
      name: "unknown",
      credential: "not-configured",
      version: "0.162.0",
      expected: "credential_binding_unavailable",
    },
    {
      name: "malformed",
      credential: "broken",
      version: "0.162.0",
      expected: "credential_binding_unavailable",
    },
    {
      name: "wrong-material",
      credential: "login",
      version: "0.161.0",
      expected: "runtime_entry_invalid",
    },
  ]) {
    const root = join(base, `auth-${scenario.name}`),
      cwd = join(root, "src");
    await mkdir(cwd, { recursive: true });
    await requireCommand("git", ["init", "--quiet"], root);
    await mkdir(join(root, ".reins"));
    await writeFile(
      join(root, ".reins", "workspace.json"),
      JSON.stringify({
        environments: configuration.environments,
        runtimes: [
          { harness: "codex", version: "0.162.0", image: runtimeImage },
        ],
        bindings: [
          {
            ref: "code",
            harness: "codex",
            credentialBindingRef: scenario.credential,
          },
        ],
      }),
    );
    await writeFile(join(root, ".reins", "allow-version"), "ready");
    await writeFile(join(root, ".reins", "fixture-version"), scenario.version);
    assert.equal(
      (await cli(["attach", "-C", cwd, "--binding", "code"])).status,
      0,
    );
    for (;;) {
      const observed = await cli(["status", "-C", cwd]);
      const runtime = observed.value.runtime as {
        status: string;
        error?: { code: string };
      };
      if (runtime.status === "preparing") {
        await delay(100);
        continue;
      }
      if (scenario.expected === "ready") {
        assert.equal(runtime.status, "ready", JSON.stringify(observed));
        const selectedContainer = await requireCommand("docker", [
          "ps",
          "-q",
          "--filter",
          `label=reins.workspace.managed=true`,
        ]);
        const candidates = selectedContainer
          .split("\n")
          .filter((id) => id !== container);
        assert.equal(candidates.length, 1);
        assert.equal(
          await requireCommand("docker", [
            "exec",
            candidates[0]!,
            "node",
            "-e",
            "const fs=require('node:fs'),path=process.env.CODEX_HOME,login=JSON.parse(fs.readFileSync(path+'/auth.json','utf8'));if(login.tokens.access_token!=='fixture-selected-access'||'unselected' in login||JSON.stringify(fs.readdirSync(path))!=='[\"auth.json\"]'||(fs.statSync(path+'/auth.json').mode&511)!==384)process.exit(1);const probe=process.env.HOME+'/write-probe';fs.writeFileSync(probe,'ok');fs.unlinkSync(probe);console.log('selected login only; private home writable')",
          ]),
          "selected login only; private home writable",
        );
      } else {
        assert.equal(runtime.status, "failed");
        assert.equal(
          runtime.error?.code,
          scenario.expected,
          JSON.stringify(observed),
        );
        const rejected = await control(
          [
            "spawn",
            "codex",
            "caller task",
            "--name",
            `rejected-${scenario.name}`,
          ],
          cwd,
        );
        assert.equal(rejected.status, 65);
        assert.equal(rejected.value.code, "workspace_not_ready");
      }
      break;
    }
    const detached = await cli([
      "detach",
      "-C",
      cwd,
      "--session-disposition",
      "require_none",
    ]);
    assert.equal(detached.status, 0, JSON.stringify(detached));
  }
  if (independentUse) {
    const deployment = {
      cli: join(installed, "dist", "reins.js"),
      cwd: join(worktree, "src"),
      targetFile: join(worktree, "src", "target.txt"),
      launcher: env,
      completionFile: join(base, "independent-use-done"),
      messageFormat: { path: "target.txt" },
    };
    await record("independent-use-ready", deployment);
    process.stdout.write(
      JSON.stringify({ kind: "independent-use-ready", ...deployment }) + "\n",
    );
    for (;;) {
      try {
        await readFile(deployment.completionFile);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await delay(500);
    }
  }
  await record("result", "passed");
} finally {
  await record(
    "fixtureImageRemoval",
    await command("docker", ["image", "rm", imageTag, materialTag]),
  );
}
