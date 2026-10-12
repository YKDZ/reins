import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createReinsClient } from "@reins/client";
import {
  consumerContextSchema,
  decodeTurnHandle,
  type DomainEvent,
  type ProtocolMessage,
} from "@reins/protocol";
import { createUnixSocketClient } from "@reins/transport";
import {
  connect as connectSdk,
  type AgentFact,
  type ReinsConnection,
  type SpawnInput,
  type TurnHandle,
} from "@ykdz/reins-sdk";
import * as v from "valibot";
import { afterEach, expect, test, vi } from "vitest";

import {
  controlData,
  killWithControlCli,
  spawnWithControlCli,
  type ControlCliRunner,
} from "./fixtures/control-cli.ts";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const cliBin = join(repo, "apps/cli/dist/reins.js");
const daemonBin = join(repo, "packages/daemon/dist/main.js");
const adapters = fileURLToPath(
  new URL("./fixtures/cwd-adapters.ts", import.meta.url),
);
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
});

async function fixture(prefix = "reins-wrr03") {
  const root = await mkdtemp(join(tmpdir(), prefix + "-cwd-"));
  const runtime = await mkdtemp("/dev/shm/" + prefix + "-runtime-");
  cleanup.push(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  });
  const daemonCwd = join(root, "daemon");
  const callerCwd = join(root, "caller", "nested");
  await mkdir(daemonCwd, { recursive: true });
  await mkdir(callerCwd, { recursive: true });
  await writeFile(join(daemonCwd, "marker.txt"), "daemon-owned-marker");
  await writeFile(join(callerCwd, "marker.txt"), "caller-owned-marker");
  const env = {
    ...process.env,
    REINS_SOCKET: join(runtime, "reins.sock"),
    REINS_STATE_DIR: join(runtime, "state"),
    REINS_CONSUMER_CONTEXT: "cwd-test",
    REINS_DAEMON_BIN: daemonBin,
  };
  const daemon: ChildProcess = spawn(
    process.execPath,
    [daemonBin, "--adapters", adapters],
    { cwd: daemonCwd, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const errors: string[] = [];
  daemon.stderr?.on("data", (chunk) => errors.push(String(chunk)));
  cleanup.push(async () => {
    if (daemon.exitCode !== null || daemon.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      daemon.once("close", () => resolve());
      daemon.kill("SIGTERM");
    });
  });
  async function cli(
    args: readonly string[],
    cwd = callerCwd,
    commandEnv: NodeJS.ProcessEnv = env,
  ) {
    const child = spawn(process.execPath, [cliBin, ...args], {
      env: commandEnv,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    const exitCode = await new Promise<number | null>((resolve) =>
      child.once("close", resolve),
    );
    return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
  }
  const runControlCli: ControlCliRunner = (args, commandEnv, cwd) =>
    cli(args, cwd, commandEnv);
  await vi.waitFor(async () => {
    expect(daemon.exitCode, errors.join("")).toBeNull();
    await access(env.REINS_SOCKET);
    const result = await cli(["list"]);
    expect(result.exitCode, result.stderr + errors.join("")).toBe(0);
    expect(controlData(result).sessions).toEqual([]);
  });
  async function client(consumerContext = env.REINS_CONSUMER_CONTEXT) {
    const connection = await createUnixSocketClient<ProtocolMessage>(
      env.REINS_SOCKET,
    );
    const client = createReinsClient(connection, {
      consumerContext: v.parse(consumerContextSchema, consumerContext),
    });
    cleanup.push(async () => client.close());
    expect(await client.initialize()).toHaveProperty("result");
    return client;
  }
  async function sdk() {
    const connection = await connectSdk({
      socketPath: env.REINS_SOCKET,
      consumerContext: env.REINS_CONSUMER_CONTEXT,
    });
    cleanup.push(async () => connection.close());
    return connection;
  }
  return {
    root,
    runtime,
    daemonCwd,
    callerCwd,
    env,
    cli,
    client,
    sdk,
    runControlCli,
  };
}

async function awaitTurnCompletion(
  subscription: Awaited<ReturnType<ReinsConnection["attach"]>>,
): Promise<Extract<AgentFact, { type: "turn.completed" }>> {
  let completed: Extract<AgentFact, { type: "turn.completed" }> | undefined;
  try {
    for await (const fact of subscription) {
      if (fact.type === "turn.completed") completed = fact;
    }
    await subscription.done;
  } finally {
    subscription.close();
  }
  if (completed === undefined) throw new Error("SDK 未报告回合结束事实");
  return completed;
}

async function prepareOperation(
  cli: Awaited<ReturnType<typeof fixture>>["cli"],
  callerCwd: string,
  env: NodeJS.ProcessEnv,
  operation: "send" | "interrupt",
): Promise<string> {
  const result = await cli(["prepare-operation", operation], callerCwd, env);
  expect(result.exitCode, result.stderr + result.stdout).toBe(0);
  const credential = controlData(result).credential;
  expect(typeof credential).toBe("string");
  return credential as string;
}

test("local CLI projects its cwd into an already running daemon and the worker really reads there", async () => {
  const {
    callerCwd,
    daemonCwd,
    cli,
    client: connectClient,
    env,
    runControlCli,
    sdk,
  } = await fixture();
  const spawned = await spawnWithControlCli(runControlCli, env, callerCwd, {
    sessionName: "directory",
    harness: "codex",
    message: "read-marker",
    cwd: callerCwd,
  });
  expect(spawned.exitCode, spawned.stderr).toBe(0);
  const ack = controlData(spawned) as {
    sessionHandle: string;
    cwd: string;
    turnHandle: string;
  };
  expect(ack).toMatchObject({
    cwd: callerCwd,
    turnHandle: expect.stringMatching(/^[a-z0-9@/.-]+$/u),
  });
  const connection = await sdk();
  const completionSubscription = await connection.attach(
    { scope: "turn", turnHandle: ack.turnHandle as TurnHandle },
    { mode: "available" },
  );
  const completed = await awaitTurnCompletion(completionSubscription);
  expect(JSON.parse(completed.finalReply ?? "null")).toEqual({
    cwd: callerCwd,
    marker: "caller-owned-marker",
  });
  expect(Object.keys(ack).sort()).toEqual([
    "cwd",
    "sessionHandle",
    "turnHandle",
  ]);
  const target = decodeTurnHandle(ack.turnHandle);
  expect(target.sessionId).toBe(ack.sessionHandle);
  const client = await connectClient();
  const events: DomainEvent[] = [];
  client.onNotification((notification) => {
    if (notification.method === "event") events.push(notification.params.event);
  });
  expect(
    await client.request("attach", {
      scope: "session",
      sessionId: target.sessionId,
      replay: { mode: "available" },
    }),
  ).toHaveProperty("result");
  await vi.waitFor(() =>
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.created",
        sessionId: target.sessionId,
        cwd: callerCwd,
      }),
    ),
  );
  expect(events).toContainEqual(
    expect.objectContaining({ type: "turn.started", ...target }),
  );
  expect(
    controlData(await cli(["list", "--session", ack.sessionHandle])).sessions,
  ).toMatchObject([
    {
      sessionHandle: ack.sessionHandle,
      cwd: callerCwd,
      lastCompletedTurn: { turnHandle: ack.turnHandle },
    },
  ]);
  const foreign = await connectClient("foreign-consumer");
  expect(
    await foreign.request("list", { sessionId: target.sessionId }),
  ).toMatchObject({ result: [] });
  const explicit = await spawnWithControlCli(runControlCli, env, callerCwd, {
    sessionName: "explicit",
    harness: "codex",
    message: "read-marker",
    cwd: daemonCwd,
  });
  expect(explicit.exitCode, explicit.stdout).toBe(0);
  const explicitAck = controlData(explicit) as {
    turnHandle: string;
    sessionHandle: string;
    cwd: string;
  };
  expect(explicitAck.cwd).toBe(daemonCwd);
  const explicitSubscription = await connection.attach(
    { scope: "turn", turnHandle: explicitAck.turnHandle as TurnHandle },
    { mode: "available" },
  );
  const explicitCompleted = await awaitTurnCompletion(explicitSubscription);
  expect(JSON.parse(explicitCompleted.finalReply ?? "null")).toEqual({
    cwd: daemonCwd,
    marker: "daemon-owned-marker",
  });
});

