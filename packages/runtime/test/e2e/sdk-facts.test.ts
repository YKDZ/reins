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
  parseOperationKey,
  parsePermissionHandle,
  parseResumeCursor,
  parseRuntimeScopeId,
  parseSessionHandle,
  parseToolKey,
  parseTurnHandle,
  ReinsSdkError,
  serializeAgentFactId,
  serializeMessageKey,
  serializeOperationKey,
  serializePermissionHandle,
  serializeResumeCursor,
  serializeSessionHandle,
  serializeToolKey,
  serializeTurnHandle,
  type AgentFact,
  type AutonomousTurnCause,
  type BackgroundActivitySource,
  type BackgroundActivityStatus,
  type ReinsConnection,
  type TurnOrigin,
} from "@ykdz/reins-sdk";
import { afterEach, expect, test, vi } from "vitest";

const runtimePackage = fileURLToPath(new URL("../../", import.meta.url));
const daemonBin = join(runtimePackage, "node_modules/.bin/reins-daemon");
const adapters = fileURLToPath(
  new URL("./fixtures/readable-events-adapters.ts", import.meta.url),
);
const autonomousAdapters = fileURLToPath(
  new URL("./fixtures/autonomous-adapters.ts", import.meta.url),
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

async function fixture(adapterModule = adapters) {
  const directory = await mkdtemp(join(tmpdir(), "reins-sdk-facts-"));
  await mkdir(join(directory, "state"));
  const env = {
    ...process.env,
    REINS_SOCKET: join(directory, "reins.sock"),
    REINS_STATE_DIR: join(directory, "state"),
    REINS_CONSUMER_CONTEXT: "sdk-facts-test",
    REINS_IDLE_TIMEOUT_MS: "120000",
  };
  const daemon = spawn(daemonBin, ["--adapters", adapterModule], {
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
      { operationKey: connection.prepareOperation("spawn") },
    );
  }

  return { directory, env, sdk, spawnSession };
}

test("自主回合保留来源、参与前驱并让迟到后台事实进入会话历史", async () => {
  const f = await fixture(autonomousAdapters);
  const owner = await f.sdk();
  const wakeGate = join(f.directory, "wake-background");
  const turnGate = join(f.directory, "finish-autonomous-turn");
  const startedFile = join(f.directory, "autonomous-turn-id");
  const spawnResult = await f.spawnSession(
    owner,
    JSON.stringify({ wakeGate, turnGate, startedFile }),
    "autonomous",
  );
  const jobSource: BackgroundActivitySource = {
    kind: "fixture_job",
    id: "job-before-status",
  };
  const activeStatus: BackgroundActivityStatus = "active";
  const callerOrigin: TurnOrigin = { kind: "caller" };
  const autonomousOrigin: TurnOrigin = {
    kind: "harness",
    harness: "codex",
    cause: { source: jobSource },
  };
  const autonomousCause: AutonomousTurnCause = { source: jobSource };
  const firstWait = await owner.wait({
    targets: [spawnResult.turnHandle],
    completion: "all",
  });
  expect(firstWait.status).toBe("satisfied");

  const observer = await f.sdk();
  const endedCallerTurn = await observer.attach(
    { scope: "turn", turnHandle: spawnResult.turnHandle },
    { mode: "snapshot" },
  );
  expect(await endedCallerTurn.done).toMatchObject({ reason: "end_turn" });
  const sessionTarget = {
    scope: "session" as const,
    sessionHandle: spawnResult.sessionHandle,
  };
  const sessionFacts = await observer.attach(sessionTarget, {
    mode: "snapshot",
  });
  if (sessionFacts.initial.mode !== "snapshot")
    throw new Error("预期获得会话快照");
  expect(sessionFacts.initial).toMatchObject({
    mode: "snapshot",
    baseline: {
      session: {
        state: "idle",
        lastCompletedTurn: { origin: callerOrigin },
      },
    },
  });
  expect(sessionFacts.initial.baseline.backgroundActivities).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "background.activity",
        source: { kind: "fixture_job", id: "job-before-status" },
        causedBy: {
          turnHandle: spawnResult.turnHandle,
          toolKey: expect.any(String),
        },
        status: activeStatus,
      }),
      expect.objectContaining({
        type: "background.activity",
        source: { kind: "fixture_job", id: "job-after-status" },
        causedBy: {
          turnHandle: spawnResult.turnHandle,
          toolKey: expect.any(String),
        },
        status: activeStatus,
      }),
    ]),
  );

  await writeFile(wakeGate, "wake");
  await vi.waitFor(async () => {
    expect(await readFile(startedFile, "utf8")).toContain("t");
  });
  const outputBeforeStatus = await sessionFacts.next();
  expect(outputBeforeStatus.done).toBe(false);
  if (outputBeforeStatus.done) throw new Error("会话订阅提前结束");
  expect(outputBeforeStatus.value).toMatchObject({
    type: "tool.completed",
    name: "finish_background_job",
    result: {
      content: [{ type: "text", text: "BACKGROUND_OUTPUT_BEFORE_STATUS" }],
      bytes: "AAEC",
    },
    isError: false,
  });
  if (outputBeforeStatus.value.type !== "tool.completed")
    throw new Error("预期先收到后台工具正文");
  const beforeStatusToolKey = outputBeforeStatus.value.toolKey;
  sessionFacts.acknowledge(outputBeforeStatus.value);
  const beforeStatus = await sessionFacts.next();
  expect(beforeStatus.done).toBe(false);
  if (beforeStatus.done) throw new Error("会话订阅提前结束");
  expect(beforeStatus.value).toMatchObject({
    type: "background.activity",
    source: { kind: "fixture_job", id: "job-before-status" },
    status: "completed",
    causedBy: {
      turnHandle: spawnResult.turnHandle,
      toolKey: beforeStatusToolKey,
    },
  });
  sessionFacts.acknowledge(beforeStatus.value);
  const afterStatus = await sessionFacts.next();
  expect(afterStatus.done).toBe(false);
  if (afterStatus.done) throw new Error("会话订阅提前结束");
  expect(afterStatus.value).toMatchObject({
    type: "background.activity",
    source: { kind: "fixture_job", id: "job-after-status" },
    status: "completed",
    causedBy: {
      turnHandle: spawnResult.turnHandle,
      toolKey: expect.any(String),
    },
  });
  if (afterStatus.value.type !== "background.activity")
    throw new Error("预期先收到第二项后台状态");
  const afterStatusToolKey = afterStatus.value.causedBy?.toolKey;
  sessionFacts.acknowledge(afterStatus.value);
  const outputAfterStatus = await sessionFacts.next();
  expect(outputAfterStatus.done).toBe(false);
  if (outputAfterStatus.done) throw new Error("会话订阅提前结束");
  expect(outputAfterStatus.value).toMatchObject({
    type: "tool.completed",
    toolKey: afterStatusToolKey,
    name: "finish_background_job",
    result: {
      content: [{ type: "text", text: "BACKGROUND_OUTPUT_AFTER_STATUS" }],
      bytes: "BAUG",
    },
    isError: false,
  });
  if (outputAfterStatus.value.type !== "tool.completed")
    throw new Error("预期在后台完成状态后收到工具正文");
  sessionFacts.acknowledge(outputAfterStatus.value);
  const turnStart = await sessionFacts.next();
  expect(turnStart.done).toBe(false);
  if (turnStart.done) throw new Error("自主回合未发布");
  expect(turnStart.value).toMatchObject({
    type: "turn.started",
    origin: autonomousOrigin,
    cause: {
      ...autonomousCause,
      causedBy: { turnHandle: spawnResult.turnHandle },
    },
  });
  sessionFacts.acknowledge(turnStart.value);
  if (turnStart.value.type !== "turn.started")
    throw new Error("预期收到自主回合开始事实");
  const autonomousTurn = turnStart.value.turnHandle;
  expect(
    await owner.wait({
      targets: [spawnResult.turnHandle],
      completion: "all",
    }),
  ).toMatchObject({
    status: "satisfied",
    completed: [{ turnHandle: spawnResult.turnHandle, stopReason: "end_turn" }],
  });

  const autonomousFacts = await observer.attach(
    { scope: "turn", turnHandle: autonomousTurn },
    { mode: "snapshot" },
  );
  expect(autonomousFacts.initial).toMatchObject({
    mode: "snapshot",
    baseline: {
      session: {
        state: "busy",
        activeTurn: autonomousTurn,
        activeTurnOrigin: autonomousOrigin,
      },
      activeTurnCause: {
        ...autonomousCause,
        causedBy: {
          turnHandle: spawnResult.turnHandle,
          toolKey: expect.any(String),
        },
      },
      backgroundActivities: [],
    },
  });
  await expect(
    owner.send({
      placement: "new_turn",
      sessionHandle: spawnResult.sessionHandle,
      message: "caller input while autonomous turn is active",
    }),
  ).rejects.toMatchObject({ failure: { code: "session_busy" } });

  const history = await observer.attach(sessionTarget, { mode: "history" });
  const historyFacts = [];
  for (;;) {
    const item = await history.next();
    if (item.done) break;
    historyFacts.push(item.value);
    history.acknowledge(item.value);
    if (
      item.value.type === "turn.started" &&
      item.value.turnHandle === autonomousTurn
    )
      break;
  }
  expect(historyFacts.map((fact) => fact.type)).toContain(
    "background.activity",
  );
  expect(
    historyFacts.filter(
      (fact) =>
        fact.type === "turn.completed" &&
        fact.turnHandle === spawnResult.turnHandle,
    ),
  ).toHaveLength(1);
  expect(historyFacts).toContainEqual(
    expect.objectContaining({
      type: "tool.completed",
      toolKey: beforeStatusToolKey,
      result: {
        content: [{ type: "text", text: "BACKGROUND_OUTPUT_BEFORE_STATUS" }],
        bytes: "AAEC",
      },
    }),
  );
  expect(
    historyFacts.filter(
      (fact) =>
        fact.type === "tool.completed" && fact.toolKey === beforeStatusToolKey,
    ),
  ).toHaveLength(1);
  expect(
    historyFacts.filter(
      (fact) =>
        fact.type === "tool.completed" &&
        fact.name === "ordinary_tool_without_background_source",
    ),
  ).toHaveLength(0);
  expect(historyFacts).toContainEqual(
    expect.objectContaining({
      type: "tool.completed",
      toolKey: afterStatusToolKey,
      result: {
        content: [{ type: "text", text: "BACKGROUND_OUTPUT_AFTER_STATUS" }],
        bytes: "BAUG",
      },
    }),
  );

  await owner.interrupt(
    { turnHandle: autonomousTurn },
    { operationKey: owner.prepareOperation("interrupt") },
  );
  const autonomousWait = await owner.wait({
    targets: [autonomousTurn],
    completion: "all",
  });
  expect(autonomousWait).toMatchObject({
    status: "satisfied",
    pending: [],
    completed: [{ turnHandle: autonomousTurn, stopReason: "cancelled" }],
  });
  const terminal = await autonomousFacts.next();
  expect(terminal.done).toBe(false);
  if (terminal.done) throw new Error("Autonomous terminal was not observed");
  expect(terminal.value).toMatchObject({
    type: "turn.completed",
    turnHandle: autonomousTurn,
    stopReason: "cancelled",
  });
  autonomousFacts.acknowledge(terminal.value);
  expect(await autonomousFacts.done).toMatchObject({ reason: "cancelled" });
  const sessionTerminal = await sessionFacts.next();
  expect(sessionTerminal.done).toBe(false);
  if (sessionTerminal.done) throw new Error("会话订阅不能随回合订阅一起结束");
  expect(sessionTerminal.value).toMatchObject({
    type: "turn.completed",
    turnHandle: autonomousTurn,
    stopReason: "cancelled",
  });
  sessionFacts.acknowledge(sessionTerminal.value);

  await expect(
    owner.send({
      placement: "new_turn",
      sessionHandle: spawnResult.sessionHandle,
      ifLastCompletedTurn: spawnResult.turnHandle,
      message: "stale predecessor",
    }),
  ).rejects.toMatchObject({ failure: { code: "turn_precondition_failed" } });
});

