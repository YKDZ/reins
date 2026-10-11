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
    await record("wait-result", completed);
    assert.equal(
      (
        completed.result as typeof completed.result & {
          publications?: unknown[];
        }
      ).publications?.length,
      1,
      "wait must discover the saved publication",
    );
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
  const subscription = await control.subscribe({
    scope: "session",
    sessionId: activeSession,
    replay: { mode: "none" },
  });
  const observed: unknown[] = [];
  subscription.onEvent((event) => observed.push(event));
  const sent = await control.request("send", {
    sessionId: activeSession,
    placement: "new_turn",
    message: JSON.stringify({
      path: "second.txt",
      content: "second observation\n",
      publish: true,
    }),
  });
  assert.ok("result" in sent);
  const secondWait = await control.request("wait", {
    targets: [{ sessionId: activeSession, turnId: sent.result.turnId }],
    completion: "all",
  });
  await record("second-wait", secondWait);
  await record("subscription-events", observed);
  assert.ok(
    observed.some(
      (event) => (event as { type: string }).type === "publication.ready",
    ),
    "subscription must discover a saved publication",
  );
  subscription.close();
  await subscription.done;
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
