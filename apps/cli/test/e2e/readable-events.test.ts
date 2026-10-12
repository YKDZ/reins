import { spawn, type ChildProcess } from "node:child_process";
import {
  access,
  readFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createReinsClient } from "@reins/client";
import {
  consumerContextSchema,
  decodeTurnHandle,
  decodePermissionHandle,
  encodeTurnHandle,
  turnIdSchema,
  type ProtocolMessage,
} from "@reins/protocol";
import { createUnixSocketClient } from "@reins/transport";
import {
  connect as connectSdk,
  createPresentationProjector,
} from "@ykdz/reins-sdk";
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

async function fixture(rich = false, isolatedProcessGroup = false) {
  const root = await mkdtemp(join(tmpdir(), "reins-wrr17-cwd-"));
  const runtime = await mkdtemp("/dev/shm/reins-wrr17-runtime-");
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
    REINS_CONSUMER_CONTEXT: "readable-events-test",
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
    {
      cwd: daemonCwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      ...(isolatedProcessGroup ? { detached: true } : {}),
    },
  );
  const errors: string[] = [];
  daemon.stderr?.on("data", (chunk) => errors.push(String(chunk)));
  const stopDaemon = async (signal: NodeJS.Signals = "SIGTERM") => {
    if (daemon.exitCode !== null || daemon.signalCode !== null) return;
    const closed = new Promise<void>((resolve) =>
      daemon.once("close", () => resolve()),
    );
    if (
      isolatedProcessGroup &&
      process.platform !== "win32" &&
      daemon.pid !== undefined
    )
      process.kill(-daemon.pid, signal);
    else daemon.kill(signal);
    await closed;
  };
  cleanup.push(() => stopDaemon());
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
    stopDaemon,
  };
}

test("public SDK facts keep their identity across none, available, and after, and CLI renders the same history", async () => {
  const f = await fixture(true);
  const gate = join(f.root, "stable-facts-release");
  const resolutionFile = join(f.root, "stable-facts-resolution.json");
  const control = await f.client();
  const spawned = await f.spawnSession(
    "stable-facts",
    JSON.stringify({
      gate,
      reply: "done",
      permission: true,
      resolutionFile,
    }),
  );
  const turnHandle = spawned.turnHandle;
  const observer = await f.sdk();
  const target = {
    scope: "turn" as const,
    turnHandle: turnHandle as unknown as import("@ykdz/reins-sdk").TurnHandle,
  };
  const live = await observer.attach(target, { mode: "none" });
  const checkpoint = live.checkpoint;
  const consume = async (
    subscription: Awaited<ReturnType<typeof observer.attach>>,
    resolveRequests = false,
  ) => {
    const facts: import("@ykdz/reins-sdk").AgentFact[] = [];
    for await (const fact of subscription) {
      facts.push(fact);
      if (resolveRequests && fact.type === "permission.requested") {
        const response = await control.request("resolvePermission", {
          ...decodePermissionHandle(fact.permissionHandle),
          resolution: { outcome: "deny", feedback: "not approved" },
        });
        if ("error" in response) throw new Error(response.error.code);
      }
    }
    return facts;
  };
  const liveFactsPromise = consume(live, true);
  await writeFile(gate, "release");
  const liveFacts = await liveFactsPromise;
  expect(await live.done).toMatchObject({ reason: "end_turn" });
  expect(liveFacts.map((fact) => fact.type)).toEqual([
    "text.delta",
    "text.delta",
    "message",
    "tool.requested",
    "tool.completed",
    "permission.requested",
    "permission.resolved",
    "turn.completed",
  ]);

  const available = await observer.attach(target, { mode: "available" });
  const availableFacts = await consume(available);
  expect(await available.done).toMatchObject({ reason: "end_turn" });
  const byIdentity = new Map(availableFacts.map((fact) => [fact.factId, fact]));
  for (const fact of liveFacts)
    expect(byIdentity.get(fact.factId)).toEqual(fact);

  const resumed = await observer.attach(target, {
    mode: "after",
    cursor: checkpoint,
  });
  const resumedFacts = await consume(resumed);
  expect(await resumed.done).toMatchObject({ reason: "end_turn" });
  expect(resumedFacts).toEqual(liveFacts);

  await expect(
    observer.attach(
      {
        scope: "session",
        sessionHandle: spawned.sessionHandle,
      },
      { mode: "after", cursor: checkpoint },
    ),
  ).rejects.toMatchObject({
    failure: {
      code: "invalid_params",
      facts: {
        issues: [expect.objectContaining({ path: "replay.cursor" })],
      },
    },
  });

  const targetAddress = decodeTurnHandle(turnHandle);
  expect(
    await control.request("wait", {
      targets: [targetAddress],
      completion: "all",
    }),
  ).toMatchObject({ result: { completed: [{ finalReply: "done" }] } });
  const structured = await f.cli([
    "attach",
    turnHandle,
    "--scope",
    "turn",
    "--replay",
    "available",
  ]);
  expect(structured.exitCode, structured.stdout + structured.stderr).toBe(0);
  const frames = structured.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const cliFacts = frames
    .filter((frame) => frame.kind === "record" && frame.variant === "fact")
    .map((frame) => (frame.data as { fact: Record<string, unknown> }).fact);
  expect(cliFacts.map((fact) => fact.factId)).toEqual(
    availableFacts.map((fact) => fact.factId),
  );
  expect(cliFacts.find((fact) => fact.type === "message")).toMatchObject({
    content: "hello world",
  });
  for (const fact of cliFacts)
    for (const key of ["sessionId", "turnId", "messageId", "toolCallId"])
      expect(fact).not.toHaveProperty(key);

  const rendered = await f.cli([
    "attach",
    turnHandle,
    "--scope",
    "turn",
    "--replay",
    "available",
    "--output-format",
    "text",
  ]);
  expect(rendered.exitCode, rendered.stdout + rendered.stderr).toBe(0);
  expect(rendered.stdout).toContain("worker: hello world");
  expect(rendered.stdout).toContain("[tool] read-file completed");
  expect(rendered.stdout).not.toContain("native-result-name");
});

