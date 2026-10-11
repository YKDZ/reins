import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { createReinsClient, createWorkspaceClient } from "@reins/client";
import {
  consumerContextSchema,
  sessionNameSchema,
  type ProtocolEventNotification,
  type ProtocolMessage,
} from "@reins/protocol";
import { createUnixSocketClient } from "@reins/transport";
import type { WorkspaceMessage } from "@reins/workspace-protocol";
import * as v from "valibot";

const task = JSON.parse(process.argv[2]!) as {
  base: string;
  installed: string;
  worktree: string;
  git: string;
  env: NodeJS.ProcessEnv;
};
const execute = promisify(execFile);
const env = { ...process.env, ...task.env };
const owner = v.parse(consumerContextSchema, task.env.REINS_CONSUMER_CONTEXT);
const managerPath = join(task.installed, "dist", "reins-workspace-manager.js");
const state = task.env.REINS_WORKSPACE_MANAGER_STATE_DIR!;
const record = async (name: string, value: unknown) =>
  appendFile(
    join(task.base, "evidence", "history-facts.ndjson"),
    JSON.stringify({ name, value }) + "\n",
  );
async function connect(consumer = owner) {
  const client = createWorkspaceClient(
    await createUnixSocketClient<WorkspaceMessage>(
      task.env.REINS_WORKSPACE_MANAGER_SOCKET!,
    ),
    { consumerContext: consumer },
  );
  await client.initialize();
  return client;
}
let manager = await connect();
let attached = false;
async function stopManager() {
  const pids: number[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const command = await readFile(`/proc/${entry}/cmdline`, "utf8").catch(
      () => "",
    );
    if (command.split("\0").includes(managerPath)) pids.push(Number(entry));
  }
  assert.equal(pids.length, 1, JSON.stringify(pids));
  process.kill(pids[0]!, "SIGTERM");
  manager.close();
  while ((await readdir(join(state, ".."))).includes("manager-state.lock"))
    await delay(20);
  await record("managerStopped", pids[0]);
}
async function restartManager() {
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
      manager = await connect();
      break;
    } catch (error) {
      assert.equal(exited, false, JSON.stringify(error));
      await delay(20);
    }
  }
  await record("managerRestarted", child.pid);
}
const history = () =>
  manager.request("workspace.history", { cwd: task.worktree });
const allHistory = () =>
  manager.request("workspace.history", {
    cwd: task.worktree,
    allWorktrees: true,
  });
async function detach() {
  const result = await manager.request(
    "workspace.detach",
    { cwd: task.worktree, sessionDisposition: "kill" },
    600_000,
  );
  assert.equal(result.detachment?.status, "released", JSON.stringify(result));
  attached = false;
  await record("detached", result);
}
async function openControl() {
  await manager.request(
    "workspace.attach",
    { cwd: task.worktree, bindings: ["code"] },
    600_000,
  );
  attached = true;
  for (;;) {
    const current = await manager.request(
      "workspace.status",
      { cwd: task.worktree },
      600_000,
    );
    if (current.runtime.status === "ready") break;
    assert.equal(current.runtime.status, "preparing", JSON.stringify(current));
    await delay(2000);
  }
  const route = await manager.request(
    "workspace.route",
    { cwd: task.worktree },
    600_000,
  );
  const client = createReinsClient(
    await createUnixSocketClient<ProtocolMessage>(route.socket),
    { consumerContext: owner },
  );
  assert.ok("result" in (await client.initialize()));
  return client;
}
type Control = Awaited<ReturnType<typeof openControl>>;
async function turn(control: Control, name: string) {
  const params = {
    harness: "codex",
    sessionName: v.parse(sessionNameSchema, name),
    cwd: task.worktree,
    message: JSON.stringify({ path: "tracked.txt" }),
  };
  await manager.request(
    "workspace.admit",
    { cwd: task.worktree, action: "spawn", params },
    600_000,
  );
  const spawned = await control.request("spawn", params, 600_000);
  assert.ok("result" in spawned, JSON.stringify(spawned));
  const observed: ProtocolEventNotification["params"][] = [];
  const unsubscribe = control.onNotification((notification) => {
    if (notification.method === "event") observed.push(notification.params);
  });
  const target = {
    sessionId: spawned.result.sessionId,
    turnId: spawned.result.turnId,
  };
  const attached = await control.request("attach", {
    scope: "turn",
    ...target,
    replay: { mode: "available" },
  });
  assert.ok("result" in attached, JSON.stringify(attached));
  while (!observed.some((item) => item.event.type === "turn.completed"))
    await delay(10);
  unsubscribe();
  const waited = await control.request("wait", {
    targets: [target],
    completion: "all",
  });
  assert.ok("result" in waited, JSON.stringify(waited));
  await record(name, { observed, waited });
  return { observed, waited, target };
}
const events = (value: Awaited<ReturnType<typeof history>>) =>
  value.entries.flatMap((entry) => entry.events);