test("快照初始切面包含可决议授权，确认事实应用后才推进游标", async () => {
  const f = await fixture();
  const control = await f.sdk();
  const gate = join(f.directory, "release-snapshot");
  const completionGate = join(f.directory, "complete-snapshot");
  const spawned = await f.spawnSession(
    control,
    JSON.stringify({
      gate,
      completionGate,
      reply: "snapshot complete",
      permission: true,
    }),
    "snapshot-baseline",
  );
  const observer = await f.sdk();
  const target = {
    scope: "turn" as const,
    turnHandle: spawned.turnHandle,
  };
  const subscription = await observer.attach(target, { mode: "snapshot" });

  expect(subscription.initial).toMatchObject({
    mode: "snapshot",
    target,
    baseline: {
      session: { state: "busy", activeTurn: spawned.turnHandle },
      confirmedTerminals: [],
      pendingPermissions: [],
    },
  });
  const initialCursor = subscription.initial.cursor;
  await expect(
    observer.attach(target, {
      mode: "snapshot",
      cursor: initialCursor,
    } as never),
  ).rejects.toMatchObject({ failure: { code: "invalid_params" } });
  expect(parseResumeCursor(serializeResumeCursor(initialCursor))).toBe(
    initialCursor,
  );
  expect(subscription.checkpoint).toBe(initialCursor);

  await writeFile(gate, "release");
  let item = await subscription.next();
  expect(item.done).toBe(false);
  if (item.done) throw new Error("Snapshot follow did not receive a fact");
  expect(subscription.checkpoint).toBe(initialCursor);
  subscription.acknowledge(item.value);
  expect(subscription.checkpoint).not.toBe(initialCursor);

  let requested: Extract<AgentFact, { type: "permission.requested" }> | null =
    item.value.type === "permission.requested" ? item.value : null;
  while (requested === null) {
    item = await subscription.next();
    if (item.done) throw new Error("Permission request was not emitted");
    if (item.value.type === "permission.requested") requested = item.value;
    else subscription.acknowledge(item.value);
  }

  const authorization = await observer.attach(target, { mode: "snapshot" });
  expect(authorization.initial).toMatchObject({
    baseline: {
      pendingPermissions: [
        {
          type: "permission.requested",
          permissionHandle: requested.permissionHandle,
          kind: "write",
        },
      ],
    },
  });
  authorization.close();
  subscription.acknowledge(requested);
  await observer.resolvePermission(
    requested.permissionHandle,
    { outcome: "deny", feedback: "snapshot accepted" },
    { operationKey: observer.prepareOperation("resolvePermission") },
  );
  await writeFile(completionGate, "complete");
  for await (const fact of subscription) subscription.acknowledge(fact);
  expect(await subscription.done).toMatchObject({ reason: "end_turn" });
});

