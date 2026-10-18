import { spawn, type ChildProcess } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDaemonState } from "@reins/daemon/state";
import {
  connect,
  parseRuntimeScopeId,
  type AgentFact,
  type ReinsConnection,
} from "@ykdz/reins-sdk";
import { afterEach, expect, test as baseTest, vi } from "vitest";

const runtimePackage = fileURLToPath(new URL("../../", import.meta.url));
const daemonBin = join(runtimePackage, "node_modules/.bin/reins-daemon");
const test =
  process.env.REINS_LIVE_QODER_STEERING === "1" ? baseTest : baseTest.skip;
type LiveFixture = {
  readonly directory: string;
  readonly daemon: ChildProcess;
  readonly connections: ReinsConnection[];
  readonly env: NodeJS.ProcessEnv;
  runtimeScopeId: ReturnType<typeof parseRuntimeScopeId> | undefined;
};
const fixtures: LiveFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) {
    for (const connection of fixture.connections) connection.close();
    if (
      fixture.daemon.exitCode === null &&
      fixture.daemon.signalCode === null
    ) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          fixture.daemon.kill("SIGKILL");
          resolve();
        }, 10_000);
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
  if (!process.env.QODERCLI_PATH)
    throw new Error("QODERCLI_PATH must select the installed Qoder CLI");
  const directory = await mkdtemp(join(tmpdir(), "reins-live-qoder-steering-"));
  const cwd = join(directory, "caller");
  const runtime = join(directory, "runtime");
  await mkdir(cwd, { recursive: true });
  await mkdir(runtime, { recursive: true });
  const env = {
    ...process.env,
    REINS_SOCKET: join(runtime, "reins.sock"),
    REINS_STATE_DIR: join(runtime, "state"),
    REINS_CONSUMER_CONTEXT: "live-qoder-contract",
    REINS_IDLE_TIMEOUT_MS: "120000",
  };
  const daemon = spawn(daemonBin, [], {
    cwd,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderr: string[] = [];
  const entry: LiveFixture = {
    directory,
    daemon,
    connections: [],
    env,
    runtimeScopeId: undefined,
  };
  fixtures.push(entry);
  daemon.stderr?.on("data", (chunk: Buffer) => stderr.push(String(chunk)));
  await vi.waitFor(
    async () => {
      expect(daemon.exitCode, stderr.join("")).toBeNull();
      await access(env.REINS_SOCKET);
    },
    { timeout: 10_000 },
  );
  const runtimeScopeId = parseRuntimeScopeId(
    (await resolveDaemonState({ env })).runtimeScopeId,
  );
  entry.runtimeScopeId = runtimeScopeId;
  const connection = await connect({
    socketPath: env.REINS_SOCKET,
    consumerContext: env.REINS_CONSUMER_CONTEXT,
    runtimeScopeId,
  });
  entry.connections.push(connection);
  return { cwd, connection, fixture: entry };
}

async function reconnect(entry: LiveFixture): Promise<ReinsConnection> {
  if (entry.runtimeScopeId === undefined)
    throw new Error("Qoder live fixture has no runtime scope ID");
  const connection = await connect({
    socketPath: entry.env.REINS_SOCKET!,
    consumerContext: entry.env.REINS_CONSUMER_CONTEXT!,
    runtimeScopeId: entry.runtimeScopeId,
  });
  entry.connections.push(connection);
  return connection;
}

async function waitForFact(
  facts: AgentFact[],
  predicate: (fact: AgentFact) => boolean,
  message: string,
): Promise<AgentFact> {
  const observed = () =>
    facts
      .slice(-24)
      .map((fact) => {
        if (fact.type === "tool.requested") return `${fact.type}:${fact.name}`;
        if (fact.type === "permission.requested")
          return `${fact.type}:${fact.kind}`;
        if (fact.type === "turn.completed")
          return `${fact.type}:${fact.stopReason}`;
        if (fact.type === "background.activity")
          return `${fact.type}:${fact.status}:${fact.source.kind}`;
        if (fact.type === "message") {
          const content =
            typeof fact.content === "string"
              ? fact.content
              : fact.content
                  .map((part) => (part.type === "text" ? part.text : part.type))
                  .join("");
          return `${fact.type}:${fact.role}:${content.slice(0, 120)}`;
        }
        return fact.type;
      })
      .join(", ");
  await vi.waitFor(
    () => {
      expect(facts.some(predicate), `${message}; observed: ${observed()}`).toBe(
        true,
      );
    },
    { timeout: 120_000, interval: 100 },
  );
  const fact = facts.find(predicate);
  if (fact === undefined) throw new Error(message);
  return fact;
}

test("公开 SDK 经生产 daemon 与固定 Qoder CLI 完成精确中断续接", async () => {
  const { cwd, connection } = await fixture();
  const marker = join(cwd, "effect.txt");
  const initial = await connection.spawn(
    {
      sessionLabel: "ticket-24-qoder-steering",
      harness: "qoder",
      authorizationMode: "allowAll",
      message: `Use exactly one Bash tool call with this exact command: printf 'ONCE\\n' >> ${marker}; sleep 60. Do not use other tools. After that command ends, reply ORIGINAL_DONE. If a new user message arrives before it ends, stop the old task and follow that request.`,
      cwd,
    },
    { operationKey: connection.prepareOperation("spawn") },
  );
  const subscription = await connection.attach(
    { scope: "turn", turnHandle: initial.turnHandle },
    { mode: "history" },
  );
  const facts: AgentFact[] = [];
  const consume = (async () => {
    for await (const fact of subscription) {
      facts.push(fact);
      subscription.acknowledge(fact);
    }
  })();

  await waitForFact(
    facts,
    (fact) => fact.type === "tool.requested" && fact.name === "Bash",
    "Qoder did not start the requested Bash call",
  );
  await vi.waitFor(
    async () => {
      expect(await readFile(marker, "utf8")).toBe("ONCE\n");
    },
    { timeout: 120_000, interval: 50 },
  );

  const correction =
    "Stop the unfinished command. Do not call any tools. Reply CONTROL_CONTINUED only.";
  const activeSendKey = connection.prepareOperation("send");
  const activeSend = connection.send(
    {
      placement: "active_turn",
      turnHandle: initial.turnHandle,
      message: correction,
    },
    { operationKey: activeSendKey },
  );
  const prematureNewTurn = connection.send(
    {
      placement: "new_turn",
      sessionHandle: initial.sessionHandle,
      message: "Reply NEW_TURN_OK only. Do not call tools.",
    },
    { operationKey: connection.prepareOperation("send") },
  );
  await expect(prematureNewTurn).rejects.toMatchObject({
    failure: { code: "session_busy" },
  });
  const accepted = await activeSend;
  expect(accepted).toMatchObject({
    sessionHandle: initial.sessionHandle,
    turnHandle: initial.turnHandle,
    deliveryPoint: "active_turn",
  });
  expect(await connection.getOperation(activeSendKey)).toMatchObject({
    status: "succeeded",
    result: accepted,
  });
  expect(facts.filter((fact) => fact.type === "turn.completed")).toEqual([]);

  const terminal = await waitForFact(
    facts,
    (fact) => fact.type === "turn.completed",
    "The corrected Qoder turn did not reach its terminal event",
  );
  expect(terminal).toMatchObject({
    type: "turn.completed",
    turnHandle: initial.turnHandle,
    stopReason: "end_turn",
  });
  expect(await readFile(marker, "utf8")).toBe("ONCE\n");
  expect(
    facts.filter(
      (fact) => fact.type === "tool.requested" && fact.name === "Bash",
    ),
  ).toHaveLength(1);
  await consume;

  const nextTurn = await connection.send(
    {
      placement: "new_turn",
      sessionHandle: initial.sessionHandle,
      message: "Reply NEW_TURN_OK only. Do not call tools.",
    },
    { operationKey: connection.prepareOperation("send") },
  );
  expect(nextTurn.turnHandle).not.toBe(initial.turnHandle);
  expect(nextTurn.deliveryPoint).toBe("new_turn");

  const nextSubscription = await connection.attach(
    { scope: "turn", turnHandle: nextTurn.turnHandle },
    { mode: "history" },
  );
  const nextFacts: AgentFact[] = [];
  for await (const fact of nextSubscription) {
    nextFacts.push(fact);
    nextSubscription.acknowledge(fact);
  }
  expect(
    nextFacts.filter((fact) => fact.type === "turn.completed"),
  ).toMatchObject([
    { turnHandle: nextTurn.turnHandle, stopReason: "end_turn" },
  ]);
}, 240_000);

test("固定 CLI 的后台 Agent 事实关联到产生它的工具调用", async () => {
  const { cwd, connection } = await fixture();
  const marker = join(cwd, "agent-marker.txt");
  await writeFile(marker, "QODER_AGENT_MARKER\n");
  const spawned = await connection.spawn(
    {
      sessionLabel: "ticket-25-agent-task-facts",
      harness: "qoder",
      authorizationMode: "allowAll",
      message: `Use the Agent tool exactly once with run_in_background set to true. Delegate a read-only task to read ${marker} and report its one-line contents. After launching the task, reply LAUNCHED only.`,
      cwd,
    },
    { operationKey: connection.prepareOperation("spawn") },
  );
  const subscription = await connection.attach(
    { scope: "session", sessionHandle: spawned.sessionHandle },
    { mode: "history" },
  );
  const facts: AgentFact[] = [];
  const consume = (async () => {
    for await (const fact of subscription) {
      facts.push(fact);
      subscription.acknowledge(fact);
    }
  })();
  const agentTool = await waitForFact(
    facts,
    (fact) => fact.type === "tool.requested" && fact.name === "Agent",
    "Fixed Qoder did not invoke its Agent tool",
  );
  if (agentTool.type !== "tool.requested")
    throw new Error("Qoder Agent call was not a tool.requested fact");
  expect(agentTool.input).toMatchObject({ run_in_background: true });
  const activityStarted = await waitForFact(
    facts,
    (fact) => fact.type === "background.activity" && fact.status === "active",
    "Fixed Qoder did not expose its Agent task_started fact",
  );
  if (activityStarted.type !== "background.activity")
    throw new Error("Qoder task start was not a background activity fact");
  expect(typeof activityStarted.description).toBe("string");
  expect(activityStarted.description?.length).toBeGreaterThan(0);
  expect(activityStarted.source.kind).toBe("qoder_task");
  expect(activityStarted.causedBy).toEqual({
    turnHandle: spawned.turnHandle,
    toolKey: agentTool.toolKey,
  });
  const activityCompleted = await waitForFact(
    facts,
    (fact) =>
      fact.type === "background.activity" &&
      fact.source.id === activityStarted.source.id &&
      fact.status === "completed" &&
      typeof fact.summary === "string" &&
      fact.summary.length > 0,
    "Fixed Qoder did not expose its Agent task_notification summary",
  );
  expect(activityCompleted).toMatchObject({
    type: "background.activity",
    source: activityStarted.source,
    status: "completed",
    causedBy: activityStarted.causedBy,
  });
  if (activityCompleted.type !== "background.activity")
    throw new Error("Qoder task completion was not a background activity fact");
  expect(activityCompleted.summary).toMatch(/\S/u);
  await expect(
    connection.wait({
      targets: [spawned.turnHandle],
      completion: "all",
      timeoutMs: 120_000,
    }),
  ).resolves.toMatchObject({ status: "satisfied", pending: [] });
  subscription.close();
  await consume;
}, 240_000);

test("固定 CLI 将长 caller 正文完整保留在公开事实中", async () => {
  const { cwd, connection } = await fixture();
  const records = JSON.stringify(
    {
      document: "Qoder 公共入口的普通参考记录",
      records: Array.from({ length: 48 }, (_, index) => ({
        recordId: `runtime-observation-${String(index + 1).padStart(3, "0")}`,
        sequence: index + 1,
        category: ["startup", "delivery", "completion"][index % 3],
        summary: `第 ${index + 1} 条记录描述一次独立的运行观察，包含稳定编号、处理阶段和用于核对长正文传递的普通中文说明。`,
      })),
    },
    null,
    2,
  );
  const message = `请把下面的 JSON 作为普通参考资料阅读。不要调用任何工具，只回复 CONTEXT_RECEIVED。\n\n${records}`;
  expect(message.length).toBeGreaterThan(8_000);
  const spawned = await connection.spawn(
    {
      sessionLabel: "ticket-25-long-caller-message",
      harness: "qoder",
      authorizationMode: "allowAll",
      message,
      cwd,
    },
    { operationKey: connection.prepareOperation("spawn") },
  );
  const subscription = await connection.attach(
    { scope: "turn", turnHandle: spawned.turnHandle },
    { mode: "history" },
  );
  const facts: AgentFact[] = [];
  const consume = (async () => {
    for await (const fact of subscription) {
      facts.push(fact);
      subscription.acknowledge(fact);
    }
  })();
  const callerMessage = await waitForFact(
    facts,
    (fact) =>
      fact.type === "message" &&
      fact.role === "caller" &&
      fact.content === message,
    "Qoder caller message was not preserved in full",
  );
  expect(callerMessage).toMatchObject({
    type: "message",
    role: "caller",
    turnHandle: spawned.turnHandle,
    content: message,
  });
  await expect(
    connection.wait({
      targets: [spawned.turnHandle],
      completion: "all",
      timeoutMs: 120_000,
    }),
  ).resolves.toMatchObject({
    status: "satisfied",
    completed: [{ turnHandle: spawned.turnHandle, stopReason: "end_turn" }],
  });
  expect(
    facts.filter((fact) => fact.type === "message" && fact.role === "caller"),
  ).toEqual([callerMessage]);
  subscription.close();
  await consume;
}, 240_000);

test("固定 CLI 完整传递较大的官方 Read 与 Write 工具输入输出", async () => {
  const { cwd, connection } = await fixture();
  const sourcePath = join(cwd, "source-records.json");
  const destinationPath = join(cwd, "copied-records.json");
  const document = JSON.stringify(
    {
      document: "Qoder tool round-trip completeness record",
      records: Array.from({ length: 50 }, (_, index) => ({
        recordId: `tool-observation-${String(index + 1).padStart(3, "0")}`,
        sequence: index + 1,
        category: ["input", "execution", "result", "close"][index % 4],
        summary: `Record ${index + 1} verifies complete tool transfer with status labels, punctuation, and a stable sequence value.`,
      })),
    },
    null,
    2,
  );
  expect(document.length).toBeGreaterThan(6_000);
  await writeFile(sourcePath, document);
  const message = `Use the Read tool once to read ${sourcePath}, then use the Write tool once to copy the complete Read result to ${destinationPath}, including every displayed line-number prefix unchanged. Do not summarize or call other tools. After both calls, reply FILE_COPY_DONE only.`;
  const spawned = await connection.spawn(
    {
      sessionLabel: "ticket-25-large-tool-facts",
      harness: "qoder",
      authorizationMode: "allowAll",
      message,
      cwd,
    },
    { operationKey: connection.prepareOperation("spawn") },
  );
  const subscription = await connection.attach(
    { scope: "turn", turnHandle: spawned.turnHandle },
    { mode: "history" },
  );
  const facts: AgentFact[] = [];
  let subscriptionFailure: unknown;
  const consume = (async () => {
    try {
      for await (const fact of subscription) {
        facts.push(fact);
        subscription.acknowledge(fact);
      }
    } catch (error) {
      subscriptionFailure = error;
    }
  })();
  const callerMessage = await waitForFact(
    facts,
    (fact) =>
      fact.type === "message" &&
      fact.role === "caller" &&
      fact.content === message,
    "Qoder caller message was not preserved in full",
  );
  expect(callerMessage).toMatchObject({ content: message });
  const readRequest = await waitForFact(
    facts,
    (fact) => fact.type === "tool.requested" && fact.name === "Read",
    "Qoder did not request the official Read tool",
  );
  if (readRequest.type !== "tool.requested")
    throw new Error("Qoder Read call was not a tool.requested fact");
  expect(readRequest.input).toMatchObject({ file_path: sourcePath });
  const readCompleted = await waitForFact(
    facts,
    (fact) =>
      fact.type === "tool.completed" && fact.toolKey === readRequest.toolKey,
    "Qoder Read result was not committed",
  );
  if (readCompleted.type !== "tool.completed")
    throw new Error("Qoder Read result was malformed");
  const expectedReadResult = document
    .split("\n")
    .map((line, index) => `${index + 1}\t${line}`)
    .join("\n");
  expect(readCompleted.result).toBe(expectedReadResult);
  const writeRequest = await waitForFact(
    facts,
    (fact) => fact.type === "tool.requested" && fact.name === "Write",
    "Qoder did not request the official Write tool",
  );
  if (writeRequest.type !== "tool.requested")
    throw new Error("Qoder Write call was not a tool.requested fact");
  const expectedWrittenContent = `${expectedReadResult}\n`;
  if (
    typeof writeRequest.input !== "object" ||
    writeRequest.input === null ||
    !("file_path" in writeRequest.input) ||
    typeof writeRequest.input.file_path !== "string" ||
    !("content" in writeRequest.input) ||
    typeof writeRequest.input.content !== "string"
  )
    throw new Error("Qoder Write input did not preserve its content");
  expect(writeRequest.input.file_path).toBe(destinationPath);
  const writtenContent = writeRequest.input.content;
  expect(writtenContent.length).toBeGreaterThan(6_000);
  expect(writtenContent).toBe(expectedWrittenContent);
  const writeCompleted = await waitForFact(
    facts,
    (fact) =>
      fact.type === "tool.completed" && fact.toolKey === writeRequest.toolKey,
    "Qoder Write result was not committed",
  );
  if (writeCompleted.type !== "tool.completed")
    throw new Error("Qoder Write result was malformed");
  expect(writeCompleted.isError).toBe(false);
  expect(await readFile(destinationPath, "utf8")).toBe(writtenContent);
  await expect(
    connection.wait({
      targets: [spawned.turnHandle],
      completion: "all",
      timeoutMs: 120_000,
    }),
  ).resolves.toMatchObject({ status: "satisfied", pending: [] });
  expect(
    facts.filter(
      (fact) => fact.type === "tool.requested" && fact.name === "Read",
    ),
  ).toHaveLength(1);
  expect(
    facts.filter(
      (fact) => fact.type === "tool.requested" && fact.name === "Write",
    ),
  ).toHaveLength(1);
  subscription.close();
  await consume;
  expect(subscriptionFailure).toBeUndefined();
}, 240_000);

test("Qoder 交互授权在重连后按同一操作幂等决议", async () => {
  const { cwd, connection, fixture: liveFixture } = await fixture();
  const marker = join(cwd, "authorized-effect.txt");
  const token = "QODER_AUTHORIZED_EFFECT";
  const command = `printf '%s\\n' '${token}' > ${marker}; cat ${marker}`;
  const message = `Use exactly one Bash tool call with this exact command: ${command}. Do not call other tools. Wait for it to finish, then reply AUTHORIZED_DONE only.`;
  const spawned = await connection.spawn(
    {
      sessionLabel: "ticket-25-permission-reconnect",
      harness: "qoder",
      authorizationMode: "interactive",
      message,
      cwd,
    },
    { operationKey: connection.prepareOperation("spawn") },
  );
  const subscription = await connection.attach(
    { scope: "turn", turnHandle: spawned.turnHandle },
    { mode: "history" },
  );
  const facts: AgentFact[] = [];
  const consume = (async () => {
    for await (const fact of subscription) {
      facts.push(fact);
      subscription.acknowledge(fact);
    }
  })();
  const callerMessage = await waitForFact(
    facts,
    (fact) =>
      fact.type === "message" &&
      fact.role === "caller" &&
      fact.content === message,
    "Qoder caller message was not preserved in full",
  );
  expect(callerMessage.type).toBe("message");
  const toolRequest = await waitForFact(
    facts,
    (fact) => fact.type === "tool.requested" && fact.name === "Bash",
    "Qoder did not request the audited Bash tool",
  );
  if (toolRequest.type !== "tool.requested")
    throw new Error("Qoder tool request was not a tool.requested fact");
  expect(toolRequest.input).toMatchObject({ command });

  const requestedPermission = await waitForFact(
    facts,
    (fact) => fact.type === "permission.requested",
    "Qoder interactive Bash call did not request authorization",
  );
  if (requestedPermission.type !== "permission.requested")
    throw new Error("Qoder permission fact was not permission.requested");
  expect(requestedPermission.toolKey).toBe(toolRequest.toolKey);
  expect(requestedPermission.options).toContainEqual({
    outcome: "allow",
    scope: "once",
  });

  subscription.close();
  await consume;
  connection.close();
  const reconnected = await reconnect(liveFixture);
  const recoveredHistory = await reconnected.attach(
    { scope: "turn", turnHandle: spawned.turnHandle },
    { mode: "history" },
  );
  const authorizationSnapshot = await reconnected.attach(
    { scope: "turn", turnHandle: spawned.turnHandle },
    { mode: "snapshot" },
  );
  if (authorizationSnapshot.initial.mode !== "snapshot")
    throw new Error("Qoder authorization snapshot omitted its baseline");
  expect(
    authorizationSnapshot.initial.baseline.pendingPermissions,
  ).toContainEqual(
    expect.objectContaining({
      permissionHandle: requestedPermission.permissionHandle,
      toolKey: requestedPermission.toolKey,
    }),
  );
  authorizationSnapshot.close();
  await expect(authorizationSnapshot.done).resolves.toMatchObject({
    reason: "closed",
  });

  const recoveredFacts: AgentFact[] = [];
  let recoveredFailure: unknown;
  const recoveredConsume = (async () => {
    try {
      for await (const fact of recoveredHistory) {
        recoveredFacts.push(fact);
        recoveredHistory.acknowledge(fact);
      }
    } catch (error) {
      recoveredFailure = error;
    }
  })();
  const replayedPermission = await waitForFact(
    recoveredFacts,
    (fact) =>
      fact.type === "permission.requested" &&
      fact.permissionHandle === requestedPermission.permissionHandle,
    "Qoder pending permission was not replayed after reconnect",
  );
  if (replayedPermission.type !== "permission.requested")
    throw new Error("Qoder replay omitted its permission request");
  expect(replayedPermission.toolKey).toBe(requestedPermission.toolKey);

  const resolutionKey = reconnected.prepareOperation("resolvePermission");
  const resolution = { outcome: "allow", scope: "once" } as const;
  const resolved = await reconnected.resolvePermission(
    replayedPermission.permissionHandle,
    resolution,
    { operationKey: resolutionKey },
  );
  expect(resolved).toMatchObject({ status: "resolved" });
  await expect(
    reconnected.resolvePermission(
      replayedPermission.permissionHandle,
      resolution,
      { operationKey: resolutionKey },
    ),
  ).resolves.toEqual(resolved);
  await expect(
    reconnected.resolvePermission(
      replayedPermission.permissionHandle,
      { outcome: "deny", feedback: "同一操作不可改变决议" },
      { operationKey: resolutionKey },
    ),
  ).rejects.toMatchObject({ failure: { code: "operation_key_conflict" } });
  await expect(
    reconnected.resolvePermission(
      replayedPermission.permissionHandle,
      resolution,
      { operationKey: reconnected.prepareOperation("resolvePermission") },
    ),
  ).rejects.toMatchObject({ failure: { code: "permission_not_pending" } });
  await expect(reconnected.getOperation(resolutionKey)).resolves.toMatchObject({
    status: "succeeded",
    result: resolved,
  });

  const toolCompleted = await waitForFact(
    recoveredFacts,
    (fact) =>
      fact.type === "tool.completed" && fact.toolKey === toolRequest.toolKey,
    "Qoder Bash result was not committed",
  );
  if (toolCompleted.type !== "tool.completed")
    throw new Error("Qoder Bash result was not a tool.completed fact");
  expect(toolCompleted).toMatchObject({
    type: "tool.completed",
    toolKey: toolRequest.toolKey,
    result: token,
    isError: false,
  });
  expect(await readFile(marker, "utf8")).toBe(`${token}\n`);
  await expect(
    reconnected.wait({
      targets: [spawned.turnHandle],
      completion: "all",
      timeoutMs: 120_000,
    }),
  ).resolves.toMatchObject({ status: "satisfied", pending: [] });
  const bashCalls = recoveredFacts.filter(
    (fact) =>
      fact.type === "tool.requested" && fact.toolKey === toolRequest.toolKey,
  );
  expect(bashCalls).toHaveLength(1);
  await recoveredConsume;
  expect(recoveredFailure).toBeUndefined();
}, 240_000);

test("取消待授权的 Qoder 工具后，迟到授权不会执行工具", async () => {
  const { cwd, connection } = await fixture();
  const marker = join(cwd, "must-not-run.txt");
  const spawned = await connection.spawn(
    {
      sessionLabel: "ticket-25-cancel-pending-permission",
      harness: "qoder",
      authorizationMode: "interactive",
      message: `只用一次 Bash 执行精确命令 printf 'SHOULD_NOT_RUN\\n' > ${marker}，不要调用其他工具。获准后回复 CANCEL_PERMISSION_DONE。`,
      cwd,
    },
    { operationKey: connection.prepareOperation("spawn") },
  );
  const subscription = await connection.attach(
    { scope: "turn", turnHandle: spawned.turnHandle },
    { mode: "history" },
  );
  const facts: AgentFact[] = [];
  const consume = (async () => {
    for await (const fact of subscription) {
      facts.push(fact);
      subscription.acknowledge(fact);
    }
  })();
  const permission = await waitForFact(
    facts,
    (fact) => fact.type === "permission.requested",
    "Qoder did not ask before the interactive tool ran",
  );
  if (permission.type !== "permission.requested")
    throw new Error("Qoder permission fact was malformed");
  await expect(
    connection.interrupt(
      { turnHandle: spawned.turnHandle },
      { operationKey: connection.prepareOperation("interrupt") },
    ),
  ).resolves.toMatchObject({ status: "accepted" });
  await expect(
    connection.wait({
      targets: [spawned.turnHandle],
      completion: "all",
      timeoutMs: 120_000,
    }),
  ).resolves.toMatchObject({
    status: "satisfied",
    completed: [{ turnHandle: spawned.turnHandle, stopReason: "cancelled" }],
  });
  await expect(
    connection.resolvePermission(
      permission.permissionHandle,
      { outcome: "allow", scope: "once" },
      { operationKey: connection.prepareOperation("resolvePermission") },
    ),
  ).rejects.toMatchObject({ failure: { code: "permission_not_pending" } });
  await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  await consume;
}, 240_000);

test("官方关闭正在运行的 Qoder 工具只停止 A 并保留 B", async () => {
  const { cwd, connection } = await fixture();
  const directoryA = join(cwd, "worker-a");
  const directoryB = join(cwd, "worker-b");
  await mkdir(directoryA);
  await mkdir(directoryB);
  const command =
    "printf 'STARTED\\n' > started.txt; sleep 12; printf 'FINISHED\\n' > finished.txt";
  const spawnWriter = async (sessionLabel: string, workdir: string) =>
    connection.spawn(
      {
        sessionLabel,
        harness: "qoder",
        authorizationMode: "allowAll",
        message: `只用一次 Bash 且 command 逐字为：${command}。不要提前终止命令；结束后只回复 WRITER_DONE。`,
        cwd: workdir,
      },
      { operationKey: connection.prepareOperation("spawn") },
    );
  const sessionA = await spawnWriter("ticket-25-close-a", directoryA);
  const factsA: AgentFact[] = [];
  const historyA = await connection.attach(
    { scope: "session", sessionHandle: sessionA.sessionHandle },
    { mode: "history" },
  );
  const consumeA = (async () => {
    for await (const fact of historyA) {
      factsA.push(fact);
      historyA.acknowledge(fact);
    }
  })();
  await waitForFact(
    factsA,
    (fact) => fact.type === "tool.requested" && fact.name === "Bash",
    "Qoder A did not start its Bash call",
  );
  await vi.waitFor(async () =>
    expect(await readFile(join(directoryA, "started.txt"), "utf8")).toBe(
      "STARTED\n",
    ),
  );

  const sessionB = await spawnWriter("ticket-25-close-b", directoryB);
  const factsB: AgentFact[] = [];
  const historyB = await connection.attach(
    { scope: "session", sessionHandle: sessionB.sessionHandle },
    { mode: "history" },
  );
  const consumeB = (async () => {
    for await (const fact of historyB) {
      factsB.push(fact);
      historyB.acknowledge(fact);
    }
  })();
  await waitForFact(
    factsB,
    (fact) => fact.type === "tool.requested" && fact.name === "Bash",
    "Qoder B did not start its Bash call",
  );
  await vi.waitFor(async () =>
    expect(await readFile(join(directoryB, "started.txt"), "utf8")).toBe(
      "STARTED\n",
    ),
  );

  await expect(
    connection.kill(
      { sessionHandle: sessionA.sessionHandle },
      { operationKey: connection.prepareOperation("kill") },
    ),
  ).resolves.toMatchObject({ status: "killed" });
  await expect(
    connection.wait({
      targets: [sessionB.turnHandle],
      completion: "all",
      timeoutMs: 120_000,
    }),
  ).resolves.toMatchObject({ status: "satisfied", pending: [] });
  await expect(
    connection.wait({
      targets: [sessionA.turnHandle],
      completion: "all",
      timeoutMs: 120_000,
    }),
  ).resolves.toMatchObject({
    status: "satisfied",
    completed: [{ turnHandle: sessionA.turnHandle, stopReason: "killed" }],
  });
  historyA.close();
  historyB.close();
  await consumeA;
  await consumeB;
  expect(await readFile(join(directoryB, "finished.txt"), "utf8")).toBe(
    "FINISHED\n",
  );
  await expect(access(join(directoryA, "finished.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(factsA.some((fact) => fact.type === "session.killed")).toBe(true);
  expect(
    factsB.some(
      (fact) =>
        fact.type === "turn.completed" &&
        fact.turnHandle === sessionB.turnHandle &&
        fact.stopReason === "end_turn",
    ),
  ).toBe(true);
}, 240_000);
