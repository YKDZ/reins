import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readlink,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { createWorkspaceClient } from "@reins/client";
import {
  consumerContextSchema,
  sessionNameSchema,
  type SessionId,
} from "@reins/protocol";
import { createUnixSocketClient } from "@reins/transport";
import type { WorkspaceMessage } from "@reins/workspace-protocol";
import { captureFixedCommit } from "@reins/workspace-source";
import * as v from "valibot";

const task = JSON.parse(process.argv[2]!) as {
  base: string;
  socket: string;
  image: string;
  runtimeImage: string;
  cliPath: string;
};
const source = join(task.base, "caller-source");
await mkdir(join(source, "src"), { recursive: true });
const git = (...args: string[]) =>
  execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
git("init", "--quiet");
await mkdir(join(source, ".reins"));
await writeFile(
  join(source, ".reins/workspace.json"),
  JSON.stringify({
    environments: [{ provider: "docker", image: task.image }],
    runtimes: [
      { harness: "codex", version: "0.149.0", image: task.runtimeImage },
    ],
    bindings: [{ ref: "code", harness: "codex" }],
  }),
);
await writeFile(join(source, "src/input.txt"), "fixed first commit\n");
await writeFile(join(source, "run"), "#!/bin/sh\nexit 0\n");
await chmod(join(source, "run"), 0o755);
await symlink("input.txt", join(source, "src/link"));
git("add", ".");
git(
  "-c",
  "user.name=Fixture",
  "-c",
  "user.email=fixture@example.invalid",
  "commit",
  "-qm",
  "first",
);
const firstCommit = git("rev-parse", "HEAD");
const material = await captureFixedCommit(source, firstCommit);
const incompletePack = execFileSync(
  "git",
  ["-C", source, "pack-objects", "--stdout"],
  { input: firstCommit + "\n" },
);
const incompleteMaterial = {
  ...material,
  packBase64: incompletePack.toString("base64"),
  sha256: createHash("sha256").update(incompletePack).digest("hex"),
};
await writeFile(join(source, "src/input.txt"), "fixed second commit\n");
git("add", ".");
git(
  "-c",
  "user.name=Fixture",
  "-c",
  "user.email=fixture@example.invalid",
  "commit",
  "-qm",
  "second",
);
const nextMaterial = await captureFixedCommit(source, git("rev-parse", "HEAD"));
const connect = async (consumer: string) => {
  const manager = createWorkspaceClient(
    await createUnixSocketClient<WorkspaceMessage>(task.socket),
    { consumerContext: v.parse(consumerContextSchema, consumer) },
  );
  await manager.initialize();
  return manager;
};
const manager = await connect("reins-wrr24-owner-a");
const other = await connect("reins-wrr24-owner-b");
const controls: Awaited<ReturnType<typeof manager.control>>[] = [];
const sessions: {
  control: Awaited<ReturnType<typeof manager.control>>;
  sessionId: SessionId;
}[] = [];
const incoming: string[] = [];
const facts: unknown[] = [];
const record = async (name: string, value: unknown) => {
  facts.push({ name, value });
  await writeFile(
    join(task.base, "evidence/fixed-source-facts.json"),
    JSON.stringify(facts, null, 2),
  );
};
try {
  const receive = async (selected = material, viaCli = false) => {
    const handoff = viaCli
      ? (JSON.parse(
          execFileSync(
            process.execPath,
            [
              task.cliPath,
              "workspace",
              "handoff",
              "--repository",
              source,
              "--commit",
              selected.commit,
              "--subdirectory",
              "src",
              "--binding",
              "code",
            ],
            { encoding: "utf8" },
          ),
        ) as Awaited<ReturnType<typeof manager.request<"workspace.handoff">>>)
      : await manager.request(
          "workspace.handoff",
          { material: selected, subdirectory: "src", bindings: ["code"] },
          120_000,
        );
    incoming.push(handoff.workspace.cwd);
    await record("handoff", handoff);
    for (;;) {
      const current = await manager.request(
        "workspace.status",
        { cwd: handoff.workspace.cwd },
        120_000,
      );
      if (current.runtime.status === "ready") break;
      assert.equal(
        current.runtime.status,
        "preparing",
        JSON.stringify(current),
      );
      await delay(1000);
    }
    return handoff;
  };
  const first = await receive(material, true);
  await rm(source, { recursive: true });
  // 调用侧相同路径留下假内容，目标 worker 必须读取新物化目录。
  await mkdir(join(source, "src"), { recursive: true });
  await writeFile(join(source, "src/input.txt"), "caller path decoy\n");

  assert.notEqual(first.workspace.cwd, join(source, "src"));
  assert.equal(
    execFileSync("git", ["-C", first.workspace.cwd, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    firstCommit,
  );
  assert.match(
    await readFile(join(first.workspace.root, ".git"), "utf8"),
    /^gitdir: /u,
  );
  assert.equal(await readlink(join(first.workspace.cwd, "link")), "input.txt");
  assert.notEqual(
    (await stat(join(first.workspace.root, "run"))).mode & 0o111,
    0,
  );
  await assert.rejects(
    other.request("workspace.locate", {
      workspaceHandle: first.workspaceHandle,
    }),
    { code: "attachment_not_found" },
  );
  await assert.rejects(
    other.request("workspace.status", { cwd: first.workspace.cwd }),
    { code: "attachment_owned" },
  );
  const control = await manager.control({
    workspaceHandle: first.workspaceHandle,
  });
  controls.push(control);
  assert.ok("result" in (await control.initialize()));
  const spawn = await control.request("spawn", {
    harness: "codex",
    cwd: first.workspace.cwd,
    sessionName: v.parse(sessionNameSchema, "fixed-reader"),
    message: JSON.stringify({ path: "input.txt" }),
  });
  assert.ok("result" in spawn, JSON.stringify(spawn));
  sessions.push({ control, sessionId: spawn.result.sessionId });
  const completed = await control.request("wait", {
    targets: [
      { sessionId: spawn.result.sessionId, turnId: spawn.result.turnId },
    ],
    completion: "all",
  });
  assert.ok("result" in completed, JSON.stringify(completed));
  const read = JSON.parse(completed.result.completed[0]!.finalReply!);
  assert.equal(read.content, "fixed first commit\n");
  assert.equal(read.cwd, first.workspace.cwd);
  assert.deepEqual(read.options, {});
  await record("worker-read-fixed-target", completed.result);
  // 活动工作树有 staged 和 unstaged 修改时再次交接，旧会话仍留在原 cwd。
  const native = (...args: string[]) =>
    execFileSync("git", ["-C", first.workspace.root, ...args], {
      encoding: "utf8",
    });
  await writeFile(
    join(first.workspace.cwd, "input.txt"),
    "staged old change\n",
  );
  native("add", "src/input.txt");
  await writeFile(
    join(first.workspace.cwd, "input.txt"),
    "unstaged old change\n",
  );
  const indexPath = native(
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "index",
  ).trim();
  const indexBefore = createHash("sha256")
    .update(await readFile(indexPath))
    .digest("hex");
  const second = await receive(nextMaterial);
  assert.notEqual(second.workspaceHandle, first.workspaceHandle);
  assert.notEqual(second.workspace.root, first.workspace.root);
  assert.equal(native("rev-parse", "HEAD").trim(), firstCommit);
  assert.equal(
    createHash("sha256")
      .update(await readFile(indexPath))
      .digest("hex"),
    indexBefore,
  );
  assert.equal(
    await readFile(join(first.workspace.cwd, "input.txt"), "utf8"),
    "unstaged old change\n",
  );
  const sent = await control.request("send", {
    sessionId: spawn.result.sessionId,
    placement: "new_turn",
    message: JSON.stringify({ path: "input.txt" }),
  });
  assert.ok("result" in sent, JSON.stringify(sent));
  const again = await control.request("wait", {
    targets: [
      { sessionId: spawn.result.sessionId, turnId: sent.result.turnId },
    ],
    completion: "all",
  });
  assert.ok("result" in again);
  const reread = JSON.parse(again.result.completed[0]!.finalReply!);
  assert.equal(reread.cwd, first.workspace.cwd);
  assert.equal(reread.pid, read.pid);
  assert.equal(reread.content, "unstaged old change\n");
  const secondControl = await manager.control({
    workspaceHandle: second.workspaceHandle,
  });
  controls.push(secondControl);
  assert.ok("result" in (await secondControl.initialize()));
  const secondSpawn = await secondControl.request("spawn", {
    harness: "codex",
    cwd: second.workspace.cwd,
    sessionName: v.parse(sessionNameSchema, "second-reader"),
    message: JSON.stringify({ path: "input.txt" }),
  });
  assert.ok("result" in secondSpawn);
  sessions.push({
    control: secondControl,
    sessionId: secondSpawn.result.sessionId,
  });
  const secondWait = await secondControl.request("wait", {
    targets: [
      {
        sessionId: secondSpawn.result.sessionId,
        turnId: secondSpawn.result.turnId,
      },
    ],
    completion: "all",
  });
  assert.ok("result" in secondWait);
  assert.equal(
    JSON.parse(secondWait.result.completed[0]!.finalReply!).content,
    "fixed second commit\n",
  );
  await record("new-tree-old-session-preserved", {
    old: again.result,
    new: secondWait.result,
    indexBefore,
    head: firstCommit,
  });
  const beforeRejected = await readdir(
    join(task.base, "manager-state/incoming"),
  );
  for (const invalid of [
    { ...material, packBase64: "" },
    { ...material, packBase64: Buffer.from("damaged pack").toString("base64") },
    { ...material, commit: "f".repeat(40) },
  ]) {
    await assert.rejects(
      manager.request(
        "workspace.handoff",
        { material: invalid, subdirectory: "src", bindings: ["code"] },
        120_000,
      ),
      { code: "source_invalid" },
    );
  }
  await assert.rejects(
    manager.request(
      "workspace.handoff",
      { material: incompleteMaterial, subdirectory: "src", bindings: ["code"] },
      120_000,
    ),
    { code: "source_invalid" },
  );
  // 合法 checksum 的损坏 pack 不能只凭摘要通过。
  const damaged = Buffer.from("damaged pack");
  await assert.rejects(
    manager.request(
      "workspace.handoff",
      {
        material: {
          ...material,
          packBase64: damaged.toString("base64"),
          sha256: createHash("sha256").update(damaged).digest("hex"),
        },
        subdirectory: "src",
        bindings: ["code"],
      },
      120_000,
    ),
    { code: "source_invalid" },
  );
  assert.deepEqual(
    await readdir(join(task.base, "manager-state/incoming")),
    beforeRejected,
  );
  await record("rejected-material", {
    empty: true,
    damaged: true,
    validDigestDamaged: true,
    missingCommit: true,
    missingObjectClosure: true,
  });
  await record("result", "passed");
} finally {
  for (const { control, sessionId } of sessions) {
    const killed = await control.request("kill", { sessionId });
    assert.ok("result" in killed, JSON.stringify(killed));
  }
  for (const control of controls) control.close();
  for (const cwd of incoming) {
    const detached = await manager.request(
      "workspace.detach",
      { cwd, sessionDisposition: "require_none" },
      120_000,
    );
    assert.equal(detached.runtime.status, "released");
  }
  await record("product-cleanup", {
    sessionsKilled: sessions.length,
    detached: incoming,
    status: "passed",
  });
  other.close();
  manager.close();
}
