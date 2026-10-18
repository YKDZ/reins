import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { consumerContextSchema } from "@reins/protocol";
import { openLocal } from "@ykdz/reins";
import {
  connect,
  parseDiagnosticId,
  parseMessageKey,
  parseResumeCursor,
  parseRuntimeScopeId,
  parseSessionHandle,
  parseTurnHandle,
  serializeDiagnosticId,
  serializeMessageKey,
  serializeResumeCursor,
  serializeRuntimeScopeId,
  serializeSessionHandle,
  serializeTurnHandle,
  type DiagnosticsQuery,
  type ReinsConnection,
  type SendInput,
  type SessionHandle,
  type SpawnInput,
  type TurnHandle,
} from "@ykdz/reins-sdk";
import { ReinsSdkError } from "@ykdz/reins-sdk";
import * as v from "valibot";
import { afterEach, expect, test } from "vitest";

const runtimePackage = fileURLToPath(new URL("../../", import.meta.url));
const daemonBin = join(runtimePackage, "node_modules/.bin/reins-daemon");
const adaptersModule = fileURLToPath(
  new URL("./fixtures/fake-adapters.ts", import.meta.url),
);
const fixtureDaemonBin = fileURLToPath(
  new URL("./fixtures/daemon-fixture.mjs", import.meta.url),
);
const fixtures: Array<{ directory: string; daemonPids: string }> = [];
const clients: ReinsConnection[] = [];

test("RuntimeScopeId parser rejects identities with another role", () => {
  const scope = parseRuntimeScopeId("00000000-0000-4000-8000-000000000000");
  expect(serializeRuntimeScopeId(scope)).toBe(
    "00000000-0000-4000-8000-000000000000",
  );
  expect(() =>
    parseRuntimeScopeId(
      "session:00000000-0000-4000-8000-000000000000:daemon:1",
    ),
  ).toThrow();
  expect(() => parseRuntimeScopeId("diagnostic:daemon:1")).toThrow();
});

async function waitForProcessExit(
  pid: number,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Daemon process ${pid} did not exit`);
}

async function waitForSocket(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await stat(path)).isSocket()) return;
    } catch {
      // fixture 尚未绑定 socket。
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Daemon socket ${path} did not appear`);
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const fixture of fixtures.splice(0)) {
    let pids: number[] = [];
    try {
      pids = (await readFile(fixture.daemonPids, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(Number);
    } catch {
      // 初始化失败时 daemon 可能尚未启动。
    }
    const cleanupErrors: unknown[] = [];
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // daemon 已经退出。
      }
      try {
        await waitForProcessExit(pid);
      } catch (error) {
        try {
          process.kill(pid, "SIGKILL");
          await waitForProcessExit(pid, 2_000);
        } catch (killError) {
          cleanupErrors.push(killError);
        }
        cleanupErrors.push(error);
      }
    }
    await rm(fixture.directory, { recursive: true, force: true });
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Daemon cleanup failed");
    }
  }
});

test("runtime rejects an empty consumer binding before starting the daemon", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reins-application-unbound-"));
  const daemonPids = join(directory, "daemon-pids.txt");
  fixtures.push({ directory, daemonPids });
  const daemonLauncher = join(directory, "reins-daemon");
  await writeFile(
    daemonLauncher,
    `#!/bin/sh\nprintf '%s\\n' "$$" >> '${daemonPids}'\nexec '${daemonBin}' "$@"\n`,
    { mode: 0o700 },
  );
  const socketPath = join(directory, "reins.sock");

  await expect(
    openLocal({
      consumerContext: "",
      env: {
        ...process.env,
        REINS_SOCKET: socketPath,
        REINS_STATE_DIR: join(directory, "state"),
        REINS_DAEMON_BIN: daemonLauncher,
        REINS_ADAPTERS_MODULE: adaptersModule,
      },
    }),
  ).rejects.toMatchObject({
    stage: "connect",
    failure: { code: "consumer_context_required" },
  });
  await expect(access(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(daemonPids)).rejects.toMatchObject({ code: "ENOENT" });
});

test("openLocal fails without a stable state root before any harness dispatch", async () => {
  await expect(
    openLocal({
      consumerContext: "no-state-consumer",
      timeoutMs: 1_000,
      env: {
        ...process.env,
        REINS_SOCKET: join(tmpdir(), "reins-no-state.sock"),
        REINS_STATE_DIR: "",
        XDG_STATE_HOME: "",
        HOME: "",
      },
    }),
  ).rejects.toMatchObject({
    stage: "connect",
    failure: {
      code: "runtime_scope_unavailable",
      facts: { reason: "state_root" },
    },
  });
});

test("different endpoints cannot start writers for the same state root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reins-application-writer-"));
  const daemonPids = join(directory, "daemon-pids.txt");
  const requestsFile = join(directory, "requests.jsonl");
  fixtures.push({ directory, daemonPids });
  const daemonLauncher = join(directory, "reins-daemon");
  await writeFile(
    daemonLauncher,
    `#!/bin/sh\nprintf '%s\\n' "$$" >> '${daemonPids}'\nexec '${daemonBin}' "$@"\n`,
    { mode: 0o700 },
  );
  const stateDirectory = join(directory, "state");
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    REINS_STATE_DIR: stateDirectory,
    REINS_DAEMON_BIN: daemonLauncher,
    REINS_ADAPTERS_MODULE: adaptersModule,
    REINS_FIXTURE_REQUESTS_FILE: requestsFile,
    REINS_IDLE_TIMEOUT_MS: "120000",
  };
  const first = await openLocal({
    consumerContext: "writer-lease-consumer",
    env: { ...baseEnv, REINS_SOCKET: join(directory, "first.sock") },
  });
  clients.push(first);
  const spawned = await first.spawn(
    {
      harness: "codex",
      message: "first writer",
      sessionLabel: "writer-session",
      cwd: process.cwd(),
    },
    { operationKey: first.prepareOperation("spawn") },
  );

  await expect(
    openLocal({
      consumerContext: "writer-lease-consumer",
      timeoutMs: 1_000,
      env: { ...baseEnv, REINS_SOCKET: join(directory, "second.sock") },
    }),
  ).rejects.toMatchObject({
    stage: "connect",
    failure: { code: "daemon_start_failed" },
  });
  await expect(
    first.list({ sessionHandle: spawned.sessionHandle }),
  ).resolves.toMatchObject([{ sessionHandle: spawned.sessionHandle }]);
  const dispatches = (await readFile(requestsFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string });
  expect(
    dispatches.filter(({ type }) => type === "worker_started"),
  ).toHaveLength(1);
});

