import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { appendFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { createReinsClient, createWorkspaceClient } from "@reins/client";
import {
  consumerContextSchema,
  sessionNameSchema,
  type ProtocolMessage,
  type ProtocolEventNotification,
} from "@reins/protocol";
import { createUnixSocketClient } from "@reins/transport";
import type { WorkspaceMessage } from "@reins/workspace-protocol";
import * as v from "valibot";

const task = JSON.parse(process.argv[2]!) as {
  base: string;
  installed: string;
  worktree: string;
  env: NodeJS.ProcessEnv;
};
const execute = promisify(execFile);
const env = { ...process.env, ...task.env };
const original = v.parse(
  consumerContextSchema,
  task.env.REINS_CONSUMER_CONTEXT,
);
const replacement = v.parse(consumerContextSchema, "reins-wrr23-new-consumer");
const managerPath = join(task.installed, "dist/reins-workspace-manager.js");
const state = task.env.REINS_WORKSPACE_MANAGER_STATE_DIR!;
const record = async (name: string, value: unknown) =>
  appendFile(
    join(task.base, "evidence/recovery-facts.ndjson"),
    JSON.stringify({ name, value }) + "\n",
  );
async function command(
  binary: string,
  args: string[],
  overrides: NodeJS.ProcessEnv = {},
) {
  try {
    const result = await execute(binary, args, {
      env: { ...env, ...overrides },
      maxBuffer: 8 * 1024 * 1024,
    });
    return { status: 0, ...result };
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    return {
      status: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
}
async function connect(owner = original) {
  const client = createWorkspaceClient(
    await createUnixSocketClient<WorkspaceMessage>(
      task.env.REINS_WORKSPACE_MANAGER_SOCKET!,
    ),
    { consumerContext: owner },
  );
  await client.initialize();
  return client;
}
let manager = await connect();
let managerStopped = false;
async function stopManager() {
  const pids: number[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const args = await readFile(`/proc/${entry}/cmdline`, "utf8").catch(
      () => "",
    );
    if (args.split("\0").includes(managerPath)) pids.push(Number(entry));
  }
  assert.equal(pids.length, 1, JSON.stringify(pids));
  process.kill(pids[0]!, "SIGTERM");
  manager.close();
  while ((await readdir(join(state, ".."))).includes("manager-state.lock"))
    await delay(20);
  managerStopped = true;
  await record("managerStoppedWithoutWorkerTeardown", pids[0]);
}
async function restartManager(owner = original) {
  const child = spawn(process.execPath, [managerPath], {
    env,
    stdio: ["ignore", "ignore", "inherit"],
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  for (;;) {
    try {
      manager = await connect(owner);
      break;
    } catch (error) {
      assert.equal(exited, false, String(error));
      await delay(20);
    }
  }
  managerStopped = false;
  await record("managerRestarted", { pid: child.pid, owner });
}
async function admin(action: string, extra: string[] = []) {
  const result = await command(process.execPath, [
    managerPath,
    action,
    "--cwd",
    task.worktree,
    ...extra,
  ]);
  await record(`admin ${action}`, result);
  return result;
}
const controls: ReturnType<typeof createReinsClient>[] = [];
async function attach(owner = original) {
  await manager.request(
    "workspace.attach",
    { cwd: task.worktree, bindings: ["code"] },
    600_000,
  );
  for (;;) {
    const status = await manager.request(
      "workspace.status",
      { cwd: task.worktree },
      600_000,
    );
    if (status.runtime.status === "ready") break;
    assert.equal(status.runtime.status, "preparing", JSON.stringify(status));
    await delay(1000);
  }
  const route = await manager.request(
    "workspace.route",
    { cwd: task.worktree },
    600_000,
  );
  const control = createReinsClient(
    await createUnixSocketClient<ProtocolMessage>(route.socket),
    { consumerContext: owner },
  );
  assert.ok("result" in (await control.initialize()));
  controls.push(control);
  return control;
}
async function turn(
  control: ReturnType<typeof createReinsClient>,
  name: string,
  failTerminate = false,
) {
  const params = {
    harness: "codex",
    sessionName: v.parse(sessionNameSchema, name),
    cwd: task.worktree,
    message: JSON.stringify({
      path: "tracked.txt",
      ...(failTerminate ? { failTerminate: true } : {}),
    }),
  };
  const result = await control.request("spawn", params, 600_000);
  assert.ok("result" in result, JSON.stringify(result));
  const target = {
    sessionId: result.result.sessionId,
    turnId: result.result.turnId,
  };
  const observed: ProtocolEventNotification["params"][] = [];
  const unsubscribe = control.onNotification((notification) => {
    if (notification.method === "event") observed.push(notification.params);
  });
  const attached = await control.request("attach", {
    scope: "turn",
    ...target,
    replay: { mode: "available" },
  });
  assert.ok("result" in attached, JSON.stringify(attached));
  while (!observed.some((item) => item.event.type === "turn.completed"))
    await delay(10);
  unsubscribe();
  const waited = await control.request(
    "wait",
    { targets: [target], completion: "all" },
    600_000,
  );
  assert.ok("result" in waited, JSON.stringify(waited));
  assert.equal(waited.result.completed[0]?.stopReason, "end_turn");
  const reply = JSON.parse(waited.result.completed[0]!.finalReply!);
  assert.equal(reply.content, "native worktree\n");
  assert.equal(reply.cwd, task.worktree);
  assert.ok(reply.pid > 0);
  await record("actualWorkerTurn", { target, reply, observed });
  return { target, reply };
}
try {
  const control = await attach();
  const first = await turn(control, "original-worker");
  const beforeHistory = await manager.request("workspace.history", {
    cwd: task.worktree,
  });
  assert.ok(
    beforeHistory.entries.some((entry) =>
      entry.events.some((event) => event.event.type === "turn.completed"),
    ),
  );
  await record("originalHistory", beforeHistory);
  // 短命 CLI 完成并退出，不释放 attachment；另一消费者仍不能附着。
  const short = await command(process.execPath, [
    join(task.installed, "dist/reins.js"),
    "workspace",
    "status",
    "-C",
    task.worktree,
  ]);
  assert.equal(short.status, 0, short.stderr);
  await record("shortLauncherExited", short);
  const foreign = await connect(replacement);
  try {
    await assert.rejects(
      foreign.request("workspace.attach", {
        cwd: task.worktree,
        bindings: ["code"],
      }),
      { code: "attachment_owned" },
    );
  } finally {
    foreign.close();
  }
  const locked = await admin("inspect");
  assert.notEqual(locked.status, 0);
  await stopManager();
  const inspected = await admin("inspect");
  assert.equal(inspected.status, 0, inspected.stderr);
  const facts = JSON.parse(inspected.stdout);
  assert.equal(facts.consumerContext, original);
  assert.equal(facts.ownership, "attached");
  assert.equal(facts.runtime.status, "present");
  assert.equal(facts.runtime.running, true);
  assert.equal(facts.sessions.status, "available");
  assert.ok(
    facts.sessions.sessions.some(
      (session: { sessionId: string }) =>
        session.sessionId === first.target.sessionId,
    ),
  );
  assert.deepEqual(facts.history, beforeHistory);
  const pidAlive = await command("docker", [
    "exec",
    facts.runtime.containerId,
    "sh",
    "-c",
    'kill -0 "$1"',
    "sh",
    String(first.reply.pid),
  ]);
  assert.equal(pidAlive.status, 0, pidAlive.stderr);
  await record("oldWorkerStillAliveAfterLauncherAndManagerExit", {
    pid: first.reply.pid,
    ...pidAlive,
  });
  const recovery = await admin("recover");
  assert.equal(recovery.status, 0, recovery.stderr);
  assert.deepEqual(JSON.parse(recovery.stdout).binding, {
    REINS_CONSUMER_CONTEXT: original,
  });
  await restartManager(
    v.parse(
      consumerContextSchema,
      JSON.parse(recovery.stdout).binding.REINS_CONSUMER_CONTEXT,
    ),
  );
  const restored = await attach();
  const listed = await restored.request("list", {});
  assert.ok("result" in listed);
  assert.ok(
    listed.result.some(
      (session) => session.sessionId === first.target.sessionId,
    ),
  );
  assert.deepEqual(
    await manager.request("workspace.history", { cwd: task.worktree }),
    beforeHistory,
  );
  await record("originalBindingRestoredSameSessionAndHistory", listed);
  const failing = await turn(restored, "unstoppable-worker", true);
  await stopManager();
  const busy = await admin("release", [
    "--session-disposition",
    "require_none",
  ]);
  assert.notEqual(busy.status, 0);
  assert.match(busy.stderr, /workspace_busy/);
  const failed = await admin("release", ["--session-disposition", "kill"]);
  assert.notEqual(failed.status, 0);
  const retained = JSON.parse((await admin("inspect")).stdout);
  assert.equal(retained.ownership, "attached");
  assert.equal(retained.runtime.status, "present");
  assert.equal(retained.attachment.detachment.status, "failed");
  const stillAlive = await command("docker", [
    "exec",
    retained.runtime.containerId,
    "sh",
    "-c",
    'kill -0 "$1"',
    "sh",
    String(failing.reply.pid),
  ]);
  assert.equal(stillAlive.status, 0, stillAlive.stderr);
  await record("unprovedStopRefusesRelease", {
    retained,
    pid: failing.reply.pid,
    stillAlive,
  });
  await restartManager(replacement);
  await assert.rejects(
    manager.request("workspace.attach", {
      cwd: task.worktree,
      bindings: ["code"],
    }),
    { code: "workspace_detaching" },
  );
  await record("newConsumerRejectedBeforeProvedRelease", {
    oldContainer: retained.runtime.containerId,
    oldPid: failing.reply.pid,
  });
  await stopManager();
  // 管理员明确从 provider 终止隔离环境；随后相同 release 只续未完成步骤。
  const removed = await command("docker", [
    "rm",
    "-f",
    retained.runtime.containerId,
  ]);
  assert.equal(removed.status, 0, removed.stderr);
  await record("administratorExplicitProviderTermination", removed);
  const released = await admin("release", ["--session-disposition", "kill"]);
  assert.equal(released.status, 0, released.stderr);
  const releaseFacts = JSON.parse(released.stdout);
  assert.equal(releaseFacts.detachment.status, "released");
  assert.equal(releaseFacts.detachment.resources.ownership.status, "released");
  const missing = await command("docker", [
    "container",
    "ls",
    "-a",
    "--no-trunc",
    "--filter",
    "id=" + retained.runtime.containerId,
    "--format",
    "{{.ID}}",
  ]);
  assert.equal(missing.status, 0);
  assert.equal(missing.stdout.trim(), "");
  const releasedInspect = JSON.parse((await admin("inspect")).stdout);
  assert.equal(releasedInspect.ownership, "released");
  assert.deepEqual(
    releasedInspect.history.entries[0].events,
    retained.history.entries[0].events,
  );
  const noRecovery = await admin("recover");
  assert.notEqual(noRecovery.status, 0);
  assert.match(noRecovery.stderr, /attachment_not_found/);
  await restartManager(replacement);
  const next = await attach(replacement);
  const empty = await next.request("list", {});
  assert.ok("result" in empty);
  assert.deepEqual(empty.result, []);
  const hidden = await next.request("wait", {
    targets: [first.target],
    completion: "all",
    timeoutMs: 0,
  });
  assert.ok("error" in hidden, JSON.stringify(hidden));
  assert.equal(hidden.error.code, "session_not_found");
  await record("oldSessionNotInherited", hidden);
  const newHistory = await manager.request("workspace.history", {
    cwd: task.worktree,
  });
  assert.equal(newHistory.entries.length, 1);
  assert.deepEqual(newHistory.entries[0]!.events, []);
  const oldReader = await connect(original);
  const oldHistory = await oldReader.request("workspace.history", {
    cwd: task.worktree,
  });
  assert.deepEqual(
    oldHistory.entries[0]!.events,
    retained.history.entries[0].events,
  );
  oldReader.close();
  const nextTurn = await turn(next, "new-consumer-worker");
  assert.notEqual(nextTurn.target.sessionId, first.target.sessionId);
  await record("newConsumerIndependentLineage", {
    empty,
    newHistory,
    oldHistory,
    nextTurn,
  });
  const cleanup = await manager.request(
    "workspace.detach",
    { cwd: task.worktree, sessionDisposition: "kill" },
    600_000,
  );
  assert.equal(cleanup.detachment?.status, "released");
  await record("newConsumerReleased", cleanup);
} finally {
  for (const control of controls) control.close();
  if (managerStopped) await restartManager();
  try {
    const cleanup = await manager.request(
      "workspace.detach",
      { cwd: task.worktree, sessionDisposition: "kill" },
      600_000,
    );
    await record("finalProductCleanup", cleanup);
  } catch (error) {
    await record("finalProductCleanupError", error);
  }
  await stopManager();
}