test("SDK abort preserves AbortError and closes observation without stopping its session", async () => {
  const f = await fixture();
  const gate = join(f.root, "abort-observation-release");
  const spawned = await f.spawnSession(
    "abort-observation",
    JSON.stringify({ gate, reply: "still running" }),
  );
  const observer = await f.sdk();
  const target = { scope: "turn" as const, turnHandle: spawned.turnHandle };
  const preAborted = new AbortController();
  preAborted.abort();

  await expect(
    observer.attach(target, { mode: "none" }, preAborted.signal),
  ).rejects.toMatchObject({ name: "AbortError" });

  const controller = new AbortController();
  const subscription = await observer.attach(
    target,
    { mode: "none" },
    controller.signal,
  );
  controller.abort();
  await expect(subscription.done).resolves.toMatchObject({ reason: "closed" });

  const control = await f.client();
  expect(
    await control.request("list", {
      sessionId: decodeTurnHandle(spawned.turnHandle).sessionId,
    }),
  ).toMatchObject({
    result: [expect.objectContaining({ state: "busy" })],
  });
  await writeFile(gate, "release");
  const turn = decodeTurnHandle(spawned.turnHandle);
  expect(
    await control.request("wait", {
      targets: [turn],
      completion: "all",
    }),
  ).toMatchObject({ result: { completed: [{ finalReply: "still running" }] } });
});

test("interrupting a live CLI attach closes observation without killing its turn", async () => {
  const f = await fixture(true);
  const gate = join(f.root, "interrupt-release");
  const control = await f.client();
  const spawned = await f.spawnSession(
    "interrupt-observation",
    JSON.stringify({ gate, reply: "still running" }),
  );
  const turnHandle = spawned.turnHandle;
  const target = decodeTurnHandle(turnHandle);
  const child = spawn(
    process.execPath,
    [cliBin, "attach", turnHandle, "--scope", "turn", "--replay", "none"],
    { cwd: f.callerCwd, env: f.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  cleanup.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.kill("SIGTERM");
    });
  });
  const closed = new Promise<number | null>((resolve) =>
    child.once("close", resolve),
  );
  await vi.waitFor(() =>
    expect(stdout.join("")).toContain('"variant":"established"'),
  );
  child.kill("SIGINT");
  expect(await closed, stderr.join("")).toBe(0);
  expect(stdout.join("")).toContain('"variant":"ended"');
  expect(stdout.join("")).toContain('"reason":"closed"');
  expect(
    await (await f.sdk()).list({ sessionHandle: spawned.sessionHandle }),
  ).toEqual([expect.objectContaining({ state: "busy" })]);

  await writeFile(gate, "release");
  expect(
    await control.request("wait", { targets: [target], completion: "all" }),
  ).toMatchObject({ result: { completed: [{ finalReply: "still running" }] } });
});