test("an in-flight spawn keeps the shared daemon alive after its client closes", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "reins-application-in-flight-"),
  );
  const daemonPids = join(directory, "daemon-pids.txt");
  const requestsFile = join(directory, "requests.jsonl");
  fixtures.push({ directory, daemonPids });
  const daemonLauncher = join(directory, "reins-daemon");
  await writeFile(
    daemonLauncher,
    `#!/bin/sh\nprintf '%s\\n' "$$" >> '${daemonPids}'\nexec '${daemonBin}' "$@"\n`,
    { mode: 0o700 },
  );
  const options = {
    consumerContext: "in-flight-consumer",
    env: {
      ...process.env,
      REINS_SOCKET: join(directory, "reins.sock"),
      REINS_STATE_DIR: join(directory, "state"),
      REINS_DAEMON_BIN: daemonLauncher,
      REINS_ADAPTERS_MODULE: adaptersModule,
      REINS_FIXTURE_REQUESTS_FILE: requestsFile,
      REINS_FIXTURE_MODEL_CATALOG_DELAY_MS: "3000",
      REINS_IDLE_TIMEOUT_MS: "2000",
    },
  };
  const connection = await openLocal(options);
  clients.push(connection);
  const spawning = connection.spawn(
    {
      harness: "codex",
      model: "fake-model",
      message: "still in flight",
      sessionLabel: "pending-session",
      cwd: process.cwd(),
    },
    { operationKey: connection.prepareOperation("spawn") },
  );
  void spawning.catch(() => undefined);
  const dispatchDeadline = Date.now() + 2_000;
  let catalogQueryStarted = false;
  while (!catalogQueryStarted && Date.now() < dispatchDeadline) {
    try {
      catalogQueryStarted = (await readFile(requestsFile, "utf8"))
        .trim()
        .split("\n")
        .some((line) => {
          const request = JSON.parse(line) as {
            type: string;
            harness?: string;
          };
          return (
            request.type === "model_catalog_started" &&
            request.harness === "codex"
          );
        });
    } catch {
      // SDK 写入请求后 daemon 才会执行延迟中的目录查询。
    }
    if (!catalogQueryStarted)
      await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(catalogQueryStarted).toBe(true);
  connection.close();
  clients.splice(clients.indexOf(connection), 1);

  await new Promise((resolve) => setTimeout(resolve, 2_100));
  const originalPid = Number((await readFile(daemonPids, "utf8")).trim());
  expect(() => process.kill(originalPid, 0)).not.toThrow();
  const requests = (await readFile(requestsFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string });
  expect(requests.some(({ type }) => type === "worker_started")).toBe(false);

  const reconnected = await openLocal({ ...options, timeoutMs: 1_000 });
  clients.push(reconnected);
  expect(reconnected.handshake.runtimeScopeId).toBe(
    connection.handshake.runtimeScopeId,
  );
  expect((await readFile(daemonPids, "utf8")).trim().split("\n")).toHaveLength(
    1,
  );
}, 15_000);

test("programmatic callers share one real daemon and reconnect to the same session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reins-application-"));
  const daemonPids = join(directory, "daemon-pids.txt");
  fixtures.push({ directory, daemonPids });
  const daemonLauncher = join(directory, "reins-daemon");
  const daemonSockets = join(directory, "daemon-sockets.txt");
  await writeFile(
    daemonLauncher,
    `#!/bin/sh\nprintf '%s\\n' "$$" >> '${daemonPids}'\nprintf '%s\\n' "$REINS_SOCKET" >> '${daemonSockets}'\nexec '${daemonBin}' "$@"\n`,
    { mode: 0o700 },
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REINS_SOCKET: join(directory, "reins.sock"),
    REINS_STATE_DIR: join(directory, "state"),
    REINS_DAEMON_BIN: daemonLauncher,
    REINS_ADAPTERS_MODULE: adaptersModule,
    REINS_IDLE_TIMEOUT_MS: "120000",
  };
  const options = {
    consumerContext: v.parse(consumerContextSchema, "application-e2e"),
    env,
  };

  const [first, second] = await Promise.all([
    openLocal(options),
    openLocal(options),
  ]);
  clients.push(first, second);
  expect(second.handshake.runtimeScopeId).toBe(first.handshake.runtimeScopeId);

  const spawnInput = {
    harness: "codex",
    message: "keep this session after disconnect",
    sessionLabel: "application-session",
    cwd: process.cwd(),
  } satisfies SpawnInput;
  const spawned = await first.spawn(spawnInput);
  const sessionHandle = spawned.sessionHandle;

  const observedBySecond = await second.list({
    sessionHandle: sessionHandle as unknown as SessionHandle,
  });
  expect(observedBySecond).toMatchObject([
    {
      sessionHandle,
      sessionLabel: "application-session",
      state: "idle",
      lastCompletedTurn: { stopReason: "end_turn" },
    },
  ]);

  first.close();
  second.close();
  clients.splice(0, 2);

  const reconnected = await openLocal(options);
  clients.push(reconnected);
  expect(reconnected.handshake.runtimeScopeId).toBe(
    first.handshake.runtimeScopeId,
  );
  const observedAfterReconnect = await reconnected.list({
    sessionHandle: sessionHandle as unknown as SessionHandle,
  });
  expect(observedAfterReconnect).toMatchObject([
    {
      sessionHandle,
      sessionLabel: "application-session",
      state: "idle",
      lastCompletedTurn: { stopReason: "end_turn" },
    },
  ]);

  const launchedPids = (await readFile(daemonPids, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean);
  expect(launchedPids).toHaveLength(1);
  expect((await readFile(daemonSockets, "utf8")).trim().split("\n")).toEqual([
    env.REINS_SOCKET,
  ]);
}, 20_000);

