import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { createWorkspaceClient } from "@reins/client";
import {
  consumerContextSchema,
  sessionNameSchema,
  spawnAckSchema,
} from "@reins/protocol";
import { createUnixSocketClient } from "@reins/transport";
import type { WorkspaceMessage } from "@reins/workspace-protocol";
import * as v from "valibot";

const task = JSON.parse(process.argv[2]!) as {
  socket: string;
  cwd: string;
  consumer: string;
  message: string;
};
const manager = createWorkspaceClient(
  await createUnixSocketClient<WorkspaceMessage>(task.socket),
  { consumerContext: v.parse(consumerContextSchema, task.consumer) },
);
try {
  await manager.initialize();
  const client = await manager.control(task.cwd);
  try {
    assert.ok("result" in (await client.initialize()));
    const rejected = {
      cwd: task.cwd,
      sessionName: v.parse(sessionNameSchema, "unselected-sdk"),
      message: task.message,
    };
    await assert.rejects(
      client.request("spawn", { ...rejected, harness: "qoder" }),
      { code: "binding_unknown" },
    );
    const lost = join(task.cwd, "removed-after-control");
    await mkdir(lost);
    await rm(lost, { recursive: true });
    await assert.rejects(
      client.request("spawn", { ...rejected, cwd: lost, harness: "codex" }),
      { code: "invalid_directory" },
    );
    const spawn = await client.request("spawn", {
      harness: "codex",
      cwd: task.cwd,
      sessionName: v.parse(sessionNameSchema, "sdk-reader"),
      message: task.message,
      model: "caller-model",
      reasoning: "caller-effort",
      authorizationMode: "interactive",
      sandbox: "caller-sandbox",
      agent: "caller-agent",
    });
    assert.ok("result" in spawn, JSON.stringify(spawn));
    const target = {
      sessionId: spawn.result.sessionId,
      turnId: spawn.result.turnId,
    };
    const result = await client.request("wait", {
      targets: [target],
      completion: "all",
    });
    assert.ok("result" in result, JSON.stringify(result));
    assert.equal(
      JSON.parse(result.result.completed[0]!.finalReply!).content,
      "caller selected real source\n",
    );
    assert.deepEqual(
      JSON.parse(result.result.completed[0]!.finalReply!).options,
      {
        model: "caller-model",
        reasoning: "caller-effort",
        authorizationMode: "interactive",
        sandbox: "caller-sandbox",
        agent: "caller-agent",
      },
    );
    await client.request("kill", { sessionId: target.sessionId });
    process.stdout.write(
      JSON.stringify({
        kind: "sdk-read",
        spawn: spawn.result,
        wait: result.result,
      }) + "\n",
    );
    const retryParams = {
      harness: "codex",
      sessionName: v.parse(sessionNameSchema, "sdk-retry"),
      message: task.message,
    };
    let retryToken = "";
    await assert.rejects(
      client.request("spawn", { ...retryParams, cwd: task.cwd }, 0),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        const unknown = JSON.parse(error.message) as {
          code: string;
          retryToken: string;
        };
        assert.equal(unknown.code, "command_outcome_unknown");
        retryToken = unknown.retryToken;
        process.stdout.write(
          JSON.stringify({ kind: "retry-unknown", retryToken }) + "\n",
        );
        return true;
      },
    );
    const recovered = await client.retry(retryToken, retryParams);
    assert.ok("result" in recovered, JSON.stringify(recovered));
    const recoveredSpawn = v.parse(spawnAckSchema, recovered.result);
    assert.equal(recoveredSpawn.cwd, task.cwd);
    process.stdout.write(
      JSON.stringify({ kind: "retry-recovered", result: recoveredSpawn }) +
        "\n",
    );
    await client.request("kill", { sessionId: recoveredSpawn.sessionId });
  } finally {
    client.close();
  }
} finally {
  manager.close();
}
