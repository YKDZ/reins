import { spawn, type ChildProcess } from "node:child_process";
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

import { resolveDaemonState } from "@reins/daemon/state";
import {
  connect,
  parseAgentFactId,
  parseMessageKey,
  parseOperationCredential,
  parsePermissionHandle,
  parseResumeCursor,
  parseRuntimeScopeId,
  parseSessionHandle,
  parseToolKey,
  parseTurnHandle,
  ReinsSdkError,
  serializeAgentFactId,
  serializeMessageKey,
  serializeOperationCredential,
  serializePermissionHandle,
  serializeResumeCursor,
  serializeSessionHandle,
  serializeToolKey,
  serializeTurnHandle,
  type AgentFact,
  type ReinsConnection,
} from "@ykdz/reins-sdk";
import { afterEach, expect, test, vi } from "vitest";

const runtimePackage = fileURLToPath(new URL("../../", import.meta.url));
const daemonBin = join(runtimePackage, "node_modules/.bin/reins-daemon");
const adapters = fileURLToPath(
  new URL("./fixtures/readable-events-adapters.ts", import.meta.url),
);
const clients: ReinsConnection[] = [];
const fixtures: Array<{ directory: string; daemon: ChildProcess }> = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const fixture of fixtures.splice(0)) {
    if (
      fixture.daemon.exitCode === null &&
      fixture.daemon.signalCode === null
    ) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          fixture.daemon.kill("SIGKILL");
          resolve();
        }, 5_000);
        fixture.daemon.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
        fixture.daemon.kill("SIGTERM");
      });
    }
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "reins-sdk-facts-"));
  await mkdir(join(directory, "state"));
  const env = {
    ...process.env,
    REINS_SOCKET: join(directory, "reins.sock"),
    REINS_STATE_DIR: join(directory, "state"),
    REINS_CONSUMER_CONTEXT: "sdk-facts-test",
    REINS_IDLE_TIMEOUT_MS: "120000",
  };
  const daemon = spawn(daemonBin, ["--adapters", adapters], {
    cwd: directory,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderr: string[] = [];
  daemon.stderr?.on("data", (chunk: Buffer) => stderr.push(String(chunk)));
  fixtures.push({ directory, daemon });

  await vi.waitFor(async () => {
    expect(daemon.exitCode, stderr.join("")).toBeNull();
    expect((await stat(env.REINS_SOCKET)).isSocket()).toBe(true);
  });
  const runtimeScopeId = parseRuntimeScopeId(
    (await resolveDaemonState({ env })).runtimeScopeId,
  );

  async function sdk(): Promise<ReinsConnection> {
    const connection = await connect({
      socketPath: env.REINS_SOCKET,
      consumerContext: env.REINS_CONSUMER_CONTEXT,
      runtimeScopeId,
    });
    clients.push(connection);
    return connection;
  }

  async function spawnSession(
    connection: ReinsConnection,
    message: string,
    sessionLabel = "facts",
  ) {
    return connection.spawn(
      {
        harness: "codex",
        sessionLabel,
        message,
        cwd: directory,
      },
      connection.prepareOperation("spawn"),
    );
  }

  return { directory, env, sdk, spawnSession };
}

test("SDK facts preserve message, tool, authorization, and replay identity", async () => {
  const f = await fixture();
  const control = await f.sdk();
  const gate = join(f.directory, "release");
  const resolutionFile = join(f.directory, "resolution.json");
  const spawned = await f.spawnSession(
    control,
    JSON.stringify({
      gate,
      reply: "done",
      callerMessage: "next",
      permission: true,
      resolutionFile,
    }),
  );
  const observer = await f.sdk();
  const target = { scope: "turn" as const, turnHandle: spawned.turnHandle };
  const live = await observer.attach(target, { mode: "none" });
  const initialCursor = live.checkpoint;
  expect(parseResumeCursor(serializeResumeCursor(initialCursor))).toBe(
    initialCursor,
  );
  const facts: AgentFact[] = [];
  const consuming = (async () => {
    for await (const fact of live) {
      facts.push(fact);
      if (fact.type === "permission.requested") {
        await observer.resolvePermission(
          fact.permissionHandle,
          { outcome: "deny", feedback: "caller feedback" },
          observer.prepareOperation("resolvePermission"),
        );
      }
    }
  })();

  await writeFile(gate, "release");
  await consuming;
  expect(await live.done).toMatchObject({ reason: "end_turn" });
  expect(facts.map((fact) => fact.type)).toEqual([
    "message",
    "text.delta",
    "text.delta",
    "message",
    "tool.requested",
    "tool.completed",
    "permission.requested",
    "permission.resolved",
    "turn.completed",
  ]);

  const callerMessage = facts.find(
    (fact): fact is Extract<AgentFact, { type: "message" }> =>
      fact.type === "message" && fact.role === "caller",
  );
  const textFacts = facts.filter((fact) => fact.type === "text.delta");
  const workerMessage = facts.find(
    (fact): fact is Extract<AgentFact, { type: "message" }> =>
      fact.type === "message" && fact.role === "worker",
  );
  expect(callerMessage).toMatchObject({ content: "next" });
  if (callerMessage === undefined)
    throw new Error("missing caller message fact");
  expect(parseMessageKey(serializeMessageKey(callerMessage.messageKey))).toBe(
    callerMessage.messageKey,
  );
  expect(textFacts.map((fact) => fact.delta)).toEqual(["hello ", "world"]);
  expect(textFacts[0]?.messageKey).toBe(workerMessage?.messageKey);
  expect(workerMessage).toMatchObject({ content: "hello world" });

  const toolRequested = facts.find((fact) => fact.type === "tool.requested");
  const toolCompleted = facts.find((fact) => fact.type === "tool.completed");
  expect(toolRequested).toMatchObject({ name: "read-file" });
  if (toolRequested?.type !== "tool.requested")
    throw new Error("missing tool request fact");
  expect(parseToolKey(serializeToolKey(toolRequested.toolKey))).toBe(
    toolRequested.toolKey,
  );
  expect(() =>
    parseMessageKey(serializeToolKey(toolRequested.toolKey)),
  ).toThrow();
  expect(() =>
    parseToolKey(serializeMessageKey(callerMessage.messageKey)),
  ).toThrow();
  expect(toolRequested?.toolKey).toBe(toolCompleted?.toolKey);
  expect(toolCompleted).toMatchObject({
    name: "native-result-name",
    result: "file contents",
    isError: false,
  });

  const requested = facts.find((fact) => fact.type === "permission.requested");
  const resolved = facts.find((fact) => fact.type === "permission.resolved");
  expect(requested).toMatchObject({ kind: "write" });
  expect(resolved).toMatchObject({
    resolution: { outcome: "deny", feedback: "caller feedback" },
  });
  if (requested?.type !== "permission.requested")
    throw new Error("missing permission request fact");
  if (resolved?.type !== "permission.resolved")
    throw new Error("missing permission resolution fact");
  expect(resolved.permissionHandle).toBe(requested.permissionHandle);
  expect(
    parsePermissionHandle(
      serializePermissionHandle(requested.permissionHandle),
    ),
  ).toBe(requested.permissionHandle);
  expect(() =>
    parseTurnHandle(serializePermissionHandle(requested.permissionHandle)),
  ).toThrow();
  expect(() =>
    parsePermissionHandle(serializeTurnHandle(spawned.turnHandle)),
  ).toThrow();
  expect(JSON.parse(await readFile(resolutionFile, "utf8"))).toEqual({
    outcome: "deny",
    feedback: "caller feedback",
  });

  for (const fact of facts)
    for (const key of [
      "sessionId",
      "turnId",
      "messageId",
      "toolCallId",
      "permissionId",
      "subscriptionId",
      "eventId",
    ])
      expect(fact).not.toHaveProperty(key);
  const credential = control.prepareOperation("spawn");
  expect(
    parseOperationCredential(
      "spawn",
      serializeOperationCredential("spawn", credential),
    ),
  ).toBe(credential);
  expect(() =>
    parseOperationCredential(
      "send",
      serializeOperationCredential("spawn", credential),
    ),
  ).toThrow();
  expect(parseAgentFactId(serializeAgentFactId(callerMessage.factId))).toBe(
    callerMessage.factId,
  );
  expect(
    parseSessionHandle(serializeSessionHandle(spawned.sessionHandle)),
  ).toBe(spawned.sessionHandle);
  expect(parseTurnHandle(serializeTurnHandle(spawned.turnHandle))).toBe(
    spawned.turnHandle,
  );
  expect(() =>
    parseSessionHandle(serializeTurnHandle(spawned.turnHandle)),
  ).toThrow();
  expect(() =>
    parseTurnHandle(serializeSessionHandle(spawned.sessionHandle)),
  ).toThrow();
  expect(() =>
    parseResumeCursor(serializeSessionHandle(spawned.sessionHandle)),
  ).toThrow();

  const available = await observer.attach(target, { mode: "available" });
  const availableFacts: AgentFact[] = [];
  for await (const fact of available) availableFacts.push(fact);
  expect(await available.done).toMatchObject({ reason: "end_turn" });
  expect(availableFacts[0]).toMatchObject({ type: "turn.started" });
  expect(availableFacts.slice(-facts.length)).toEqual(facts);

  const resumed = await observer.attach(target, {
    mode: "after",
    cursor: initialCursor,
  });
  const resumedFacts: AgentFact[] = [];
  for await (const fact of resumed) resumedFacts.push(fact);
  expect(await resumed.done).toMatchObject({ reason: "end_turn" });
  expect(resumedFacts).toEqual(facts);

  expect(
    await control.wait({ targets: [spawned.turnHandle], completion: "all" }),
  ).toMatchObject({
    status: "satisfied",
    completed: [{ turnHandle: spawned.turnHandle, finalReply: "done" }],
  });
});

test("SDK resumes after a disconnected observer from its last delivered fact", async () => {
  const f = await fixture();
  const control = await f.sdk();
  const gate = join(f.directory, "release");
  const spawned = await f.spawnSession(
    control,
    JSON.stringify({ gate, reply: "resumed" }),
  );
  const target = {
    scope: "session" as const,
    sessionHandle: spawned.sessionHandle,
  };
  const observer = await f.sdk();
  const live = await observer.attach(target, { mode: "none" });
  const firstPromise = live.next();
  await writeFile(gate, "release");
  const first = await firstPromise;
  expect(first.done).toBe(false);
  if (first.done) throw new Error("missing first fact");
  const cursor = live.checkpoint;

  observer.close();
  await expect(live.done).rejects.toBeInstanceOf(ReinsSdkError);
  await expect(live.done).rejects.toMatchObject({
    failure: {
      code: "daemon_disconnected",
      facts: { resumeCursor: cursor },
    },
  });

  expect(
    await control.wait({ targets: [spawned.turnHandle], completion: "all" }),
  ).toMatchObject({
    status: "satisfied",
    completed: [{ finalReply: "resumed" }],
  });

  const recovery = await f.sdk();
  const resumed = await recovery.attach(target, {
    mode: "after",
    cursor,
  });
  const resumedFacts: AgentFact[] = [];
  for await (const fact of resumed) {
    resumedFacts.push(fact);
    if (fact.type === "turn.completed") break;
  }
  resumed.close();
  expect(await resumed.done).toMatchObject({ reason: "closed" });

  const full = await recovery.attach(target, { mode: "available" });
  const fullFacts: AgentFact[] = [];
  for await (const fact of full) {
    fullFacts.push(fact);
    if (fact.type === "turn.completed") break;
  }
  full.close();
  expect(await full.done).toMatchObject({ reason: "closed" });
  const firstIndex = fullFacts.findIndex(
    (fact) => fact.factId === first.value.factId,
  );
  expect(firstIndex).toBeGreaterThanOrEqual(0);
  expect([first.value, ...resumedFacts]).toEqual(fullFacts.slice(firstIndex));
});

test("turn observation ends at its target while session history crosses and resumes after the next turn", async () => {
  const f = await fixture();
  const control = await f.sdk();
  const firstGate = join(f.directory, "first-release");
  const secondGate = join(f.directory, "second-release");
  const spawned = await f.spawnSession(
    control,
    JSON.stringify({ gate: firstGate, reply: "first" }),
  );
  const observer = await f.sdk();
  const turn = await observer.attach(
    { scope: "turn", turnHandle: spawned.turnHandle },
    { mode: "none" },
  );
  const session = await observer.attach(
    { scope: "session", sessionHandle: spawned.sessionHandle },
    { mode: "none" },
  );
  const turnFacts: AgentFact[] = [];
  const sessionFacts: AgentFact[] = [];
  const turnDrain = (async () => {
    for await (const fact of turn) turnFacts.push(fact);
  })();
  const sessionDrain = (async () => {
    for await (const fact of session) sessionFacts.push(fact);
  })();

  await writeFile(firstGate, "release first");
  await turnDrain;
  expect(await turn.done).toMatchObject({ reason: "end_turn" });
  await vi.waitFor(() =>
    expect(
      sessionFacts.filter((fact) => fact.type === "turn.completed"),
    ).toHaveLength(1),
  );
  const firstCursor = session.checkpoint;
  const second = await control.send(
    {
      placement: "new_turn",
      sessionHandle: spawned.sessionHandle,
      message: JSON.stringify({ gate: secondGate, reply: "second" }),
    },
    control.prepareOperation("send"),
  );

  await writeFile(secondGate, "release second");
  expect(
    await control.wait({ targets: [second.turnHandle], completion: "all" }),
  ).toMatchObject({
    status: "satisfied",
    completed: [{ turnHandle: second.turnHandle, finalReply: "second" }],
  });
  await vi.waitFor(() =>
    expect(
      sessionFacts.filter((fact) => fact.type === "turn.completed"),
    ).toHaveLength(2),
  );
  session.close();
  expect(await session.done).toMatchObject({ reason: "closed" });
  await sessionDrain;

  const resumed = await observer.attach(
    { scope: "session", sessionHandle: spawned.sessionHandle },
    { mode: "after", cursor: firstCursor },
  );
  const resumedFacts: AgentFact[] = [];
  for await (const fact of resumed) {
    resumedFacts.push(fact);
    if (fact.type === "turn.completed" && fact.turnHandle === second.turnHandle)
      break;
  }
  resumed.close();
  expect(await resumed.done).toMatchObject({ reason: "closed" });
  expect(
    turnFacts
      .filter((fact) => fact.type === "turn.completed")
      .map((fact) => fact.turnHandle),
  ).toEqual([spawned.turnHandle]);
  expect(
    sessionFacts
      .filter((fact) => fact.type === "turn.completed")
      .map((fact) => fact.turnHandle),
  ).toEqual([spawned.turnHandle, second.turnHandle]);
  expect(
    resumedFacts
      .filter((fact) => fact.type === "turn.completed")
      .map((fact) => fact.turnHandle),
  ).toEqual([second.turnHandle]);
});

test("SDK observers independently receive the same stable fact history", async () => {
  const f = await fixture();
  const control = await f.sdk();
  const gate = join(f.directory, "release-observers");
  const spawned = await f.spawnSession(
    control,
    JSON.stringify({ gate, reply: "same history" }),
  );
  const [firstObserver, secondObserver] = await Promise.all([f.sdk(), f.sdk()]);
  const target = { scope: "turn" as const, turnHandle: spawned.turnHandle };
  const [first, second] = await Promise.all([
    firstObserver.attach(target, { mode: "none" }),
    secondObserver.attach(target, { mode: "none" }),
  ]);
  const collect = async (subscription: typeof first) => {
    const facts: AgentFact[] = [];
    for await (const fact of subscription) facts.push(fact);
    return facts;
  };
  const histories = Promise.all([collect(first), collect(second)]);

  await writeFile(gate, "release");
  const [firstFacts, secondFacts] = await histories;
  expect(await first.done).toMatchObject({ reason: "end_turn" });
  expect(await second.done).toMatchObject({ reason: "end_turn" });
  expect(firstFacts).toEqual(secondFacts);
  expect(firstFacts.at(-1)).toMatchObject({
    type: "turn.completed",
    turnHandle: spawned.turnHandle,
    stopReason: "end_turn",
  });
});

test("SDK abort closes observation without cancelling the exact turn", async () => {
  const f = await fixture();
  const control = await f.sdk();
  const gate = join(f.directory, "abort-release");
  const spawned = await f.spawnSession(
    control,
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
  expect(await subscription.done).toMatchObject({ reason: "closed" });
  expect(
    await control.list({ sessionHandle: spawned.sessionHandle }),
  ).toMatchObject([{ state: "busy", activeTurn: spawned.turnHandle }]);

  await writeFile(gate, "release");
  expect(
    await control.wait({ targets: [spawned.turnHandle], completion: "all" }),
  ).toMatchObject({
    status: "satisfied",
    completed: [
      { turnHandle: spawned.turnHandle, finalReply: "still running" },
    ],
  });
});

test.each(["failed", "cancelled"] as const)(
  "SDK turn facts preserve the exact %s terminal reason",
  async (stopReason) => {
    const f = await fixture();
    const control = await f.sdk();
    const gate = join(f.directory, `release-${stopReason}`);
    const spawned = await f.spawnSession(
      control,
      JSON.stringify({ gate, reply: "terminal fact", stopReason }),
    );
    const observer = await f.sdk();
    const subscription = await observer.attach(
      { scope: "turn", turnHandle: spawned.turnHandle },
      { mode: "none" },
    );
    await writeFile(gate, "complete");
    const facts: AgentFact[] = [];
    for await (const fact of subscription) facts.push(fact);
    expect(await subscription.done).toMatchObject({ reason: stopReason });
    const terminal = facts.find((fact) => fact.type === "turn.completed");
    expect(terminal).toMatchObject({
      type: "turn.completed",
      turnHandle: spawned.turnHandle,
      stopReason,
    });
    if (stopReason === "failed")
      expect(terminal).toMatchObject({
        failure: {
          failureCategory: "unclassified",
          retryDisposition: "unknown",
        },
      });
  },
);

test("active replay remains bounded before a permission-blocked turn completes", async () => {
  const f = await fixture();
  const control = await f.sdk();
  const gate = join(f.directory, "release-large-active-history");
  const spawned = await f.spawnSession(
    control,
    JSON.stringify({ gate, reply: "done", messages: 1_005, permission: true }),
  );
  const observer = await f.sdk();
  const target = {
    scope: "session" as const,
    sessionHandle: spawned.sessionHandle,
  };
  const live = await observer.attach(target, { mode: "none" });
  const permission = (async () => {
    for (;;) {
      const item = await live.next();
      if (item.done) throw new Error("Permission request was not emitted");
      if (item.value.type === "permission.requested") return item.value;
    }
  })();
  await writeFile(gate, "release");
  const requested = await permission;
  const available = await observer.attach(target, { mode: "available" });
  expect(available.establishment.window).toMatchObject({ truncated: true });
  expect(available.establishment.replayed).toBeLessThanOrEqual(1_000);
  const retained: AgentFact[] = [];
  for (let index = 0; index < available.establishment.replayed; index += 1) {
    const item = await available.next();
    expect(item.done).toBe(false);
    if (!item.done) retained.push(item.value);
  }
  available.close();
  expect(await available.done).toMatchObject({ reason: "closed" });
  expect(retained.some((fact) => fact.type === "permission.requested")).toBe(
    true,
  );
  expect(retained.some((fact) => fact.type === "turn.completed")).toBe(false);

  await observer.resolvePermission(
    requested.permissionHandle,
    { outcome: "deny", feedback: "finish active replay test" },
    observer.prepareOperation("resolvePermission"),
  );
  const terminal: AgentFact[] = [];
  for (;;) {
    const item = await live.next();
    if (item.done) break;
    terminal.push(item.value);
    if (
      item.value.type === "turn.completed" &&
      item.value.turnHandle === spawned.turnHandle
    )
      break;
  }
  live.close();
  expect(await live.done).toMatchObject({ reason: "closed" });
  expect(terminal.at(-1)).toMatchObject({
    type: "turn.completed",
    turnHandle: spawned.turnHandle,
  });
});

test("SDK cursors remain bound to their exact scope and session", async () => {
  const f = await fixture();
  const control = await f.sdk();
  const first = await f.spawnSession(
    control,
    JSON.stringify({
      gate: join(f.directory, "first-cursor-gate"),
      reply: "first",
    }),
  );
  const second = await f.spawnSession(
    control,
    JSON.stringify({
      gate: join(f.directory, "second-cursor-gate"),
      reply: "second",
    }),
    "second-cursor-session",
  );
  const observer = await f.sdk();
  const sessionTarget = {
    scope: "session" as const,
    sessionHandle: first.sessionHandle,
  };
  const initial = await observer.attach(sessionTarget, { mode: "none" });
  const cursor = initial.checkpoint;
  initial.close();
  expect(await initial.done).toMatchObject({ reason: "closed" });

  await expect(
    observer.attach(
      { scope: "turn", turnHandle: first.turnHandle },
      { mode: "after", cursor },
    ),
  ).rejects.toMatchObject({ failure: { code: "invalid_params" } });
  await expect(
    observer.attach(
      { scope: "session", sessionHandle: second.sessionHandle },
      { mode: "after", cursor },
    ),
  ).rejects.toMatchObject({ failure: { code: "invalid_params" } });
});

test("SDK exposes its retained replay window and reports an expired cursor", async () => {
  const f = await fixture();
  const control = await f.sdk();
  const gate = join(f.directory, "release-history");
  const spawned = await f.spawnSession(
    control,
    JSON.stringify({ gate, reply: "bounded", messages: 1_005 }),
  );
  const target = { scope: "turn" as const, turnHandle: spawned.turnHandle };
  const observer = await f.sdk();
  const before = await observer.attach(target, { mode: "none" });
  const staleCursor = before.checkpoint;
  before.close();
  expect(await before.done).toMatchObject({ reason: "closed" });

  await writeFile(gate, "release");
  expect(
    await control.wait({
      targets: [spawned.turnHandle],
      completion: "all",
      timeoutMs: 10_000,
    }),
  ).toMatchObject({ status: "satisfied" });

  const available = await observer.attach(target, { mode: "available" });
  const window = available.establishment.window;
  expect(window).toMatchObject({
    truncated: true,
    oldest: expect.any(Number),
    head: expect.any(Number),
  });
  expect(window.oldest).toBeGreaterThan(1);
  const facts: AgentFact[] = [];
  for await (const fact of available) facts.push(fact);
  expect(await available.done).toMatchObject({ reason: "end_turn" });
  expect(facts.length).toBeLessThanOrEqual(1_000);

  await expect(
    observer.attach(target, { mode: "after", cursor: staleCursor }),
  ).rejects.toMatchObject({
    failure: {
      code: "event_cursor_expired",
      facts: { oldest: window.oldest, head: window.head },
    },
  });
});
