import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
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

import { resolveDaemonState } from "@reins/daemon/state";
import {
  connect as connectSdk,
  parseRuntimeScopeId,
  ReinsSdkError,
  type AgentFact,
  type ReinsConnection,
  type SessionHandle,
} from "@ykdz/reins-sdk";
import { afterEach, expect, test as baseTest, vi } from "vitest";

const runtimePackage = fileURLToPath(new URL("../../", import.meta.url));
const daemonBin = join(runtimePackage, "node_modules/.bin/reins-daemon");
const adapters = fileURLToPath(
  new URL("./fixtures/kill-adapters.ts", import.meta.url),
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
  // 读取原生 worker 的调用回执，避免把宿主 watcher 配额作为用例前置条件。
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      if ((await readFile(join(cwd, "turn-started.txt"), "utf8")).length > 0)
        return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new Error("原生 worker 未在用例时限内记录回合启动");
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(10, remaining)),
    );
  }
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
  await vi.waitFor(async () => {
    expect(daemon.exitCode, errors.join("")).toBeNull();
    await access(env.REINS_SOCKET);
  });
  const runtimeScopeId = parseRuntimeScopeId(
    (await resolveDaemonState({ env })).runtimeScopeId,
  );
  async function sdk() {
    const connection = await connectSdk({
      socketPath: env.REINS_SOCKET,
      consumerContext: env.REINS_CONSUMER_CONTEXT,
      runtimeScopeId,
    });
    cleanup.push(async () => connection.close());
    return connection;
  }
  async function spawnSession(
    connection: ReinsConnection,
    sessionLabel: string,
    cwd: string,
    message: string,
  ) {
    return connection.spawn(
      { sessionLabel, harness: "codex", message, cwd },
      { operationKey: connection.prepareOperation("spawn") },
    );
  }
  async function killSession(
    connection: ReinsConnection,
    sessionHandle: SessionHandle,
  ) {
    return connection.kill(
      { sessionHandle },
      { operationKey: connection.prepareOperation("kill") },
    );
  }
  return {
    root,
    daemon,
    daemonCwd,
    callerCwd,
    env,
    sdk,
    spawnSession,
    killSession,
  };
}

test("kill commits exactly one killed turn before the session terminal", async () => {
  const { callerCwd, sdk, spawnSession, killSession } = await fixture();
  const connection = await sdk();
  const spawned = await spawnSession(
    connection,
    "kill-busy",
    callerCwd,
    "caller busy task",
  );
  const subscription = await connection.attach(
    { scope: "session", sessionHandle: spawned.sessionHandle },
    { mode: "available" },
  );
  const events: AgentFact[] = [];
  const collect = (async () => {
    for await (const fact of subscription) events.push(fact);
  })();
  await nativeReady(callerCwd);
  const killed = await killSession(connection, spawned.sessionHandle);
  expect(killed).toMatchObject({
    status: "killed",
    sessionHandle: spawned.sessionHandle,
  });
  await collect;
  await expect(subscription.done).resolves.toMatchObject({
    reason: "session_killed",
  });
  const terminalFacts = events.filter(
    (fact) => fact.type === "turn.completed" || fact.type === "session.killed",
  );
  expect(terminalFacts).toHaveLength(2);
  expect(terminalFacts).toMatchObject([
    {
      type: "turn.completed",
      turnHandle: spawned.turnHandle,
      stopReason: "killed",
    },
    { type: "session.killed", sessionHandle: spawned.sessionHandle },
  ]);
});

test("重连后仍可通过 SDK 查询已完成的关闭操作", async () => {
  const { callerCwd, sdk, spawnSession } = await fixture();
  const connection = await sdk();
  const spawned = await spawnSession(
    connection,
    "query-kill-operation",
    callerCwd,
    "caller busy task",
  );
  await nativeReady(callerCwd);

  const operationKey = connection.prepareOperation("kill");
  const result = await connection.kill(
    { sessionHandle: spawned.sessionHandle },
    { operationKey },
  );
  expect(result).toMatchObject({ status: "killed" });

  connection.close();
  const reconnected = await sdk();
  await expect(reconnected.getOperation(operationKey)).resolves.toEqual({
    status: "succeeded",
    operationKey,
    result: {
      sessionHandle: spawned.sessionHandle,
      status: "killed",
    },
  });
});