test("the SDK replays a completed turn when observation starts after completion", async () => {
  const f = await fixture();
  const spawned = await f.spawnSession("ack-order", "caller task");
  const control = await f.client();
  expect(
    await control.request("wait", {
      targets: [decodeTurnHandle(spawned.turnHandle)],
      completion: "all",
    }),
  ).toMatchObject({ result: { completed: [{ stopReason: "end_turn" }] } });
  const observer = await f.sdk();
  const subscription = await observer.attach(
    { scope: "turn", turnHandle: spawned.turnHandle },
    { mode: "available" },
  );
  const facts: import("@ykdz/reins-sdk").AgentFact[] = [];
  for await (const fact of subscription) facts.push(fact);
  expect(await subscription.done).toMatchObject({ reason: "end_turn" });
  expect(facts.at(-1)).toMatchObject({
    type: "turn.completed",
    turnHandle: spawned.turnHandle,
    stopReason: "end_turn",
  });
});

test("SDK turn observation ends on its exact turn while session observation continues", async () => {
  const f = await fixture();
  const gate = join(f.root, "release");
  const first = await f.spawnSession(
    "exact",
    JSON.stringify({ gate, reply: "first" }),
  );
  const firstAddress = decodeTurnHandle(first.turnHandle);
  const observer = await f.sdk();
  const control = await f.client();
  const turn = await observer.attach(
    { scope: "turn", turnHandle: first.turnHandle },
    { mode: "none" },
  );
  const session = await observer.attach(
    { scope: "session", sessionHandle: first.sessionHandle },
    { mode: "none" },
  );
  const collect = async (
    subscription: Awaited<ReturnType<typeof observer.attach>>,
  ) => {
    const facts: import("@ykdz/reins-sdk").AgentFact[] = [];
    for await (const fact of subscription) facts.push(fact);
    return facts;
  };
  const turnFactsPromise = collect(turn);
  const sessionFacts: import("@ykdz/reins-sdk").AgentFact[] = [];
  const sessionFactsPromise = (async () => {
    for await (const fact of session) sessionFacts.push(fact);
  })();
  await writeFile(gate, "release");
  const turnFacts = await turnFactsPromise;
  expect(await turn.done).toMatchObject({ reason: "end_turn" });
  const sent = await control.request("send", {
    placement: "new_turn",
    sessionId: firstAddress.sessionId,
    message: "successor",
  });
  if ("error" in sent) throw new Error(sent.error.code);
  const secondTurnHandle = encodeTurnHandle({
    sessionId: sent.result.sessionId,
    turnId: sent.result.turnId,
  }) as unknown as import("@ykdz/reins-sdk").TurnHandle;
  await vi.waitFor(() =>
    expect(
      sessionFacts.filter((fact) => fact.type === "turn.completed"),
    ).toHaveLength(2),
  );
  session.close();
  expect(await session.done).toMatchObject({ reason: "closed" });
  await sessionFactsPromise;
  const turnEnds = (facts: readonly import("@ykdz/reins-sdk").AgentFact[]) =>
    facts.filter((fact) => fact.type === "turn.completed");
  expect(turnEnds(turnFacts)).toHaveLength(1);
  expect(turnEnds(sessionFacts)).toHaveLength(2);
  expect(turnEnds(sessionFacts).map((fact) => fact.turnHandle)).toEqual([
    first.turnHandle,
    secondTurnHandle,
  ]);
});

