import { spawn, type ChildProcess } from "node:child_process";
import { access, cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { daemonGenerationSchema } from "@reins/protocol";
import { connect, type ReinsConnection } from "@ykdz/reins-sdk";
import * as v from "valibot";
import { afterEach, expect, test, vi } from "vitest";

const runtimePackage = fileURLToPath(new URL("../../", import.meta.url));
const daemonBin = join(runtimePackage, "node_modules/.bin/reins-daemon");
const adapters = fileURLToPath(
  new URL("./fixtures/fake-adapters.ts", import.meta.url),
);
const daemons: ChildProcess[] = [];
const clients: ReinsConnection[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const daemon of daemons.splice(0)) {
    if (daemon.exitCode !== null || daemon.signalCode !== null) continue;
    await new Promise<void>((resolve) => {
      daemon.once("close", () => resolve());
      daemon.kill("SIGKILL");
    });
  }
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function startDaemon(env: NodeJS.ProcessEnv): Promise<{
  daemon: ChildProcess;
  errors: string[];
}> {
  const daemon = spawn(process.execPath, [daemonBin, "--adapters", adapters], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const errors: string[] = [];
  daemon.stderr?.on("data", (chunk: Buffer) => errors.push(String(chunk)));
  daemons.push(daemon);
  await vi.waitFor(async () => {
    expect(daemon.exitCode, errors.join("")).toBeNull();
    await access(env.REINS_SOCKET ?? "");
  });
  return { daemon, errors };
}

async function stopDaemon(
  daemon: ChildProcess,
  socketPath: string,
  errors: string[],
): Promise<void> {
  const closed = new Promise<void>((resolve) =>
    daemon.once("close", () => resolve()),
  );
  daemon.kill("SIGTERM");
  await closed;
  await vi.waitFor(async () => {
    await expect(access(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  expect(daemon.exitCode, errors.join("")).toBe(0);
}

async function connectSdk(env: NodeJS.ProcessEnv): Promise<ReinsConnection> {
  const connection = await connect({
    socketPath: env.REINS_SOCKET ?? "",
    consumerContext: env.REINS_CONSUMER_CONTEXT ?? "",
  });
  clients.push(connection);
  return connection;
}

test("rolling back durable state does not reuse an earlier SDK session generation", async () => {
  const directory = await mkdtemp(
    join(
      process.platform === "linux" ? "/dev/shm" : tmpdir(),
      "reins-sdk-lineage-",
    ),
  );
  directories.push(directory);
  const stateDirectory = join(directory, "state");
  const snapshotDirectory = join(directory, "snapshot");
  const socketPath = join(directory, "reins.sock");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REINS_SOCKET: socketPath,
    REINS_STATE_DIR: stateDirectory,
    REINS_IDLE_TIMEOUT_MS: "120000",
    REINS_CONSUMER_CONTEXT: "sdk-generation-lineage",
  };

  const first = await startDaemon(env);
  const firstPid = first.daemon.pid ?? -1;
  await stopDaemon(first.daemon, socketPath, first.errors);
  await cp(stateDirectory, snapshotDirectory, { recursive: true });

  const second = await startDaemon(env);
  const secondPid = second.daemon.pid ?? -1;
  const secondClient = await connectSdk(env);
  const secondSpawn = await secondClient.spawn(
    {
      sessionLabel: "foo",
      harness: "codex",
      message: "hello",
      cwd: directory,
    },
    secondClient.prepareOperation("spawn"),
  );
  expect(
    await secondClient.wait({
      targets: [secondSpawn.turnHandle],
      completion: "all",
      timeoutMs: 5_000,
    }),
  ).toMatchObject({ status: "satisfied" });
  const staleGeneration = secondClient.handshake.daemonGeneration;
  const staleHandle = secondSpawn.sessionHandle;
  const counterAfterSecond = (
    await readFile(join(stateDirectory, "generation"), "utf8")
  ).trim();
  secondClient.close();
  clients.splice(clients.indexOf(secondClient), 1);
  await stopDaemon(second.daemon, socketPath, second.errors);

  await rm(stateDirectory, { recursive: true, force: true });
  await cp(snapshotDirectory, stateDirectory, { recursive: true });

  const third = await startDaemon(env);
  const thirdPid = third.daemon.pid ?? -1;
  const thirdClient = await connectSdk(env);
  const current = await thirdClient.spawn(
    {
      sessionLabel: "foo",
      harness: "codex",
      message: "hello",
      cwd: directory,
    },
    thirdClient.prepareOperation("spawn"),
  );
  const currentGeneration = thirdClient.handshake.daemonGeneration;
  const counterAfterThird = (
    await readFile(join(stateDirectory, "generation"), "utf8")
  ).trim();

  expect(counterAfterThird).toBe(counterAfterSecond);
  expect(currentGeneration).not.toBe(staleGeneration);
  expect(v.safeParse(daemonGenerationSchema, currentGeneration).success).toBe(
    true,
  );
  expect(current.sessionHandle).not.toBe(staleHandle);
  expect(
    await thirdClient.kill(
      { sessionHandle: staleHandle },
      thirdClient.prepareOperation("kill"),
    ),
  ).toEqual({ sessionHandle: staleHandle, status: "not_found" });
  expect(await thirdClient.list({ sessionLabel: "foo" })).toMatchObject([
    { sessionHandle: current.sessionHandle },
  ]);
  expect(await thirdClient.list({ sessionLabel: "foo" })).toHaveLength(1);
  expect(
    await thirdClient.kill(
      { sessionHandle: current.sessionHandle },
      thirdClient.prepareOperation("kill"),
    ),
  ).toMatchObject({ status: "killed" });
  thirdClient.close();
  clients.splice(clients.indexOf(thirdClient), 1);

  await stopDaemon(third.daemon, socketPath, third.errors);
  expect(new Set([firstPid, secondPid, thirdPid]).size).toBe(3);
  expect(daemons.filter((daemon) => daemon.exitCode === null)).toHaveLength(0);
});
