import { spawn, type ChildProcess } from "node:child_process";
import {
  access,
  readFile,
  mkdir,
  mkdtemp,
  rm,
  stat,
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
  encodePermissionHandle,
  encodeTurnHandle,
  sessionNameSchema,
  turnIdSchema,
  type ProtocolMessage,
} from "@reins/protocol";
import { createUnixSocketClient } from "@reins/transport";
import { connect as connectSdk } from "@ykdz/reins-sdk";
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

async function fixture(rich = false) {
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
  return { root, runtime, daemonCwd, callerCwd, env, cli, client, sdk, daemon };
}

test("public SDK facts keep their identity across none, available, and after, and CLI renders the same history", async () => {
  const f = await fixture(true);
  const gate = join(f.root, "stable-facts-release");
  const resolutionFile = join(f.root, "stable-facts-resolution.json");
  const control = await f.client();
  const cwdStat = await stat(f.callerCwd, { bigint: true });
  const spawned = await control.request("spawn", {
    harness: "codex",
    sessionName: v.parse(sessionNameSchema, "stable-facts"),
    message: JSON.stringify({
      gate,
      reply: "done",
      permission: true,
      resolutionFile,
    }),
    cwd: f.callerCwd,
    cwdIdentity: { device: String(cwdStat.dev), inode: String(cwdStat.ino) },
  });
  if ("error" in spawned) throw new Error(spawned.error.code);
  const turnHandle = encodeTurnHandle({
    sessionId: spawned.result.sessionId,
    turnId: spawned.result.turnId,
  });
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
        sessionHandle: spawned.result
          .sessionId as unknown as import("@ykdz/reins-sdk").SessionHandle,
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

test("interrupting a live CLI attach closes observation without killing its turn", async () => {
  const f = await fixture(true);
  const gate = join(f.root, "interrupt-release");
  const control = await f.client();
  const cwdStat = await stat(f.callerCwd, { bigint: true });
  const spawned = await control.request("spawn", {
    harness: "codex",
    sessionName: v.parse(sessionNameSchema, "interrupt-observation"),
    message: JSON.stringify({ gate, reply: "still running" }),
    cwd: f.callerCwd,
    cwdIdentity: { device: String(cwdStat.dev), inode: String(cwdStat.ino) },
  });
  if ("error" in spawned) throw new Error(spawned.error.code);
  const turnHandle = encodeTurnHandle({
    sessionId: spawned.result.sessionId,
    turnId: spawned.result.turnId,
  });
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
    await control.request("list", { sessionId: spawned.result.sessionId }),
  ).toMatchObject({
    result: [expect.objectContaining({ state: "busy" })],
  });

  await writeFile(gate, "release");
  const target = decodeTurnHandle(turnHandle);
  expect(
    await control.request("wait", { targets: [target], completion: "all" }),
  ).toMatchObject({ result: { completed: [{ finalReply: "still running" }] } });
});

test("a completed turn receives its establishment ACK before any subscription notification", async () => {
  const { cli, env } = await fixture();
  const spawned = await cli([
    "spawn",
    "codex",
    "caller task",
    "--name",
    "ack-order",
  ]);
  expect(spawned.exitCode, spawned.stdout).toBe(0);
  const target = decodeTurnHandle(JSON.parse(spawned.stdout).turnHandle);
  const connection = await createUnixSocketClient<ProtocolMessage>(
    env.REINS_SOCKET,
  );
  const messages: ProtocolMessage[] = [];
  connection.onEvent((event) => {
    if (event.kind === "message") messages.push(event.message);
  });
  const client = createReinsClient(connection, {
    consumerContext: v.parse(consumerContextSchema, env.REINS_CONSUMER_CONTEXT),
  });
  cleanup.push(async () => client.close());
  expect(await client.initialize()).toHaveProperty("result");
  await vi.waitFor(async () =>
    expect(await client.request("list", {})).toMatchObject({
      result: [expect.objectContaining({ state: "idle" })],
    }),
  );
  messages.length = 0;
  let end!: () => void;
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  client.onNotification((notification) => {
    if (notification.method === "attach.ended") end();
  });
  expect(
    await client.request("attach", {
      scope: "turn",
      ...target,
      replay: { mode: "none" },
    }),
  ).toHaveProperty("result");
  await ended;
  expect(messages[0]).toMatchObject({
    kind: "response",
    result: expect.anything(),
  });
});

test("none turn subscription stays on its exact turn while session subscription survives it and closes explicitly", async () => {
  const f = await fixture();
  const gate = join(f.root, "release");
  const first = await f.cli([
    "spawn",
    "codex",
    JSON.stringify({ gate, reply: "first" }),
    "--name",
    "exact",
  ]);
  const target = decodeTurnHandle(JSON.parse(first.stdout).turnHandle);
  const client = await f.client();
  const wire: import("@reins/protocol").ProtocolNotification[] = [];
  client.onNotification((event) => wire.push(event));
  const turn = await client.subscribe({
    scope: "turn",
    ...target,
    replay: { mode: "none" },
  });
  const session = await client.subscribe({
    scope: "session",
    sessionId: target.sessionId,
    replay: { mode: "none" },
  });
  expect(turn.establishment).not.toHaveProperty("subscriptionId");
  expect(turn.establishment.target).not.toHaveProperty("sessionId");
  const turnEvents: import("@reins/client").AgentEvent[] = [];
  const sessionEvents: import("@reins/client").AgentEvent[] = [];
  turn.onEvent((event) => turnEvents.push(event));
  session.onEvent((event) => sessionEvents.push(event));
  await writeFile(gate, "release");
  expect(await turn.done).toMatchObject({ reason: "end_turn" });
  const sent = await f.cli([
    "send",
    target.sessionId,
    "successor",
    "--placement",
    "new_turn",
  ]);
  expect(sent.exitCode, sent.stdout).toBe(0);
  await vi.waitFor(() =>
    expect(
      sessionEvents.filter((event) => event.type === "turn.completed"),
    ).toHaveLength(2),
  );
  expect(
    turnEvents.filter((event) => event.type === "turn.completed"),
  ).toHaveLength(1);
  session.close();
  expect(await session.done).toMatchObject({ reason: "closed" });
  const closed = wire.find(
    (event) =>
      event.method === "attach.ended" && event.params.reason === "closed",
  )!;
  const positions = wire
    .filter(
      (event) =>
        event.method === "event" &&
        event.params.subscriptionId === closed.params.subscriptionId,
    )
    .map((event) => (event.method === "event" ? event.params.eventId : 0));
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(new Set(positions).size).toBe(positions.length);
});

test("shared client projects merged text, paired tools and a complete permission reusable by a short-lived CLI", async () => {
  const f = await fixture(true);
  const gate = join(f.root, "release"),
    resolutionFile = join(f.root, "resolution.json");
  const spawned = await f.cli([
    "spawn",
    "codex",
    JSON.stringify({ gate, reply: "done", permission: true, resolutionFile }),
    "--name",
    "permission",
  ]);
  expect(spawned.exitCode, spawned.stdout).toBe(0);
  const target = decodeTurnHandle(JSON.parse(spawned.stdout).turnHandle);
  const client = await f.client();
  const subscription = await client.subscribe({
    scope: "turn",
    ...target,
    replay: { mode: "none" },
  });
  const events: import("@reins/client").AgentEvent[] = [];
  subscription.onEvent((event) => events.push(event));
  await writeFile(gate, "release");
  await vi.waitFor(() =>
    expect(events.some((event) => event.type === "permission.requested")).toBe(
      true,
    ),
  );
  const permission = events.find(
    (event) => event.type === "permission.requested",
  )!;
  if (permission.type !== "permission.requested")
    throw new Error("missing permission");
  expect(
    events
      .filter((event) => event.type === "text")
      .map((event) => event.content)
      .join(""),
  ).toBe("hello world");
  expect(events.find((event) => event.type === "tool.completed")).toMatchObject(
    { name: "read-file", result: "file contents" },
  );
  for (const event of events)
    for (const key of [
      "sessionId",
      "turnId",
      "permissionId",
      "messageId",
      "toolCallId",
      "subscriptionId",
    ])
      expect(event).not.toHaveProperty(key);
  const rejected = await f.cli([
    "resolve-permission",
    encodePermissionHandle({
      ...decodePermissionHandle(permission.permissionHandle),
      turnId: v.parse(turnIdSchema, "wrong-parent"),
    }),
    "--outcome",
    "deny",
  ]);
  expect(rejected.exitCode, rejected.stdout + rejected.stderr).toBe(64);
  expect(JSON.parse(rejected.stdout)).toMatchObject({ code: "invalid_params" });
  await expect(access(resolutionFile)).rejects.toThrow();
  const resolution = await f.cli([
    "resolve-permission",
    permission.permissionHandle,
    "--outcome",
    "deny",
    "--feedback",
    "caller feedback",
  ]);
  expect(resolution.exitCode, resolution.stdout + resolution.stderr).toBe(0);
  expect(JSON.parse(resolution.stdout)).toMatchObject({
    permissionHandle: permission.permissionHandle,
    status: "resolved",
  });
  const ended = await subscription.done;
  expect(ended).toEqual({
    target: {
      scope: "turn",
      turnHandle: JSON.parse(spawned.stdout).turnHandle,
    },
    reason: "end_turn",
    lastEventId: expect.any(Number),
  });
  expect(JSON.parse(await readFile(resolutionFile, "utf8"))).toEqual({
    outcome: "deny",
    feedback: "caller feedback",
  });
  expect(
    events.filter((event) => event.type === "permission.resolved"),
  ).toHaveLength(1);
});

test.each(["failed", "cancelled"] as const)(
  "turn scope ends at %s and cannot follow a successor",
  async (stopReason) => {
    const f = await fixture();
    const gate = join(f.root, "release");
    const spawned = await f.cli([
      "spawn",
      "codex",
      JSON.stringify({ gate, reply: "done", stopReason }),
      "--name",
      "terminal",
    ]);
    const target = decodeTurnHandle(JSON.parse(spawned.stdout).turnHandle);
    const client = await f.client();
    const subscription = await client.subscribe({
      scope: "turn",
      ...target,
      replay: { mode: "none" },
    });
    const events: { type: string; [key: string]: unknown }[] = [];
    subscription.onEvent((event) => events.push(event));
    await writeFile(gate, "release");
    expect(await subscription.done).toMatchObject({ reason: stopReason });
    if (stopReason === "failed") {
      const terminal = events.find((event) => event.type === "turn.completed");
      const failure = {
        failureCategory: "unclassified",
        retryDisposition: "unknown",
      };
      expect(terminal).toMatchObject({ failure });
      expect(terminal).not.toHaveProperty("turnId");
      const waited = await client.request("wait", {
        targets: [target],
        completion: "all",
        timeoutMs: 0,
      });
      expect(waited).toMatchObject({ result: { completed: [{ failure }] } });
      const args = [
        "attach",
        JSON.parse(spawned.stdout).turnHandle,
        "--scope",
        "turn",
        "--replay",
        "available",
      ];
      const json = await f.cli(args);
      expect(json.exitCode, json.stdout + json.stderr).toBe(0);
      const projected = json.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .find((event) => event.type === "turn.completed");
      expect(projected).toMatchObject({
        failure,
        message: expect.stringContaining("unknown"),
      });
      expect(projected).not.toHaveProperty("subscriptionId");
      const pretty = await f.cli([...args, "--pretty"]);
      expect(pretty.exitCode, pretty.stdout + pretty.stderr).toBe(0);
      expect(pretty.stdout).toContain(projected.message);
    }
  },
);

test("client close rejects subscription completion with daemon_disconnected", async () => {
  const f = await fixture();
  const gate = join(f.root, "never-release");
  const spawned = await f.cli([
    "spawn",
    "codex",
    JSON.stringify({ gate, reply: "unused" }),
    "--name",
    "close",
  ]);
  const target = decodeTurnHandle(JSON.parse(spawned.stdout).turnHandle);
  const client = await f.client();
  const subscription = await client.subscribe({
    scope: "session",
    sessionId: target.sessionId,
    replay: { mode: "none" },
  });
  const result = expect(subscription.done).rejects.toThrow(
    '"code":"daemon_disconnected"',
  );
  client.close();
  await result;
});

test("CLI emits legal NDJSON partial events followed by daemon_disconnected and exits 65", async () => {
  const f = await fixture(true);
  const gate = join(f.root, "release");
  const spawned = await f.cli([
    "spawn",
    "codex",
    JSON.stringify({ gate, reply: "unused", permission: true }),
    "--name",
    "disconnect",
  ]);
  const target = decodeTurnHandle(JSON.parse(spawned.stdout).turnHandle);
  const child = spawn(
    process.execPath,
    [
      cliBin,
      "attach",
      JSON.parse(spawned.stdout).turnHandle,
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
  // 独立观察者确认会话仍未终止；CLI 在注册后才可收到以下原生事件。
  await vi.waitFor(() =>
    expect(output.join("")).toContain('"subscription.established"'),
  );
  await writeFile(gate, "release");
  await vi.waitFor(() =>
    expect(output.join("")).toContain('"permission.requested"'),
  );
  f.daemon.kill("SIGKILL");
  expect(await exited, stderr.join("")).toBe(65);
  const lines = output
    .join("")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(lines.some((line) => line.type === "text")).toBe(true);
  expect(lines.at(-1)).toMatchObject({ code: "daemon_disconnected" });
  expect(lines).not.toContainEqual(
    expect.objectContaining({ sessionId: target.sessionId }),
  );
});

test("concurrent connections with the same request ID each release their own subscription after ACK", async () => {
  const f = await fixture();
  const gate = join(f.root, "release");
  const spawned = await f.cli([
    "spawn",
    "codex",
    JSON.stringify({ gate, reply: "done" }),
    "--name",
    "concurrent",
  ]);
  const target = decodeTurnHandle(JSON.parse(spawned.stdout).turnHandle);
  const first = await f.client(),
    second = await f.client();
  const subscriptions = await Promise.all([
    first.subscribe({ scope: "turn", ...target, replay: { mode: "none" } }),
    second.subscribe({ scope: "turn", ...target, replay: { mode: "none" } }),
  ]);
  const ended = [false, false];
  subscriptions.forEach((subscription, index) => {
    void subscription.done.then(
      () => {
        ended[index] = true;
      },
      () => {},
    );
  });
  await writeFile(gate, "release");
  await vi.waitFor(() => expect(ended).toEqual([true, true]));
});
