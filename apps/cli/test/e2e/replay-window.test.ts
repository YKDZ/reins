import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createReinsClient } from "@reins/client";
import {
  consumerContextSchema,
  decodeTurnHandle,
  decodeResumeCursor,
  encodeResumeCursor,
  daemonGenerationSchema,
  type ProtocolMessage,
} from "@reins/protocol";
import { createUnixSocketClient } from "@reins/transport";
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
  return { root, runtime, daemonCwd, callerCwd, env, cli, client, daemon };
}

test("available exposes a truncated bounded window and ends the exact completed turn", async () => {
  const f = await fixture();
  const gate = join(f.root, "release");
  await writeFile(gate, "release");
  const spawned = await f.cli([
    "spawn",
    "codex",
    JSON.stringify({ gate, reply: "done", messages: 1005 }),
    "--name",
    "window",
  ]);
  expect(spawned.exitCode, spawned.stdout + spawned.stderr).toBe(0);
  const target = decodeTurnHandle(JSON.parse(spawned.stdout).turnHandle);
  const client = await f.client();
  await client.request("wait", { targets: [target], completion: "all" });
  const subscription = await client.subscribe({
    scope: "turn",
    ...target,
    replay: { mode: "available" },
  });
  const events: import("@reins/client").AgentEvent[] = [];
  subscription.onEvent((event) => events.push(event));
  expect(subscription.establishment.window).toMatchObject({
    truncated: true,
    oldest: expect.any(Number),
    head: expect.any(Number),
  });
  expect(subscription.establishment.window.oldest).toBeGreaterThan(1);
  expect(events.length).toBeLessThanOrEqual(1000);
  expect(await subscription.done).toMatchObject({ reason: "end_turn" });
});

test("a disconnected observer resumes after its last event without replaying business actions", async () => {
  const f = await fixture();
  const gate = join(f.root, "release");
  const spawned = await f.cli([
    "spawn",
    "codex",
    JSON.stringify({ gate, reply: "first" }),
    "--name",
    "resume",
  ]);
  expect(spawned.exitCode, spawned.stdout).toBe(0);
  const target = decodeTurnHandle(JSON.parse(spawned.stdout).turnHandle);
  const client = await f.client();
  const subscription = await client.subscribe({
    scope: "session",
    sessionId: target.sessionId,
    replay: { mode: "none" },
  });
  const first: Exclude<
    import("@reins/client").AgentEvent,
    { type: "publication.ready" }
  >[] = [];
  subscription.onEvent((event) => {
    if (event.type !== "publication.ready") first.push(event);
  });
  await writeFile(gate, "release");
  await vi.waitFor(() => expect(first.at(-1)?.type).toBe("turn.completed"));
  const failure = subscription.done.catch((error) => JSON.parse(error.message));
  client.close();
  const disconnected = await failure;
  expect(disconnected).toMatchObject({
    code: "daemon_disconnected",
    resumeCursor: expect.stringMatching(/^resume1_/),
  });
  const next = await f.cli([
    "send",
    target.sessionId,
    JSON.stringify({ gate, reply: "second" }),
    "--placement",
    "new_turn",
  ]);
  expect(next.exitCode, next.stdout).toBe(0);
  const secondTarget = decodeTurnHandle(JSON.parse(next.stdout).turnHandle);
  const observer = await f.client();
  await observer.request("wait", {
    targets: [secondTarget],
    completion: "all",
  });
  const recovered = await observer.subscribe({
    scope: "session",
    sessionId: target.sessionId,
    replay: { mode: "after", cursor: disconnected.resumeCursor },
  } as never);
  const events: Exclude<
    import("@reins/client").AgentEvent,
    { type: "publication.ready" }
  >[] = [];
  recovered.onEvent((event) => {
    if (event.type !== "publication.ready") events.push(event);
  });
  await vi.waitFor(() => expect(events.at(-1)?.type).toBe("turn.completed"));
  const ids = events.map((event) => event.eventId);
  expect(ids[0]).toBe(first.at(-1)!.eventId + 1);
  expect(ids.at(-1)).toBe(recovered.establishment.window.head);
  expect(ids).toEqual(
    Array.from(
      { length: ids.length },
      (_, index) => first.at(-1)!.eventId + index + 1,
    ),
  );
  expect(
    events.filter((event) => event.type === "turn.completed"),
  ).toHaveLength(1);
  recovered.close();
  expect(await recovered.done).toMatchObject({ reason: "closed" });
  expect(
    await observer.request("wait", {
      targets: [secondTarget],
      completion: "all",
      timeoutMs: 0,
    }),
  ).toMatchObject({ result: { completed: [{ finalReply: "second" }] } });
  expect((await f.cli(["kill", target.sessionId])).exitCode).toBe(0);
  const replay = await f.cli([
    "attach",
    target.sessionId,
    "--scope",
    "session",
    "--replay",
    "after",
    "--cursor",
    disconnected.resumeCursor,
  ]);
  expect(replay.exitCode, replay.stdout + replay.stderr).toBe(0);
  const records = replay.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    records.filter((event) => event.type === "turn.completed"),
  ).toHaveLength(1);
  expect(records.at(-1)).toMatchObject({
    type: "subscription.ended",
    reason: "session_killed",
  });
});