test("官方关闭已确认但本地资源释放失败时保留关闭效果且不发布终态", async () => {
  const { callerCwd, sdk, spawnSession, killSession } = await fixture();
  const connection = await sdk();
  const spawned = await spawnSession(
    connection,
    "partial-close-effect",
    callerCwd,
    "fail local release after official close",
  );
  const subscription = await connection.attach(
    { scope: "session", sessionHandle: spawned.sessionHandle },
    { mode: "available" },
  );
  const facts: AgentFact[] = [];
  const collect = (async () => {
    for await (const fact of subscription) facts.push(fact);
  })();
  await nativeReady(callerCwd);

  const failedCloseKey = connection.prepareOperation("kill");
  const failure = await connection
    .kill(
      { sessionHandle: spawned.sessionHandle },
      { operationKey: failedCloseKey },
    )
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  if (!(failure instanceof ReinsSdkError)) throw failure;
  expect(failure.failure).toMatchObject({
    code: "internal_error",
    facts: {
      cause: { kind: "closed" },
      effect: {
        kind: "session_closed",
        sessionHandle: spawned.sessionHandle,
      },
    },
  });
  await expect(connection.getOperation(failedCloseKey)).resolves.toMatchObject({
    status: "failed",
    operationKey: failedCloseKey,
    error: {
      code: "internal_error",
      facts: {
        effect: {
          kind: "session_closed",
          sessionHandle: spawned.sessionHandle,
        },
      },
    },
  });
  expect(
    facts.filter(
      (fact) =>
        fact.type === "turn.completed" || fact.type === "session.killed",
    ),
  ).toEqual([]);

  await expect(
    killSession(connection, spawned.sessionHandle),
  ).resolves.toMatchObject({
    status: "killed",
    sessionHandle: spawned.sessionHandle,
  });
  await collect;
  await expect(subscription.done).resolves.toMatchObject({
    reason: "session_killed",
  });
  expect(
    facts.filter(
      (fact) =>
        fact.type === "turn.completed" || fact.type === "session.killed",
    ),
  ).toMatchObject([
    {
      type: "turn.completed",
      turnHandle: spawned.turnHandle,
      stopReason: "killed",
    },
    { type: "session.killed", sessionHandle: spawned.sessionHandle },
  ]);
});

test("关闭开始后拒绝新发送并等待在途发送再发布终态事实", async () => {
  const { callerCwd, sdk, spawnSession, killSession } = await fixture();
  const connection = await sdk();
  const spawned = await spawnSession(
    connection,
    "in-flight-send-kill",
    callerCwd,
    "hold steer for kill",
  );
  const subscription = await connection.attach(
    { scope: "session", sessionHandle: spawned.sessionHandle },
    { mode: "available" },
  );
  const facts: AgentFact[] = [];
  const collect = (async () => {
    for await (const fact of subscription) facts.push(fact);
  })();
  await nativeReady(callerCwd);

  const inFlightSend = connection.send(
    {
      placement: "active_turn",
      turnHandle: spawned.turnHandle,
      message: "already dispatched",
    },
    { operationKey: connection.prepareOperation("send") },
  );
  await vi.waitFor(async () =>
    expect(await readFile(join(callerCwd, "steer-started.txt"), "utf8")).toBe(
      "started",
    ),
  );

  try {
    let killSettled = false;
    const killing = killSession(connection, spawned.sessionHandle).then(
      (result) => {
        killSettled = true;
        return result;
      },
      (error: unknown) => {
        killSettled = true;
        throw error;
      },
    );
    await expect(
      connection.send(
        {
          placement: "active_turn",
          turnHandle: spawned.turnHandle,
          message: "must be rejected after kill begins",
        },
        { operationKey: connection.prepareOperation("send") },
      ),
    ).rejects.toMatchObject({ failure: { code: "session_terminating" } });
    expect(killSettled).toBe(false);

    await writeFile(join(callerCwd, "release-steer.txt"), "continue");
    await expect(inFlightSend).resolves.toMatchObject({
      deliveryPoint: "active_turn",
      turnHandle: spawned.turnHandle,
    });
    await expect(killing).resolves.toMatchObject({ status: "killed" });
    await collect;
    await expect(subscription.done).resolves.toMatchObject({
      reason: "session_killed",
    });
    const callerFactIndex = facts.findIndex(
      (fact) =>
        fact.type === "message" &&
        fact.role === "caller" &&
        fact.content === "already dispatched",
    );
    const completedIndex = facts.findIndex(
      (fact) => fact.type === "turn.completed",
    );
    const killedIndex = facts.findIndex(
      (fact) => fact.type === "session.killed",
    );
    expect(callerFactIndex).toBeGreaterThanOrEqual(0);
    expect(completedIndex).toBeGreaterThan(callerFactIndex);
    expect(killedIndex).toBeGreaterThan(completedIndex);
  } finally {
    await writeFile(join(callerCwd, "release-steer.txt"), "continue");
  }
});

