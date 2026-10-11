import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { createWorkspaceClient } from "@reins/client";
import { consumerContextSchema, sessionNameSchema } from "@reins/protocol";
import { createUnixSocketClient } from "@reins/transport";
import type { WorkspaceMessage } from "@reins/workspace-protocol";
import * as v from "valibot";

const task = JSON.parse(process.argv[2]!) as {
  base: string;
  socket: string;
  image: string;
  runtimeImage: string;
  cliPath: string;
  failedReceipt?: { directory: string; receiptId: string };
};
const manager = createWorkspaceClient(
  await createUnixSocketClient<WorkspaceMessage>(task.socket),
  { consumerContext: v.parse(consumerContextSchema, "reins-wrr26-owner-a") },
);
await manager.initialize();
if (task.failedReceipt) {
  // 连接后降权制造真实不可写目录，避免替换清理函数或模拟文件系统。
  process.setgid!(65534);
  process.setuid!(65534);
  const result = await manager.removeReceipt(
    task.failedReceipt.directory,
    task.failedReceipt.receiptId,
  );
  manager.close();
  process.stdout.write(JSON.stringify(result) + "\n");
} else {
  const root = join(task.base, "native-source");
  await mkdir(join(root, ".reins"), { recursive: true });
  execFileSync("git", ["init", "--quiet", root]);
  await writeFile(join(root, "original.txt"), "consumer-owned history\n");
  execFileSync("git", ["-C", root, "add", "original.txt"]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Caller",
    "-c",
    "user.email=caller@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "caller-owned commit",
  ]);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  const originalHead = git("rev-parse", "HEAD");
  git("update-ref", "refs/deliverables/keep", originalHead);
  const gitBefore = {
    head: originalHead,
    refs: git("show-ref"),
    index: await readFile(join(root, ".git/index")),
    objects: git("rev-list", "--objects", "--all"),
    original: await readFile(join(root, "original.txt")),
  };
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
  const facts: unknown[] = [];
  const record = async (name: string, value: unknown) => {
    facts.push({ name, value });
    await writeFile(
      join(task.base, "evidence/publication-facts.json"),
      JSON.stringify(facts, null, 2),
    );
  };
  const cli = (...args: string[]) =>
    JSON.parse(
      execFileSync(process.execPath, [task.cliPath, "workspace", ...args], {
        encoding: "utf8",
      }),
    );
  let detached = false;
  let control: Awaited<ReturnType<typeof manager.control>> | undefined;
  try {
    await manager.request(
      "workspace.attach",
      { cwd: root, bindings: ["code"] },
      600_000,
    );
    for (;;) {
      const state = await manager.request(
        "workspace.status",
        { cwd: root },
        600_000,
      );
      if (state.runtime.status === "ready") break;
      assert.equal(state.runtime.status, "preparing", JSON.stringify(state));
      await delay(1000);
    }
    control = await manager.control(root);
    assert.ok("result" in (await control.initialize()));
    const spawn = await control.request("spawn", {
      harness: "codex",
      cwd: root,
      sessionName: v.parse(sessionNameSchema, "retain-publisher"),
      message: JSON.stringify({
        path: "first.txt",
        content: "retained first\n",
        publish: true,
      }),
    });
    assert.ok("result" in spawn);
    const completed = await control.request(
      "wait",
      {
        targets: [
          { sessionId: spawn.result.sessionId, turnId: spawn.result.turnId },
        ],
        completion: "all",
      },
      600_000,
    );
    assert.ok("result" in completed);
    const firstWorker = JSON.parse(completed.result.completed[0]!.finalReply!);
    const first = JSON.parse(firstWorker.result.stdout);
    assert.deepEqual(firstWorker.options, {});
    const sent = await control.request("send", {
      sessionId: spawn.result.sessionId,
      placement: "new_turn",
      message: JSON.stringify({
        path: "second.txt",
        content: "retained second\n",
        publish: true,
      }),
    });
    assert.ok("result" in sent);
    const done = await control.request(
      "wait",
      {
        targets: [
          { sessionId: spawn.result.sessionId, turnId: sent.result.turnId },
        ],
        completion: "all",
      },
      600_000,
    );
    assert.ok("result" in done);
    const secondWorker = JSON.parse(done.result.completed[0]!.finalReply!);
    const second = JSON.parse(secondWorker.result.stdout);
    await record("actual-worker-publications", {
      firstWorker,
      secondWorker,
      first,
      second,
    });
    const ended = await manager.request(
      "workspace.detach",
      { cwd: root, sessionDisposition: "kill" },
      600_000,
    );
    assert.equal(ended.runtime.status, "released");
    detached = true;
    control.close();
    control = undefined;
    await record("product-detach", ended);
    const listed = cli("publications", "-C", root);
    assert.equal(listed.length, 2);
    for (const publication of listed) {
      assert.equal(publication.source.cwd, root);
      assert.equal(
        (await readFile(publication.storagePath)).length,
        publication.bytes,
      );
    }
    const receipts = join(task.base, "receipts");
    const received = cli(
      "receive",
      first.publicationId,
      "--directory",
      receipts,
      "--active-root",
      root,
    );
    const retained = await manager.receivePublication(second.publicationId, {
      directory: receipts,
      activeRoot: root,
    });
    assert.equal(
      await readFile(received.localPath, "utf8"),
      "retained first\n",
    );
    assert.equal(
      await readFile(retained.localPath, "utf8"),
      "retained second\n",
    );
    assert.equal(cli("publications", "-C", root).length, 2);
    await record("detached-query-and-arrival", {
      listed,
      received,
      retained,
      receipts: cli("receipts", "--directory", receipts),
    });
    const removedPublication = cli("remove-publication", first.publicationId);
    assert.equal(removedPublication.state, "released");
    assert.deepEqual(removedPublication.remaining, {
      directory: "absent",
      metadata: "absent",
      payload: "absent",
    });
    assert.equal(
      await readFile(received.localPath, "utf8"),
      "retained first\n",
    );
    assert.deepEqual(
      cli("publications", "-C", root).map(
        (value: { publicationId: string }) => value.publicationId,
      ),
      [second.publicationId],
    );
    await assert.rejects(
      manager.request("publication.read", {
        publicationId: first.publicationId,
      }),
      { code: "publication_not_found" },
    );
    const removedReceipt = cli(
      "remove-receipt",
      received.receiptId,
      "--directory",
      receipts,
    );
    assert.equal(removedReceipt.state, "released");
    assert.equal(
      await readFile(retained.localPath, "utf8"),
      "retained second\n",
    );
    assert.equal(
      (
        await manager.request("publication.read", {
          publicationId: second.publicationId,
        })
      ).publication.publicationId,
      second.publicationId,
    );
    await record("independent-selected-cleanup", {
      removedPublication,
      removedReceipt,
      publications: cli("publications", "-C", root),
      receipts: cli("receipts", "--directory", receipts),
    });
    const folder = dirname(retained.localPath);
    const ownerFolder = dirname(folder);
    await chmod(receipts, 0o755);
    await chmod(ownerFolder, 0o555);
    await chmod(folder, 0o755);
    await chmod(retained.localPath, 0o644);
    await chmod(join(folder, "receipt.json"), 0o644);
    const failed = JSON.parse(
      execFileSync(
        process.execPath,
        [
          process.argv[1]!,
          JSON.stringify({
            ...task,
            failedReceipt: {
              directory: receipts,
              receiptId: retained.receiptId,
            },
          }),
        ],
        { encoding: "utf8" },
      ),
    );
    assert.equal(failed.state, "failed");
    assert.deepEqual(failed.remaining, {
      directory: "present",
      metadata: "present",
      payload: "present",
    });
    assert.equal(
      await readFile(retained.localPath, "utf8"),
      "retained second\n",
    );
    await record("real-cleanup-failure-remains", failed);
    await chmod(ownerFolder, 0o700);
    const retry = cli(
      "remove-receipt",
      retained.receiptId,
      "--directory",
      receipts,
    );
    assert.equal(retry.state, "released");
    assert.equal(cli("receipts", "--directory", receipts).length, 0);
    assert.equal(cli("publications", "-C", root).length, 1);
    assert.deepEqual(
      {
        head: git("rev-parse", "HEAD"),
        refs: git("show-ref"),
        index: await readFile(join(root, ".git/index")),
        objects: git("rev-list", "--objects", "--all"),
        original: await readFile(join(root, "original.txt")),
      },
      gitBefore,
    );
    await record("git-history-and-tree-preserved", {
      head: originalHead,
      refs: gitBefore.refs,
      objects: gitBefore.objects,
    });
    const finalCopyCleanup = cli("remove-publication", second.publicationId);
    assert.equal(finalCopyCleanup.state, "released");
    await record("product-copy-cleanup", {
      retry,
      finalCopyCleanup,
      publications: cli("publications", "-C", root),
      receipts: cli("receipts", "--directory", receipts),
    });
    await record("result", "passed");
  } catch (error) {
    await record("failure", String(error));
    throw error;
  } finally {
    control?.close();
    if (!detached)
      await record(
        "product-cleanup",
        await manager.request(
          "workspace.detach",
          { cwd: root, sessionDisposition: "kill" },
          600_000,
        ),
      );
    manager.close();
  }
}
