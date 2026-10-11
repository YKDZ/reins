import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { createReinsClient, createWorkspaceClient } from "@reins/client";
import {
  consumerContextSchema,
  decodeTurnHandle,
  turnHandleSchema,
  permissionIdSchema,
  sessionNameSchema,
  type ProtocolMessage,
} from "@reins/protocol";
import { createUnixSocketClient } from "@reins/transport";
import type { WorkspaceMessage } from "@reins/workspace-protocol";
import * as v from "valibot";

const task = JSON.parse(process.argv[2]!) as {
  socket: string;
  cwd: string;
  consumer: string;
  directory: string;
  action?: "prepare" | "probe";
  turnHandle?: string;
  expected?: "ready" | "failed";
};
const connection = await createUnixSocketClient<WorkspaceMessage>(task.socket);
let admission: string | undefined;
let release: (() => void) | undefined;
const manager = createWorkspaceClient(
  {
    ...connection,
    send(message) {
      if (
        message.kind === "request" &&
        message.method === "workspace.admit" &&
        message.params.action === "spawn"
      )
        admission = message.requestId;
      connection.send(message);
    },
    onEvent(listener) {
      return connection.onEvent((event) => {
        if (
          event.kind === "message" &&
          event.message.kind === "response" &&
          event.message.requestId === admission &&
          "result" in event.message
        ) {
          release = () => listener(event);
          void writeFile(join(task.directory, "admission-ready"), "ready");
        } else listener(event);
      });
    },
  },
  { consumerContext: v.parse(consumerContextSchema, task.consumer) },
);
try {
  await manager.initialize();
  if (task.action === "prepare") {
    for (;;) {
      const current = await manager.request(
        "workspace.status",
        { cwd: task.cwd },
        600_000,
      );
      if (current.runtime.status === task.expected) {
        process.stdout.write(JSON.stringify(current) + "\n");
        break;
      }
      assert.equal(
        current.runtime.status,
        "preparing",
        JSON.stringify(current),
      );
      await delay(2000);
    }
  } else {
    const route = await manager.request(
      "workspace.route",
      { cwd: task.cwd },
      600_000,
    );
    const client = createReinsClient(
      await createUnixSocketClient<ProtocolMessage>(route.socket),
      { consumerContext: v.parse(consumerContextSchema, task.consumer) },
    );
    try {
      assert.ok("result" in (await client.initialize()));
      if (task.action === "probe") {
        const target = decodeTurnHandle(
          v.parse(turnHandleSchema, task.turnHandle),
        );
        const sent = await client.request("send", {
          placement: "new_turn",
          sessionId: target.sessionId,
          message: "Caller gate probe",
        });
        const resolved = await client.request("resolvePermission", {
          ...target,
          permissionId: v.parse(permissionIdSchema, "p1"),
          resolution: { outcome: "deny" },
        });
        const listed = await client.request("list", {});
        assert.ok("error" in sent && sent.error.code === "workspace_detaching");
        assert.ok(
          "error" in resolved && resolved.error.code === "workspace_detaching",
        );
        assert.ok("result" in listed);
        process.stdout.write(JSON.stringify({ sent, resolved, listed }) + "\n");
      } else {
        // 只延迟已成功的 Manager 准入响应，底层请求与 CommandId 仍由真实共享客户端生成。
        const params = {
          harness: "codex",
          sessionName: v.parse(sessionNameSchema, "late-admission"),
          cwd: task.cwd,
          message: JSON.stringify({
            heldFile: "late-held.txt",
            relativeFile: "late-relative.txt",
            intervalMs: 25,
          }),
        };
        const pending = manager
          .request(
            "workspace.admit",
            { cwd: task.cwd, action: "spawn", params },
            600_000,
          )
          .then(() => client.request("spawn", params));
        for (;;) {
          try {
            await readFile(join(task.directory, "admission-release"));
            break;
          } catch {
            await delay(10);
          }
        }
        assert.ok(release);
        release();
        let outcome: unknown;
        try {
          outcome = await pending;
        } catch (error) {
          outcome = {
            rejected:
              error instanceof Error ? JSON.parse(error.message) : error,
          };
        }
        await writeFile(
          join(task.directory, "late-admission-result.json"),
          JSON.stringify(outcome),
        );
      }
    } finally {
      client.close();
    }
  }
} finally {
  manager.close();
}