test("kill stops the actual writer and its held FD while another session survives", async () => {
  const { callerCwd, root, daemon, sdk, spawnSession, killSession } =
    await fixture();
  const connection = await sdk();
  const otherCwd = join(root, "other");
  await mkdir(otherCwd);
  const other = await spawnSession(
    connection,
    "other-writer",
    otherCwd,
    "other caller task",
  );
  const spawned = await spawnSession(
    connection,
    "owned-writer",
    callerCwd,
    "caller writer task",
  );
  const subscription = await connection.attach(
    { scope: "session", sessionHandle: spawned.sessionHandle },
    { mode: "available" },
  );
  let statesAtTerminal: string[] | undefined;
  let pids: { parent: number; writer: number } | undefined;
  const facts: AgentFact[] = [];
  const collect = (async () => {
    for await (const fact of subscription) {
      facts.push(fact);
      if (fact.type === "session.killed" && pids !== undefined)
        statesAtTerminal = [
          processState(pids.parent),
          processState(pids.writer),
        ];
    }
  })();
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
  pids = JSON.parse(await readFile(join(callerCwd, "pids.json"), "utf8")) as {
    parent: number;
    writer: number;
  };
  const killed = await killSession(connection, spawned.sessionHandle);
  const writerState = processState(pids.writer);
  expect(["Z", "X", "gone"]).toContain(writerState);
  expect(killed).toMatchObject({ status: "killed" });
  await collect;
  await expect(subscription.done).resolves.toMatchObject({
    reason: "session_killed",
  });
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
  expect(await connection.list()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        sessionHandle: spawned.sessionHandle,
        state: "killed",
      }),
      expect.objectContaining({
        sessionHandle: other.sessionHandle,
        state: "busy",
      }),
    ]),
  );
  expect(facts.filter((fact) => fact.type === "session.killed")).toHaveLength(
    1,
  );
});

test.each(["complete during kill", "complete naturally"])(
  "kill preserves the unique natural terminal: %s",
  async (message) => {
    const { callerCwd, sdk, spawnSession, killSession } = await fixture();
    const connection = await sdk();
    const spawned = await spawnSession(
      connection,
      "natural-race",
      callerCwd,
      message,
    );
    const subscription = await connection.attach(
      { scope: "session", sessionHandle: spawned.sessionHandle },
      { mode: "available" },
    );
    const events: AgentFact[] = [];
    const collect = (async () => {
      for await (const fact of subscription) events.push(fact);
    })();
    await nativeReady(callerCwd);
    if (message === "complete naturally")
      await vi.waitFor(() =>
        expect(events.some((fact) => fact.type === "turn.completed")).toBe(
          true,
        ),
      );
    const [first, concurrent] = await Promise.all([
      killSession(connection, spawned.sessionHandle),
      killSession(connection, spawned.sessionHandle),
    ]);
    for (const result of [first, concurrent]) {
      expect(result.sessionHandle).toBe(spawned.sessionHandle);
      expect(["killed", "not_found"]).toContain(result.status);
    }
    expect(await killSession(connection, spawned.sessionHandle)).toMatchObject({
      sessionHandle: spawned.sessionHandle,
      status: expect.stringMatching(/^(killed|not_found)$/u),
    });
    await collect;
    await expect(subscription.done).resolves.toMatchObject({
      reason: "session_killed",
    });
    const terminalFacts = events.filter(
      (fact) =>
        fact.type === "turn.completed" || fact.type === "session.killed",
    );
    expect(terminalFacts).toHaveLength(2);
    expect(terminalFacts).toMatchObject([
      {
        type: "turn.completed",
        turnHandle: spawned.turnHandle,
        stopReason: "end_turn",
      },
      { type: "session.killed", sessionHandle: spawned.sessionHandle },
    ]);
  },
);

test("failed termination leaves the real writer and original turn alive for a fresh retry", async () => {
  const { callerCwd, sdk, spawnSession, killSession } = await fixture();
  const connection = await sdk();
  const spawned = await spawnSession(
    connection,
    "retry-kill",
    callerCwd,
    "fail first termination",
  );
  const subscription = await connection.attach(
    { scope: "session", sessionHandle: spawned.sessionHandle },
    { mode: "available" },
  );
  const events: AgentFact[] = [];
  const collect = (async () => {
    for await (const fact of subscription) events.push(fact);
  })();
  await nativeReady(callerCwd);
  await expect(
    killSession(connection, spawned.sessionHandle),
  ).rejects.toMatchObject({
    name: "ReinsSdkError",
    failure: { code: "internal_error" },
  });
  const before = await readFile(join(callerCwd, "held.txt"), "utf8");
  await vi.waitFor(async () =>
    expect(
      (await readFile(join(callerCwd, "held.txt"), "utf8")).length,
    ).toBeGreaterThan(before.length),
  );
  expect(
    events.filter(
      (fact) =>
        fact.type === "turn.completed" || fact.type === "session.killed",
    ),
  ).toEqual([]);
  expect(
    await connection.list({ sessionHandle: spawned.sessionHandle }),
  ).toMatchObject([{ state: "busy", activeTurn: spawned.turnHandle }]);
  const killed = await killSession(connection, spawned.sessionHandle);
  expect(killed).toMatchObject({
    sessionHandle: spawned.sessionHandle,
    status: "killed",
  });
  await collect;
  await expect(subscription.done).resolves.toMatchObject({
    reason: "session_killed",
  });
  expect(
    events.filter(
      (fact) =>
        fact.type === "turn.completed" || fact.type === "session.killed",
    ),
  ).toMatchObject([
    {
      type: "turn.completed",
      turnHandle: spawned.turnHandle,
      stopReason: "killed",
    },
    { type: "session.killed", sessionHandle: spawned.sessionHandle },
  ]);
});