test("重启后只读旧世代已提交回合并明确标记失去控制的目标", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reins-application-old-gen-"));
  const daemonPids = join(directory, "daemon-pids.txt");
  fixtures.push({ directory, daemonPids });
  const daemonLauncher = join(directory, "reins-daemon");
  await writeFile(
    daemonLauncher,
    `#!/bin/sh\nprintf '%s\\n' "$$" >> '${daemonPids}'\nexec '${daemonBin}' "$@"\n`,
    { mode: 0o700 },
  );
  const options = {
    consumerContext: "old-generation-observation",
    env: {
      ...process.env,
      REINS_SOCKET: join(directory, "reins.sock"),
      REINS_STATE_DIR: join(directory, "state"),
      REINS_DAEMON_BIN: daemonLauncher,
      REINS_ADAPTERS_MODULE: adaptersModule,
      REINS_IDLE_TIMEOUT_MS: "120000",
    },
  };
  const original = await openLocal(options);
  clients.push(original);
  const completed = await original.spawn({
    harness: "codex",
    message: "complete before daemon restart",
    cwd: process.cwd(),
  });
  await expect(
    original.wait({ targets: [completed.turnHandle], completion: "all" }),
  ).resolves.toMatchObject({ status: "satisfied" });
  const sendKey = original.prepareOperation("send");
  const sent = await original.send(
    {
      placement: "new_turn",
      sessionHandle: completed.sessionHandle,
      ifLastCompletedTurn: completed.turnHandle,
      message: "complete before daemon restart",
    },
    { operationKey: sendKey },
  );
  await expect(
    original.wait({ targets: [sent.turnHandle], completion: "all" }),
  ).resolves.toMatchObject({ status: "satisfied" });

  const active = await original.spawn({
    harness: "codex",
    message: "hold across daemon restart",
    cwd: process.cwd(),
  });
  const killed = await original.spawn({
    harness: "codex",
    message: "hold then close before daemon restart",
    cwd: process.cwd(),
  });
  await original.kill({ sessionHandle: killed.sessionHandle });

  const originalGeneration = original.handshake.daemonGeneration;
  const originalPid = Number((await readFile(daemonPids, "utf8")).trim());
  process.kill(originalPid, "SIGKILL");
  await waitForProcessExit(originalPid);
  await new Promise((resolve) => setTimeout(resolve, 35_000));
  const reconnected = await openLocal(options);
  clients.push(reconnected);
  expect(reconnected.handshake.daemonGeneration).not.toBe(originalGeneration);
  expect(await reconnected.list()).toEqual([]);
  await expect(reconnected.getOperation(sendKey)).resolves.toEqual({
    status: "succeeded",
    operationKey: sendKey,
    result: sent,
  });
  expect(
    await reconnected.list({ sessionHandle: completed.sessionHandle }),
  ).toMatchObject([
    {
      state: "unreachable",
      lastKnownState: "idle",
      lastCompletedTurn: {
        turnHandle: sent.turnHandle,
        stopReason: "end_turn",
      },
    },
  ]);
  expect(
    await reconnected.list({ sessionHandle: active.sessionHandle }),
  ).toMatchObject([
    {
      state: "unreachable",
      lastKnownState: "busy",
      lastKnownActiveTurn: active.turnHandle,
    },
  ]);
  expect(
    await reconnected.list({ sessionHandle: killed.sessionHandle }),
  ).toMatchObject([{ state: "killed" }]);

  await expect(
    reconnected.wait({
      targets: [completed.turnHandle, active.turnHandle],
      completion: "any",
    }),
  ).resolves.toMatchObject({
    status: "satisfied",
    completed: [{ turnHandle: completed.turnHandle, stopReason: "end_turn" }],
    pending: [],
    unreachable: [{ turnHandle: active.turnHandle }],
  });
  await expect(
    reconnected.wait({
      targets: [completed.turnHandle, active.turnHandle],
      completion: "all",
    }),
  ).resolves.toMatchObject({
    status: "unreachable",
    completed: [{ turnHandle: completed.turnHandle, stopReason: "end_turn" }],
    pending: [],
    unreachable: [{ turnHandle: active.turnHandle }],
  });
  await expect(
    reconnected.wait({ targets: [killed.turnHandle], completion: "all" }),
  ).resolves.toMatchObject({
    status: "satisfied",
    completed: [{ turnHandle: killed.turnHandle, stopReason: "killed" }],
  });
}, 60_000);

