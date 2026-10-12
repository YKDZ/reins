import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { consumerContextSchema, sessionNameSchema } from "@reins/protocol";
import * as v from "valibot";
import { afterEach, expect, test } from "vitest";

import {
  connectReins,
  isReinsStartupTransportFailure,
} from "../../src/application.ts";

const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const daemonBin = join(repository, "packages/daemon/dist/main.js");
const adaptersModule = join(
  repository,
  "apps/cli/test/e2e/fixtures/fake-adapters.ts",
);
const fixtureDaemonBin = join(
  repository,
  "apps/cli/test/e2e/fixtures/daemon-fixture.mjs",
);
const fixtures: Array<{ directory: string; daemonPids: string }> = [];
const clients: Awaited<ReturnType<typeof connectReins>>[] = [];

async function workingDirectoryIdentity(): Promise<{
  device: string;
  inode: string;
}> {
  const directory = await stat(process.cwd(), { bigint: true });
  return { device: String(directory.dev), inode: String(directory.ino) };
}

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

test("non-CLI callers share one real daemon and reconnect to the same session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reins-application-"));
  const daemonPids = join(directory, "daemon-pids.txt");
  fixtures.push({ directory, daemonPids });
  const daemonLauncher = join(directory, "reins-daemon");
  const daemonSockets = join(directory, "daemon-sockets.txt");
  await writeFile(
    daemonLauncher,
    `#!/bin/sh\nprintf '%s\\n' "$$" >> '${daemonPids}'\nprintf '%s\\n' "$REINS_SOCKET" >> '${daemonSockets}'\nexec '${process.execPath}' '${daemonBin}' "$@"\n`,
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

  const spawned = await first.request("spawn", {
    harness: "fake",
    message: "keep this session after disconnect",
    sessionName: v.parse(sessionNameSchema, "application-session"),
    cwd: process.cwd(),
    cwdIdentity: await workingDirectoryIdentity(),
  });
  expect(spawned).toHaveProperty("result");
  if ("error" in spawned) throw new Error(spawned.error.code);
  const sessionId = spawned.result.sessionId;

  const observedBySecond = await second.request("list", { sessionId });
  expect(observedBySecond).toMatchObject({
    result: [{ sessionId, sessionName: "application-session" }],
  });

  first.close();
  second.close();
  clients.splice(0, 2);

  const reconnected = await connectReins(options);
  clients.push(reconnected);
  const observedAfterReconnect = await reconnected.request("list", {
    sessionId,
  });
  expect(observedAfterReconnect).toMatchObject({
    result: [{ sessionId, sessionName: "application-session" }],
  });

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
    `#!/bin/sh\nprintf '%s\\n' "$$" >> '${daemonPids}'\nprintf '%s\\n' "$REINS_SOCKET" >> '${daemonSockets}'\nexec '${process.execPath}' '${daemonBin}' "$@"\n`,
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

  expect(failure).toMatchObject({
    kind: "reins_startup_transport_failure",
    code: "address_in_use",
  });
  expect(isReinsStartupTransportFailure(failure)).toBe(true);
  if (!isReinsStartupTransportFailure(failure)) {
    throw new Error("Expected a typed startup transport failure");
  }
  expect(failure.code).toBe("address_in_use");
  await waitForProcessExit(Number(await readFile(fixturePid, "utf8")));

  env.REINS_DAEMON_BIN = daemonLauncher;
  env.REINS_ADAPTERS_MODULE = adaptersModule;
  env.REINS_IDLE_TIMEOUT_MS = "120000";
  const retried = await connectReins({
    consumerContext: v.parse(consumerContextSchema, "application-e2e"),
    env,
  });
  clients.push(retried);
  const capabilities = await retried.request("capabilities", {});
  expect(capabilities).toHaveProperty("result");
  expect((await readFile(daemonSockets, "utf8")).trim().split("\n")).toEqual([
    env.REINS_SOCKET,
  ]);
});
