import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

import { createWorkspaceClient } from "@reins/client";
import {
  consumerContextSchema,
  encodeTurnHandle,
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
let manager = await connect("reins-wrr26-owner-a");
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
let cli: ReturnType<typeof spawn> | undefined;
const until = async <T>(
  read: () => Promise<T | undefined> | T | undefined,
): Promise<T> => {
  const deadline = Date.now() + 600_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    assert.ok(Date.now() < deadline, "caller observation budget expired");
    await delay(50);
  }
};
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
      completed.result.publications?.length,
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
  const observed: import("@reins/client").AgentEvent[] = [];
  subscription.onEvent((event) => observed.push(event));
  const publishGate = join(root, "publish-second");
  const finishGate = join(root, "finish-second");
  const secondMessage = JSON.stringify({
    path: "second.txt",
    content: "second observation\n",
    publish: true,
    publishAfterFile: publishGate,
    finishAfterFile: finishGate,
    fail: true,
  });
  const sent = await control.request("send", {
    sessionId: activeSession,
    placement: "new_turn",
    message: secondMessage,
  });
  assert.ok("result" in sent);
  const target = { sessionId: activeSession, turnId: sent.result.turnId };
  const cliEvents: Array<Record<string, unknown>> = [];
  let cliStderr = "";
  cli = spawn(
    process.execPath,
    [
      task.cliPath,
      "-C",
      root,
      "--json",
      "attach",
      encodeTurnHandle(target),
      "--scope",
      "turn",
      "--replay",
      "none",
    ],
    { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  createInterface({ input: cli.stdout! }).on("line", (line) =>
    cliEvents.push(JSON.parse(line)),
  );
  cli.stderr!.on("data", (chunk) => {
    cliStderr += String(chunk);
  });
  const cliDone = new Promise<number>((resolve, reject) => {
    cli!.once("error", reject);
    cli!.once("close", (status) => resolve(status ?? 1));
  });
  await until(() =>
    cliEvents.find((event) => event.type === "subscription.established"),
  );
  await writeFile(publishGate, "publish now");
  const notification = await until(() =>
    observed.find(
      (event) =>
        event.type === "publication.ready" &&
        event.publication.source.path === join(root, "second.txt"),
    ),
  );
  assert.equal(notification.type, "publication.ready");
  if (notification.type !== "publication.ready")
    throw new Error("Missing publication");
  assert.equal(notification.publication.state, "ready");
  assert.equal("eventId" in notification, false);
  assert.equal("turnHandle" in notification, false);
  await until(() =>
    cliEvents.find(
      (event) =>
        event.type === "publication.ready" &&
        (event.publication as { source: { path: string } }).source.path ===
          join(root, "second.txt"),
    ),
  );
  const pending = await control.request("wait", {
    targets: [target],
    completion: "all",
    timeoutMs: 0,
  });
  assert.ok("result" in pending);
  assert.equal(pending.result.status, "timeout");
  assert.deepEqual(pending.result.completed, []);
  assert.deepEqual(pending.result.pending, [target]);
  assert.equal(pending.result.publications?.length, 2);
  assert.equal(
    observed.some(
      (event) =>
        event.type === "turn.completed" &&
        event.turnHandle === encodeTurnHandle(target),
    ),
    false,
  );
  assert.equal(
    cliEvents.some((event) => event.type === "subscription.ended"),
    false,
  );
  assert.deepEqual(await manager.receipts(receipts), []);
  await record("published-while-turn-pending", {
    notification,
    pending,
    cliEvents: [...cliEvents],
    receipts: [],
  });
  let cliWait: { status: number; stdout: string };
  try {
    cliWait = {
      status: 0,
      stdout: execFileSync(
        process.execPath,
        [
          task.cliPath,
          "-C",
          root,
          "--json",
          "wait",
          encodeTurnHandle(target),
          "--completion",
          "all",
          "--timeout",
          "0",
        ],
        { encoding: "utf8" },
      ),
    };
  } catch (error) {
    const result = error as { status: number; stdout: string | Buffer };
    cliWait = { status: result.status, stdout: String(result.stdout) };
  }
  assert.equal(cliWait.status, 4);
  const cliWaiting = JSON.parse(cliWait.stdout);
  assert.equal(cliWaiting.status, "timeout");
  assert.equal(cliWaiting.publications.length, 2);
  assert.equal(cliWaiting.pending[0].turnHandle, encodeTurnHandle(target));
  await record("cli-wait-keeps-publication-and-terminal-separate", cliWait);
  await writeFile(finishGate, "finish now");
  const failed = await control.request("wait", {
    targets: [target],
    completion: "all",
  });
  assert.ok("result" in failed);
  assert.equal(failed.result.completed[0]!.stopReason, "failed");
  const failedReply = JSON.parse(failed.result.completed[0]!.finalReply!);
  assert.equal(failedReply.failureStatus, 7);
  assert.equal(failedReply.message, secondMessage);
  assert.deepEqual(failedReply.options, {});
  assert.equal(failed.result.publications?.length, 2);
  assert.equal(await cliDone, 0, cliStderr);
  assert.ok(
    cliEvents.some(
      (event) =>
        event.type === "turn.completed" && event.stopReason === "failed",
    ),
  );
  assert.ok(cliEvents.some((event) => event.type === "subscription.ended"));
  await record("task-failure-keeps-publications", {
    failed,
    cliEvents,
    failedReply,
  });
  subscription.close();
  await subscription.done;
  const observedBeforeDisconnect = observed.length;
  const thirdGate = join(root, "publish-third");
  const thirdFinished = join(root, "finish-third");
  const publishedFile = join(root, "third-published.json");
  const third = await control.request("send", {
    sessionId: activeSession,
    placement: "new_turn",
    message: JSON.stringify({
      path: "lost.txt",
      content: "query after disconnect\n",
      publish: true,
      publishAfterFile: thirdGate,
      finishAfterFile: thirdFinished,
      publishedFile,
    }),
  });
  assert.ok("result" in third);
  control.close();
  control = undefined;
  manager.close();
  await writeFile(thirdGate, "publish without observer");
  const workerPublication = await until(async () => {
    try {
      return JSON.parse(await readFile(publishedFile, "utf8"));
    } catch {
      return undefined;
    }
  });
  assert.equal(workerPublication.result.status, 0);
  manager = await connect("reins-wrr26-owner-a");
  const recovered = await manager.request(
    "publication.list",
    { cwd: root },
    600_000,
  );
  assert.equal(recovered.length, 3);
  const thirdPublication = JSON.parse(workerPublication.result.stdout);
  assert.ok(
    recovered.some(
      (publication) =>
        publication.publicationId === thirdPublication.publicationId,
    ),
  );
  assert.equal(observed.length, observedBeforeDisconnect);
  assert.deepEqual(await other.request("publication.list", { cwd: root }), []);
  assert.deepEqual(
    await manager.request("publication.list", { cwd: join(root, "other") }),
    [],
  );
  assert.deepEqual(await manager.receipts(receipts), []);
  await record("disconnected-without-observer-query-recovers", {
    workerPublication,
    recovered,
    observedBeforeDisconnect,
    observedAfter: observed.length,
    receipts: [],
  });
  control = await manager.control(root);
  assert.ok("result" in (await control.initialize()));
  await writeFile(thirdFinished, "finish after reconnect");
  const lastWait = await control.request("wait", {
    targets: [{ sessionId: activeSession, turnId: third.result.turnId }],
    completion: "all",
  });
  assert.ok("result" in lastWait);
  assert.equal(lastWait.result.completed[0]!.stopReason, "end_turn");
  assert.equal(lastWait.result.publications?.length, 3);
  const arrived = await manager.receivePublication(
    notification.publication.publicationId,
    { directory: receipts, activeRoot: root },
  );
  assert.equal(arrived.state, "arrived");
  assert.equal(
    await readFile(arrived.localPath, "utf8"),
    "second observation\n",
  );
  assert.equal(
    (await manager.request("publication.list", { cwd: root })).length,
    3,
  );
  await record("explicit-arrival-after-failed-task", { arrived, lastWait });
  await record("result", "passed");
} catch (error) {
  await record("failure", error);
  throw error;
} finally {
  if (cli && cli.exitCode === null && cli.signalCode === null)
    cli.kill("SIGTERM");
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
