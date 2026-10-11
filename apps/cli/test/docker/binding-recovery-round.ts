import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const base = process.cwd();
const output = join(base, "evidence");
await mkdir(output, { recursive: true });
const { image: nodeImage, fixtureImage } = JSON.parse(
  await readFile(join(base, "base-image.json"), "utf8"),
) as { image: string; fixtureImage?: string };
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
  '#!/usr/bin/env node\nimport fs from "node:fs";import path from "node:path";const kind=path.basename(process.argv[1])==="codex"?"codex":"qoder";console.log(kind==="codex"?"codex-cli 0.162.0":"qoder-cli 1.1.23");\n',
  { mode: 0o755 },
);
// 硬链接组装同文件系统内的夹具 payload，避免重复复制消费者依赖及逐 COPY 层提交。
const payload = join(context, "payload");
await mkdir(join(payload, "opt", "reins", "harnesses", "codex", "bin"), {
  recursive: true,
});
// 精确缓存环境已有相同的依赖和原生工具；新发行 dist 始终覆盖旧产品代码。
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
  join(payload, "opt", "reins", "workspace-binding-adapter.ts"),
  await readFile(join(base, "workspace-binding-adapter.ts")),
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
  'console.log("1.1.23");\n',
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
await writeFile(
  join(payload, "opt", "reins", "workspace-binding-worker.ts"),
  await readFile(join(base, "workspace-binding-worker.ts")),
);
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
  "codex-cli 0.162.0",
);
await writeFile(join(preflight, ".reins", "qoder-valid"), "fixture check");
assert.equal(
  await requireCommand(
    join(payload, "opt", "reins", "harnesses", "qoder", "bin", "qoderclicn"),
    ["--version"],
    join(preflight, "src"),
  ),
  "qoder-cli 1.1.23",
);
await writeFile(
  join(context, "Dockerfile"),
  `FROM ${fixtureImage ?? nodeImage}\nCOPY image-context/payload /\nENV REINS_ADAPTERS_MODULE=/opt/reins/workspace-binding-adapter.ts\n`,
);
const imageTag = `reins-wrr12-material-${process.pid}:candidate`;
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
await writeFile(
  join(worktree, "src", "target.txt"),
  "caller selected binding task\n",
);
const configuration = {
  environments: [{ provider: "docker", image }],
  runtimes: [
    { harness: "codex", version: "0.162.0", image: runtimeImage },
    { harness: "qoder", version: "1.1.23", image: runtimeImage },
  ],
  bindings: [
    { ref: "code", harness: "codex", credentialBindingRef: "codex-login" },
    { ref: "qoder", harness: "qoder", credentialBindingRef: "qoder-login" },
  ] as { ref: string; harness: string; credentialBindingRef?: string }[],
};
const config = async () =>
  writeFile(
    join(worktree, ".reins", "workspace.json"),
    JSON.stringify(configuration),
  );
await config();
const codexSource = join(base, "selected-codex.json");
const qoderSource = join(base, "selected-qoder-user");
const machineSource = join(base, "selected-qoder-machine");
const nativeSources = [codexSource, qoderSource, machineSource];
const validCodex = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    id_token: "fixture-id",
    access_token: "fixture-codex-valid",
    refresh_token: "fixture-refresh",
    account_id: "fixture-account",
  },
  unselected: "must not project",
});
await writeFile(codexSource, validCodex);
await writeFile(qoderSource, "");
await writeFile(machineSource, "fixture-machine");
const env = {
  REINS_CONSUMER_CONTEXT: "reins-wrr12-owner",
  REINS_WORKSPACE_MANAGER_SOCKET: join(base, "manager.sock"),
  REINS_WORKSPACE_MANAGER_STATE_DIR: join(base, "manager-state"),
  REINS_WORKSPACE_RESOURCE_PREFIX: "reins-wrr12-runtime",
  REINS_CODEX_AUTH_BINDINGS: JSON.stringify({ "codex-login": codexSource }),
  REINS_QODER_AUTH_BINDINGS: JSON.stringify({
    "qoder-login": { userFile: qoderSource, machineIdFile: machineSource },
  }),
};
let manager: ReturnType<typeof spawn> | undefined;
let keeper: ReturnType<typeof spawn> | undefined;
const cwd = join(worktree, "src");
async function startManager() {
  manager = spawn(
    process.execPath,
    [join(installed, "dist", "reins-workspace-manager.js")],
    { env: { ...process.env, ...env }, stdio: "ignore" },
  );
  for (;;) {
    try {
      await access(env.REINS_WORKSPACE_MANAGER_SOCKET);
      break;
    } catch {
      assert.equal(manager.exitCode, null);
      await delay(25);
    }
  }
  // 调用间持有同一公开 client，避免无 attachment 时 owned Manager 空闲退出。
  keeper = spawn(
    process.execPath,
    [
      join(base, "workspace-attach-client.js"),
      JSON.stringify({
        socket: env.REINS_WORKSPACE_MANAGER_SOCKET,
        cwd,
        consumer: env.REINS_CONSUMER_CONTEXT,
        keepAlive: true,
      }),
    ],
    { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  const connected = await new Promise<string>((resolve, reject) => {
    let stdout = "",
      stderr = "";
    keeper!.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes("\n")) resolve(stdout.trim());
    });
    keeper!.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    keeper!.once("error", reject);
    keeper!.once("close", (status) =>
      reject(new Error("Manager keeper exited " + status + ": " + stderr)),
    );
  });
  assert.deepEqual(JSON.parse(connected), { connected: true });
}
async function stopManager() {
  for (const child of [keeper, manager]) {
    if (
      child === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      continue;
    await new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.kill("SIGTERM");
    });
  }
}
const ownerLabel =
  "reins.workspace.owner=sha256:" +
  createHash("sha256")
    .update(JSON.stringify(env.REINS_WORKSPACE_MANAGER_STATE_DIR))
    .digest("hex");
