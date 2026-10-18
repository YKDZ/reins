import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { openLocal } from "@ykdz/reins";
import type { AgentFact, ReinsConnection } from "@ykdz/reins-sdk";
import { afterEach, expect, test } from "vitest";

const live = process.env.REINS_CODEX_CONTRACT_LIVE === "1";
const runtimePackage = fileURLToPath(new URL("../../", import.meta.url));
const daemonBin = join(runtimePackage, "node_modules/.bin/reins-daemon");
const fixtures: Array<{ directory: string; daemonPids: string }> = [];
const clients: ReinsConnection[] = [];

type ProviderRequest = {
  body: Record<string, unknown>;
  response: ServerResponse;
};

async function waitForProviderRequest(
  requests: readonly ProviderRequest[],
  count: number,
): Promise<ProviderRequest> {
  const deadline = Date.now() + 20_000;
  while (requests.length < count && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  const request = requests[count - 1];
  if (request === undefined)
    throw new Error(`等待本地模型服务第 ${count} 次请求超时`);
  return request;
}

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`等待本地工具文件超时: ${path}`);
}

async function waitForProcessIds(
  path: string,
  count: number,
): Promise<number[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const processIds = (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(Number);
      if (processIds.length >= count) return processIds;
    } catch {
      // 首个 app-server 启动前 PID 文件尚不存在。
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待第 ${count} 个 Codex app-server 超时`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (process.platform === "linux") {
      try {
        const stat = await readFile(`/proc/${pid}/stat`, "utf8");
        const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
        if (state === "Z" || state === "X") return;
      } catch {
        return;
      }
    } else {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Codex 关闭后工具进程仍存活: ${pid}`);
}

