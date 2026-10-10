import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, watch } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  rename,
  readFile,
  writeFile,
} from "node:fs/promises";
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
import * as v from "valibot";
import { afterEach, expect, test as baseTest, vi } from "vitest";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const cliBin = join(repo, "apps/cli/dist/reins.js");
const daemonBin = join(repo, "packages/daemon/dist/main.js");
const adapters = fileURLToPath(
  new URL(
    "../../../../packages/daemon/test/fixtures/kill-adapters.ts",
    import.meta.url,
  ),
);
const test = baseTest.skipIf(
  process.platform !== "linux" || process.arch !== "x64",
);
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  const errors: unknown[] = [];
  for (const release of cleanup.splice(0).reverse()) {
    try {
      await release();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0)
    throw new AggregateError(errors, "Fixture cleanup failed");
});

function processState(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    throw error;
  }
}

async function nativeReady(cwd: string): Promise<void> {
  // 等真实原生接收回执；只使用测试自身的截止时间，不为每个启动阶段另设一秒门槛。
  await new Promise<void>((resolve, reject) => {
    const ready = () => {
      void readFile(join(cwd, "turn-started.txt"), "utf8").then(
        (message) => {
          if (message.length > 0) {
            watcher.close();
            resolve();
          }
        },
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") {
            watcher.close();
            reject(error);
          }
        },
      );
    };
    const watcher = watch(cwd, ready);
    watcher.on("error", reject);
    cleanup.push(async () => watcher.close());
    ready();
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "reins-wrr07-cwd-"));
  const runtime = await mkdtemp("/dev/shm/reins-wrr07-runtime-");
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
    REINS_CONSUMER_CONTEXT: "kill-terminal-test",
    REINS_DAEMON_BIN: daemonBin,
    REINS_W05_NATIVE_LOG: join(runtime, "native.jsonl"),
  };
  // 独占 subreaper 只在 daemon 结束后回收后代，保留真实 Z 反例且不遗留给 PID 1。
  const daemon: ChildProcess = spawn(
    "perl",
    [
      "-e",
      'die "subreaper unavailable: $!" if syscall(157,36,1,0,0,0)!=0; my $daemon=fork(); die "fork failed: $!" unless defined $daemon; if($daemon==0){exec @ARGV; die "exec failed: $!";} $SIG{TERM}=sub{kill "TERM",$daemon;}; $SIG{USR1}=sub{kill "KILL",$daemon;}; my $ended; do {$ended=waitpid($daemon,0);} until $ended==$daemon; my $status=$?; while(wait()>0){} exit($status>>8);',
      process.execPath,
      daemonBin,
      "--adapters",
      adapters,
    ],
    { cwd: daemonCwd, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const errors: string[] = [];
  daemon.stderr?.on("data", (chunk) => errors.push(String(chunk)));
  cleanup.push(async () => {
    if (daemon.exitCode !== null || daemon.signalCode !== null) return;
    let forced = false;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        forced = true;
        daemon.kill("SIGUSR1");
      }, 5_000);
      daemon.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      daemon.kill("SIGTERM");
    });
    expect(forced, "Product cleanup required a platform fallback").toBe(false);
    expect(daemon.exitCode, errors.join("")).toBe(0);
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
  return { root, runtime, daemon, daemonCwd, callerCwd, env, cli, client };
}

test("kill commits exactly one killed turn before the session terminal", async () => {
  const { cli, callerCwd, client: connect } = await fixture();
  const spawned = await cli([
    "spawn",
    "codex",
    "caller busy task",
    "--name",
    "kill-busy",
  ]);
  expect(spawned.exitCode, spawned.stderr).toBe(0);
  const target = decodeTurnHandle(JSON.parse(spawned.stdout).turnHandle);
  const client = await connect();
  const events: DomainEvent[] = [];
  client.onNotification((notification) => {
    if (notification.method === "event") events.push(notification.params);
  });
  expect(
    await client.request("attach", { sessionId: target.sessionId, replay: 50 }),
  ).toHaveProperty("result");
  await vi.waitFor(() =>
    expect(events.some((event) => event.type === "turn.started")).toBe(true),
  );
  await nativeReady(callerCwd);
  const killed = await cli(["kill", target.sessionId]);
  expect(killed.exitCode, killed.stdout + killed.stderr).toBe(0);
  await vi.waitFor(() =>
    expect(events.some((event) => event.type === "session.killed")).toBe(true),
  );
  expect(
    events.filter(
      (event) =>
        event.type === "turn.completed" || event.type === "session.killed",
    ),
  ).toMatchObject([
    {
      type: "turn.completed",
      sessionId: target.sessionId,
      turnId: target.turnId,
      stopReason: "killed",
    },
    { type: "session.killed", sessionId: target.sessionId },
  ]);
});