test("application startup failure keeps the raw transport code", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reins-application-error-"));
  const daemonPids = join(directory, "daemon-pids.txt");
  fixtures.push({ directory, daemonPids });
  const fixturePid = join(directory, "fixture.pid");
  const daemonLauncher = join(directory, "reins-daemon");
  const daemonSockets = join(directory, "daemon-sockets.txt");
  await writeFile(
    daemonLauncher,
    `#!/bin/sh\nprintf '%s\\n' "$$" >> '${daemonPids}'\nprintf '%s\\n' "$REINS_SOCKET" >> '${daemonSockets}'\nexec '${daemonBin}' "$@"\n`,
    { mode: 0o700 },
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REINS_SOCKET: join(directory, "reins.sock"),
    REINS_STATE_DIR: join(directory, "state"),
    REINS_DAEMON_BIN: fixtureDaemonBin,
    REINS_FIXTURE_DAEMON_MODE: "startup-transport-address-in-use",
    REINS_FIXTURE_PID_FILE: fixturePid,
  };

  let failure: unknown;
  try {
    await openLocal({
      consumerContext: v.parse(consumerContextSchema, "application-e2e"),
      env,
      timeoutMs: 1_000,
    });
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(ReinsSdkError);
  expect(failure).toMatchObject({
    failure: {
      code: "daemon_start_failed",
      facts: { transportCode: "address_in_use" },
    },
  });
  await waitForProcessExit(Number(await readFile(fixturePid, "utf8")));

  env.REINS_DAEMON_BIN = daemonLauncher;
  env.REINS_ADAPTERS_MODULE = adaptersModule;
  env.REINS_IDLE_TIMEOUT_MS = "120000";
  const retried = await openLocal({
    consumerContext: v.parse(consumerContextSchema, "application-e2e"),
    env,
  });
  clients.push(retried);
  const modelCatalog = await retried.modelCatalog();
  expect(modelCatalog).toHaveProperty("catalogs");
  expect((await readFile(daemonSockets, "utf8")).trim().split("\n")).toEqual([
    env.REINS_SOCKET,
  ]);
});

test("application reports local startup IO failures and can retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reins-application-io-"));
  const daemonPids = join(directory, "daemon-pids.txt");
  fixtures.push({ directory, daemonPids });
  const blockedParent = join(directory, "socket-parent");
  await writeFile(blockedParent, "ordinary file");
  const socketPath = join(blockedParent, "reins.sock");
  const daemonLauncher = join(directory, "reins-daemon");
  await writeFile(
    daemonLauncher,
    `#!/bin/sh\nprintf '%s\\n' "$$" >> '${daemonPids}'\nexec '${daemonBin}' "$@"\n`,
    { mode: 0o700 },
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REINS_SOCKET: socketPath,
    REINS_STATE_DIR: join(directory, "state"),
    REINS_DAEMON_BIN: daemonLauncher,
    REINS_ADAPTERS_MODULE: adaptersModule,
    REINS_IDLE_TIMEOUT_MS: "120000",
  };
  const options = {
    consumerContext: v.parse(consumerContextSchema, "application-e2e"),
    env,
  };

  let failure: unknown;
  try {
    await openLocal(options);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ReinsSdkError);
  expect(failure).toMatchObject({
    stage: "connect",
    failure: {
      code: "daemon_start_failed",
      facts: {
        systemCode: "EEXIST",
        cause: { kind: "io" },
      },
    },
  });

  await rm(blockedParent);
  await mkdir(blockedParent);
  const retried = await openLocal(options);
  clients.push(retried);
  expect(await retried.modelCatalog()).toHaveProperty("catalogs");
  expect((await readFile(daemonPids, "utf8")).trim().split("\n")).toHaveLength(
    1,
  );
});

