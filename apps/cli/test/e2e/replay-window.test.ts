import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createReinsClient } from "@reins/client";
import {
  consumerContextSchema,
  decodeTurnHandle,
  encodeTurnHandle,
  type ProtocolMessage,
} from "@reins/protocol";
import { createUnixSocketClient } from "@reins/transport";
import { connect as connectSdk, ReinsSdkError } from "@ykdz/reins-sdk";
import * as v from "valibot";
import { afterEach, expect, test, vi } from "vitest";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const cliBin = join(repo, "apps/cli/dist/reins.js");
const daemonBin = join(repo, "packages/daemon/dist/main.js");
const adapters = fileURLToPath(
  new URL(
    "../../../../packages/daemon/test/fixtures/wait-adapters.ts",
    import.meta.url,
  ),
);
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
});

async function fixture(rich = true) {
  const root = await mkdtemp(join(tmpdir(), "reins-wrr18-cwd-"));
  const runtime = await mkdtemp("/dev/shm/reins-wrr18-runtime-");
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
    REINS_CONSUMER_CONTEXT: "replay-window-test",
    REINS_DAEMON_BIN: daemonBin,
  };
  const daemon: ChildProcess = spawn(
    process.execPath,
    [
      daemonBin,
      "--adapters",
      rich
        ? adapters.replace("wait-adapters.ts", "readable-events-adapters.ts")
        : adapters,
    ],
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
  async function sdk(consumerContext = env.REINS_CONSUMER_CONTEXT) {
    const connection = await connectSdk({
      socketPath: env.REINS_SOCKET,
      consumerContext,
    });
    cleanup.push(async () => connection.close());
    return connection;
  }
  async function spawnSession(sessionName: string, message: string) {
    const connection = await sdk();
    return connection.spawn(
      { sessionName, harness: "codex", message, cwd: callerCwd },
      connection.prepareOperation("spawn"),
    );
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
    spawnSession,
    daemon,
  };
}

test("public SDK resumes exactly after the last delivered fact on disconnect", async () => {
  const f = await fixture();
  const gate = join(f.root, "sdk-disconnect-release");
  const control = await f.client();
  const spawned = await f.spawnSession(
    "sdk-disconnect",
    JSON.stringify({ gate, reply: "resumed", messages: 4 }),
  );
  const sessionHandle = spawned.sessionHandle;
  const turnHandle = spawned.turnHandle;
  const target = { scope: "session" as const, sessionHandle };
  const observer = await f.sdk();
  const live = await observer.attach(target, { mode: "none" });
  const firstPromise = live.next();
  await writeFile(gate, "release");
  const first = await firstPromise;
  expect(first.done).toBe(false);
  expect(first.value?.type).toBe("message");
  const deliveredCheckpoint = live.checkpoint;
  observer.close();
  let disconnected: unknown;
  try {
    await live.done;
  } catch (error) {
    disconnected = error;
  }
  expect(disconnected).toBeInstanceOf(ReinsSdkError);
  expect(disconnected).toMatchObject({
    failure: {
      code: "daemon_disconnected",
      facts: { resumeCursor: deliveredCheckpoint },
    },
  });

  const recovery = await f.sdk();
  const resumed = await recovery.attach(target, {
    mode: "after",
    cursor: deliveredCheckpoint,
  });
  const resumedFacts: import("@ykdz/reins-sdk").AgentFact[] = [];
  for await (const fact of resumed) {
    resumedFacts.push(fact);
    if (fact.type === "turn.completed") break;
  }
  expect(await resumed.done).toMatchObject({ reason: "closed" });
  expect(resumedFacts.at(-1)?.type).toBe("turn.completed");

  const full = await recovery.attach(target, { mode: "available" });
  const fullFacts: import("@ykdz/reins-sdk").AgentFact[] = [];
  for await (const fact of full) {
    fullFacts.push(fact);
    if (fact.type === "turn.completed") break;
  }
  expect(await full.done).toMatchObject({ reason: "closed" });
  const firstIndex = fullFacts.findIndex(
    (fact) => fact.factId === first.value?.factId,
  );
  expect(firstIndex).toBeGreaterThanOrEqual(0);
  expect([first.value, ...resumedFacts]).toEqual(fullFacts.slice(firstIndex));

  expect(
    await control.request("wait", {
      targets: [decodeTurnHandle(turnHandle)],
      completion: "all",
    }),
  ).toMatchObject({ result: { completed: [{ finalReply: "resumed" }] } });
});

