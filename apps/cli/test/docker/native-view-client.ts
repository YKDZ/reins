import assert from "node:assert/strict";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { createWorkspaceClient, isCommandOutcomeUnknown } from "@reins/client";
import {
  consumerContextSchema,
  decodePermissionHandle,
  decodeTurnHandle,
  permissionHandleSchema,
  sessionNameSchema,
  type ProtocolMethod,
  type ProtocolParams,
} from "@reins/protocol";
import { createUnixSocketClient } from "@reins/transport";
import type { WorkspaceMessage } from "@reins/workspace-protocol";
import * as v from "valibot";

const task = JSON.parse(process.argv[2]!) as {
  socket: string;
  consumer: string;
  cwd: string;
  turnHandle: string;
  spawnMessage: string;
  evidence: string;
};
const save = async (name: string, value: unknown) => {
  const path = join(task.evidence, name);
  await writeFile(path + ".tmp", JSON.stringify(value, null, 2));
  await rename(path + ".tmp", path);
};
const waitForFile = async (path: string) => {
  for (;;) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await delay(25);
    }
  }
};
const target = decodeTurnHandle(task.turnHandle);
const manager = createWorkspaceClient(
  await createUnixSocketClient<WorkspaceMessage>(task.socket),
  { consumerContext: v.parse(consumerContextSchema, task.consumer) },
);
try {
  await manager.initialize();
  // 保持故障前已经取得的同一个 control，后续动作不能绕过 Manager。
  const client = await manager.control(task.cwd);
  try {
    assert.ok("result" in (await client.initialize()));
    const subscription = await client.subscribe({
      scope: "turn",
      ...target,
      replay: { mode: "available" },
    });
    const permission = await new Promise<string>((resolve) => {
      subscription.onEvent((event) => {
        if (event.type === "permission.requested")
          resolve(event.permissionHandle);
      });
    });
    const permissionHandle = v.parse(permissionHandleSchema, permission);
    const knownMessage = JSON.stringify({
      recordFile: "known-effect.txt",
      value: "caller known effect\n",
    });
    const known = await client.request("send", {
      ...target,
      placement: "active_turn",
      message: knownMessage,
    });
    assert.ok("result" in known, JSON.stringify(known));
    assert.equal(
      await waitForFile(join(task.cwd, "known-effect.txt")),
      "caller known effect\n",
    );
    const unknownMessage = JSON.stringify({
      recordFile: "unknown-effect.txt",
      value: "caller effect without native acceptance\n",
      acknowledge: false,
    });
    let unknown: unknown;
    await assert.rejects(
      client.request(
        "send",
        { ...target, placement: "active_turn", message: unknownMessage },
        0,
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        unknown = JSON.parse(error.message) as unknown;
        assert.ok(isCommandOutcomeUnknown(unknown));
        assert.equal(unknown.method, "send");
        return true;
      },
    );
    assert.equal(
      await waitForFile(join(task.cwd, "unknown-effect.txt")),
      "caller effect without native acceptance\n",
    );
    await save("client-ready.json", { known, unknown, permissionHandle });
    await waitForFile(join(task.evidence, "fault-applied.json"));
    const rejected: { method: string; error: unknown }[] = [];
    const deny = async <M extends ProtocolMethod>(
      method: M,
      params: ProtocolParams<M>,
    ) => {
      await assert.rejects(client.request(method, params), (error: unknown) => {
        assert.ok(error !== null && typeof error === "object");
        assert.equal((error as { code: string }).code, "native_view_lost");
        rejected.push({ method, error });
        return true;
      });
    };
    await deny("spawn", {
      harness: "codex",
      cwd: task.cwd,
      sessionName: v.parse(sessionNameSchema, "must-reject-sdk"),
      message: task.spawnMessage,
    });
    await deny("send", {
      ...target,
      placement: "active_turn",
      message: "caller rejected active input",
    });
    await deny("send", {
      sessionId: target.sessionId,
      placement: "new_turn",
      message: "caller rejected new input",
    });
    await deny("resolvePermission", {
      ...decodePermissionHandle(permissionHandle),
      resolution: { outcome: "allow", scope: "once" },
    });
    await save("client-result.json", {
      known,
      unknown,
      permissionHandle,
      rejected,
    });
    subscription.close();
  } finally {
    client.close();
  }
} finally {
  manager.close();
}