test("a connected daemon handshake failure does not launch a replacement", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "reins-application-handshake-"),
  );
  const daemonPids = join(directory, "daemon-pids.txt");
  fixtures.push({ directory, daemonPids });
  const socketPath = join(directory, "reins.sock");
  const fixturePid = join(directory, "fixture.pid");
  const existingDaemon = spawn(process.execPath, [fixtureDaemonBin], {
    env: {
      ...process.env,
      REINS_SOCKET: socketPath,
      REINS_FIXTURE_DAEMON_MODE: "initialize-close",
      REINS_FIXTURE_PID_FILE: daemonPids,
      REINS_FIXTURE_EXIT_FILE: fixturePid,
    },
    stdio: "ignore",
  });
  if (existingDaemon.pid === undefined)
    throw new Error("Could not start handshake fixture daemon");
  existingDaemon.unref();
  await waitForSocket(socketPath);

  const launchMarker = join(directory, "unexpected-launches.txt");
  const daemonLauncher = join(directory, "reins-daemon");
  await writeFile(
    daemonLauncher,
    `#!/bin/sh\nprintf 'launched\\n' >> '${launchMarker}'\nexit 1\n`,
    { mode: 0o700 },
  );
  let failure: unknown;
  try {
    await openLocal({
      consumerContext: v.parse(consumerContextSchema, "application-e2e"),
      env: {
        ...process.env,
        REINS_SOCKET: socketPath,
        REINS_STATE_DIR: join(directory, "state"),
        REINS_DAEMON_BIN: daemonLauncher,
      },
      timeoutMs: 1_000,
    });
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(ReinsSdkError);
  expect(failure).toMatchObject({
    stage: "handshake",
    failure: { code: "daemon_disconnected", facts: {} },
  });
  await expect(readFile(launchMarker, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("public SDK keeps bounded stderr evidence and rejects unsupported capture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reins-application-stderr-"));
  const daemonPids = join(directory, "daemon-pids.txt");
  fixtures.push({ directory, daemonPids });
  const daemonLauncher = join(directory, "reins-daemon");
  await writeFile(
    daemonLauncher,
    `#!/bin/sh\nprintf '%s\\n' "$$" >> '${daemonPids}'\nexec '${daemonBin}' "$@"\n`,
    { mode: 0o700 },
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REINS_SOCKET: join(directory, "reins.sock"),
    REINS_STATE_DIR: join(directory, "state"),
    REINS_DAEMON_BIN: daemonLauncher,
    REINS_ADAPTERS_MODULE: adaptersModule,
    REINS_IDLE_TIMEOUT_MS: "120000",
  };
  const connection = await openLocal({
    consumerContext: "application-stderr-e2e",
    env,
  });
  clients.push(connection);

  const captured = await connection.spawn(
    {
      harness: "codex",
      message: "capture diagnostic evidence",
      sessionLabel: "capture-stderr",
      cwd: process.cwd(),
      captureHarnessStderr: true,
    },
    { operationKey: connection.prepareOperation("spawn") },
  );
  let result = await connection.diagnostics({
    sessionHandle: captured.sessionHandle,
    kinds: ["harness_stderr"],
  });
  const deadline = Date.now() + 5_000;
  while (
    !("records" in result && result.records.length === 3) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    result = await connection.diagnostics({
      sessionHandle: captured.sessionHandle,
      kinds: ["harness_stderr"],
    });
  }
  expect(result).toMatchObject({ truncated: false });
  if (!("records" in result))
    throw new Error("missing bounded stderr diagnostics");
  const first = result.records[0];
  if (first?.source !== "harness" || first.kind !== "harness_stderr")
    throw new Error("missing harness stderr diagnostic record");
  const evidence = first.text;
  expect(evidence).toMatchObject({
    text: "é".repeat(8_192),
    truncated: true,
    originalBytes: 20_000,
  });
  expect(Buffer.byteLength(evidence.text, "utf8")).toBe(16 * 1024);
  const firstTurnHandle = first.turnHandle;
  if (firstTurnHandle === undefined)
    throw new Error("missing stderr diagnostic turn handle");
  expect(
    await connection.diagnostics({
      diagnosticId: parseDiagnosticId(first.diagnosticId),
    }),
  ).toMatchObject({ record: { diagnosticId: first.diagnosticId } });
  const byTurn = await connection.diagnostics({
    turnHandle: parseTurnHandle(firstTurnHandle),
    kinds: ["harness_stderr"],
  });
  expect("records" in byTurn ? byTurn.records.length : 0).toBe(3);
  await expect(
    connection.diagnostics({ turnHandle: "invalid" as TurnHandle }),
  ).rejects.toMatchObject({
    stage: "query",
    failure: {
      code: "invalid_params",
      facts: { issues: [{ issue: "invalid_value", path: "turnHandle" }] },
    },
  });
  await expect(
    connection.diagnostics({
      sessionHandle: parseSessionHandle(
        "session:00000000-0000-4000-8000-000000000000:other:1",
      ),
      turnHandle: parseTurnHandle(firstTurnHandle),
    }),
  ).rejects.toMatchObject({
    failure: {
      code: "invalid_params",
      facts: {
        issues: [
          {
            issue: "invalid_combination",
            paths: ["sessionHandle", "turnHandle"],
          },
        ],
      },
    },
  });

  const queries = [
    { sessionHandle: captured.sessionHandle },
    {
      sessionHandle: captured.sessionHandle,
      turnHandle: firstTurnHandle,
    },
    {
      harness: "codex",
      sources: ["harness"],
    },
    { kinds: ["harness_stderr"] },
    { minSeverity: "info" },
    { since: first.recordedAt, until: first.recordedAt },
  ] satisfies readonly DiagnosticsQuery[];
  for (const query of queries) {
    const filtered = await connection.diagnostics(query);
    expect("records" in filtered ? filtered.records.length : 0).toBeGreaterThan(
      0,
    );
  }
  expect(parseDiagnosticId(serializeDiagnosticId(first.diagnosticId))).toBe(
    first.diagnosticId,
  );
  expect(() =>
    parseSessionHandle(serializeDiagnosticId(first.diagnosticId)),
  ).toThrow();
  expect(() =>
    parseDiagnosticId(serializeSessionHandle(captured.sessionHandle)),
  ).toThrow();
  expect(
    await connection.diagnostics({
      sessionHandle: captured.sessionHandle,
      harness: "qoder",
    }),
  ).toEqual({ records: [], truncated: false });
  expect(
    await connection.diagnostics({
      sessionHandle: captured.sessionHandle,
      limit: 1,
    }),
  ).toMatchObject({
    records: [{ diagnosticId: result.records.at(-1)?.diagnosticId }],
    truncated: true,
  });
  expect(await connection.diagnostics({ harness: "qoder" })).toEqual({
    records: [],
    truncated: false,
  });
  await expect(
    connection.diagnostics({
      diagnosticId: parseDiagnosticId(
        `diagnostic:${connection.handshake.runtimeScopeId}:missing:1`,
      ),
    }),
  ).rejects.toMatchObject({
    failure: { code: "diagnostic_not_found" },
  });

  const unsupportedSessionLabel = "unsupported-stderr-capture";
  await expect(
    connection.spawn(
      {
        harness: "qoder",
        message: "capture is unavailable",
        sessionLabel: unsupportedSessionLabel,
        cwd: process.cwd(),
        captureHarnessStderr: true,
      },
      { operationKey: connection.prepareOperation("spawn") },
    ),
  ).rejects.toMatchObject({
    failure: {
      code: "unsupported_feature",
      facts: { feature: "capture_harness_stderr" },
    },
  });
  expect(
    await connection.list({ sessionLabel: unsupportedSessionLabel }),
  ).toEqual([]);
});