test("public SDK exposes a truncated window and types an expired cursor", async () => {
  const f = await fixture();
  const gate = join(f.root, "sdk-window-release");
  const control = await f.client();
  const spawned = await f.spawnSession(
    "sdk-window",
    JSON.stringify({ gate, reply: "bounded", messages: 1005 }),
  );
  const turnHandle = spawned.turnHandle;
  const target = { scope: "turn" as const, turnHandle };
  const observer = await f.sdk();
  const before = await observer.attach(target, { mode: "none" });
  const staleCursor = before.checkpoint;
  before.close();
  expect(await before.done).toMatchObject({ reason: "closed" });

  await writeFile(gate, "release");
  await control.request("wait", {
    targets: [decodeTurnHandle(turnHandle)],
    completion: "all",
  });
  const available = await observer.attach(target, { mode: "available" });
  expect(available.establishment.window).toMatchObject({
    truncated: true,
    oldest: expect.any(Number),
    head: expect.any(Number),
  });
  expect(available.establishment.window.oldest).toBeGreaterThan(1);
  const facts: import("@ykdz/reins-sdk").AgentFact[] = [];
  for await (const fact of available) facts.push(fact);
  expect(await available.done).toMatchObject({ reason: "end_turn" });
  expect(facts.length).toBeLessThanOrEqual(1000);

  await expect(
    observer.attach(target, { mode: "after", cursor: staleCursor }),
  ).rejects.toMatchObject({
    failure: {
      code: "event_cursor_expired",
      facts: {
        oldest: available.establishment.window.oldest,
        head: available.establishment.window.head,
      },
    },
  });
});

test("session replay resumes exactly after a turn and CLI replays the second turn", async () => {
  const f = await fixture();
  const firstGate = join(f.root, "first-release");
  const secondGate = join(f.root, "second-release");
  const spawned = await f.spawnSession(
    "resume",
    JSON.stringify({ gate: firstGate, reply: "first" }),
  );
  const sessionId = decodeTurnHandle(spawned.turnHandle).sessionId;
  const target = {
    scope: "session" as const,
    sessionHandle: spawned.sessionHandle,
  };
  const control = await f.client();
  const observer = await f.sdk();
  const firstSubscription = await observer.attach(target, { mode: "none" });
  const firstFacts: import("@ykdz/reins-sdk").AgentFact[] = [];
  const firstTurnEnd = (async () => {
    for (;;) {
      const item = await firstSubscription.next();
      if (item.done) throw new Error("The session ended unexpectedly");
      firstFacts.push(item.value);
      if (
        item.value.type === "turn.completed" &&
        item.value.turnHandle === spawned.turnHandle
      )
        return;
    }
  })();
  await writeFile(firstGate, "release");
  await firstTurnEnd;
  const resumeCursor = firstSubscription.checkpoint;
  const failed = firstSubscription.done.catch((error: unknown) => error);
  observer.close();
  const disconnect = await failed;
  expect(disconnect).toMatchObject({
    failure: {
      code: "daemon_disconnected",
      facts: { resumeCursor },
    },
  });
  expect(await control.request("list", { sessionId })).toMatchObject({
    result: [expect.objectContaining({ state: "idle" })],
  });

  const sent = await control.request("send", {
    placement: "new_turn",
    sessionId,
    message: JSON.stringify({ gate: secondGate, reply: "second" }),
  });
  if ("error" in sent) throw new Error(sent.error.code);
  const secondTurnHandle = encodeTurnHandle({
    sessionId: sent.result.sessionId,
    turnId: sent.result.turnId,
  }) as unknown as import("@ykdz/reins-sdk").TurnHandle;
  const secondTarget = { scope: "turn" as const, turnHandle: secondTurnHandle };
  const secondObserver = await f.sdk();
  const secondLive = await secondObserver.attach(secondTarget, {
    mode: "none",
  });
  const secondCheckpoint = secondLive.checkpoint;
  const secondFactsPromise = (async () => {
    const facts: import("@ykdz/reins-sdk").AgentFact[] = [];
    for await (const fact of secondLive) facts.push(fact);
    return facts;
  })();
  await writeFile(secondGate, "release");
  const secondFacts = await secondFactsPromise;
  expect(await secondLive.done).toMatchObject({ reason: "end_turn" });

  const recovery = await f.sdk();
  const resumed = await recovery.attach(target, {
    mode: "after",
    cursor: resumeCursor,
  });
  const resumedFacts: import("@ykdz/reins-sdk").AgentFact[] = [];
  for await (const fact of resumed) {
    resumedFacts.push(fact);
    if (fact.type === "turn.completed" && fact.turnHandle === secondTurnHandle)
      break;
  }
  expect(await resumed.done).toMatchObject({ reason: "closed" });
  expect(
    resumedFacts.filter((fact) => fact.type === "turn.completed"),
  ).toHaveLength(1);
  const full = await recovery.attach(target, { mode: "available" });
  const fullFacts: import("@ykdz/reins-sdk").AgentFact[] = [];
  for await (const fact of full) {
    fullFacts.push(fact);
    if (fact.type === "turn.completed" && fact.turnHandle === secondTurnHandle)
      break;
  }
  expect(await full.done).toMatchObject({ reason: "closed" });
  const firstTerminal = fullFacts.findIndex(
    (fact) =>
      fact.type === "turn.completed" && fact.turnHandle === spawned.turnHandle,
  );
  expect(firstTerminal).toBeGreaterThanOrEqual(0);
  expect(resumedFacts).toEqual(fullFacts.slice(firstTerminal + 1));

  const replay = await f.cli([
    "attach",
    secondTurnHandle,
    "--scope",
    "turn",
    "--replay",
    "after",
    "--cursor",
    secondCheckpoint,
  ]);
  expect(replay.exitCode, replay.stdout + replay.stderr).toBe(0);
  const records = replay.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const cliFacts = records
    .filter((record) => record.kind === "record" && record.variant === "fact")
    .map((record) => (record.data as { fact: Record<string, unknown> }).fact);
  expect(cliFacts.map((fact) => fact.factId)).toEqual(
    secondFacts.map((fact) => fact.factId),
  );
  expect(records.at(-2)).toMatchObject({
    kind: "record",
    variant: "ended",
    data: { end: { reason: "end_turn" } },
  });
});