test("available remains bounded during an unfinished text stream", async () => {
  const f = await fixture();
  const gate = join(f.root, "release");
  await writeFile(gate, "release");
  const spawned = await f.cli([
    "spawn",
    "codex",
    JSON.stringify({ gate, reply: "done", deltas: 1005, permission: true }),
    "--name",
    "unfinished",
  ]);
  const target = decodeTurnHandle(JSON.parse(spawned.stdout).turnHandle);
  const client = await f.client();
  // 授权保持该流未终止；available回放后再读到授权证明之前delta已经全部到达。
  const subscription = await client.subscribe({
    scope: "session",
    sessionId: target.sessionId,
    replay: { mode: "available" },
  });
  const events: import("@reins/client").AgentEvent[] = [];
  subscription.onEvent((event) => events.push(event));
  await vi.waitFor(() =>
    expect(events.some((event) => event.type === "permission.requested")).toBe(
      true,
    ),
  );
  subscription.close();
  await subscription.done;
  const bounded = await client.subscribe({
    scope: "session",
    sessionId: target.sessionId,
    replay: { mode: "available" },
  });
  expect(bounded.establishment.replayed).toBeLessThanOrEqual(1000);
  expect(bounded.establishment.window.truncated).toBe(true);
  bounded.close();
  await bounded.done;
});