test("SDK facts retain permission history while the presenter pairs text and tools", async () => {
  const f = await fixture(true);
  const gate = join(f.root, "release"),
    resolutionFile = join(f.root, "resolution.json");
  const spawned = await f.spawnSession(
    "permission",
    JSON.stringify({ gate, reply: "done", permission: true, resolutionFile }),
  );
  const observer = await f.sdk();
  const control = await f.client();
  const subscription = await observer.attach(
    { scope: "turn", turnHandle: spawned.turnHandle },
    { mode: "none" },
  );
  const facts: import("@ykdz/reins-sdk").AgentFact[] = [];
  const presentations: import("@ykdz/reins-sdk").AgentPresentation[] = [];
  const project = createPresentationProjector();
  const consumed = (async () => {
    for await (const fact of subscription) {
      facts.push(fact);
      presentations.push(...project(fact));
      if (fact.type !== "permission.requested") continue;
      const permissionAddress = decodePermissionHandle(fact.permissionHandle);
      const rejected = await control.request("resolvePermission", {
        ...permissionAddress,
        turnId: v.parse(turnIdSchema, "wrong-parent"),
        resolution: { outcome: "deny" },
      });
      expect(rejected).toMatchObject({ error: { code: "invalid_params" } });
      await expect(access(resolutionFile)).rejects.toThrow();
      const resolution = await control.request("resolvePermission", {
        ...permissionAddress,
        resolution: { outcome: "deny", feedback: "caller feedback" },
      });
      expect(resolution).toHaveProperty("result");
    }
  })();
  await writeFile(gate, "release");
  await consumed;
  expect(await subscription.done).toMatchObject({ reason: "end_turn" });
  const requested = facts.find((fact) => fact.type === "permission.requested");
  const resolved = facts.find((fact) => fact.type === "permission.resolved");
  expect(requested).toMatchObject({ type: "permission.requested" });
  expect(resolved).toMatchObject({ type: "permission.resolved" });
  if (requested?.type !== "permission.requested")
    throw new Error("missing permission request fact");
  if (resolved?.type !== "permission.resolved")
    throw new Error("missing permission resolution fact");
  expect(resolved.permissionHandle).toBe(requested.permissionHandle);
  expect(facts.find((fact) => fact.type === "message")).toMatchObject({
    content: "hello world",
  });
  expect(
    presentations
      .filter((presentation) => presentation.type === "text")
      .map((presentation) => presentation.content)
      .join(""),
  ).toBe("hello world");
  expect(
    presentations.find(
      (presentation) => presentation.type === "text" && presentation.complete,
    ),
  ).toMatchObject({ complete: true });
  expect(facts.find((fact) => fact.type === "tool.completed")).toMatchObject({
    name: "native-result-name",
    result: "file contents",
  });
  expect(
    presentations.find(
      (presentation) => presentation.type === "tool.completed",
    ),
  ).toMatchObject({ name: "read-file", result: "file contents" });
  for (const fact of facts)
    for (const key of [
      "sessionId",
      "turnId",
      "permissionId",
      "messageId",
      "toolCallId",
      "subscriptionId",
      "eventId",
    ])
      expect(fact).not.toHaveProperty(key);
  expect(JSON.parse(await readFile(resolutionFile, "utf8"))).toEqual({
    outcome: "deny",
    feedback: "caller feedback",
  });
  expect(
    facts.filter((fact) => fact.type === "permission.resolved"),
  ).toHaveLength(1);
});

test.each(["failed", "cancelled"] as const)(
  "turn scope preserves its %s terminal fact and text rendering",
  async (stopReason) => {
    const f = await fixture();
    const gate = join(f.root, "release");
    const spawned = await f.spawnSession(
      "terminal",
      JSON.stringify({ gate, reply: "done", stopReason }),
    );
    const observer = await f.sdk();
    const subscription = await observer.attach(
      { scope: "turn", turnHandle: spawned.turnHandle },
      { mode: "none" },
    );
    await writeFile(gate, "release");
    const events: import("@ykdz/reins-sdk").AgentFact[] = [];
    for await (const event of subscription) events.push(event);
    expect(await subscription.done).toMatchObject({ reason: stopReason });
    const terminal = events.find((event) => event.type === "turn.completed");
    expect(terminal).toMatchObject({ type: "turn.completed", stopReason });
    const failure =
      stopReason === "failed"
        ? {
            failureCategory: "unclassified",
            retryDisposition: "unknown",
          }
        : undefined;
    if (stopReason === "failed") {
      expect(terminal).toMatchObject({ failure });
      expect(terminal).not.toHaveProperty("turnId");
      const control = await f.client();
      expect(
        await control.request("wait", {
          targets: [decodeTurnHandle(spawned.turnHandle)],
          completion: "all",
          timeoutMs: 0,
        }),
      ).toMatchObject({ result: { completed: [{ failure }] } });
    }
    const args = [
      "attach",
      spawned.turnHandle,
      "--scope",
      "turn",
      "--replay",
      "available",
    ];
    const structured = await f.cli(args);
    expect(structured.exitCode, structured.stdout + structured.stderr).toBe(0);
    const frames = structured.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const projected = frames
      .filter((frame) => frame.kind === "record" && frame.variant === "fact")
      .map((frame) => (frame.data as { fact: Record<string, unknown> }).fact)
      .find((fact) => fact.type === "turn.completed");
    expect(projected).toMatchObject({ type: "turn.completed", stopReason });
    if (failure !== undefined) expect(projected).toMatchObject({ failure });
    const rendered = await f.cli([...args, "--output-format", "text"]);
    expect(rendered.exitCode, rendered.stdout + rendered.stderr).toBe(0);
    expect(rendered.stdout).toContain(`[turn completed] ${stopReason}`);
  },
);