test("available remains bounded during an unfinished text stream", async () => {
  const f = await fixture();
  const gate = join(f.root, "release");
  const spawned = await f.spawnSession(
    "unfinished",
    JSON.stringify({ gate, reply: "done", deltas: 1005, permission: true }),
  );
  const observer = await f.sdk();
  const target = {
    scope: "session" as const,
    sessionHandle: spawned.sessionHandle,
  };
  const live = await observer.attach(target, { mode: "none" });
  const permissionReached = (async () => {
    for await (const fact of live)
      if (fact.type === "permission.requested") return fact;
    throw new Error("The permission request was not emitted");
  })();
  await writeFile(gate, "release");
  expect(await permissionReached).toMatchObject({
    type: "permission.requested",
  });
  live.close();
  expect(await live.done).toMatchObject({ reason: "closed" });

  const subscription = await observer.attach(target, { mode: "available" });
  expect(subscription.establishment.replayed).toBeLessThanOrEqual(1000);
  expect(subscription.establishment.window.truncated).toBe(true);
  const facts: import("@ykdz/reins-sdk").AgentFact[] = [];
  for await (const fact of subscription) {
    facts.push(fact);
    if (fact.type === "permission.requested") break;
  }
  expect(facts.some((fact) => fact.type === "permission.requested")).toBe(true);
  expect(facts.some((fact) => fact.type === "turn.completed")).toBe(false);
  subscription.close();
  expect(await subscription.done).toMatchObject({ reason: "closed" });
});