test("SDK consumer binding isolates another consumer's sessions and controls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reins-application-scope-"));
  const daemonPids = join(directory, "daemon-pids.txt");
  fixtures.push({ directory, daemonPids });
  const daemonLauncher = join(directory, "reins-daemon");
  await writeFile(
    daemonLauncher,
    `#!/bin/sh\nprintf '%s\\n' "$$" >> '${daemonPids}'\nexec '${daemonBin}' "$@"\n`,
    { mode: 0o700 },
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REINS_SOCKET: join(directory, "reins.sock"),
    REINS_STATE_DIR: join(directory, "state"),
    REINS_DAEMON_BIN: daemonLauncher,
    REINS_ADAPTERS_MODULE: adaptersModule,
    REINS_IDLE_TIMEOUT_MS: "120000",
  };
  const owner = await openLocal({ consumerContext: "scope-owner", env });
  clients.push(owner);
  const spawned = await owner.spawn(
    {
      harness: "codex",
      message: "owned session",
      sessionLabel: "owned-session",
      cwd: process.cwd(),
    },
    { operationKey: owner.prepareOperation("spawn") },
  );
  const foreign = await connect({
    socketPath: env.REINS_SOCKET!,
    consumerContext: "scope-foreign",
  });
  clients.push(foreign);
  expect(foreign.handshake.runtimeScopeId).toBe(owner.handshake.runtimeScopeId);

  await expect(
    connect({
      socketPath: env.REINS_SOCKET!,
      consumerContext: "wrong-target",
      runtimeScopeId: parseRuntimeScopeId(
        "00000000-0000-4000-8000-000000000001",
      ),
    }),
  ).rejects.toMatchObject({
    stage: "handshake",
    failure: {
      code: "runtime_scope_mismatch",
      facts: {
        actualRuntimeScopeId: owner.handshake.runtimeScopeId,
      },
    },
  });

  expect(await foreign.list()).toEqual([]);
  expect(
    await foreign.kill(
      { sessionHandle: spawned.sessionHandle },
      { operationKey: foreign.prepareOperation("kill") },
    ),
  ).toEqual({ sessionHandle: spawned.sessionHandle, status: "not_found" });
  await expect(
    foreign.send(
      {
        placement: "new_turn",
        sessionHandle: spawned.sessionHandle,
        message: "foreign input",
      },
      { operationKey: foreign.prepareOperation("send") },
    ),
  ).rejects.toMatchObject({
    failure: {
      code: "session_not_found",
      facts: { sessionHandle: spawned.sessionHandle },
    },
  });
  await expect(
    foreign.wait({ targets: [spawned.turnHandle], completion: "all" }),
  ).rejects.toMatchObject({
    failure: {
      code: "session_not_found",
      facts: { sessionHandle: spawned.sessionHandle },
    },
  });
  expect(
    await owner.list({ sessionHandle: spawned.sessionHandle }),
  ).toHaveLength(1);
});

test("SDK 将可选会话标签作为元数据并始终通过精确身份控制", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reins-application-label-"));
  const daemonPids = join(directory, "daemon-pids.txt");
  fixtures.push({ directory, daemonPids });
  const daemonLauncher = join(directory, "reins-daemon");
  await writeFile(
    daemonLauncher,
    `#!/bin/sh\nprintf '%s\\n' "$$" >> '${daemonPids}'\nexec '${daemonBin}' "$@"\n`,
    { mode: 0o700 },
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REINS_SOCKET: join(directory, "reins.sock"),
    REINS_STATE_DIR: join(directory, "state"),
    REINS_DAEMON_BIN: daemonLauncher,
    REINS_ADAPTERS_MODULE: adaptersModule,
    REINS_IDLE_TIMEOUT_MS: "120000",
  };
  const connection = await openLocal({
    consumerContext: "application-label-e2e",
    env,
  });
  clients.push(connection);

  const unlabelled = await connection.spawn(
    {
      harness: "codex",
      message: "unlabelled",
      cwd: process.cwd(),
    },
    { operationKey: connection.prepareOperation("spawn") },
  );
  const label = "root";
  const first = await connection.spawn(
    {
      harness: "codex",
      message: "first labelled session",
      sessionLabel: label,
      cwd: process.cwd(),
    },
    { operationKey: connection.prepareOperation("spawn") },
  );
  const second = await connection.spawn(
    {
      harness: "codex",
      message: "second labelled session",
      sessionLabel: label,
      cwd: process.cwd(),
    },
    { operationKey: connection.prepareOperation("spawn") },
  );
  const longLabel = "标签—".repeat(40);
  const longLabelled = await connection.spawn(
    {
      harness: "codex",
      message: "long label",
      sessionLabel: longLabel,
      cwd: process.cwd(),
    },
    { operationKey: connection.prepareOperation("spawn") },
  );

  expect(unlabelled.sessionHandle).not.toBe(first.sessionHandle);
  expect(first.sessionHandle).not.toBe(second.sessionHandle);
  expect(first.sessionHandle).not.toBe(longLabelled.sessionHandle);
  expect(await connection.list({ sessionLabel: label })).toMatchObject([
    { sessionHandle: first.sessionHandle, sessionLabel: label },
    { sessionHandle: second.sessionHandle, sessionLabel: label },
  ]);
  expect(await connection.list({ sessionLabel: longLabel })).toMatchObject([
    { sessionHandle: longLabelled.sessionHandle, sessionLabel: longLabel },
  ]);
  expect(
    await connection.list({ sessionHandle: unlabelled.sessionHandle }),
  ).toMatchObject([{ sessionHandle: unlabelled.sessionHandle }]);
  expect(
    (await connection.list({ sessionHandle: unlabelled.sessionHandle }))[0],
  ).not.toHaveProperty("sessionLabel");

  expect(parseSessionHandle(serializeSessionHandle(first.sessionHandle))).toBe(
    first.sessionHandle,
  );
  expect(parseTurnHandle(serializeTurnHandle(first.turnHandle))).toBe(
    first.turnHandle,
  );
  const emptyLabel = await connection.spawn(
    {
      harness: "codex",
      message: "empty label",
      sessionLabel: "",
      cwd: process.cwd(),
    },
    { operationKey: connection.prepareOperation("spawn") },
  );
  expect(await connection.list({ sessionLabel: "" })).toMatchObject([
    { sessionHandle: emptyLabel.sessionHandle, sessionLabel: "" },
  ]);
  const formerReservedLabel = "session_name_conflict";
  const retryInput = {
    harness: "codex",
    message: "same operation with former reserved label",
    sessionLabel: formerReservedLabel,
    cwd: process.cwd(),
  } satisfies SpawnInput;
  const retryOperationKey = connection.prepareOperation("spawn");
  const original = await connection.spawn(retryInput, {
    operationKey: retryOperationKey,
  });
  const replay = await connection.spawn(retryInput, {
    operationKey: retryOperationKey,
  });
  expect(replay.sessionHandle).toBe(original.sessionHandle);
  await expect(
    connection.spawn(
      { ...retryInput, sessionLabel: "changed label" },
      { operationKey: retryOperationKey },
    ),
  ).rejects.toMatchObject({
    failure: { code: "operation_key_conflict" },
  });
  const independent = await connection.spawn(
    { ...retryInput, message: "different operation, same label" },
    { operationKey: connection.prepareOperation("spawn") },
  );
  expect(independent.sessionHandle).not.toBe(original.sessionHandle);
  expect(
    await connection.list({ sessionLabel: formerReservedLabel }),
  ).toMatchObject([
    { sessionHandle: original.sessionHandle },
    { sessionHandle: independent.sessionHandle },
  ]);
  expect(
    await connection.kill(
      { sessionHandle: first.sessionHandle },
      { operationKey: connection.prepareOperation("kill") },
    ),
  ).toEqual({ sessionHandle: first.sessionHandle, status: "killed" });
  expect(await connection.list({ sessionLabel: label })).toMatchObject([
    { sessionHandle: first.sessionHandle, state: "killed" },
    { sessionHandle: second.sessionHandle, state: "idle" },
  ]);
});

