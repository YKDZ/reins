import { spawn } from "node:child_process";
import {
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
import {
  connect,
  type ReinsConnection,
  type SessionHandle,
} from "@ykdz/reins-sdk";
import { ReinsSdkError } from "@ykdz/reins-sdk";
import { connectReins } from "@ykdz/reins/application";
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
    connectReins(options),
    connectReins(options),
  ]);
  clients.push(first, second);

  const spawnInput = {
    harness: "fake",
    message: "keep this session after disconnect",
    sessionName: "application-session",
    cwd: process.cwd(),
  };
  const spawnCredential = first.prepareOperation("spawn");
  const spawned = await first.spawn(spawnInput, spawnCredential);
  const sessionHandle = spawned.sessionHandle;

  const observedBySecond = await second.list({
    sessionHandle: sessionHandle as unknown as SessionHandle,
  });
  expect(observedBySecond).toMatchObject([
    {
      sessionHandle,
      sessionName: "application-session",
      state: "idle",
      lastCompletedTurn: { stopReason: "end_turn" },
    },
  ]);

  first.close();
  second.close();
  clients.splice(0, 2);

  const reconnected = await connectReins(options);
  clients.push(reconnected);
  const observedAfterReconnect = await reconnected.list({
    sessionHandle: sessionHandle as unknown as SessionHandle,
  });
  expect(observedAfterReconnect).toMatchObject([
    {
      sessionHandle,
      sessionName: "application-session",
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
    await connectReins({
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
  const retried = await connectReins({
    consumerContext: v.parse(consumerContextSchema, "application-e2e"),
    env,
  });
  clients.push(retried);
  const capabilities = await retried.capabilities();
  expect(capabilities).toHaveProperty("capabilities");
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
    await connectReins(options);
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
  const retried = await connectReins(options);
  clients.push(retried);
  expect(await retried.capabilities()).toHaveProperty("capabilities");
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
    await connectReins({
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
  const connection = await connectReins({
    consumerContext: "application-stderr-e2e",
    env,
  });
  clients.push(connection);

  const captured = await connection.spawn(
    {
      harness: "capture",
      message: "capture diagnostic evidence",
      sessionName: "capture-stderr",
      cwd: process.cwd(),
      captureHarnessStderr: true,
    },
    connection.prepareOperation("spawn"),
  );
  let result = await connection.diagnostics({
    sessionHandle: captured.sessionHandle,
    kinds: ["harness_stderr"],
  });
  const deadline = Date.now() + 5_000;
  while (!("records" in result && result.records.length === 3) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    result = await connection.diagnostics({
      sessionHandle: captured.sessionHandle,
      kinds: ["harness_stderr"],
    });
  }
  expect(result).toMatchObject({ truncated: false });
  if (!("records" in result)) throw new Error("missing bounded stderr diagnostics");
  expect(result.records[0]?.text).toMatchObject({
    text: "é".repeat(8_192),
    truncated: true,
    originalBytes: 20_000,
  });
  expect(Buffer.byteLength(result.records[0]?.text?.text ?? "", "utf8")).toBe(
    16 * 1024,
  );

  const unsupportedSessionName = "unsupported-stderr-capture";
  await expect(
    connection.spawn(
      {
        harness: "fake",
        message: "capture is unavailable",
        sessionName: unsupportedSessionName,
        cwd: process.cwd(),
        captureHarnessStderr: true,
      },
      connection.prepareOperation("spawn"),
    ),
  ).rejects.toMatchObject({
    failure: { code: "unsupported_feature", facts: { feature: "capture_harness_stderr" } },
  });
  expect(
    await connection.list({ sessionName: unsupportedSessionName }),
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
  const owner = await connectReins({ consumerContext: "scope-owner", env });
  clients.push(owner);
  const spawned = await owner.spawn(
    {
      harness: "fake",
      message: "owned session",
      sessionName: "owned-session",
      cwd: process.cwd(),
    },
    owner.prepareOperation("spawn"),
  );
  const foreign = await connect({
    socketPath: env.REINS_SOCKET!,
    consumerContext: "scope-foreign",
  });
  clients.push(foreign);

  expect(await foreign.list()).toEqual([]);
  expect(
    await foreign.kill(
      { sessionHandle: spawned.sessionHandle },
      foreign.prepareOperation("kill"),
    ),
  ).toEqual({ sessionHandle: spawned.sessionHandle, status: "not_found" });
  await expect(
    foreign.send(
      {
        placement: "new_turn",
        sessionHandle: spawned.sessionHandle,
        message: "foreign input",
      },
      foreign.prepareOperation("send"),
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
  expect(await owner.list({ sessionHandle: spawned.sessionHandle })).toHaveLength(
    1,
  );
});