function completeResponse(
  request: ProviderRequest,
  index: number,
  text: string,
): void {
  const item = {
    id: `message-${index}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const events = [
    {
      type: "response.created",
      response: { id: `response-${index}`, status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `response-${index}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  request.response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const event of events)
    request.response.write(
      `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    );
  request.response.end();
}

function completeToolCall(
  request: ProviderRequest,
  index: number,
  name: string,
  arguments_: Record<string, unknown>,
): void {
  const item = {
    id: `call-${index}`,
    type: "function_call",
    call_id: `call-${index}`,
    name,
    arguments: JSON.stringify(arguments_),
  };
  const events = [
    {
      type: "response.created",
      response: { id: `response-${index}`, status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress" },
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `response-${index}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  request.response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const event of events)
    request.response.write(
      `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    );
  request.response.end();
}

async function stopDaemon(daemonPids: string): Promise<void> {
  let pids: number[] = [];
  try {
    pids = (await readFile(daemonPids, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    return;
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      continue;
    }
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    try {
      process.kill(pid, 0);
    } catch {
      continue;
    }
    process.kill(pid, "SIGKILL");
    const killDeadline = Date.now() + 1_500;
    while (Date.now() < killDeadline) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const fixture of fixtures.splice(0)) {
    await stopDaemon(fixture.daemonPids);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test.skipIf(!live)(
  "Codex 0.162.1 经正式 SDK 与 daemon 接受精确输入、中断并继续",
  async () => {
    expect(
      execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(),
    ).toBe("codex-cli 0.162.1");

    const directory = await mkdtemp(join(tmpdir(), "reins-codex-control-"));
    const daemonPids = join(directory, "daemon-pids.txt");
    fixtures.push({ directory, daemonPids });
    const codexHome = join(directory, "codex-home");
    const codexLauncherDirectory = join(directory, "codex-bin");
    const codexProcessIds = join(directory, "codex-pids.txt");
    const daemonLauncher = join(directory, "reins-daemon");
    const socketPath = join(directory, "reins.sock");
    const stateDirectory = join(directory, "state");

    const providerRequests: ProviderRequest[] = [];
    const provider = createServer(async (incoming, response) => {
      if (incoming.method === "GET" && incoming.url?.startsWith("/v1/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [] }));
        return;
      }
      if (incoming.method !== "POST" || incoming.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      let bodyText = "";
      for await (const chunk of incoming) bodyText += String(chunk);
      providerRequests.push({
        body: JSON.parse(bodyText) as Record<string, unknown>,
        response,
      });
    });
    await new Promise<void>((resolve) =>
      provider.listen(0, "127.0.0.1", resolve),
    );
    const port = (provider.address() as { port: number }).port;

    await mkdir(codexHome);
    await mkdir(codexLauncherDirectory);
    const codexExecutable = execFileSync("which", ["codex"], {
      encoding: "utf8",
    }).trim();
    await writeFile(
      join(codexLauncherDirectory, "codex"),
      `#!/bin/sh\nprintf '%s\\n' "$$" >> '${codexProcessIds}'\nexec '${codexExecutable}' "$@"\n`,
      { mode: 0o700 },
    );
    await writeFile(
      join(codexHome, "config.toml"),
      [
        'model = "reins-probe"',
        'model_provider = "reins_probe"',
        "[model_providers.reins_probe]",
        'name = "Reins local control probe"',
        `base_url = "http://127.0.0.1:${port}/v1"`,
        'wire_api = "responses"',
        "requires_openai_auth = false",
        "[features]",
        "responses_websockets_v2 = false",
      ].join("\n") + "\n",
    );
    await writeFile(
      daemonLauncher,
      `#!/bin/sh\nprintf '%s\\n' "$$" >> '${daemonPids}'\nexec '${daemonBin}' "$@"\n`,
      { mode: 0o700 },
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: codexHome,
      REINS_SOCKET: socketPath,
      REINS_STATE_DIR: stateDirectory,
      REINS_DAEMON_BIN: daemonLauncher,
      REINS_IDLE_TIMEOUT_MS: "120000",
      PATH: `${codexLauncherDirectory}:${process.env.PATH ?? ""}`,
    };
    delete env.REINS_ADAPTERS_MODULE;
    const connection = await openLocal({
      consumerContext: "codex-control-e2e",
      env,
    });
    clients.push(connection);
    let activeConnection = connection;

    try {
      const spawned = await connection.spawn({
        harness: "codex",
        cwd: directory,
        message: "FIRST_MARKER",
      });
      const firstRequest = await waitForProviderRequest(providerRequests, 1);
      expect(JSON.stringify(firstRequest.body.input)).toContain("FIRST_MARKER");

      const correction = await connection.send(
        {
          placement: "active_turn",
          turnHandle: spawned.turnHandle,
          message: "STEER_MARKER",
        },
        { operationKey: connection.prepareOperation("send") },
      );
      expect(correction).toMatchObject({
        turnHandle: spawned.turnHandle,
        deliveryPoint: "active_turn",
      });
      completeResponse(firstRequest, 1, "FIRST_RESPONSE");
      const steeredRequest = await waitForProviderRequest(providerRequests, 2);
      expect(JSON.stringify(steeredRequest.body.input)).toContain(
        "STEER_MARKER",
      );
      completeResponse(steeredRequest, 2, "STEER_APPLIED");
      await expect(
        connection.wait({
          targets: [spawned.turnHandle],
          completion: "all",
          timeoutMs: 20_000,
        }),
      ).resolves.toMatchObject({
        status: "satisfied",
        completed: [{ turnHandle: spawned.turnHandle, stopReason: "end_turn" }],
      });

      await expect(
        connection.send(
          {
            placement: "active_turn",
            turnHandle: spawned.turnHandle,
            message: "STALE_TARGET_MARKER",
          },
          { operationKey: connection.prepareOperation("send") },
        ),
      ).rejects.toMatchObject({ failure: { code: "turn_not_active" } });

      const interruptTarget = await connection.send(
        {
          placement: "new_turn",
          sessionHandle: spawned.sessionHandle,
          ifLastCompletedTurn: spawned.turnHandle,
          message: "INTERRUPT_ME",
        },
        { operationKey: connection.prepareOperation("send") },
      );
      await waitForProviderRequest(providerRequests, 3);
      const interruptKey = connection.prepareOperation("interrupt");
      await expect(
        connection.interrupt(
          { turnHandle: interruptTarget.turnHandle },
          { operationKey: interruptKey },
        ),
      ).resolves.toEqual({
        turnHandle: interruptTarget.turnHandle,
        status: "accepted",
      });
      await expect(
        connection.getOperation(interruptKey),
      ).resolves.toMatchObject({
        status: "succeeded",
        result: { turnHandle: interruptTarget.turnHandle, status: "accepted" },
      });
      await expect(
        connection.wait({
          targets: [interruptTarget.turnHandle],
          completion: "all",
          timeoutMs: 20_000,
        }),
      ).resolves.toMatchObject({
        status: "satisfied",
        completed: [
          { turnHandle: interruptTarget.turnHandle, stopReason: "cancelled" },
        ],
      });

      const continuation = await connection.send(
        {
          placement: "new_turn",
          sessionHandle: spawned.sessionHandle,
          ifLastCompletedTurn: interruptTarget.turnHandle,
          message: "CONTINUE_MARKER",
        },
        { operationKey: connection.prepareOperation("send") },
      );
      const continuedRequest = await waitForProviderRequest(
        providerRequests,
        4,
      );
      expect(JSON.stringify(continuedRequest.body.input)).toContain(
        "CONTINUE_MARKER",
      );
      completeResponse(continuedRequest, 3, "CONTINUE_OK");
      await expect(
        connection.wait({
          targets: [continuation.turnHandle],
          completion: "all",
          timeoutMs: 20_000,
        }),
      ).resolves.toMatchObject({
        status: "satisfied",
        completed: [
          { turnHandle: continuation.turnHandle, stopReason: "end_turn" },
        ],
      });

      const raceTarget = await connection.send(
        {
          placement: "new_turn",
          sessionHandle: spawned.sessionHandle,
          ifLastCompletedTurn: continuation.turnHandle,
          message: "NATURAL_INTERRUPT_RACE",
        },
        { operationKey: connection.prepareOperation("send") },
      );
      const raceRequest = await waitForProviderRequest(providerRequests, 5);
      const raceKey = connection.prepareOperation("interrupt");
      const interruptRace = connection
        .interrupt(
          { turnHandle: raceTarget.turnHandle },
          { operationKey: raceKey },
        )
        .then(
          (result) => ({ kind: "accepted" as const, result }),
          (error: unknown) => ({ kind: "not_accepted" as const, error }),
        );
      if (!raceRequest.response.destroyed)
        completeResponse(raceRequest, 4, "NATURAL_COMPLETION_WON");
      const raceResult = await interruptRace;
      const racedTurn = await connection.wait({
        targets: [raceTarget.turnHandle],
        completion: "all",
        timeoutMs: 20_000,
      });
      expect(racedTurn).toMatchObject({ status: "satisfied", pending: [] });
      expect(["end_turn", "cancelled"]).toContain(
        racedTurn.completed[0]?.stopReason,
      );
      const raceOperation = await connection.getOperation(raceKey);
      if (raceResult.kind === "accepted") {
        expect(raceResult.result).toEqual({
          turnHandle: raceTarget.turnHandle,
          status: "accepted",
        });
        expect(raceOperation).toMatchObject({
          status: "succeeded",
          result: { turnHandle: raceTarget.turnHandle, status: "accepted" },
        });
      } else {
        expect(raceOperation.status).not.toBe("succeeded");
        expect(raceResult.error).toBeDefined();
      }

      const toolRequestIndex = providerRequests.length + 1;
      const toolSession = await connection.spawn({
        harness: "codex",
        cwd: directory,
        message: "RUN_BUILTIN_TOOL_MARKER",
        authorizationMode: "interactive",
      });
      const toolHistory = await connection.attach(
        { scope: "turn", turnHandle: toolSession.turnHandle },
        { mode: "history" },
      );
      const toolRequest = await waitForProviderRequest(
        providerRequests,
        toolRequestIndex,
      );
      const command = `node -e 'process.stdout.write("BUILTIN_BODY_BEGIN\\n" + "output-body\\n".repeat(4000) + "BUILTIN_BODY_END\\n")'`;
      completeToolCall(toolRequest, toolRequestIndex, "exec_command", {
        cmd: command,
        workdir: directory,
        sandbox_permissions: "require_escalated",
        justification: "在本测试临时目录执行确定性输出命令",
      });

      const toolFacts: AgentFact[] = [];
      let requestedPermission:
        | Extract<AgentFact, { type: "permission.requested" }>
        | undefined;
      while (requestedPermission === undefined) {
        const item = await toolHistory.next();
        if (item.done) throw new Error("Codex 未提交工具授权请求");
        toolFacts.push(item.value);
        toolHistory.acknowledge(item.value);
        if (item.value.type === "permission.requested")
          requestedPermission = item.value;
      }
      const requestedTool = toolFacts.find(
        (fact) => fact.type === "tool.requested",
      );
      if (requestedTool?.type !== "tool.requested")
        throw new Error("Codex 授权没有关联到已请求工具");
      expect(requestedPermission.toolKey).toBe(requestedTool.toolKey);
      expect(requestedPermission.options).toContainEqual({
        outcome: "allow",
        scope: "once",
      });

      const reconnected = await openLocal({
        consumerContext: "codex-control-e2e",
        env,
      });
      clients.push(reconnected);
      activeConnection = reconnected;
      connection.close();
      const recoveredHistory = await reconnected.attach(
        { scope: "turn", turnHandle: toolSession.turnHandle },
        { mode: "history" },
      );
      const authorizationSnapshot = await reconnected.attach(
        { scope: "turn", turnHandle: toolSession.turnHandle },
        { mode: "snapshot" },
      );
      if (authorizationSnapshot.initial.mode !== "snapshot")
        throw new Error("Codex 授权快照没有返回基线");
      expect(
        authorizationSnapshot.initial.baseline.pendingPermissions,
      ).toContainEqual(
        expect.objectContaining({
          permissionHandle: requestedPermission.permissionHandle,
          toolKey: requestedTool.toolKey,
        }),
      );
      authorizationSnapshot.close();
      await expect(authorizationSnapshot.done).resolves.toMatchObject({
        reason: "closed",
      });
      let recoveredPermission:
        | Extract<AgentFact, { type: "permission.requested" }>
        | undefined;
      while (recoveredPermission === undefined) {
        const item = await recoveredHistory.next();
        if (item.done) throw new Error("重连未回放 Codex 授权事实");
        if (item.value.type === "permission.requested")
          recoveredPermission = item.value;
        recoveredHistory.acknowledge(item.value);
      }
      expect(recoveredPermission.permissionHandle).toBe(
        requestedPermission.permissionHandle,
      );
      expect(recoveredPermission.toolKey).toBe(requestedTool.toolKey);
      const resolutionKey = reconnected.prepareOperation("resolvePermission");
      const resolution = {
        outcome: "allow",
        scope: "once",
      } as const;
      await expect(
        reconnected.resolvePermission(
          recoveredPermission.permissionHandle,
          resolution,
          { operationKey: resolutionKey },
        ),
      ).resolves.toMatchObject({ status: "resolved" });
      await expect(
        reconnected.resolvePermission(
          recoveredPermission.permissionHandle,
          resolution,
          { operationKey: resolutionKey },
        ),
      ).resolves.toMatchObject({ status: "resolved" });
      await expect(
        reconnected.resolvePermission(
          recoveredPermission.permissionHandle,
          { outcome: "deny", feedback: "同一操作不可变更" },
          { operationKey: resolutionKey },
        ),
      ).rejects.toMatchObject({ failure: { code: "operation_key_conflict" } });

      const afterToolRequest = await waitForProviderRequest(
        providerRequests,
        toolRequestIndex + 1,
      );
      completeResponse(
        afterToolRequest,
        toolRequestIndex + 1,
        "TOOL_RESULT_SEEN",
      );
      await expect(
        reconnected.wait({
          targets: [toolSession.turnHandle],
          completion: "all",
          timeoutMs: 20_000,
        }),
      ).resolves.toMatchObject({ status: "satisfied", pending: [] });
      for (;;) {
        const item = await recoveredHistory.next();
        if (item.done) break;
        toolFacts.push(item.value);
        recoveredHistory.acknowledge(item.value);
      }
      expect(await recoveredHistory.done).toMatchObject({ reason: "end_turn" });
      const toolRequested = toolFacts.find(
        (fact) => fact.type === "tool.requested",
      );
      const toolCompleted = toolFacts.find(
        (fact) => fact.type === "tool.completed",
      );
      expect(toolRequested).toMatchObject({
        type: "tool.requested",
        name: "commandExecution",
      });
      expect(toolRequested?.input).toContain("BUILTIN_BODY_BEGIN");
      expect(toolCompleted).toMatchObject({
        type: "tool.completed",
        toolKey: toolRequested?.toolKey,
        name: "commandExecution",
        result:
          "BUILTIN_BODY_BEGIN\n" +
          "output-body\n".repeat(4000) +
          "BUILTIN_BODY_END\n",
        isError: false,
      });
      expect(
        toolFacts.filter((fact) => fact.type === "permission.resolved"),
      ).toHaveLength(1);
      expect(
        toolFacts.some(
          (fact) =>
            fact.type === "message" &&
            fact.role === "caller" &&
            fact.content === "RUN_BUILTIN_TOOL_MARKER",
        ),
      ).toBe(true);

      const closingToolRequestIndex = providerRequests.length + 1;
      const closingSession = await activeConnection.spawn({
        harness: "codex",
        cwd: directory,
        message: "RUN_TOOL_UNTIL_SESSION_CLOSE",
        authorizationMode: "allowAll",
      });
      const closingTurnHistory = await activeConnection.attach(
        { scope: "turn", turnHandle: closingSession.turnHandle },
        { mode: "history" },
      );
      const closingToolRequest = await waitForProviderRequest(
        providerRequests,
        closingToolRequestIndex,
      );
      const closingCommand = `node -e 'const fs=require("node:fs");fs.writeFileSync("codex-tool.pid",String(process.pid));setTimeout(()=>fs.writeFileSync("codex-tool.finished","finished"),12000)'`;
      completeToolCall(
        closingToolRequest,
        closingToolRequestIndex,
        "exec_command",
        { cmd: closingCommand, workdir: directory },
      );
      const toolPid = Number(
        await waitForFile(join(directory, "codex-tool.pid")),
      );
      expect(Number.isInteger(toolPid)).toBe(true);

      const survivorRequestIndex = providerRequests.length + 1;
      const survivor = await activeConnection.spawn({
        harness: "codex",
        cwd: directory,
        message: "SURVIVOR_SESSION_MARKER",
        authorizationMode: "allowAll",
      });
      const survivorRequest = await waitForProviderRequest(
        providerRequests,
        survivorRequestIndex,
      );
      await expect(
        activeConnection.kill(
          { sessionHandle: closingSession.sessionHandle },
          { operationKey: activeConnection.prepareOperation("kill") },
        ),
      ).resolves.toMatchObject({
        sessionHandle: closingSession.sessionHandle,
        status: "killed",
      });
      await waitForProcessExit(toolPid);
      await expect(
        readFile(join(directory, "codex-tool.finished"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      closingTurnHistory.close();

      const closedHistory = await activeConnection.attach(
        { scope: "session", sessionHandle: closingSession.sessionHandle },
        { mode: "history" },
      );
      if (closedHistory.initial.mode !== "history")
        throw new Error("已关闭会话订阅未返回历史初始结果");
      const closedFacts: AgentFact[] = [];
      for (let index = 0; index < closedHistory.initial.replayed; index += 1) {
        const item = await closedHistory.next();
        if (item.done) throw new Error("已关闭会话历史未完整回放");
        closedFacts.push(item.value);
        closedHistory.acknowledge(item.value);
      }
      closedHistory.close();
      const closingTool = closedFacts.find(
        (fact) => fact.type === "tool.requested",
      );
      expect(closingTool).toBeDefined();
      expect(
        closedFacts.some(
          (fact) =>
            fact.type === "tool.completed" &&
            fact.toolKey === closingTool?.toolKey,
        ),
      ).toBe(false);

      completeResponse(survivorRequest, survivorRequestIndex, "SURVIVOR_OK");
      await expect(
        activeConnection.wait({
          targets: [survivor.turnHandle],
          completion: "all",
          timeoutMs: 20_000,
        }),
      ).resolves.toMatchObject({ status: "satisfied", pending: [] });

      const cancellationRequestIndex = providerRequests.length + 1;
      const cancellationSession = await activeConnection.spawn({
        harness: "codex",
        cwd: directory,
        message: "INTERRUPT_PENDING_AUTHORIZATION",
        authorizationMode: "interactive",
      });
      const cancellationHistory = await activeConnection.attach(
        { scope: "turn", turnHandle: cancellationSession.turnHandle },
        { mode: "history" },
      );
      const cancellationRequest = await waitForProviderRequest(
        providerRequests,
        cancellationRequestIndex,
      );
      const cancelledCommand = `node -e 'require("node:fs").writeFileSync("codex-cancelled-tool","ran")'`;
      completeToolCall(
        cancellationRequest,
        cancellationRequestIndex,
        "exec_command",
        {
          cmd: cancelledCommand,
          workdir: directory,
          sandbox_permissions: "require_escalated",
          justification: "本测试将中断待授权的工具",
        },
      );
      let cancellationPermission:
        | Extract<AgentFact, { type: "permission.requested" }>
        | undefined;
      while (cancellationPermission === undefined) {
        const item = await cancellationHistory.next();
        if (item.done) throw new Error("待中断回合未产生授权请求");
        cancellationHistory.acknowledge(item.value);
        if (item.value.type === "permission.requested")
          cancellationPermission = item.value;
      }
      await expect(
        activeConnection.interrupt(
          { turnHandle: cancellationSession.turnHandle },
          { operationKey: activeConnection.prepareOperation("interrupt") },
        ),
      ).resolves.toMatchObject({ status: "accepted" });
      await expect(
        activeConnection.wait({
          targets: [cancellationSession.turnHandle],
          completion: "all",
          timeoutMs: 20_000,
        }),
      ).resolves.toMatchObject({
        status: "satisfied",
        completed: [
          {
            turnHandle: cancellationSession.turnHandle,
            stopReason: "cancelled",
          },
        ],
      });
      await expect(
        activeConnection.resolvePermission(
          cancellationPermission.permissionHandle,
          { outcome: "allow", scope: "once" },
          {
            operationKey:
              activeConnection.prepareOperation("resolvePermission"),
          },
        ),
      ).rejects.toMatchObject({ failure: { code: "permission_not_pending" } });
      await expect(
        readFile(join(directory, "codex-cancelled-tool"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      for (;;) {
        const item = await cancellationHistory.next();
        if (item.done) break;
        cancellationHistory.acknowledge(item.value);
      }
      await expect(cancellationHistory.done).resolves.toMatchObject({
        reason: "cancelled",
      });

      const interruptToolRequestIndex = providerRequests.length + 1;
      const interruptToolSession = await activeConnection.spawn({
        harness: "codex",
        cwd: directory,
        message: "INTERRUPT_RUNNING_BUILTIN_TOOL",
        authorizationMode: "allowAll",
      });
      const interruptToolHistory = await activeConnection.attach(
        { scope: "turn", turnHandle: interruptToolSession.turnHandle },
        { mode: "history" },
      );
      const interruptToolRequest = await waitForProviderRequest(
        providerRequests,
        interruptToolRequestIndex,
      );
      const interruptToolCommand = `node -e 'const fs=require("node:fs");fs.writeFileSync("interrupt-tool-started",String(process.pid));const timer=setInterval(()=>{if(fs.existsSync("release-interrupt-tool")){clearInterval(timer);fs.writeFileSync("interrupt-tool-late","late")}},25)'`;
      completeToolCall(
        interruptToolRequest,
        interruptToolRequestIndex,
        "exec_command",
        { cmd: interruptToolCommand, workdir: directory },
      );
      const interruptToolFacts: AgentFact[] = [];
      let interruptedTool:
        | Extract<AgentFact, { type: "tool.requested" }>
        | undefined;
      while (interruptedTool === undefined) {
        const item = await interruptToolHistory.next();
        if (item.done) throw new Error("待中断回合未启动内置工具");
        interruptToolFacts.push(item.value);
        interruptToolHistory.acknowledge(item.value);
        if (
          item.value.type === "tool.requested" &&
          item.value.name === "commandExecution"
        )
          interruptedTool = item.value;
      }
      expect(interruptedTool.input).toContain("interrupt-tool-started");
      const interruptToolPid = Number(
        await waitForFile(join(directory, "interrupt-tool-started")),
      );
      expect(Number.isInteger(interruptToolPid)).toBe(true);
      await expect(
        activeConnection.interrupt(
          { turnHandle: interruptToolSession.turnHandle },
          { operationKey: activeConnection.prepareOperation("interrupt") },
        ),
      ).resolves.toMatchObject({ status: "accepted" });
      await expect(
        activeConnection.wait({
          targets: [interruptToolSession.turnHandle],
          completion: "all",
          timeoutMs: 20_000,
        }),
      ).resolves.toMatchObject({
        status: "satisfied",
        completed: [
          {
            turnHandle: interruptToolSession.turnHandle,
            stopReason: "cancelled",
          },
        ],
      });
      await waitForProcessExit(interruptToolPid);
      await writeFile(join(directory, "release-interrupt-tool"), "release");
      await new Promise((resolve) => setTimeout(resolve, 100));
      await expect(
        readFile(join(directory, "interrupt-tool-late"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      for (;;) {
        const item = await interruptToolHistory.next();
        if (item.done) break;
        interruptToolFacts.push(item.value);
        interruptToolHistory.acknowledge(item.value);
      }
      await expect(interruptToolHistory.done).resolves.toMatchObject({
        reason: "cancelled",
      });
      expect(
        interruptToolFacts.filter(
          (fact) =>
            fact.type === "tool.completed" &&
            fact.toolKey === interruptedTool.toolKey,
        ),
      ).toHaveLength(0);

      const afterInterruptedToolRequestIndex = providerRequests.length + 1;
      const afterInterruptedTool = await activeConnection.send(
        {
          placement: "new_turn",
          sessionHandle: interruptToolSession.sessionHandle,
          ifLastCompletedTurn: interruptToolSession.turnHandle,
          message: "CONTINUE_AFTER_TOOL_INTERRUPT",
        },
        { operationKey: activeConnection.prepareOperation("send") },
      );
      const afterInterruptedToolRequest = await waitForProviderRequest(
        providerRequests,
        afterInterruptedToolRequestIndex,
      );
      completeResponse(
        afterInterruptedToolRequest,
        afterInterruptedToolRequestIndex,
        "INTERRUPTED_TOOL_SESSION_CONTINUED",
      );
      await expect(
        activeConnection.wait({
          targets: [afterInterruptedTool.turnHandle],
          completion: "all",
          timeoutMs: 20_000,
        }),
      ).resolves.toMatchObject({
        status: "satisfied",
        completed: [
          {
            turnHandle: afterInterruptedTool.turnHandle,
            stopReason: "end_turn",
          },
        ],
      });

      const history = await activeConnection.attach(
        { scope: "session", sessionHandle: spawned.sessionHandle },
        { mode: "history" },
      );
      if (history.initial.mode !== "history")
        throw new Error("会话历史订阅未返回历史初始结果");
      const facts: AgentFact[] = [];
      for (let index = 0; index < history.initial.replayed; index += 1) {
        const item = await history.next();
        if (item.done) throw new Error("会话历史未交付完整重放事实");
        facts.push(item.value);
        history.acknowledge(item.value);
      }
      history.close();
      expect(facts).toContainEqual(
        expect.objectContaining({
          type: "message",
          role: "caller",
          messageKey: correction.messageKey,
          content: "STEER_MARKER",
        }),
      );
      expect(
        facts.filter(
          (fact) =>
            fact.type === "turn.completed" &&
            fact.turnHandle === spawned.turnHandle,
        ),
      ).toHaveLength(1);
      expect(
        facts.some(
          (fact) =>
            fact.type === "message" &&
            fact.role === "caller" &&
            fact.content === "STALE_TARGET_MARKER",
        ),
      ).toBe(false);

      const codexProcessIdsBeforeLoss = (
        await waitForProcessIds(codexProcessIds, 1)
      ).length;
      const lossRequestIndex = providerRequests.length + 1;
      const lostSession = await activeConnection.spawn({
        harness: "codex",
        cwd: directory,
        message: "STREAM_LOSS_WITHOUT_TERMINAL",
        authorizationMode: "allowAll",
      });
      await waitForProviderRequest(providerRequests, lossRequestIndex);
      const codexProcessIdsAfterStart = await waitForProcessIds(
        codexProcessIds,
        codexProcessIdsBeforeLoss + 1,
      );
      const lostAppServerPid = codexProcessIdsAfterStart.at(-1);
      if (lostAppServerPid === undefined)
        throw new Error("Codex app-server 未记录进程号");
      const activeLossSubscription = await activeConnection.attach(
        { scope: "session", sessionHandle: lostSession.sessionHandle },
        { mode: "snapshot" },
      );
      expect(activeLossSubscription.initial).toMatchObject({
        mode: "snapshot",
        baseline: { session: { state: "busy" } },
      });
      process.kill(lostAppServerPid, "SIGKILL");
      await expect(
        activeConnection.wait({
          targets: [lostSession.turnHandle],
          completion: "all",
          timeoutMs: 20_000,
        }),
      ).resolves.toMatchObject({
        status: "unreachable",
        completed: [],
        pending: [],
        unreachable: [
          { turnHandle: lostSession.turnHandle, reason: "control_lost" },
        ],
      });
      await expect(activeLossSubscription.done).resolves.toMatchObject({
        reason: "control_unavailable",
      });
      const unavailableHistory = await activeConnection.attach(
        { scope: "turn", turnHandle: lostSession.turnHandle },
        { mode: "history" },
      );
      if (unavailableHistory.initial.mode !== "history")
        throw new Error("不可用回合未返回其已提交历史");
      const unavailableFacts: AgentFact[] = [];
      for (
        let index = 0;
        index < unavailableHistory.initial.replayed;
        index += 1
      ) {
        const item = await unavailableHistory.next();
        if (item.done) throw new Error("不可用回合历史提前结束");
        unavailableFacts.push(item.value);
        unavailableHistory.acknowledge(item.value);
      }
      await expect(unavailableHistory.done).resolves.toMatchObject({
        reason: "control_unavailable",
      });
      expect(
        unavailableFacts.some(
          (fact) =>
            fact.type === "turn.completed" &&
            fact.turnHandle === lostSession.turnHandle,
        ),
      ).toBe(false);
      expect(
        await activeConnection.list({
          sessionHandle: lostSession.sessionHandle,
        }),
      ).toMatchObject([
        {
          state: "unreachable",
          lastKnownState: "busy",
          unreachableReason: "control_lost",
        },
      ]);

      const survivingRequestIndex = providerRequests.length + 1;
      const survivingSession = await activeConnection.spawn({
        harness: "codex",
        cwd: directory,
        message: "SESSION_AFTER_OTHER_STREAM_LOSS",
        authorizationMode: "allowAll",
      });
      const survivingRequest = await waitForProviderRequest(
        providerRequests,
        survivingRequestIndex,
      );
      completeResponse(survivingRequest, survivingRequestIndex, "SURVIVES");
      await expect(
        activeConnection.wait({
          targets: [survivingSession.turnHandle],
          completion: "all",
          timeoutMs: 20_000,
        }),
      ).resolves.toMatchObject({
        status: "satisfied",
        completed: [
          { turnHandle: survivingSession.turnHandle, stopReason: "end_turn" },
        ],
      });
    } finally {
      for (const client of clients.splice(0)) client.close();
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        provider.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    }
  },
  180_000,
);