test("SDK send, wait, interrupt, kill, and new-turn delivery keep exact targets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reins-sdk-control-actions-"));
  const daemonPids = join(directory, "daemon-pids.txt");
  fixtures.push({ directory, daemonPids });
  const daemonLauncher = join(directory, "reins-daemon");
  const observations = join(directory, "adapter-observations.ndjson");
  await writeFile(
    daemonLauncher,
    `#!/bin/sh\nprintf '%s\\n' "$$" >> '${daemonPids}'\nexec '${daemonBin}' "$@"\n`,
    { mode: 0o700 },
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REINS_SOCKET: join(directory, "reins.sock"),
    REINS_STATE_DIR: join(directory, "state"),
    REINS_DAEMON_BIN: daemonLauncher,
    REINS_ADAPTERS_MODULE: adaptersModule,
    REINS_FIXTURE_REQUESTS_FILE: observations,
    REINS_IDLE_TIMEOUT_MS: "120000",
  };
  const connection = await openLocal({
    consumerContext: "sdk-control-actions",
    env,
  });
  clients.push(connection);

  const active = await connection.spawn(
    {
      harness: "codex",
      message: "hold the active turn",
      sessionLabel: "active-send",
      cwd: process.cwd(),
    },
    { operationKey: connection.prepareOperation("spawn") },
  );
  for (const input of [
    {
      sessionHandle: active.sessionHandle,
      message: "missing placement",
    },
    {
      placement: "unknown",
      sessionHandle: active.sessionHandle,
      message: "unknown placement",
    },
    {
      placement: "active_turn",
      turnHandle: active.turnHandle,
      ifLastCompletedTurn: active.turnHandle,
      message: "conflicting active turn precondition",
    },
  ]) {
    await expect(
      connection.send(input as unknown as SendInput, {
        operationKey: connection.prepareOperation("send"),
      }),
    ).rejects.toMatchObject({
      stage: "operation",
      failure: { code: "invalid_params" },
    });
  }
  expect(
    await connection.list({ sessionHandle: active.sessionHandle }),
  ).toMatchObject([{ state: "busy", activeTurn: active.turnHandle }]);
  const activeMessage = "  exact active input\nkeep spacing  ";
  const subscription = await connection.attach(
    { scope: "turn", turnHandle: active.turnHandle },
    { mode: "available" },
  );
  const callerFactPromise = (async () => {
    for await (const fact of subscription) {
      if (
        fact.type === "message" &&
        fact.role === "caller" &&
        fact.content === activeMessage
      )
        return fact;
    }
    throw new Error("The active caller message was not published as a fact");
  })();
  const activeSend = await connection.send(
    {
      placement: "active_turn",
      turnHandle: active.turnHandle,
      message: activeMessage,
    },
    { operationKey: connection.prepareOperation("send") },
  );
  expect(activeSend).toMatchObject({
    sessionHandle: active.sessionHandle,
    turnHandle: active.turnHandle,
    deliveryPoint: "active_turn",
  });
  const callerFact = await callerFactPromise;
  expect(callerFact.messageKey).toBe(activeSend.messageKey);
  expect(parseMessageKey(serializeMessageKey(activeSend.messageKey))).toBe(
    callerFact.messageKey,
  );
  const cursor = subscription.checkpoint;
  expect(parseResumeCursor(serializeResumeCursor(cursor))).toBe(cursor);
  subscription.close();
  expect(
    await connection.wait({
      targets: [active.turnHandle],
      completion: "all",
      timeoutMs: 5_000,
    }),
  ).toMatchObject({
    status: "satisfied",
    completed: [
      {
        turnHandle: active.turnHandle,
        stopReason: "end_turn",
        finalReply: "ok",
      },
    ],
  });

  const nextMessage = "new turn input";
  const nextTurn = await connection.send(
    {
      placement: "new_turn",
      sessionHandle: active.sessionHandle,
      message: nextMessage,
    },
    { operationKey: connection.prepareOperation("send") },
  );
  expect(nextTurn).toMatchObject({
    sessionHandle: active.sessionHandle,
    deliveryPoint: "new_turn",
  });
  expect(nextTurn.turnHandle).not.toBe(active.turnHandle);
  expect(
    await connection.wait({
      targets: [nextTurn.turnHandle],
      completion: "all",
      timeoutMs: 5_000,
    }),
  ).toMatchObject({ status: "satisfied" });

  const held = await connection.spawn(
    {
      harness: "codex",
      message: "hold for interrupt",
      sessionLabel: "interrupt-target",
      cwd: process.cwd(),
    },
    { operationKey: connection.prepareOperation("spawn") },
  );
  expect(
    await connection.interrupt(
      { turnHandle: held.turnHandle },
      { operationKey: connection.prepareOperation("interrupt") },
    ),
  ).toEqual({ turnHandle: held.turnHandle, status: "accepted" });
  expect(
    await connection.wait({
      targets: [held.turnHandle],
      completion: "all",
      timeoutMs: 0,
    }),
  ).toEqual({
    status: "timeout",
    completed: [],
    pending: [held.turnHandle],
  });
  expect(
    await connection.kill(
      { sessionHandle: held.sessionHandle },
      { operationKey: connection.prepareOperation("kill") },
    ),
  ).toEqual({ sessionHandle: held.sessionHandle, status: "killed" });
  expect(
    await connection.wait({
      targets: [held.turnHandle],
      completion: "all",
      timeoutMs: 5_000,
    }),
  ).toMatchObject({
    status: "satisfied",
    completed: [{ turnHandle: held.turnHandle, stopReason: "killed" }],
  });

  const observed = (await readFile(observations, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const delivered = observed.filter(
    (record) => record.type === "message_delivered",
  );
  expect(delivered).toHaveLength(2);
  expect(delivered[0]).toMatchObject({ message: activeMessage });
  expect(delivered[1]).toMatchObject({ message: nextMessage });
});