const cli = async (args: string[]) => {
  const result = await command(
    process.execPath,
    [join(installed, "dist", "reins.js"), "workspace", ...args, "-C", cwd],
    base,
    env,
  );
  await record("workspace " + args.join(" "), result);
  return { ...result, value: JSON.parse(result.stdout) as any };
};
const control = async (args: string[]) => {
  const result = await command(
    process.execPath,
    [join(installed, "dist", "reins.js"), ...args],
    cwd,
    env,
  );
  await record("control " + args.join(" "), result);
  return { ...result, value: JSON.parse(result.stdout) as any };
};
const attach = (refs = ["qoder", "code"]) =>
  cli(["attach", ...refs.flatMap((ref) => ["--binding", ref])]);
let sequence = 0;
async function round(harness: string, expected: string, gate?: string) {
  const supplied = JSON.stringify({
    path: "target.txt",
    ...(gate === undefined ? {} : { gate }),
  });
  const started = await control([
    "spawn",
    harness,
    supplied,
    "--name",
    `reader-${++sequence}`,
  ]);
  assert.equal(started.status, 0, JSON.stringify(started));
  const turn = started.value.turnHandle;
  return {
    started,
    finish: async () => {
      const result = await control(["wait", turn, "--completion", "all"]);
      assert.equal(
        result.status,
        expected === "expired" ? 1 : 0,
        JSON.stringify(result),
      );
      assert.equal(
        result.value.completed[0].stopReason,
        expected === "expired" ? "failed" : "end_turn",
      );
      if (expected === "expired")
        assert.deepEqual(result.value.completed[0].failure, {
          failureCategory: "credential_rejected",
          retryDisposition: "external_state_change",
        });
      const reply = JSON.parse(result.value.completed[0].finalReply);
      assert.equal(reply.credential, expected);
      assert.equal(reply.message, supplied);
      assert.equal(reply.content, "caller selected binding task\n");
      assert.deepEqual(reply.options, {});
      await control(["kill", started.value.sessionId]);
      return reply;
    },
  };
}
try {
  await startManager();
  let reusedRejections: string | undefined;
  try {
    reusedRejections = await readFile(
      join(base, "reused-binding-rejections.json"),
      "utf8",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (reusedRejections !== undefined) {
    await record(
      "reused binding rejection evidence",
      JSON.parse(reusedRejections),
    );
  } else {
    // 空组合与同harness两个引用都在创建运行资源前拒绝。
    const empty = await command(
      process.execPath,
      [
        join(base, "workspace-attach-client.js"),
        JSON.stringify({
          socket: env.REINS_WORKSPACE_MANAGER_SOCKET,
          cwd,
          consumer: env.REINS_CONSUMER_CONTEXT,
          bindings: [],
        }),
      ],
      base,
      env,
    );
    assert.equal(empty.status, 1);
    configuration.bindings.push({ ref: "code-again", harness: "codex" });
    await config();
    assert.equal(
      (await attach(["code", "code-again"])).value.code,
      "binding_conflict",
    );
    configuration.bindings.pop();
    await config();
  }
  // 错误绑定：CLI 必须等准备结果并非零；不把持久受理误当成功。
  const accepted = await command(
    process.execPath,
    [
      join(base, "workspace-attach-client.js"),
      JSON.stringify({
        socket: env.REINS_WORKSPACE_MANAGER_SOCKET,
        cwd,
        consumer: env.REINS_CONSUMER_CONTEXT,
        bindings: ["qoder", "code"],
      }),
    ],
    base,
    env,
  );
  assert.equal(accepted.status, 0);
  assert.equal(JSON.parse(accepted.stdout).runtime.status, "preparing");
  await record("shared client preparing acceptance", accepted);
  const first = await attach();
  assert.equal(
    first.status,
    1,
    "Partial credential failure must make CLI attach nonzero",
  );
  assert.equal(first.value.runtime.status, "failed");
  assert.equal(
    first.value.harnesses.find((x: any) => x.harness === "codex").stage,
    "ready",
  );
  assert.equal(
    first.value.harnesses.find((x: any) => x.harness === "qoder").error.code,
    "credential_binding_unavailable",
  );
  const container = await requireCommand("docker", [
    "ps",
    "-q",
    "--filter",
    "label=" + ownerLabel,
  ]);
  const originalId = await requireCommand("docker", [
    "inspect",
    "--format",
    "{{.Id}}",
    container,
  ]);
  const a = await round("codex", "correct", "release");
  const b = await round("codex", "correct", "release");
  assert.notEqual(a.started.value.sessionId, b.started.value.sessionId);
  const busy = await control(["list"]);
  assert.equal(busy.value.filter((x: any) => x.state === "busy").length, 2);
  const guarded = await cli([
    "detach",
    "--session-disposition",
    "require_none",
  ]);
  assert.equal(guarded.status, 1);
  assert.equal(guarded.value.code, "workspace_busy");
  await writeFile(join(cwd, "release"), "caller releases concurrent tasks");
  const replies = await Promise.all([a.finish(), b.finish()]);
  assert.notEqual(replies[0].pid, replies[1].pid);
  const unavailable = await control([
    "spawn",
    "qoder",
    JSON.stringify({ path: "target.txt" }),
    "--name",
    "failed-binding",
  ]);
  assert.equal(unavailable.value.code, "harness_not_prepared");
  await requireCommand("docker", [
    "exec",
    container,
    "node",
    "-e",
    "const fs=require('node:fs');fs.writeFileSync('/opt/reins/harnesses/codex/value','keep successful material');fs.writeFileSync(process.env.CODEX_HOME+'/auth.json',fs.readFileSync(process.env.CODEX_HOME+'/auth.json','utf8').replace('fixture-codex-valid','fixture-codex-expired'))",
  ]);
  // 同源修正：已成功的 material 与 credential 都不能再次复制。
  await writeFile(qoderSource, "fixture-qoder-valid");
  assert.equal((await attach(["code", "qoder"])).status, 0);
  assert.equal(
    await requireCommand("docker", [
      "inspect",
      "--format",
      "{{.Id}}",
      container,
    ]),
    originalId,
  );
  assert.equal(
    await requireCommand("docker", [
      "exec",
      container,
      "cat",
      "/opt/reins/harnesses/codex/value",
    ]),
    "keep successful material",
  );
  const nativeFiles = JSON.parse(
    await requireCommand("docker", [
      "exec",
      container,
      "node",
      "-e",
      "const fs=require('node:fs'),code=process.env.CODEX_HOME,qoder=process.env.QODERCN_CONFIG_DIR+'/.auth';console.log(JSON.stringify({directories:[code,qoder].map(p=>fs.statSync(p).mode&0o777),files:[code+'/auth.json',qoder+'/user',qoder+'/machine_id'].map(p=>fs.statSync(p).mode&0o777),codexUnselectedField:Object.hasOwn(JSON.parse(fs.readFileSync(code+'/auth.json','utf8')),'unselected')}))",
    ]),
  );
  assert.deepEqual(nativeFiles, {
    directories: [0o700, 0o700],
    files: [0o600, 0o600, 0o600],
    codexUnselectedField: false,
  });
  await record("privateNativeProjection", nativeFiles);
  await (await round("codex", "expired")).finish();
  await (await round("qoder", "correct")).finish();
  await requireCommand("docker", [
    "exec",
    container,
    "node",
    "-e",
    "const fs=require('node:fs');fs.writeFileSync(process.env.QODERCN_CONFIG_DIR+'/.auth/user','fixture-qoder-expired');fs.writeFileSync(process.env.CODEX_HOME+'/auth.json',fs.readFileSync(process.env.CODEX_HOME+'/auth.json','utf8').replace('fixture-codex-expired','fixture-codex-valid'))",
  ]);
  await (await round("qoder", "expired")).finish();
  await (await round("codex", "correct")).finish();
  const stable = await cli(["status"]);
  assert.equal(stable.value.preparation.attempts.length, 2);
  assert.equal(stable.value.preparation.attempts[0].status, "failed");
  // 同名引用换来源必须拒绝；同源内容修正则已经在本轮恢复成功。
  await stopManager();
  const replacement = join(base, "different-codex-source.json");
  nativeSources.push(replacement);
  await writeFile(replacement, validCodex);
  env.REINS_CODEX_AUTH_BINDINGS = JSON.stringify({
    "codex-login": replacement,
  });
  await startManager();
  assert.equal((await attach()).value.code, "attachment_intent_conflict");
  await stopManager();
  env.REINS_CODEX_AUTH_BINDINGS = JSON.stringify({
    "codex-login": codexSource,
  });
  await startManager();
  assert.equal((await attach()).status, 0);
  // Qoder 的两个显式原生来源各自固定，不允许借同引用换其中任一文件。
  for (const [key, content] of [
    ["userFile", "fixture-qoder-valid"],
    ["machineIdFile", "fixture-machine"],
  ] as const) {
    await stopManager();
    const changedSource = join(base, "different-qoder-" + key);
    nativeSources.push(changedSource);
    await writeFile(changedSource, content);
    env.REINS_QODER_AUTH_BINDINGS = JSON.stringify({
      "qoder-login": {
        userFile: qoderSource,
        machineIdFile: machineSource,
        [key]: changedSource,
      },
    });
    await startManager();
    assert.equal((await attach()).value.code, "attachment_intent_conflict");
    await stopManager();
    env.REINS_QODER_AUTH_BINDINGS = JSON.stringify({
      "qoder-login": { userFile: qoderSource, machineIdFile: machineSource },
    });
    await startManager();
    assert.equal((await attach()).status, 0);
  }
  // 同ref不得在重入时改变harness或凭据省略状态。
  const original = structuredClone(configuration.bindings);
  configuration.bindings[0]!.harness = "qoder";
  await config();
  assert.equal((await attach()).value.code, "attachment_intent_conflict");
  configuration.bindings = structuredClone(original);
  delete configuration.bindings[0]!.credentialBindingRef;
  await config();
  assert.equal((await attach()).value.code, "attachment_intent_conflict");
  configuration.bindings = original;
  await config();
  assert.equal(
    (await cli(["attach", "--binding", "code", "--binding", "code"])).status,
    1,
  );
  assert.equal(
    (await cli(["detach", "--session-disposition", "require_none"])).status,
    0,
  );
  // 省略绑定不会寻找宿主凭据，两个实际worker都观察为省略。
  configuration.bindings = original.map(
    ({ credentialBindingRef: _, ...binding }) => binding,
  );
  await config();
  assert.equal((await attach()).status, 0);
  await (await round("codex", "omitted")).finish();
  await (await round("qoder", "omitted")).finish();
  // 省略后补绑定同样是改变已受理意图，不能借同名ref混入凭据。
  configuration.bindings = original;
  await config();
  assert.equal((await attach()).value.code, "attachment_intent_conflict");
  await cli(["detach", "--session-disposition", "require_none"]);
  // 上一环境已detach，此处重新显式准备只用于错误的Codex原生材料。
  await writeFile(codexSource, "invalid login document");
  assert.equal((await attach()).status, 1);
  await (await round("qoder", "correct")).finish();
  await writeFile(codexSource, validCodex);
  assert.equal((await attach()).status, 0);
  await (await round("codex", "correct")).finish();
  await cli(["detach", "--session-disposition", "require_none"]);
  async function publicFiles(directory: string): Promise<string[]> {
    const files: string[] = [];
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (item.name === "home") continue;
      const path = join(directory, item.name);
      if (item.isDirectory()) files.push(...(await publicFiles(path)));
      else if (item.isFile()) files.push(path);
    }
    return files;
  }
  for (const path of await publicFiles(env.REINS_WORKSPACE_MANAGER_STATE_DIR)) {
    const text = await readFile(path, "utf8");
    for (const secret of [
      "fixture-codex-valid",
      "fixture-codex-expired",
      "fixture-qoder-valid",
      "fixture-qoder-expired",
      "fixture-refresh",
      ...nativeSources,
    ])
      assert.equal(text.includes(secret), false, path);
  }
  for (const secret of [
    "fixture-codex-valid",
    "fixture-codex-expired",
    "fixture-qoder-valid",
    "fixture-refresh",
    ...nativeSources,
  ])
    assert.equal(JSON.stringify(facts).includes(secret), false);
  await record("nativeSecretProjection", {
    publicStateAndFactsContainSecrets: false,
  });
  await record("result", "passed");
} finally {
  await stopManager();
  const remaining = await requireCommand("docker", [
    "ps",
    "-aq",
    "--filter",
    "label=" + ownerLabel,
  ]);
  if (remaining)
    await command("docker", ["rm", "-f", ...remaining.split(/\s+/u)]);
  await record(
    "runtimeMaterialImageRemoval",
    await command("docker", ["image", "rm", materialTag]),
  );
  await record(
    "fixtureImageRemoval",
    await command("docker", ["image", "rm", imageTag]),
  );
}
