import { EventEmitter } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  createCodexDriver,
  createCodexTransport,
  type CodexChild,
} from "@reins/codex";
import { createDaemon } from "@reins/daemon";
import {
  makeDiagnosticId,
  type DaemonGeneration,
  type DiagnosticId,
  type ProtocolMessage,
  type RuntimeScopeId,
  type SessionId,
} from "@reins/protocol";
import { createUnixSocketServer } from "@reins/transport";
import {
  connect,
  type AgentFact,
  type ReinsConnection,
  type SessionHandle,
} from "@ykdz/reins-sdk";
import { expect, test, vi } from "vitest";

type NativeFrame = Record<string, unknown> & { id?: number };

async function startFixture(): Promise<{
  readonly directory: string;
  readonly client: ReinsConnection;
  readonly outbound: NativeFrame[];
  notify(method: string, params: Record<string, unknown>): void;
  request(id: number, method: string, params: Record<string, unknown>): void;
  close(): Promise<void>;
}> {
  const runtimeScopeId =
    "00000000-0000-4000-8000-000000000000" as RuntimeScopeId;
  const generation = "test" as DaemonGeneration;
  const directory = await mkdtemp(join(tmpdir(), "reins-codex-routing-"));
  const socketPath = join(directory, "daemon.sock");
  const outbound: NativeFrame[] = [];
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const childEvents = new EventEmitter();
  let childClosed = false;
  let nativeTurnSequence = 0;
  let pendingInput = "";
  const child: CodexChild = {
    stdin,
    stdout,
    on(event, listener) {
      if (event === "exit") childEvents.on("exit", () => listener());
      else childEvents.on("error", listener);
    },
    kill() {
      if (childClosed) return true;
      childClosed = true;
      childEvents.emit("exit");
      stdout.end();
      return true;
    },
    treeAlive: () => !childClosed,
  };
  stdin.on("data", (chunk) => {
    pendingInput += String(chunk);
    for (;;) {
      const newline = pendingInput.indexOf("\n");
      if (newline < 0) break;
      const frame = JSON.parse(pendingInput.slice(0, newline)) as NativeFrame;
      pendingInput = pendingInput.slice(newline + 1);
      outbound.push(frame);
      if (frame.id === undefined || typeof frame.method !== "string") continue;
      const result =
        frame.method === "thread/start"
          ? { thread: { id: "native-thread" } }
          : frame.method === "turn/start"
            ? { turn: { id: `native-${++nativeTurnSequence}` } }
            : frame.method === "turn/steer"
              ? { turnId: `native-${nativeTurnSequence}` }
              : {};
      queueMicrotask(() =>
        stdout.write(`${JSON.stringify({ id: frame.id, result })}\n`),
      );
    }
  });

  let sessionSequence = 0;
  let diagnosticSequence = 0;
  const diagnostics = {
    generation,
    sessionId: () =>
      `session:${runtimeScopeId}:test:${++sessionSequence}` as SessionId,
    async record(): Promise<DiagnosticId | undefined> {
      diagnosticSequence += 1;
      return makeDiagnosticId(
        runtimeScopeId,
        generation,
        String(diagnosticSequence),
      );
    },
    async query() {
      return { records: [], truncated: false };
    },
    health() {
      return { status: "healthy" as const, repairs: [] };
    },
    async close() {},
  };
  const transport = createUnixSocketServer<ProtocolMessage>({
    path: socketPath,
  });
  const daemon = createDaemon({
    transport,
    adapters: new Map([
      [
        "codex",
        {
          driverFactory: createCodexDriver({
            transportFactory: (options) =>
              createCodexTransport({ ...options, spawnChild: () => child }),
          }),
          async modelCatalog() {
            return { harness: "codex", models: [] };
          },
        },
      ],
    ]),
    identity: {
      session: () => diagnostics.sessionId(),
    },
    diagnostics,
    runtimeScopeId,
    idleTimeoutMs: 60_000,
  });
  const running = daemon.start();
  void running.catch(() => undefined);

  try {
    await vi.waitFor(async () => {
      expect((await stat(socketPath)).isSocket()).toBe(true);
    });
    const client = await connect({
      socketPath,
      consumerContext: "codex-routing-test",
    });
    return {
      directory,
      client,
      outbound,
      notify(method, params) {
        stdout.write(`${JSON.stringify({ method, params })}\n`);
      },
      request(id, method, params) {
        stdout.write(`${JSON.stringify({ id, method, params })}\n`);
      },
      async close() {
        client.close();
        await daemon.stop().catch(() => undefined);
        await running.catch(() => undefined);
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await daemon.stop().catch(() => undefined);
    await running.catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function commandItem(
  id: string,
  status: "inProgress" | "completed",
  output: string | null,
) {
  return {
    type: "commandExecution",
    id,
    command: "echo tool output",
    status,
    aggregatedOutput: output,
  };
}

function agentMessage(id: string, text: string) {
  return { type: "agentMessage", id, text };
}

async function readHistory(
  client: ReinsConnection,
  sessionHandle: SessionHandle,
): Promise<AgentFact[]> {
  const history = await client.attach(
    { scope: "session", sessionHandle },
    { mode: "history" },
  );
  if (history.initial.mode !== "history") throw new Error("预期获得会话历史");
  const facts: AgentFact[] = [];
  for (let index = 0; index < history.initial.replayed; index += 1) {
    const next = await history.next();
    if (next.done) throw new Error("会话历史在重放完成前结束");
    facts.push(next.value);
    history.acknowledge(next.value);
  }
  history.close();
  return facts;
}

async function waitForNativeFrame(
  outbound: readonly NativeFrame[],
  id: number,
): Promise<NativeFrame> {
  let frame: NativeFrame | undefined;
  await vi.waitFor(
    () => {
      frame = outbound.find((candidate) => candidate.id === id);
      expect(frame, JSON.stringify(outbound)).toBeDefined();
    },
    { timeout: 3_000, interval: 10 },
  );
  if (frame === undefined) throw new Error("未收到 Codex 原生应答");
  return frame;
}

async function completeTwoTurnsWithLateMessage() {
  const fixture = await startFixture();
  try {
    const first = await fixture.client.spawn(
      { harness: "codex", cwd: fixture.directory, message: "first" },
      { operationKey: fixture.client.prepareOperation("spawn") },
    );
    fixture.notify("item/started", {
      threadId: "native-thread",
      turnId: "native-1",
      item: commandItem("old-tool", "inProgress", null),
    });
    fixture.notify("item/completed", {
      threadId: "native-thread",
      turnId: "native-1",
      item: commandItem("old-tool", "completed", "OLD_TOOL_OUTPUT"),
    });
    fixture.notify("item/completed", {
      threadId: "native-thread",
      turnId: "native-1",
      item: agentMessage("first-message", "FIRST_REPLY"),
    });
    fixture.notify("turn/completed", {
      threadId: "native-thread",
      turn: { id: "native-1", status: "completed", error: null },
    });
    await expect(
      fixture.client.wait({
        targets: [first.turnHandle],
        completion: "all",
      }),
    ).resolves.toMatchObject({
      completed: [{ turnHandle: first.turnHandle, finalReply: "FIRST_REPLY" }],
    });

    const second = await fixture.client.send(
      {
        placement: "new_turn",
        sessionHandle: first.sessionHandle,
        ifLastCompletedTurn: first.turnHandle,
        message: "second",
      },
      { operationKey: fixture.client.prepareOperation("send") },
    );
    fixture.notify("item/completed", {
      threadId: "native-thread",
      turnId: "native-2",
      item: agentMessage("new-message", "NEW_CURRENT_REPLY"),
    });
    fixture.notify("item/completed", {
      threadId: "native-thread",
      turnId: "native-1",
      item: agentMessage("late-old-message", "OLD_LATE_REPLY"),
    });
    fixture.notify("turn/completed", {
      threadId: "native-thread",
      turn: { id: "native-2", status: "completed", error: null },
    });
    const secondWait = await fixture.client.wait({
      targets: [second.turnHandle],
      completion: "all",
    });
    return { fixture, first, second, secondWait };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

test("迟到的旧 Codex 回合正文不覆盖当前回合结果", async () => {
  const { fixture, first, second, secondWait } =
    await completeTwoTurnsWithLateMessage();
  try {
    expect(secondWait).toMatchObject({
      completed: [
        { turnHandle: second.turnHandle, finalReply: "NEW_CURRENT_REPLY" },
      ],
    });
    const history = await readHistory(fixture.client, first.sessionHandle);
    expect(
      history.some(
        (fact) =>
          fact.type === "message" &&
          fact.turnHandle === second.turnHandle &&
          fact.content === "NEW_CURRENT_REPLY",
      ),
    ).toBe(true);
    expect(
      history.some(
        (fact) => fact.type === "message" && fact.content === "OLD_LATE_REPLY",
      ),
    ).toBe(false);
  } finally {
    await fixture.close();
  }
});

test("Codex 授权只关联当前原生回合及其已知工具", async () => {
  const { fixture, first, second } = await completeTwoTurnsWithLateMessage();
  try {
    const third = await fixture.client.send(
      {
        placement: "new_turn",
        sessionHandle: first.sessionHandle,
        ifLastCompletedTurn: second.turnHandle,
        message: "third",
      },
      { operationKey: fixture.client.prepareOperation("send") },
    );
    const observation = await fixture.client.attach(
      { scope: "turn", turnHandle: third.turnHandle },
      { mode: "snapshot" },
    );
    fixture.request(9000, "item/commandExecution/requestApproval", {
      threadId: "native-thread",
      turnId: "native-1",
      itemId: "old-tool",
      command: "echo old",
      availableDecisions: ["accept", "decline"],
    });
    const staleResponse = await waitForNativeFrame(fixture.outbound, 9000);
    expect(staleResponse).toMatchObject({
      id: 9000,
      error: { code: -32602 },
    });

    fixture.notify("item/started", {
      threadId: "native-thread",
      turnId: "native-3",
      item: commandItem("current-tool", "inProgress", null),
    });
    const toolNotice = await observation.next();
    expect(toolNotice.done).toBe(false);
    if (toolNotice.done) throw new Error("当前工具事实未发布");
    expect(toolNotice.value.type).toBe("tool.requested");
    if (toolNotice.value.type !== "tool.requested")
      throw new Error("预期收到当前工具请求");
    observation.acknowledge(toolNotice.value);

    fixture.request(9001, "item/commandExecution/requestApproval", {
      threadId: "native-thread",
      turnId: "native-3",
      itemId: "current-tool",
      command: "echo current",
      availableDecisions: ["accept", "decline"],
    });
    const permissionNotice = await observation.next();
    expect(permissionNotice.done).toBe(false);
    if (permissionNotice.done) throw new Error("当前授权事实未发布");
    expect(permissionNotice.value.type).toBe("permission.requested");
    if (permissionNotice.value.type !== "permission.requested")
      throw new Error("预期收到当前回合授权");
    expect(permissionNotice.value.toolKey).toBe(toolNotice.value.toolKey);
    observation.acknowledge(permissionNotice.value);

    await fixture.client.resolvePermission(
      permissionNotice.value.permissionHandle,
      { outcome: "allow", scope: "once" },
      { operationKey: fixture.client.prepareOperation("resolvePermission") },
    );
    expect(await waitForNativeFrame(fixture.outbound, 9001)).toMatchObject({
      id: 9001,
      result: { decision: "accept" },
    });

    fixture.notify("item/completed", {
      threadId: "native-thread",
      turnId: "native-3",
      item: commandItem("current-tool", "completed", "CURRENT_TOOL_OUTPUT"),
    });
    fixture.notify("item/completed", {
      threadId: "native-thread",
      turnId: "native-3",
      item: agentMessage("third-message", "THIRD_REPLY"),
    });
    fixture.notify("turn/completed", {
      threadId: "native-thread",
      turn: { id: "native-3", status: "completed", error: null },
    });
    await expect(
      fixture.client.wait({
        targets: [third.turnHandle],
        completion: "all",
      }),
    ).resolves.toMatchObject({
      completed: [{ turnHandle: third.turnHandle, finalReply: "THIRD_REPLY" }],
    });
    observation.close();

    const history = await readHistory(fixture.client, first.sessionHandle);
    const currentTool = history.filter(
      (fact) =>
        (fact.type === "tool.requested" || fact.type === "tool.completed") &&
        fact.turnHandle === third.turnHandle,
    );
    const currentPermissions = history.filter(
      (fact) =>
        fact.type === "permission.requested" &&
        fact.turnHandle === third.turnHandle,
    );
    expect(currentTool).toHaveLength(2);
    expect(currentPermissions).toHaveLength(1);
    const currentPermission = currentPermissions[0];
    if (currentPermission?.type !== "permission.requested")
      throw new Error("当前授权未进入历史");
    expect(currentTool[0]).toMatchObject({
      type: "tool.requested",
      toolKey: currentPermission.toolKey,
    });
    expect(currentTool[1]).toMatchObject({
      type: "tool.completed",
      toolKey: currentPermission.toolKey,
      result: "CURRENT_TOOL_OUTPUT",
    });
  } finally {
    await fixture.close();
  }
});
