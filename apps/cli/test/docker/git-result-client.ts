import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import * as v from "valibot";

const task = JSON.parse(process.argv[2]!) as {
  base: string;
  socket: string;
  image: string;
  runtimeImage: string;
  cliPath: string;
};
const manager = createWorkspaceClient(
  await createUnixSocketClient<WorkspaceMessage>(task.socket),
  { consumerContext: v.parse(consumerContextSchema, "reins-wrr28-owner-a") },
);
await manager.initialize();
const root = join(task.base, "native-source");
const target = join(task.base, "target");
const git = (cwd: string, args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).trim();
await mkdir(join(root, ".reins"), { recursive: true });
git(root, ["init", "--quiet"]);
await writeFile(
  join(root, ".reins/workspace.json"),
  JSON.stringify({
    environments: [{ provider: "docker", image: task.image }],
    runtimes: [
      { harness: "codex", version: "0.149.0", image: task.runtimeImage },
    ],
    bindings: [{ ref: "code", harness: "codex" }],
  }),
);
await mkdir(target);
git(target, ["init", "--quiet"]);
await writeFile(join(target, "existing.txt"), "baseline\n");
git(target, ["add", "existing.txt"]);
git(target, [
  "-c",
  "user.name=Caller",
  "-c",
  "user.email=caller@example.invalid",
  "commit",
  "--quiet",
  "-m",
  "caller baseline",
]);
await writeFile(join(target, "existing.txt"), "staged\n");
git(target, ["add", "existing.txt"]);
await writeFile(join(target, "existing.txt"), "working\n");
const snapshot = async () => ({
  head: git(target, ["rev-parse", "HEAD"]),
  branch: git(target, ["symbolic-ref", "HEAD"]),
  index: (await readFile(join(target, ".git/index"))).toString("base64"),
  working: await readFile(join(target, "existing.txt"), "utf8"),
  status: git(target, ["status", "--porcelain=v1"]),
});
const before = await snapshot();
const facts: unknown[] = [];
const record = async (name: string, value: unknown) => {
  facts.push({ name, value });
  await writeFile(
    join(task.base, "evidence/git-result-facts.json"),
    JSON.stringify(facts, null, 2),
  );
};
let control: Awaited<ReturnType<typeof manager.control>> | undefined;
let sessionId: SessionId | undefined;
try {
  await manager.request(
    "workspace.attach",
    { cwd: root, bindings: ["code"] },
    600_000,
  );
  for (;;) {
    const info = await manager.request(
      "workspace.status",
      { cwd: root },
      600_000,
    );
    if (info.runtime.status === "ready") break;
    assert.equal(info.runtime.status, "preparing", JSON.stringify(info));
    await delay(1000);
  }
  control = await manager.control(root);
  assert.ok("result" in (await control.initialize()));
  const message = JSON.stringify({
    path: "result.bundle",
    files: { "result.txt": "worker prepared commit\n" },
    git: [
      ["add", "result.txt"],
      [
        "-c",
        "user.name=Worker",
        "-c",
        "user.email=worker@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "worker result",
      ],
      ["rev-parse", "HEAD"],
      ["bundle", "create", "result.bundle", "HEAD"],
    ],
  });
  const started = await control.request("spawn", {
    harness: "codex",
    cwd: root,
    sessionName: v.parse(sessionNameSchema, "git-publisher"),
    message,
  });
  assert.ok("result" in started, JSON.stringify(started));
  sessionId = started.result.sessionId;
  const done = await control.request(
    "wait",
    {
      targets: [{ sessionId, turnId: started.result.turnId }],
      completion: "all",
    },
    600_000,
  );
  assert.ok("result" in done, JSON.stringify(done));
  const reply = JSON.parse(done.result.completed[0]!.finalReply!);
  await record("worker-prepared-and-published", reply);
  assert.equal(reply.message, message);
  const commit = reply.commands[2].stdout as string;
  const publicationId = reply.publication.publicationId as string;
  const imported = spawnSync(
    process.execPath,
    [
      task.cliPath,
      "workspace",
      "import-git",
      publicationId,
      "--repository",
      target,
      "--ref",
      "refs/received/worker",
      "--commit",
      commit,
    ],
    { encoding: "utf8" },
  );
  await record("explicit-import", {
    status: imported.status,
    stdout: imported.stdout,
    stderr: imported.stderr,
  });
  assert.equal(imported.status, 0, imported.stdout + imported.stderr);
  assert.equal(git(target, ["rev-parse", "refs/received/worker"]), commit);
  assert.equal(
    git(target, ["show", "refs/received/worker:result.txt"]),
    "worker prepared commit",
  );
  const importedResult = JSON.parse(imported.stdout);
  assert.equal(importedResult.objectWriteAttempted, true);
  assert.equal(importedResult.referenceCreated, true);
  assert.ok(
    importedResult.objectDatabaseAfter.loose +
      importedResult.objectDatabaseAfter.packed >
      importedResult.objectDatabaseBefore.loose +
        importedResult.objectDatabaseBefore.packed,
  );
  const existing = "refs/received/existing";
  git(target, ["update-ref", existing, before.head]);
  await assert.rejects(
    manager.importGitPublication(publicationId, {
      repository: target,
      reference: existing,
      commit,
    }),
    {
      code: "git_import_failed",
      gitImport: { referenceCreated: false, objectWriteAttempted: false },
    },
  );
  assert.equal(git(target, ["rev-parse", existing]), before.head);
  const symbolic = "refs/received/symbolic";
  git(target, ["symbolic-ref", symbolic, "refs/heads/absent"]);
  await assert.rejects(
    manager.importGitPublication(publicationId, {
      repository: target,
      reference: symbolic,
      commit,
    }),
    { code: "git_import_failed", gitImport: { referenceCreated: false } },
  );
  assert.equal(git(target, ["symbolic-ref", symbolic]), "refs/heads/absent");
  const race = await Promise.allSettled(
    [1, 2].map(() =>
      manager.importGitPublication(publicationId, {
        repository: target,
        reference: "refs/received/race",
        commit,
      }),
    ),
  );
  assert.equal(
    race.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(race.filter((result) => result.status === "rejected").length, 1);
  assert.equal(git(target, ["rev-parse", "refs/received/race"]), commit);
  await record("existing-symbolic-and-competing-reference", {
    existing: git(target, ["rev-parse", existing]),
    symbolic: git(target, ["symbolic-ref", symbolic]),
    race,
  });
  const next = async (input: unknown) => {
    const sent = await control!.request("send", {
      sessionId: sessionId!,
      placement: "new_turn",
      message: JSON.stringify(input),
    });
    assert.ok("result" in sent, JSON.stringify(sent));
    const completed = await control!.request(
      "wait",
      {
        targets: [{ sessionId: sessionId!, turnId: sent.result.turnId }],
        completion: "all",
      },
      600_000,
    );
    assert.ok("result" in completed, JSON.stringify(completed));
    return JSON.parse(completed.result.completed[0]!.finalReply!);
  };
  const plain = await next({
    path: "plain.txt",
    files: { "plain.txt": "ordinary file without a commit\n" },
    git: [["rev-parse", "HEAD"]],
  });
  assert.equal(plain.commands[0].stdout, commit);
  await assert.rejects(
    manager.importGitPublication(plain.publication.publicationId, {
      repository: target,
      reference: "refs/received/plain",
      commit,
    }),
    {
      code: "git_import_failed",
      gitImport: { referenceCreated: false, objectWriteAttempted: false },
    },
  );
  assert.equal(git(target, ["for-each-ref", "refs/received/plain"]), "");
  const corrupt = await next({
    path: "corrupt.bundle",
    git: [["bundle", "create", "corrupt.bundle", "HEAD"]],
    truncate: 100,
  });
  const rejected = await manager
    .importGitPublication(corrupt.publication.publicationId, {
      repository: target,
      reference: "refs/received/corrupt",
      commit,
    })
    .then(
      () => assert.fail("Corrupt bundle imported"),
      (error: unknown) => error,
    );
  assert.equal((rejected as { code: string }).code, "git_import_failed");
  assert.equal(git(target, ["for-each-ref", "refs/received/corrupt"]), "");
  const partial = await next({
    path: "partial.bundle",
    files: { "result.txt": "second prepared commit\n" },
    git: [
      ["add", "result.txt"],
      [
        "-c",
        "user.name=Worker",
        "-c",
        "user.email=worker@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "second worker result",
      ],
      ["rev-parse", "HEAD"],
      ["bundle", "create", "partial.bundle", "HEAD", "^HEAD^"],
    ],
  });
  const missing = join(task.base, "missing-prerequisite.git");
  git(task.base, ["init", "--quiet", "--bare", missing]);
  await assert.rejects(
    manager.importGitPublication(partial.publication.publicationId, {
      repository: missing,
      reference: "refs/received/partial",
      commit: partial.commands[2].stdout,
    }),
    {
      code: "git_import_failed",
      gitImport: { referenceCreated: false, objectWriteAttempted: false },
    },
  );
  assert.equal(git(missing, ["for-each-ref"]), "");
  await record("ordinary-corrupt-and-missing-prerequisite-rejected", {
    plain,
    corrupt,
    rejected,
    partial,
  });
  assert.deepEqual(await snapshot(), before);
  await record("active-state-unchanged", {
    before,
    after: await snapshot(),
    importedResult,
    callerNativeView: git(target, ["show", "refs/received/worker:result.txt"]),
  });
  await record("result", "passed");
} catch (error) {
  await record("failure", String(error));
  throw error;
} finally {
  if (control && sessionId) {
    assert.ok("result" in (await control.request("kill", { sessionId })));
    control.close();
  }
  await record(
    "product-cleanup",
    await manager.request(
      "workspace.detach",
      { cwd: root, sessionDisposition: "require_none" },
      600_000,
    ),
  );
  manager.close();
}