test("public SDK delegates cwd reality checks to the daemon before creating a session", async () => {
  const { root, callerCwd, sdk } = await fixture();
  const connection = await sdk();
  for (const [index, cwd] of [
    "relative",
    join(root, "absent"),
    join(callerCwd, "marker.txt"),
  ].entries()) {
    const input = {
      sessionName: `invalid-${index}`,
      harness: "codex",
      message: "read-marker",
      cwd,
    } as unknown as SpawnInput;
    const credential = connection.prepareOperation("spawn");
    await expect(connection.spawn(input, credential)).rejects.toMatchObject({
      failure: {
        code: "invalid_params",
        facts: {
          issues: [expect.objectContaining({ path: "cwd" })],
        },
      },
    });
    expect(await connection.list()).toEqual([]);
  }
});

test("session snapshots keep the exact active or completed turn without stale active fields", async () => {
  const { cli, callerCwd, env, runControlCli, sdk } = await fixture();
  const spawned = await spawnWithControlCli(runControlCli, env, callerCwd, {
    sessionName: "snapshot",
    harness: "codex",
    message: "hold",
    cwd: callerCwd,
  });
  expect(spawned.exitCode, spawned.stdout).toBe(0);
  const ack = controlData(spawned) as {
    sessionHandle: string;
    turnHandle: string;
  };
  const busy = controlData(await cli(["list"])).sessions as Record<
    string,
    unknown
  >[];
  expect(busy).toMatchObject([
    {
      sessionHandle: ack.sessionHandle,
      state: "busy",
      activeTurn: ack.turnHandle,
    },
  ]);
  expect(busy[0]).not.toHaveProperty("lastCompletedTurn");
  const connection = await sdk();
  const completionSubscription = await connection.attach(
    { scope: "turn", turnHandle: ack.turnHandle as TurnHandle },
    { mode: "none" },
  );
  await writeFile(join(callerCwd, "release"), "finish");
  expect((await awaitTurnCompletion(completionSubscription)).stopReason).toBe(
    "end_turn",
  );
  const idle = controlData(await cli(["list"])).sessions as Record<
    string,
    unknown
  >[];
  expect(idle).toMatchObject([
    {
      state: "idle",
      lastCompletedTurn: { turnHandle: ack.turnHandle, stopReason: "end_turn" },
    },
  ]);
  expect(idle[0]).not.toHaveProperty("activeTurn");
  expect(
    (await killWithControlCli(runControlCli, env, callerCwd, ack.sessionHandle))
      .exitCode,
  ).toBe(0);
  const killed = controlData(await cli(["list"])).sessions as Record<
    string,
    unknown
  >[];
  expect(killed).toMatchObject([
    {
      state: "killed",
      lastCompletedTurn: { turnHandle: ack.turnHandle, stopReason: "end_turn" },
    },
  ]);
  expect(killed[0]).not.toHaveProperty("activeTurn");
});