test("SDK facts preserve message, tool, authorization, and replay identity", async () => {
  const f = await fixture();
  const control = await f.sdk();
  const gate = join(f.directory, "release");
  const resolutionFile = join(f.directory, "resolution.json");
  const spawnMessage = JSON.stringify({
    gate,
    reply: "done",
    permission: true,
    nativeCallerSnapshot: true,
    resolutionFile,
  });
  const spawned = await f.spawnSession(control, spawnMessage);
  const observer = await f.sdk();
  const target = { scope: "turn" as const, turnHandle: spawned.turnHandle };
  const live = await observer.attach(target, { mode: "history" });
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
          { operationKey: observer.prepareOperation("resolvePermission") },
        );
      }
      live.acknowledge(fact);
    }
  })();

  await writeFile(gate, "release");
  await consuming;
  expect(await live.done).toMatchObject({ reason: "end_turn" });
  expect(facts.map((fact) => fact.type)).toEqual([
    "turn.started",
    "message",
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

  const callerMessages = facts.filter(
    (fact): fact is Extract<AgentFact, { type: "message" }> =>
      fact.type === "message" && fact.role === "caller",
  );
  const callerMessage = callerMessages.at(-1);
  const callerFallback = callerMessages[0];
  expect(callerMessages).toHaveLength(2);
  expect(callerFallback?.messageKey).toBe(callerMessage?.messageKey);
  expect(callerFallback?.content).toBe(spawnMessage);
  expect(callerMessage?.content).toEqual([
    { type: "text", text: spawnMessage },
    { type: "image", source: "bytes", data: "AAEC" },
  ]);
  const textFacts = facts.filter((fact) => fact.type === "text.delta");
  const workerMessage = facts.find(
    (fact): fact is Extract<AgentFact, { type: "message" }> =>
      fact.type === "message" && fact.role === "worker",
  );
  expect(callerMessage).toMatchObject({
    content: [
      { type: "text", text: spawnMessage },
      { type: "image", source: "bytes", data: "AAEC" },
    ],
  });
  if (callerMessage === undefined)
    throw new Error("missing caller message fact");
  expect(parseMessageKey(serializeMessageKey(callerMessage.messageKey))).toBe(
    callerMessage.messageKey,
  );
  expect(textFacts.map((fact) => fact.delta)).toEqual(["hello ", "world"]);
  expect(textFacts[0]?.messageKey).toBe(workerMessage?.messageKey);
  expect(workerMessage).toMatchObject({
    content: "hello world",
    nativeTruncated: true,
  });

  const toolRequested = facts.find((fact) => fact.type === "tool.requested");
  const toolCompleted = facts.find((fact) => fact.type === "tool.completed");
  expect(toolRequested).toMatchObject({
    name: "read-file",
    input: { path: "report.json", options: { raw: true } },
  });
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
    result: { content: "file contents", metadata: { bytes: 13 } },
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
  const operationKey = control.prepareOperation("spawn");
  expect(parseOperationKey(serializeOperationKey(operationKey), "spawn")).toBe(
    operationKey,
  );
  expect(() =>
    parseOperationKey(serializeOperationKey(operationKey), "send"),
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

  const available = await observer.attach(target, { mode: "history" });
  const availableFacts: AgentFact[] = [];
  for await (const fact of available) {
    availableFacts.push(fact);
    available.acknowledge(fact);
  }
  expect(await available.done).toMatchObject({ reason: "end_turn" });
  expect(availableFacts[0]).toMatchObject({ type: "turn.started" });
  expect(availableFacts.slice(-facts.length)).toEqual(facts);

  const resumed = await observer.attach(target, {
    mode: "after",
    cursor: initialCursor,
  });
  const resumedFacts: AgentFact[] = [];
  for await (const fact of resumed) {
    resumedFacts.push(fact);
    resumed.acknowledge(fact);
  }
  expect(await resumed.done).toMatchObject({ reason: "end_turn" });
  expect(resumedFacts).toEqual(facts);

  expect(
    await control.wait({ targets: [spawned.turnHandle], completion: "all" }),
  ).toMatchObject({
    status: "satisfied",
    completed: [{ turnHandle: spawned.turnHandle, finalReply: "done" }],
  });
});

test("SDK resumes after a disconnected observer from its last acknowledged fact", async () => {
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
  const live = await observer.attach(target, { mode: "snapshot" });
  const firstPromise = live.next();
  await writeFile(gate, "release");
  const first = await firstPromise;
  expect(first.done).toBe(false);
  if (first.done) throw new Error("missing first fact");
  expect(live.checkpoint).toBe(live.initial.cursor);
  live.acknowledge(first.value);
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
    resumed.acknowledge(fact);
    if (fact.type === "turn.completed") break;
  }
  resumed.close();
  expect(await resumed.done).toMatchObject({ reason: "closed" });

  const full = await recovery.attach(target, { mode: "history" });
  const fullFacts: AgentFact[] = [];
  for await (const fact of full) {
    fullFacts.push(fact);
    full.acknowledge(fact);
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
    { mode: "snapshot" },
  );
  const session = await observer.attach(
    { scope: "session", sessionHandle: spawned.sessionHandle },
    { mode: "snapshot" },
  );
  const turnFacts: AgentFact[] = [];
  const sessionFacts: AgentFact[] = [];
  const turnDrain = (async () => {
    for await (const fact of turn) {
      turnFacts.push(fact);
      turn.acknowledge(fact);
    }
  })();
  const sessionDrain = (async () => {
    for await (const fact of session) {
      sessionFacts.push(fact);
      session.acknowledge(fact);
    }
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
    { operationKey: control.prepareOperation("send") },
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
    resumed.acknowledge(fact);
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
    firstObserver.attach(target, { mode: "snapshot" }),
    secondObserver.attach(target, { mode: "snapshot" }),
  ]);
  const collect = async (subscription: typeof first) => {
    const facts: AgentFact[] = [];
    for await (const fact of subscription) {
      facts.push(fact);
      subscription.acknowledge(fact);
    }
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
    observer.attach(target, { mode: "snapshot" }, preAborted.signal),
  ).rejects.toMatchObject({ name: "AbortError" });

  const controller = new AbortController();
  const subscription = await observer.attach(
    target,
    { mode: "snapshot" },
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
      { mode: "snapshot" },
    );
    await writeFile(gate, "complete");
    const facts: AgentFact[] = [];
    for await (const fact of subscription) {
      facts.push(fact);
      subscription.acknowledge(fact);
    }
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

test("active replay preserves complete history before a permission-blocked turn completes", async () => {
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
  const live = await observer.attach(target, { mode: "snapshot" });
  const permission = (async () => {
    for (;;) {
      const item = await live.next();
      if (item.done) throw new Error("Permission request was not emitted");
      if (item.value.type === "permission.requested") return item.value;
      live.acknowledge(item.value);
    }
  })();
  await writeFile(gate, "release");
  const requested = await permission;
  const available = await observer.attach(target, { mode: "history" });
  if (available.initial.mode !== "history")
    throw new Error("Expected history initial state");
  expect(available.initial.window).toMatchObject({ truncated: false });
  expect(available.initial.replayed).toBeGreaterThan(1_000);
  const replayed: AgentFact[] = [];
  for (let index = 0; index < available.initial.replayed; index += 1) {
    const item = await available.next();
    expect(item.done).toBe(false);
    if (!item.done) {
      replayed.push(item.value);
      available.acknowledge(item.value);
    }
  }
  available.close();
  expect(await available.done).toMatchObject({ reason: "closed" });
  expect(replayed.some((fact) => fact.type === "permission.requested")).toBe(
    true,
  );
  expect(replayed.some((fact) => fact.type === "turn.completed")).toBe(false);

  await observer.resolvePermission(
    requested.permissionHandle,
    { outcome: "deny", feedback: "finish active replay test" },
    { operationKey: observer.prepareOperation("resolvePermission") },
  );
  live.acknowledge(requested);
  const terminal: AgentFact[] = [];
  for (;;) {
    const item = await live.next();
    if (item.done) break;
    terminal.push(item.value);
    live.acknowledge(item.value);
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
  const initial = await observer.attach(sessionTarget, { mode: "snapshot" });
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

test("SDK replays complete history and keeps an earlier cursor valid", async () => {
  const f = await fixture();
  const control = await f.sdk();
  const gate = join(f.directory, "release-history");
  const spawned = await f.spawnSession(
    control,
    JSON.stringify({ gate, reply: "bounded", messages: 1_005 }),
  );
  const target = { scope: "turn" as const, turnHandle: spawned.turnHandle };
  const observer = await f.sdk();
  const before = await observer.attach(target, { mode: "snapshot" });
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

  const available = await observer.attach(target, { mode: "history" });
  const window = available.initial.window;
  expect(window).toMatchObject({
    truncated: false,
    oldest: expect.any(Number),
    head: expect.any(Number),
  });
  expect(window.oldest).toBe(1);
  const facts: AgentFact[] = [];
  for await (const fact of available) {
    facts.push(fact);
    available.acknowledge(fact);
  }
  expect(await available.done).toMatchObject({ reason: "end_turn" });
  expect(facts.length).toBeGreaterThan(1_000);

  const after = await observer.attach(target, {
    mode: "after",
    cursor: staleCursor,
  });
  const afterFacts: AgentFact[] = [];
  for await (const fact of after) {
    afterFacts.push(fact);
    after.acknowledge(fact);
  }
  expect(await after.done).toMatchObject({ reason: "end_turn" });
  expect(afterFacts.length).toBeGreaterThan(1_000);
});