test("CLI preserves structured facts before a typed daemon_disconnected failure", async () => {
  const f = await fixture(true, true);
  const gate = join(f.root, "release");
  const spawned = await f.spawnSession(
    "disconnect",
    JSON.stringify({ gate, reply: "unused", permission: true }),
  );
  const observer = await f.sdk();
  const sdkSubscription = await observer.attach(
    { scope: "turn", turnHandle: spawned.turnHandle },
    { mode: "none" },
  );
  const sdkCheckpoints = new Map<string, string>();
  let sdkIteratorFailure: unknown;
  const sdkDrain = (async () => {
    try {
      for await (const fact of sdkSubscription)
        sdkCheckpoints.set(fact.factId, sdkSubscription.checkpoint);
    } catch (error) {
      sdkIteratorFailure = error;
    }
  })();
  const child = spawn(
    process.execPath,
    [
      cliBin,
      "attach",
      spawned.turnHandle,
      "--scope",
      "turn",
      "--replay",
      "none",
    ],
    { env: f.env, cwd: f.callerCwd, stdio: ["ignore", "pipe", "pipe"] },
  );
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) =>
        child.once("close", () => resolve()),
      );
    }
  });
  const output: string[] = [];
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  const stderr: string[] = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  const exited = new Promise<number | null>((resolve) =>
    child.once("close", resolve),
  );
  const cliFacts = () =>
    output
      .join("")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((frame) => frame.kind === "record" && frame.variant === "fact");
  await vi.waitFor(() =>
    expect(output.join("")).toContain('"variant":"established"'),
  );
  await writeFile(gate, "release");
  await vi.waitFor(() => expect(cliFacts().length).toBeGreaterThanOrEqual(2));
  await f.stopDaemon("SIGKILL");
  expect(await exited, stderr.join("")).toBe(70);
  await sdkDrain;
  const records = output
    .join("")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const deliveredFacts = records.filter(
    (record) => record.kind === "record" && record.variant === "fact",
  );
  expect(deliveredFacts.length).toBeGreaterThanOrEqual(2);
  const failures = stderr
    .join("")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const lastFactFrame = deliveredFacts.at(-1);
  expect(lastFactFrame).toBeDefined();
  const lastFact = (
    lastFactFrame?.data as { fact: { factId: string } } | undefined
  )?.fact;
  const expectedCheckpoint =
    lastFact === undefined ? undefined : sdkCheckpoints.get(lastFact.factId);
  expect(expectedCheckpoint).toEqual(expect.any(String));
  expect(sdkIteratorFailure).toMatchObject({
    failure: {
      code: "daemon_disconnected",
      facts: { resumeCursor: expectedCheckpoint },
    },
  });
  expect(failures.at(-1)).toMatchObject({
    kind: "failure",
    command: "attach",
    variant: "attachFailed",
    data: {
      failure: {
        code: "daemon_disconnected",
        facts: { resumeCursor: expectedCheckpoint },
      },
    },
  });
  for (const frame of [...records, ...failures])
    expect(frame).not.toHaveProperty("sessionId");
});

test("separate SDK observers receive the same stable fact history", async () => {
  const f = await fixture();
  const gate = join(f.root, "release");
  const spawned = await f.spawnSession(
    "concurrent",
    JSON.stringify({ gate, reply: "done" }),
  );
  const [firstObserver, secondObserver] = await Promise.all([f.sdk(), f.sdk()]);
  const target = {
    scope: "turn" as const,
    turnHandle: spawned.turnHandle,
  };
  const [first, second] = await Promise.all([
    firstObserver.attach(target, { mode: "none" }),
    secondObserver.attach(target, { mode: "none" }),
  ]);
  const collect = async (
    subscription: Awaited<ReturnType<typeof firstObserver.attach>>,
  ) => {
    const facts: import("@ykdz/reins-sdk").AgentFact[] = [];
    for await (const fact of subscription) facts.push(fact);
    return facts;
  };
  const firstFacts = collect(first);
  const secondFacts = collect(second);
  await writeFile(gate, "release");
  const histories = await Promise.all([firstFacts, secondFacts]);
  expect(await first.done).toMatchObject({ reason: "end_turn" });
  expect(await second.done).toMatchObject({ reason: "end_turn" });
  expect(histories[0]).toEqual(histories[1]);
  expect(histories[0].at(-1)).toMatchObject({
    type: "turn.completed",
    turnHandle: spawned.turnHandle,
    stopReason: "end_turn",
  });
});