test("CLI send preserves the explicit turn and original message", async () => {
  const { cli, callerCwd, env, runControlCli } = await fixture(
    "reins-wrr06-placement",
  );
  const created = await spawnWithControlCli(runControlCli, env, callerCwd, {
    sessionName: "placement",
    harness: "codex",
    message: "hold",
    cwd: callerCwd,
  });
  expect(created.exitCode).toBe(0);
  const initial = controlData(created) as {
    sessionHandle: string;
    turnHandle: string;
  };
  const exactMessage = "  active task\nkeep spacing  ";
  const busyCredential = await prepareOperation(cli, callerCwd, env, "send");
  const busy = await cli(
    [
      "send",
      initial.sessionHandle,
      "--placement",
      "new_turn",
      "--message",
      exactMessage,
      "--operation",
      busyCredential,
    ],
    callerCwd,
    env,
  );
  expect(busy.exitCode).toBe(70);
  expect(busy.stdout + busy.stderr).toContain("session_busy");

  const activeCredential = await prepareOperation(cli, callerCwd, env, "send");
  const active = await cli(
    [
      "send",
      initial.turnHandle,
      "--placement",
      "active_turn",
      "--message",
      exactMessage,
      "--operation",
      activeCredential,
    ],
    callerCwd,
    env,
  );
  expect(active.exitCode, active.stderr).toBe(0);
  expect(controlData(active)).toMatchObject({
    sessionHandle: initial.sessionHandle,
    turnHandle: initial.turnHandle,
    deliveryPoint: "active_turn",
  });
  await writeFile(join(callerCwd, "release"), "released");
  const completed = await cli(
    ["wait", initial.turnHandle, "--completion", "all", "--timeout", "5000"],
    callerCwd,
    env,
  );
  expect(completed.exitCode, completed.stderr).toBe(0);
  expect(JSON.parse(completed.stdout).data.result.completed).toEqual([
    expect.objectContaining({
      turnHandle: initial.turnHandle,
      stopReason: "end_turn",
    }),
  ]);

  const staleCredential = await prepareOperation(cli, callerCwd, env, "send");
  const ended = await cli(
    [
      "send",
      initial.turnHandle,
      "--placement",
      "active_turn",
      "--message",
      "late task",
      "--operation",
      staleCredential,
    ],
    callerCwd,
    env,
  );
  expect(ended.exitCode).toBe(70);
  expect(ended.stdout + ended.stderr).toContain("turn_not_active");

  const nextCredential = await prepareOperation(cli, callerCwd, env, "send");
  const next = await cli(
    [
      "send",
      initial.sessionHandle,
      "--placement",
      "new_turn",
      "--message",
      "next task",
      "--operation",
      nextCredential,
    ],
    callerCwd,
    env,
  );
  expect(next.exitCode, next.stderr).toBe(0);
  const nextAck = controlData(next) as {
    sessionHandle: string;
    turnHandle: string;
    deliveryPoint: string;
  };
  expect(nextAck.sessionHandle).toBe(initial.sessionHandle);
  expect(nextAck.turnHandle).not.toBe(initial.turnHandle);
  expect(nextAck.deliveryPoint).toBe("new_turn");
  expect(decodeTurnHandle(nextAck.turnHandle).sessionId).toBe(
    initial.sessionHandle,
  );
  const nextWait = await cli(
    ["wait", nextAck.turnHandle, "--completion", "all"],
    callerCwd,
    env,
  );
  expect(nextWait.exitCode, nextWait.stderr).toBe(0);
  expect(JSON.parse(nextWait.stdout).data.result.completed).toEqual([
    expect.objectContaining({
      turnHandle: nextAck.turnHandle,
    }),
  ]);

  const unspecified = await cli(
    ["send", initial.sessionHandle, "--message", "missing placement"],
    callerCwd,
    env,
  );
  expect(unspecified.exitCode).toBe(64);
});