test("kill stops the actual writer and its held FD while another session survives", async () => {
  const { cli, callerCwd, root, daemon, client: connect } = await fixture();
  const otherCwd = join(root, "other");
  await mkdir(otherCwd);
  const other = await cli(
    ["spawn", "codex", "other caller task", "--name", "other-writer"],
    otherCwd,
  );
  expect(other.exitCode, other.stdout).toBe(0);
  const spawned = await cli([
    "spawn",
    "codex",
    "caller writer task",
    "--name",
    "owned-writer",
  ]);
  expect(spawned.exitCode, spawned.stdout).toBe(0);
  const target = decodeTurnHandle(JSON.parse(spawned.stdout).turnHandle);
  await nativeReady(callerCwd);
  await vi.waitFor(async () =>
    expect(await readFile(join(otherCwd, "pids.json"), "utf8")).toContain(
      "writer",
    ),
  );
  await rename(
    join(callerCwd, "held.txt"),
    join(callerCwd, "held-original.txt"),
  );
  await writeFile(
    join(callerCwd, "held.txt"),
    "replacement path must remain unchanged",
  );
  const before = await readFile(join(callerCwd, "held-original.txt"), "utf8");
  await vi.waitFor(async () =>
    expect(
      (await readFile(join(callerCwd, "held-original.txt"), "utf8")).length,
    ).toBeGreaterThan(before.length),
  );
  const pids = JSON.parse(
    await readFile(join(callerCwd, "pids.json"), "utf8"),
  ) as { parent: number; writer: number };
  const client = await connect();
  let statesAtTerminal: string[] | undefined;
  client.onNotification((n) => {
    if (n.method === "event" && n.params.type === "session.killed") {
      statesAtTerminal = [processState(pids.parent), processState(pids.writer)];
    }
  });
  expect(
    await client.request("attach", { sessionId: target.sessionId }),
  ).toHaveProperty("result");
  const killed = await cli(["kill", target.sessionId]);
  const writerState = processState(pids.writer);
  console.info(JSON.stringify({ killed, pids, writerState, statesAtTerminal }));
  expect(["Z", "X", "gone"]).toContain(writerState);
  expect(killed.exitCode, killed.stdout + killed.stderr).toBe(0);
  await vi.waitFor(() => expect(statesAtTerminal).toBeDefined());
  expect(
    statesAtTerminal!.every((state) => ["Z", "X", "gone"].includes(state)),
  ).toBe(true);
  const held = await readFile(join(callerCwd, "held-original.txt"), "utf8");
  const named = await readFile(join(callerCwd, "named.txt"), "utf8");
  const otherBefore = await readFile(join(otherCwd, "held.txt"), "utf8");
  await vi.waitFor(async () =>
    expect(
      (await readFile(join(otherCwd, "held.txt"), "utf8")).length,
    ).toBeGreaterThan(otherBefore.length),
  );
  expect(await readFile(join(callerCwd, "held-original.txt"), "utf8")).toBe(
    held,
  );
  expect(await readFile(join(callerCwd, "held.txt"), "utf8")).toBe(
    "replacement path must remain unchanged",
  );
  expect(await readFile(join(callerCwd, "named.txt"), "utf8")).toBe(named);
  expect(daemon.exitCode).toBeNull();
  expect(JSON.parse((await cli(["list"])).stdout)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sessionId: target.sessionId, state: "killed" }),
      expect.objectContaining({
        sessionId: JSON.parse(other.stdout).sessionId,
        state: "busy",
      }),
    ]),
  );
});

