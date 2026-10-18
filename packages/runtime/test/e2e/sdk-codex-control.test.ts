import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { openLocal } from "@ykdz/reins";
import type { AgentFact, ReinsConnection } from "@ykdz/reins-sdk";
import { afterEach, expect, test } from "vitest";

const live = process.env.REINS_CODEX_CONTROL_LIVE === "1";
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
    };
    delete env.REINS_ADAPTERS_MODULE;
    const connection = await openLocal({
      consumerContext: "codex-control-e2e",
      env,
    });
    clients.push(connection);

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

      const history = await connection.attach(
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