test("SDK new-turn preconditions are exact, persisted, and checked before delivery", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "reins-sdk-new-turn-condition-"),
  );
  const daemonPids = join(directory, "daemon-pids.txt");
  fixtures.push({ directory, daemonPids });
  const daemonLauncher = join(directory, "reins-daemon");
  const observations = join(directory, "adapter-observations.ndjson");
  await writeFile(
    daemonLauncher,
    `#!/bin/sh\nprintf '%s\\n' "$$" >> '${daemonPids}'\nexec '${daemonBin}' "$@"\n`,
    { mode: 0o700 },
  );
  const connection = await openLocal({
    consumerContext: "sdk-new-turn-condition",
    env: {
      ...process.env,
      REINS_SOCKET: join(directory, "reins.sock"),
      REINS_STATE_DIR: join(directory, "state"),
      REINS_DAEMON_BIN: daemonLauncher,
      REINS_ADAPTERS_MODULE: adaptersModule,
      REINS_FIXTURE_REQUESTS_FILE: observations,
      REINS_IDLE_TIMEOUT_MS: "120000",
    },
  });
  clients.push(connection);

  const first = await connection.spawn(
    {
      harness: "codex",
      message: "complete first turn",
      cwd: process.cwd(),
    },
    { operationKey: connection.prepareOperation("spawn") },
  );
  await connection.wait({ targets: [first.turnHandle], completion: "all" });

  const sendIntent = {
    placement: "new_turn" as const,
    sessionHandle: first.sessionHandle,
    ifLastCompletedTurn: first.turnHandle,
    message: "start second turn",
  };
  const operationKey = connection.prepareOperation("send");
  const second = await connection.send(sendIntent, { operationKey });
  await connection.wait({ targets: [second.turnHandle], completion: "all" });

  await expect(connection.send(sendIntent, { operationKey })).resolves.toEqual(
    second,
  );
  await expect(
    connection.send(
      { ...sendIntent, message: "stale retry must not dispatch" },
      { operationKey },
    ),
  ).rejects.toMatchObject({
    stage: "operation",
    failure: { code: "operation_key_conflict" },
  });
  await expect(
    connection.send(
      {
        ...sendIntent,
        message: "stale predecessor must not dispatch",
      },
      { operationKey: connection.prepareOperation("send") },
    ),
  ).rejects.toMatchObject({
    stage: "operation",
    failure: {
      code: "turn_precondition_failed",
      facts: {
        sessionHandle: first.sessionHandle,
        expected: first.turnHandle,
      },
    },
  });

  const recovered = await connection.getOperation(operationKey);
  expect(recovered).toMatchObject({
    status: "succeeded",
    operationKey,
    result: second,
  });

  const observedRecords = (
    await readFile(join(directory, "adapter-observations.ndjson"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(
    observedRecords.filter(
      (record) =>
        record.type === "message_delivered" &&
        record.message === "start second turn",
    ),
  ).toHaveLength(1);
  expect(
    observedRecords.some(
      (record) => record.message === "stale predecessor must not dispatch",
    ),
  ).toBe(false);
});