test("interrupt ACK is accepted before the exact turn reaches its terminal fact", async () => {
  const { cli, callerCwd, env, runControlCli } = await fixture("reins-wrr16");
  const created = await spawnWithControlCli(runControlCli, env, callerCwd, {
    sessionName: "exact-interrupt",
    harness: "codex",
    message: "hold",
    cwd: callerCwd,
  });
  expect(created.exitCode, created.stderr).toBe(0);
  const original = controlData(created) as {
    sessionHandle: string;
    turnHandle: string;
  };
  const credential = await prepareOperation(cli, callerCwd, env, "interrupt");
  const accepted = await cli(
    ["interrupt", original.turnHandle, "--operation", credential],
    callerCwd,
    env,
  );
  expect(accepted.exitCode, accepted.stdout + accepted.stderr).toBe(0);
  expect(controlData(accepted)).toEqual({
    turnHandle: original.turnHandle,
    status: "accepted",
  });
  expect(
    controlData(await cli(["list"], callerCwd, env)).sessions,
  ).toMatchObject([{ sessionHandle: original.sessionHandle, state: "busy" }]);

  const pending = await cli(
    ["wait", original.turnHandle, "--completion", "all", "--timeout", "0"],
    callerCwd,
    env,
  );
  expect(pending.exitCode).toBe(4);
  expect(JSON.parse(pending.stdout).data.result).toEqual({
    status: "timeout",
    completed: [],
    pending: [{ turnHandle: original.turnHandle }],
  });

  const incompleteCredential = await prepareOperation(
    cli,
    callerCwd,
    env,
    "interrupt",
  );
  const incomplete = await cli(
    ["interrupt", original.sessionHandle, "--operation", incompleteCredential],
    callerCwd,
    env,
  );
  expect(incomplete.exitCode).toBe(70);
  expect(incomplete.stdout + incomplete.stderr).toContain("invalid_params");

  const multipleCredential = await prepareOperation(
    cli,
    callerCwd,
    env,
    "interrupt",
  );
  const multiple = await cli(
    [
      "interrupt",
      original.turnHandle,
      original.turnHandle,
      "--operation",
      multipleCredential,
    ],
    callerCwd,
    env,
  );
  expect(multiple.exitCode).toBe(64);

  await writeFile(join(callerCwd, "release"), "released");
  await vi.waitFor(async () =>
    expect(
      controlData(await cli(["list"], callerCwd, env)).sessions,
    ).toMatchObject([{ state: "idle" }]),
  );
  const staleCredential = await prepareOperation(
    cli,
    callerCwd,
    env,
    "interrupt",
  );
  const stale = await cli(
    ["interrupt", original.turnHandle, "--operation", staleCredential],
    callerCwd,
    env,
  );
  expect(stale.exitCode).toBe(70);
  expect(stale.stdout + stale.stderr).toContain("turn_not_active");
  const terminal = await cli(
    ["wait", original.turnHandle, "--completion", "all"],
    callerCwd,
    env,
  );
  expect(terminal.exitCode, terminal.stderr).toBe(0);
  expect(JSON.parse(terminal.stdout).data.result.completed).toEqual([
    expect.objectContaining({
      turnHandle: original.turnHandle,
      stopReason: "end_turn",
    }),
  ]);
});