try {
  const empty = await history();
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.integrity, "unknown");
  let control = await openControl();
  try {
    const first = await turn(control, "history-first");
    const retained = await history();
    assert.deepEqual(
      events(retained).map(({ eventId, event }) => ({ eventId, event })),
      first.observed.map(({ eventId, event }) => ({ eventId, event })),
      "Consumed typed events must survive outside the runtime",
    );
    assert.equal(retained.entries[0]?.health.status, "available");
    await record("retained", { observed: first.observed, history: retained });
    const replayed = await control.request("attach", {
      scope: "turn",
      ...first.target,
      replay: { mode: "available" },
    });
    assert.ok("result" in replayed);
    assert.deepEqual(
      await history(),
      retained,
      "Repeated delivery must not duplicate history",
    );
    const projected = await manager.history({ cwd: task.worktree });
    const cli = await execute(
      process.execPath,
      [
        join(task.installed, "dist", "reins.js"),
        "workspace",
        "history",
        "-C",
        task.worktree,
      ],
      { env },
    );
    assert.deepEqual(JSON.parse(cli.stdout), projected);
    const presentation = projected.entries.flatMap((entry) => entry.events);
    assert.deepEqual(
      presentation.map((event) => event.type),
      ["turn.started", "text", "turn.completed"],
    );
    assert.ok(
      presentation.every(
        (event) =>
          !("sessionId" in event) &&
          !("eventId" in event) &&
          !("messageId" in event),
      ),
    );
    await record("publicHistory", projected);
    const foreign = await connect(
      v.parse(consumerContextSchema, "reins-wrr22-owner-b"),
    );
    try {
      assert.deepEqual(
        (
          await foreign.request("workspace.history", {
            cwd: task.worktree,
            allWorktrees: true,
          })
        ).entries,
        [],
      );
    } finally {
      foreign.close();
    }
  } finally {
    control.close();
  }
  await detach();
  const detached = await history();
  assert.equal(events(detached).length, 3);
  await stopManager();
  await restartManager();
  assert.deepEqual(
    await history(),
    detached,
    "Manager restart must preserve detached history",
  );
  control = await openControl();
  try {
    const before = await control.request("list", {});
    assert.ok("result" in before, JSON.stringify(before));
    assert.deepEqual(before.result, []);
    const second = await turn(control, "history-second");
    const across = await history();
    assert.equal(across.entries.length, 2);
    assert.equal(events(across).length, 6);
    assert.equal(
      new Set(events(across).map((item) => item.daemonGeneration)).size,
      2,
    );
    const current = await control.request("list", {});
    assert.ok("result" in current);
    assert.deepEqual(
      current.result.map((session) => session.sessionId),
      [second.target.sessionId],
    );
    await record("crossGeneration", { history: across, current });
    // 仅破坏独立历史文件，不改变真实 worker、运行时或其终态存储。
    const logs: string[] = [];
    for (const directory of await readdir(state)) {
      const path = join(state, directory, "history.ndjson");
      if (
        (await readFile(path, "utf8").catch(() => "")).includes(
          second.target.sessionId,
        )
      )
        logs.push(path);
    }
    assert.equal(logs.length, 1);
    const log = logs[0]!;
    await rename(log, `${log}.saved`);
    await mkdir(log);
    try {
      const faulted = await turn(control, "history-write-fault");
      const damaged = await history();
      assert.ok(
        damaged.entries.some(
          (entry) =>
            entry.health.errors.includes("write_failed") &&
            entry.health.errors.includes("read_failed"),
        ),
      );
      assert.equal(damaged.integrity, "unknown");
      assert.ok(
        !events(damaged).some(
          (item) => item.event.sessionId === faulted.target.sessionId,
        ),
      );
      const known = await control.request("wait", {
        targets: [second.target],
        completion: "all",
      });
      assert.deepEqual(
        "result" in known ? known.result : known,
        "result" in second.waited ? second.waited.result : second.waited,
        "History failure must not rewrite a known turn result",
      );
      await record("writeFailure", { damaged, faulted, known });
    } finally {
      await rm(log, { recursive: true });
      await rename(`${log}.saved`, log);
    }
    const saved = await readFile(log);
    await appendFile(log, '{"truncated":');
    const incomplete = await history();
    assert.equal(events(incomplete).length, 6);
    assert.ok(
      incomplete.entries.some((entry) =>
        entry.health.errors.includes("read_failed"),
      ),
    );
    assert.equal(incomplete.integrity, "unknown");
    await record("readFailure", incomplete);
    await writeFile(log, saved);
  } finally {
    control.close();
  }
  await detach();
  const old = await allHistory();
  const configuration = await readFile(
    join(task.worktree, ".reins", "workspace.json"),
  );
  const retired = join(task.base, "retired-worktree");
  await execute("git", [
    "-C",
    task.git,
    "worktree",
    "move",
    task.worktree,
    retired,
  ]);
  await execute("git", [
    "-C",
    task.git,
    "worktree",
    "add",
    "--quiet",
    "-b",
    "replacement",
    task.worktree,
  ]);
  await execute("git", [
    "-C",
    task.git,
    "worktree",
    "remove",
    "--force",
    retired,
  ]);
  await mkdir(join(task.worktree, ".reins"));
  await writeFile(
    join(task.worktree, ".reins", "workspace.json"),
    configuration,
  );
  assert.deepEqual(
    (await history()).entries,
    [],
    "A new object at the same path starts a new lineage",
  );
  assert.deepEqual(await allHistory(), old);
  await record("replacementTree", {
    current: await history(),
    all: await allHistory(),
  });
  await stopManager();
  const unrelatedDeletion = await execute(
    process.execPath,
    [
      managerPath,
      "history-delete",
      "--consumer-context",
      owner,
      "--cwd",
      task.worktree,
    ],
    { env },
  );
  assert.equal(JSON.parse(unrelatedDeletion.stdout).deleted, 0);
  const deletion = await execute(
    process.execPath,
    [
      managerPath,
      "history-delete",
      "--consumer-context",
      owner,
      "--all-worktrees",
    ],
    { env },
  );
  await record("historyDeletion", deletion);
  assert.equal(
    JSON.parse(deletion.stdout).deleted,
    2,
    "Explicit administration must delete history independently of detach",
  );
  await restartManager();
  const deleted = await allHistory();
  assert.deepEqual(events(deleted), []);
  assert.ok(
    deleted.entries.every((entry) => entry.health.status === "deleted"),
  );
  assert.equal(
    await readFile(join(task.worktree, "tracked.txt"), "utf8"),
    "native worktree\n",
  );
  await record("deletedHistory", deleted);
} finally {
  try {
    if (attached)
      await record(
        "cleanup",
        await manager.request(
          "workspace.detach",
          { cwd: task.worktree, sessionDisposition: "kill" },
          600_000,
        ),
      );
  } finally {
    manager.close();
  }
}