test("the single-session kill request returns one result and rejects an extra CLI target", async () => {
  const { cli, callerCwd, client: connect } = await fixture();
  const spawned = await cli([
    "spawn",
    "codex",
    "single caller task",
    "--name",
    "single-kill",
  ]);
  expect(spawned.exitCode, spawned.stdout).toBe(0);
  const target = decodeTurnHandle(JSON.parse(spawned.stdout).turnHandle);
  await nativeReady(callerCwd);
  const rejected = await cli(["kill", target.sessionId, target.sessionId]);
  expect(rejected.exitCode, rejected.stdout + rejected.stderr).toBe(64);
  expect(JSON.parse((await cli(["list"])).stdout)).toMatchObject([
    { state: "busy" },
  ]);
  const client = await connect();
  expect(
    await client.request("kill", { sessionId: target.sessionId }),
  ).toMatchObject({
    result: { sessionId: target.sessionId, status: "killed" },
  });
});

test.each(["complete during kill", "complete naturally"])(
  "kill preserves the unique natural terminal: %s",
  async (message) => {
    const { cli, callerCwd, client: connect } = await fixture();
    const spawned = await cli([
      "spawn",
      "codex",
      message,
      "--name",
      "natural-race",
    ]);
    expect(spawned.exitCode, spawned.stdout).toBe(0);
    const target = decodeTurnHandle(JSON.parse(spawned.stdout).turnHandle);
    await nativeReady(callerCwd);
    const client = await connect();
    const events: DomainEvent[] = [];
    client.onNotification((n) => {
      if (n.method === "event") events.push(n.params);
    });
    expect(
      await client.request("attach", {
        sessionId: target.sessionId,
        replay: 50,
      }),
    ).toHaveProperty("result");
    if (message === "complete naturally")
      await vi.waitFor(() =>
        expect(events.some((e) => e.type === "turn.completed")).toBe(true),
      );
    const [first, concurrent] = await Promise.all([
      cli(["kill", target.sessionId]),
      cli(["kill", target.sessionId]),
    ]);
    expect(first.exitCode, first.stdout).toBe(0);
    expect(concurrent.exitCode, concurrent.stdout).toBe(0);
    expect((await cli(["kill", target.sessionId])).exitCode).toBe(0);
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === "session.killed")).toBe(true),
    );
    expect(
      events.filter(
        (e) => e.type === "turn.completed" || e.type === "session.killed",
      ),
    ).toMatchObject([
      {
        type: "turn.completed",
        sessionId: target.sessionId,
        turnId: target.turnId,
        stopReason: "end_turn",
      },
      { type: "session.killed", sessionId: target.sessionId },
    ]);
  },
);

test("failed termination leaves the real writer and original turn alive for a fresh retry", async () => {
  const { cli, callerCwd, client: connect } = await fixture();
  const spawned = await cli([
    "spawn",
    "codex",
    "fail first termination",
    "--name",
    "retry-kill",
  ]);
  expect(spawned.exitCode, spawned.stdout).toBe(0);
  const target = decodeTurnHandle(JSON.parse(spawned.stdout).turnHandle);
  await nativeReady(callerCwd);
  const client = await connect();
  const events: DomainEvent[] = [];
  client.onNotification((n) => {
    if (n.method === "event") events.push(n.params);
  });
  expect(
    await client.request("attach", { sessionId: target.sessionId, replay: 50 }),
  ).toHaveProperty("result");
  const failed = await cli(["kill", target.sessionId]);
  expect(failed.exitCode, failed.stdout).toBe(65);
  expect(JSON.parse(failed.stdout)).toMatchObject({ code: "internal_error" });
  const before = await readFile(join(callerCwd, "held.txt"), "utf8");
  await vi.waitFor(async () =>
    expect(
      (await readFile(join(callerCwd, "held.txt"), "utf8")).length,
    ).toBeGreaterThan(before.length),
  );
  expect(
    events.filter(
      (e) => e.type === "turn.completed" || e.type === "session.killed",
    ),
  ).toEqual([]);
  expect(JSON.parse((await cli(["list"])).stdout)).toMatchObject([
    { state: "busy", activeTurnHandle: JSON.parse(spawned.stdout).turnHandle },
  ]);
  expect((await cli(["kill", target.sessionId])).exitCode).toBe(0);
  await vi.waitFor(() =>
    expect(events.some((e) => e.type === "session.killed")).toBe(true),
  );
  expect(events.filter((e) => e.type === "turn.completed")).toMatchObject([
    { turnId: target.turnId, stopReason: "killed" },
  ]);
});
