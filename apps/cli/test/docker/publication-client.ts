import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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
const connect = async (owner: string) => {
  const client = createWorkspaceClient(
    await createUnixSocketClient<WorkspaceMessage>(task.socket),
    { consumerContext: v.parse(consumerContextSchema, owner) },
  );
  await client.initialize();
  return client;
};
const manager = await connect("reins-wrr26-owner-a");
const other = await connect("reins-wrr26-owner-b");
const root = join(task.base, "native-source");
await mkdir(join(root, ".reins"), { recursive: true });
execFileSync("git", ["init", "--quiet", root]);
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
let control: Awaited<ReturnType<typeof manager.control>> | undefined;
let sessionId: SessionId | undefined;
try {
  await manager.request(
    "workspace.attach",
    { cwd: root, bindings: ["code"] },
    600_000,
  );
  for (;;) {
    const current = await manager.request(
      "workspace.status",
      { cwd: root },
      600_000,
    );
    if (current.runtime.status === "ready") break;
    assert.equal(current.runtime.status, "preparing", JSON.stringify(current));
    await delay(1000);
  }
  control = await manager.control(root);
  assert.ok("result" in (await control.initialize()));
  const firstMessage = JSON.stringify({
    path: "--result.txt",
    content: "first fixed bytes\n",
    publish: true,
  });
  const started = await control.request("spawn", {
    harness: "codex",
    cwd: root,
    sessionName: v.parse(sessionNameSchema, "publisher"),
    message: firstMessage,
  });
  assert.ok("result" in started, JSON.stringify(started));
  sessionId = started.result.sessionId;
  const activeSession = started.result.sessionId;
  const run = async (turnId: typeof started.result.turnId) => {
    const completed = await control!.request(
      "wait",
      { targets: [{ sessionId: activeSession, turnId }], completion: "all" },
      600_000,
    );
    assert.ok("result" in completed);
    const reply = JSON.parse(completed.result.completed[0]!.finalReply!);
    assert.deepEqual(reply.options, {});
    return reply;
  };
  const receipts = join(task.base, "receipts");
  assert.deepEqual(await manager.receipts(receipts), []);
  const first = await run(started.result.turnId);
  await record("first-worker-publication", first);
  assert.equal(first.message, firstMessage);
  assert.equal(first.result.status, 0, JSON.stringify(first));
  const publication = JSON.parse(first.result.stdout);
  assert.equal(publication.state, "ready");
  assert.equal(publication.bytes, 18);
  assert.deepEqual(publication.source, {
    cwd: root,
    path: join(root, "--result.txt"),
  });
  const runtimeContainers = JSON.parse(
    execFileSync(
      "docker",
      [
        "container",
        "ls",
        "--filter",
        "label=reins.workspace.managed=true",
        "--format",
        "json",
      ],
      { encoding: "utf8" },
    ).trim(),
  );
  const runtimeMounts = JSON.parse(
    execFileSync(
      "docker",
      [
        "container",
        "inspect",
        "--format",
        "{{json .Mounts}}",
        runtimeContainers.ID,
      ],
      { encoding: "utf8" },
    ),
  );
  await record("fixed-storage-outside-runtime", {
    publicationRoot: join(task.base, "manager-state/publications"),
    runtimeMounts,
  });
  const next = async (message: unknown) => {
    const sent = await control!.request("send", {
      sessionId: activeSession,
      placement: "new_turn",
      message: JSON.stringify(message),
    });
    assert.ok("result" in sent);
    return run(sent.result.turnId);
  };
  const noPublish = await next({
    path: "--result.txt",
    content: "second fixed bytes\n",
  });
  assert.equal(
    (await manager.request("publication.list", { cwd: root })).length,
    1,
  );
  assert.equal((await readdir(root)).includes("receipts"), false);
  await record("reply-and-completion-do-not-publish-or-receive", noPublish);
  const second = await next({ path: "--result.txt", publish: true });
  assert.equal(second.result.status, 0);
  const publication2 = JSON.parse(second.result.stdout);
  assert.notEqual(publication.publicationId, publication2.publicationId);
  await next({ path: "--result.txt", remove: true });
  const failed = await next({ path: "--result.txt", publish: true });
  assert.notEqual(failed.result.status, 0);
  assert.match(failed.result.stdout, /publication_failed/u);
  const list = await manager.request("publication.list", { cwd: root });
  assert.equal(list.length, 2);
  assert.deepEqual(await other.request("publication.list", { cwd: root }), []);
  await assert.rejects(
    other.request("publication.read", {
      publicationId: publication.publicationId,
    }),
    { code: "publication_not_found" },
  );
  await record("fixed-publications-and-failed-publish", { list, failed });
  assert.deepEqual(await manager.receipts(receipts), []);
  for (const directory of [root, join(root, "..receipts")])
    await assert.rejects(
      manager.receivePublication(publication.publicationId, {
        directory,
        activeRoot: root,
      }),
      { code: "receipt_failed" },
    );
  await assert.rejects(
    other.receivePublication(publication.publicationId, {
      directory: receipts,
      activeRoot: root,
    }),
    { code: "publication_not_found" },
  );
  assert.equal(
    (await manager.request("publication.list", { cwd: root })).length,
    2,
  );
  const arrived = await manager.receivePublication(publication.publicationId, {
    directory: receipts,
    activeRoot: root,
  });
  assert.equal(
    await readFile(arrived.localPath, "utf8"),
    "first fixed bytes\n",
  );
  const cliArrival = JSON.parse(
    execFileSync(
      process.execPath,
      [
        task.cliPath,
        "workspace",
        "receive",
        publication2.publicationId,
        "--directory",
        receipts,
        "--active-root",
        root,
      ],
      { encoding: "utf8" },
    ),
  );
  assert.equal(
    await readFile(cliArrival.localPath, "utf8"),
    "second fixed bytes\n",
  );
  assert.equal(cliArrival.state, "arrived");
  assert.deepEqual(await other.receipts(receipts), []);
  assert.equal((await manager.receipts(receipts)).length, 2);
  await record("explicit-receive-and-consumer-isolation", {
    arrived,
    cliArrival,
  });
  const unsupported = await next({ path: "unused", requestEnvironment: true });
  assert.equal(unsupported.result.error.code, "invalid_request");
  await record("publisher-service-rejects-environment-action", unsupported);
  for (const args of [
    ["--help"],
    ["workspace", "attach", "--binding", "code"],
    ["spwan"],
  ]) {
    const rejected = await next({ path: "unused", args });
    await record("deployed-worker-capabilities", { args, ...rejected });
    if (args[0] === "--help") {
      assert.equal(rejected.result.status, 0);
      assert.match(rejected.result.stdout, /publish/u);
      assert.doesNotMatch(rejected.result.stdout, /workspace|spawn|attach/u);
    } else {
      assert.equal(rejected.result.status, 64);
      assert.deepEqual(JSON.parse(rejected.result.stdout).valid, ["publish"]);
    }
  }
  await assert.rejects(
    manager.request(
      "workspace.detach",
      { cwd: root, sessionDisposition: "require_none" },
      600_000,
    ),
    { code: "workspace_busy" },
  );
  await record("live-session-detach-rejected", true);
  await record("result", "passed");
} catch (error) {
  await record("failure", error);
  throw error;
} finally {
  if (control && sessionId) {
    assert.ok("result" in (await control.request("kill", { sessionId })));
    control.close();
  }
  const detached = await manager.request(
    "workspace.detach",
    { cwd: root, sessionDisposition: "require_none" },
    600_000,
  );
  assert.equal(detached.runtime.status, "released");
  await record("product-cleanup", detached);
  other.close();
  manager.close();
}