test("SDK and CLI reject an expired cursor while preserving exact window boundaries", async () => {
  const f = await fixture();
  const firstGate = join(f.root, "first-release");
  const secondGate = join(f.root, "second-release");
  const spawned = await f.spawnSession(
    "expired",
    JSON.stringify({ gate: firstGate, reply: "first" }),
  );
  const sessionId = decodeTurnHandle(spawned.turnHandle).sessionId;
  const target = {
    scope: "session" as const,
    sessionHandle: spawned.sessionHandle,
  };
  const control = await f.client();
  const observer = await f.sdk();
  const initial = await observer.attach(target, { mode: "none" });
  const staleCursor = initial.checkpoint;
  initial.close();
  await initial.done;
  await writeFile(firstGate, "release");
  await control.request("wait", {
    targets: [decodeTurnHandle(spawned.turnHandle)],
    completion: "all",
  });
  const sent = await control.request("send", {
    placement: "new_turn",
    sessionId,
    message: JSON.stringify({
      gate: secondGate,
      reply: "second",
      messages: 1005,
    }),
  });
  if ("error" in sent) throw new Error(sent.error.code);
  const secondTurnHandle = encodeTurnHandle({
    sessionId: sent.result.sessionId,
    turnId: sent.result.turnId,
  }) as unknown as import("@ykdz/reins-sdk").TurnHandle;
  await writeFile(secondGate, "release");
  await control.request("wait", {
    targets: [decodeTurnHandle(secondTurnHandle)],
    completion: "all",
  });

  await expect(
    observer.attach(target, { mode: "after", cursor: staleCursor }),
  ).rejects.toMatchObject({
    failure: {
      code: "event_cursor_expired",
      facts: { oldest: expect.any(Number), head: expect.any(Number) },
    },
  });
  const available = await observer.attach(target, { mode: "available" });
  expect(available.establishment.window).toMatchObject({
    truncated: true,
    oldest: expect.any(Number),
    head: expect.any(Number),
  });
  expect(available.establishment.replayed).toBe(1000);
  const availableFacts: import("@ykdz/reins-sdk").AgentFact[] = [];
  let oldestCursor: import("@ykdz/reins-sdk").ResumeCursor | undefined;
  for (;;) {
    const item = await available.next();
    if (item.done) break;
    availableFacts.push(item.value);
    if (oldestCursor === undefined) oldestCursor = available.checkpoint;
    if (
      item.value.type === "turn.completed" &&
      item.value.turnHandle === secondTurnHandle
    )
      break;
  }
  const headCursor = available.checkpoint;
  available.close();
  expect(await available.done).toMatchObject({ reason: "closed" });
  expect(availableFacts).toHaveLength(1000);
  expect(availableFacts.at(-1)?.type).toBe("turn.completed");
  if (oldestCursor === undefined)
    throw new Error("The replay window was empty");
  const afterOldest = await observer.attach(target, {
    mode: "after",
    cursor: oldestCursor,
  });
  expect(afterOldest.establishment.replayed).toBe(999);
  afterOldest.close();
  await afterOldest.done;
  const afterHead = await observer.attach(target, {
    mode: "after",
    cursor: headCursor,
  });
  expect(afterHead.establishment.replayed).toBe(0);
  afterHead.close();
  await afterHead.done;

  const cli = await f.cli([
    "attach",
    spawned.sessionHandle,
    "--scope",
    "session",
    "--replay",
    "after",
    "--cursor",
    staleCursor,
  ]);
  expect(cli.exitCode, cli.stdout + cli.stderr).toBe(70);
  const cliFailure = cli.stderr
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(cliFailure.at(-1)).toMatchObject({
    kind: "failure",
    command: "attach",
    variant: "attachFailed",
    data: { failure: { code: "event_cursor_expired" } },
  });
  const availableCli = await f.cli([
    "attach",
    secondTurnHandle,
    "--scope",
    "turn",
    "--replay",
    "available",
    "--output-format",
    "text",
  ]);
  expect(availableCli.exitCode, availableCli.stdout).toBe(0);
  expect(availableCli.stdout).toContain("(truncated)");
});

test("SDK cursors remain bound to their exact scope and session", async () => {
  const f = await fixture();
  const gate = join(f.root, "release");
  const first = await f.spawnSession(
    "bound",
    JSON.stringify({ gate, reply: "first" }),
  );
  const firstSession = {
    scope: "session" as const,
    sessionHandle: first.sessionHandle,
  };
  const observer = await f.sdk();
  const source = await observer.attach(firstSession, { mode: "none" });
  const cursor = source.checkpoint;
  source.close();
  await source.done;
  await expect(
    observer.attach(
      { scope: "turn", turnHandle: first.turnHandle },
      { mode: "after", cursor },
    ),
  ).rejects.toMatchObject({ failure: { code: "invalid_params" } });
  const other = await f.spawnSession(
    "other",
    JSON.stringify({ gate, reply: "other" }),
  );
  await expect(
    observer.attach(
      { scope: "session", sessionHandle: other.sessionHandle },
      { mode: "after", cursor },
    ),
  ).rejects.toMatchObject({ failure: { code: "invalid_params" } });
});
