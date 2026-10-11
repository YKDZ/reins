import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createReinsClient } from "@reins/client";
import {
  consumerContextSchema,
  decodeTurnHandle,
  type DomainEvent,
  type ProtocolMessage,
  type SpawnParams,
} from "@reins/protocol";
import { createUnixSocketClient } from "@reins/transport";
import * as v from "valibot";
import { afterEach, expect, test, vi } from "vitest";

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
  async function cli(args: string[], cwd = callerCwd) {
    const child = spawn(process.execPath, [cliBin, ...args], {
      env,
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
  await vi.waitFor(async () => {
    expect(daemon.exitCode, errors.join("")).toBeNull();
    await access(env.REINS_SOCKET);
    const result = await cli(["list"]);
    expect(result.exitCode, result.stderr + errors.join("")).toBe(0);
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
  return { root, runtime, daemonCwd, callerCwd, env, cli, client };
}

test("local CLI projects its cwd into an already running daemon and the worker really reads there", async () => {
  const { callerCwd, daemonCwd, cli, client: connectClient } = await fixture();
  const spawned = await cli([
    "spawn",
    "codex",
    "read-marker",
    "--name",
    "directory",
  ]);
  expect(spawned.exitCode, spawned.stderr).toBe(0);
  const ack = JSON.parse(spawned.stdout) as {
    sessionId: string;
    cwd: string;
    turnHandle: string;
  };
  expect(ack).toMatchObject({
    cwd: callerCwd,
    turnHandle: expect.stringMatching(/^[a-z0-9@/.-]+$/u),
  });
  const waited = await cli(["wait", ack.sessionId, "--timeout", "5000"]);
  expect(waited.exitCode, waited.stderr).toBe(0);
  const waitResult = JSON.parse(waited.stdout) as {
    results: { turn: { finalReply: string } }[];
  };
  expect(JSON.parse(waitResult.results[0]!.turn.finalReply)).toEqual({
    cwd: callerCwd,
    marker: "caller-owned-marker",
  });
  expect(Object.keys(ack).sort()).toEqual(["cwd", "sessionId", "turnHandle"]);
  const target = decodeTurnHandle(ack.turnHandle);
  expect(target.sessionId).toBe(ack.sessionId);
  const client = await connectClient();
  const events: DomainEvent[] = [];
  client.onNotification((notification) => {
    if (notification.method === "event") events.push(notification.params);
  });
  expect(
    await client.request("attach", { sessionId: target.sessionId, replay: 10 }),
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
    JSON.parse((await cli(["list", "--session", ack.sessionId])).stdout),
  ).toMatchObject([
    {
      sessionId: ack.sessionId,
      cwd: callerCwd,
      lastCompletedTurn: { turnHandle: ack.turnHandle },
    },
  ]);
  const foreign = await connectClient("foreign-consumer");
  expect(
    await foreign.request("list", { sessionId: target.sessionId }),
  ).toMatchObject({ result: [] });
  const explicit = await cli([
    "spawn",
    "codex",
    "read-marker",
    "--name",
    "explicit",
    "--cwd",
    "../../daemon",
  ]);
  expect(explicit.exitCode, explicit.stdout).toBe(0);
  const explicitAck = JSON.parse(explicit.stdout) as {
    sessionId: string;
    cwd: string;
  };
  expect(explicitAck.cwd).toBe(daemonCwd);
  const explicitWait = JSON.parse(
    (await cli(["wait", explicitAck.sessionId, "--timeout", "5000"])).stdout,
  ) as { results: { turn: { finalReply: string } }[] };
  expect(JSON.parse(explicitWait.results[0]!.turn.finalReply)).toEqual({
    cwd: daemonCwd,
    marker: "daemon-owned-marker",
  });
  const pretty = await cli([
    "spawn",
    "codex",
    "read-marker",
    "--name",
    "pretty",
    "--pretty",
  ]);
  expect(pretty.exitCode, pretty.stderr).toBe(0);
  expect(pretty.stdout).toContain("Created session pretty@g");
  expect(pretty.stdout).toContain("\nTurn pretty@g");
  expect(pretty.stdout).toContain(`\nWorking directory ${callerCwd}\n`);
});

test("raw client rejects missing, relative and unavailable daemon-native directories before creating a session", async () => {
  const { root, callerCwd, client: connectClient } = await fixture();
  const client = await connectClient();
  for (const [index, cwd] of [
    undefined,
    "relative",
    join(root, "absent"),
    join(callerCwd, "marker.txt"),
  ].entries()) {
    const params = {
      harness: "codex",
      sessionName: `invalid-${index}`,
      message: "read-marker",
      ...(cwd === undefined ? {} : { cwd }),
    } as unknown as SpawnParams;
    const response = await client.request("spawn", params);
    expect(response).toMatchObject({
      error: {
        code: "invalid_params",
        issues: [expect.objectContaining({ path: "cwd" })],
      },
    });
    expect(await client.request("list", {})).toMatchObject({ result: [] });
  }
});

test("local path projection accepts the same directory identity and rejects a different real object", async () => {
  const { callerCwd, daemonCwd, client: connectClient } = await fixture();
  const client = await connectClient();
  const caller = await stat(callerCwd, { bigint: true });
  const cwdIdentity = { device: String(caller.dev), inode: String(caller.ino) };
  const params = {
    harness: "codex",
    sessionName: "proved",
    message: "read-marker",
    cwd: callerCwd,
    cwdIdentity,
  } as unknown as SpawnParams;
  expect(await client.request("spawn", params)).toHaveProperty("result");
  expect(
    await client.request("spawn", {
      ...params,
      sessionName: "wrong-object",
      cwd: daemonCwd,
    } as SpawnParams),
  ).toMatchObject({
    error: {
      code: "invalid_params",
      issues: [{ issue: "invalid_value", path: "cwd" }],
    },
  });
  const listed = await client.request("list", {});
  expect("result" in listed ? listed.result : []).toHaveLength(1);
});

test("session snapshots keep the exact active or completed turn without stale active fields", async () => {
  const { cli, callerCwd } = await fixture();
  const spawned = await cli(["spawn", "codex", "hold", "--name", "snapshot"]);
  expect(spawned.exitCode, spawned.stdout).toBe(0);
  const ack = JSON.parse(spawned.stdout) as {
    sessionId: string;
    turnHandle: string;
  };
  const busy = JSON.parse((await cli(["list"])).stdout) as Record<
    string,
    unknown
  >[];
  expect(busy).toMatchObject([
    {
      sessionId: ack.sessionId,
      state: "busy",
      activeTurnHandle: ack.turnHandle,
    },
  ]);
  expect(busy[0]).not.toHaveProperty("activeTurnId");
  const pretty = await cli(["list", "--session", ack.sessionId, "--pretty"]);
  expect(pretty.stdout).toContain(callerCwd);
  expect(pretty.stdout).toContain(ack.turnHandle);
  await writeFile(join(callerCwd, "release"), "finish");
  expect(
    (await cli(["wait", ack.sessionId, "--timeout", "5000"])).exitCode,
  ).toBe(0);
  const idle = JSON.parse((await cli(["list"])).stdout) as Record<
    string,
    unknown
  >[];
  expect(idle).toMatchObject([
    {
      state: "idle",
      lastCompletedTurn: { turnHandle: ack.turnHandle, stopReason: "end_turn" },
    },
  ]);
  expect(idle[0]).not.toHaveProperty("activeTurnHandle");
  expect((await cli(["kill", ack.sessionId])).exitCode).toBe(0);
  const killed = JSON.parse((await cli(["list"])).stdout) as Record<
    string,
    unknown
  >[];
  expect(killed).toMatchObject([
    {
      state: "killed",
      lastCompletedTurn: { turnHandle: ack.turnHandle, stopReason: "end_turn" },
    },
  ]);
  expect(killed[0]).not.toHaveProperty("activeTurnHandle");
});

test("CLI send 用显式落点与单值 TurnHandle，忙闲变化不改变选择", async () => {
  const { cli, callerCwd } = await fixture("reins-wrr06-placement");
  const created = await cli(["spawn", "codex", "hold", "--name", "placement"]);
  expect(created.exitCode).toBe(0);
  const initial = JSON.parse(created.stdout) as {
    sessionId: string;
    turnHandle: string;
  };
  const busy = await cli([
    "send",
    initial.sessionId,
    "new task",
    "--placement",
    "new_turn",
  ]);
  expect(busy.exitCode).toBe(65);
  expect(JSON.parse(busy.stdout)).toMatchObject({ code: "session_busy" });
  const active = await cli([
    "send",
    initial.turnHandle,
    "active task",
    "--placement",
    "active_turn",
  ]);
  expect(active.exitCode, active.stderr).toBe(0);
  expect(JSON.parse(active.stdout)).toEqual({
    sessionId: initial.sessionId,
    turnHandle: initial.turnHandle,
  });
  await writeFile(join(callerCwd, "release"), "released");
  expect(
    (await cli(["wait", initial.sessionId, "--timeout", "5000"])).exitCode,
  ).toBe(0);
  const ended = await cli([
    "send",
    initial.turnHandle,
    "late task",
    "--placement",
    "active_turn",
  ]);
  expect(ended.exitCode).toBe(65);
  expect(JSON.parse(ended.stdout)).toMatchObject({ code: "turn_not_active" });
  const next = await cli([
    "send",
    initial.sessionId,
    "next task",
    "--placement",
    "new_turn",
  ]);
  expect(next.exitCode).toBe(0);
  const nextAck = JSON.parse(next.stdout) as {
    sessionId: string;
    turnHandle: string;
  };
  expect(nextAck.sessionId).toBe(initial.sessionId);
  expect(nextAck.turnHandle).not.toBe(initial.turnHandle);
  expect(decodeTurnHandle(nextAck.turnHandle).sessionId).toBe(
    initial.sessionId,
  );
  const unspecified = await cli([
    "send",
    initial.sessionId,
    "missing placement",
  ]);
  expect(unspecified.exitCode).toBe(64);
});

test("interrupt 单 TurnHandle 返回接受事实，ACK 不等于取消", async () => {
  const { cli, callerCwd } = await fixture("reins-wrr16");
  const created = await cli([
    "spawn",
    "codex",
    "hold",
    "--name",
    "exact-interrupt",
  ]);
  expect(created.exitCode, created.stderr).toBe(0);
  const original = JSON.parse(created.stdout) as {
    sessionId: string;
    turnHandle: string;
  };
  const accepted = await cli(["interrupt", original.turnHandle]);
  expect(accepted.exitCode, accepted.stdout + accepted.stderr).toBe(0);
  expect(JSON.parse(accepted.stdout)).toEqual({
    sessionId: original.sessionId,
    turnHandle: original.turnHandle,
  });
  expect(JSON.parse((await cli(["list"])).stdout)).toMatchObject([
    { sessionId: original.sessionId, state: "busy" },
  ]);
  const incomplete = await cli(["interrupt", original.sessionId]);
  expect(incomplete.exitCode).toBe(64);
  const multiple = await cli([
    "interrupt",
    original.turnHandle,
    original.turnHandle,
  ]);
  expect(multiple.exitCode).toBe(64);
  await writeFile(join(callerCwd, "release"), "released");
  await vi.waitFor(async () =>
    expect(JSON.parse((await cli(["list"])).stdout)).toMatchObject([
      { state: "idle" },
    ]),
  );
  const stale = await cli(["interrupt", original.turnHandle]);
  expect(stale.exitCode).toBe(65);
});