test("expired cursors reject before establishment or events and never fall back to available", async () => {
  const f = await fixture();
  const gate = join(f.root, "release");
  const spawned = await f.cli([
    "spawn",
    "codex",
    JSON.stringify({ gate, reply: "first" }),
    "--name",
    "expired",
  ]);
  const target = decodeTurnHandle(JSON.parse(spawned.stdout).turnHandle);
  const client = await f.client();
  const sub = await client.subscribe({
    scope: "session",
    sessionId: target.sessionId,
    replay: { mode: "none" },
  });
  const events: import("@reins/client").AgentEvent[] = [];
  sub.onEvent((event) => events.push(event));
  await writeFile(gate, "release");
  await vi.waitFor(() => expect(events.at(-1)?.type).toBe("turn.completed"));
  const failure = sub.done.catch((error) => JSON.parse(error.message));
  client.close();
  const { resumeCursor } = await failure;
  const next = await f.cli([
    "send",
    target.sessionId,
    JSON.stringify({ gate, reply: "second", messages: 1005 }),
    "--placement",
    "new_turn",
  ]);
  const nextTarget = decodeTurnHandle(JSON.parse(next.stdout).turnHandle);
  const observer = await f.client();
  await observer.request("wait", { targets: [nextTarget], completion: "all" });
  const wire: unknown[] = [];
  observer.onNotification((event) => wire.push(event));
  const rejected = await observer.request("attach", {
    scope: "session",
    sessionId: target.sessionId,
    replay: { mode: "after", cursor: resumeCursor },
  });
  expect(rejected).toMatchObject({
    error: {
      code: "event_cursor_expired",
      oldest: expect.any(Number),
      head: expect.any(Number),
    },
  });
  expect(wire).toEqual([]);
  if (!("error" in rejected) || rejected.error.code !== "event_cursor_expired")
    throw new Error("Missing cursor expiry");
  const position = decodeResumeCursor(resumeCursor);
  const oldest = rejected.error.oldest!;
  const boundary = await observer.subscribe({
    scope: "session",
    sessionId: target.sessionId,
    replay: {
      mode: "after",
      cursor: encodeResumeCursor({ ...position, eventId: oldest }),
    },
  });
  expect(boundary.establishment.replayed).toBe(999);
  boundary.close();
  await boundary.done;
  const head = await observer.subscribe({
    scope: "session",
    sessionId: target.sessionId,
    replay: {
      mode: "after",
      cursor: encodeResumeCursor({
        ...position,
        eventId: rejected.error.head!,
      }),
    },
  });
  expect(head.establishment.replayed).toBe(0);
  head.close();
  await head.done;
  const cli = await f.cli([
    "attach",
    target.sessionId,
    "--scope",
    "session",
    "--replay",
    "after",
    "--cursor",
    resumeCursor,
  ]);
  expect(cli.exitCode, cli.stdout).toBe(65);
  expect(cli.stdout.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(cli.stdout)).toMatchObject({
    code: "event_cursor_expired",
    oldest: expect.any(Number),
    head: expect.any(Number),
  });
  const available = await f.cli([
    "attach",
    JSON.parse(next.stdout).turnHandle,
    "--scope",
    "turn",
    "--replay",
    "available",
    "--pretty",
  ]);
  expect(available.exitCode, available.stdout).toBe(0);
  expect(available.stdout).toContain("(truncated)");
});

test("a cursor is confined to its exact scope and daemon generation", async () => {
  const f = await fixture();
  const gate = join(f.root, "release");
  const spawned = await f.cli([
    "spawn",
    "codex",
    JSON.stringify({ gate, reply: "first" }),
    "--name",
    "bound",
  ]);
  const target = decodeTurnHandle(JSON.parse(spawned.stdout).turnHandle);
  const client = await f.client();
  const sub = await client.subscribe({
    scope: "session",
    sessionId: target.sessionId,
    replay: { mode: "none" },
  });
  const failure = sub.done.catch((error) => JSON.parse(error.message));
  client.close();
  const { resumeCursor } = await failure;
  const observer = await f.client();
  const wire: unknown[] = [];
  observer.onNotification((event) => wire.push(event));
  expect(
    await observer.request("attach", {
      scope: "turn",
      ...target,
      replay: { mode: "after", cursor: resumeCursor },
    }),
  ).toMatchObject({ error: { code: "invalid_params" } });
  const other = await f.cli([
    "spawn",
    "codex",
    JSON.stringify({ gate, reply: "other" }),
    "--name",
    "other",
  ]);
  const otherTarget = decodeTurnHandle(JSON.parse(other.stdout).turnHandle);
  expect(
    await observer.request("attach", {
      scope: "session",
      sessionId: otherTarget.sessionId,
      replay: { mode: "after", cursor: resumeCursor },
    }),
  ).toMatchObject({ error: { code: "invalid_params" } });
  const position = decodeResumeCursor(resumeCursor);
  const stale = encodeResumeCursor({
    ...position,
    daemonGeneration: v.parse(daemonGenerationSchema, "othergeneration"),
  });
  expect(
    await observer.request("attach", {
      scope: "session",
      sessionId: target.sessionId,
      replay: { mode: "after", cursor: stale },
    }),
  ).toMatchObject({ error: { code: "invalid_params" } });
  expect(wire).toEqual([]);
  for (const args of [
    ["--replay", "after"],
    ["--replay", "none", "--cursor", resumeCursor],
    ["--replay", "after", "--cursor", "resume1_invalid"],
  ]) {
    const invalid = await f.cli([
      "attach",
      target.sessionId,
      "--scope",
      "session",
      ...args,
    ]);
    expect(invalid.exitCode, invalid.stdout).toBe(64);
    expect(invalid.stdout.trim().split("\n")).toHaveLength(1);
  }
});
