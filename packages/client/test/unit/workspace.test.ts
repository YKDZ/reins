import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  REINS_PROTOCOL_MAJOR_VERSION,
  spawnParamsSchema,
} from "@reins/protocol";
import {
  createInMemoryTransportPair,
  createUnixSocketServer,
} from "@reins/transport";
import type { WorkspaceMessage } from "@reins/workspace-protocol";
import * as v from "valibot";
import { expect, test } from "vitest";

import { createWorkspaceClient } from "../../src/index.ts";

test("managed retry restores hidden spawn directory facts before admission and preserves the original command", async () => {
  const directory = await mkdtemp(
    join(
      process.platform === "linux" ? "/dev/shm" : tmpdir(),
      "reins-wrr08-client-",
    ),
  );
  const socket = join(directory, "daemon.sock");
  const daemon = createUnixSocketServer({ path: socket });
  const managerWire = createInMemoryTransportPair<WorkspaceMessage>();
  const manager = createWorkspaceClient(managerWire.client, {
    consumerContext: "alpha" as never,
  });
  const original = {
    harness: "codex",
    sessionName: "reader",
    message: "private caller message",
    cwd: "/caller/project/src",
    cwdIdentity: { device: "43", inode: "9876" },
  };
  const caller = {
    harness: original.harness,
    sessionName: original.sessionName,
    message: original.message,
  };
  const admitted: unknown[] = [];
  const delivered: Array<{ commandId: unknown; params: unknown }> = [];
  let initialObserved!: () => void;
  const initial = new Promise<void>((resolve) => {
    initialObserved = resolve;
  });
  managerWire.server.onEvent((event) => {
    if (event.kind !== "message" || event.message.kind !== "request") return;
    const request = event.message;
    if (request.method === "initialize") {
      managerWire.server.send({
        kind: "response",
        requestId: request.requestId,
        result: { protocolMajorVersion: 1 },
      });
    } else if (request.method === "workspace.route") {
      managerWire.server.send({
        kind: "response",
        requestId: request.requestId,
        result: { cwd: original.cwd, socket },
      });
    } else if (request.method === "workspace.admit") {
      if (request.params.action === "spawn") {
        admitted.push(request.params.params);
        if (!v.safeParse(spawnParamsSchema, request.params.params).success) {
          managerWire.server.send({
            kind: "response",
            requestId: request.requestId,
            error: { code: "invalid_request" },
          });
          return;
        }
      }
      managerWire.server.send({
        kind: "response",
        requestId: request.requestId,
        result: { cwd: original.cwd },
      });
    }
  });
  // 这里只验证公开客户端的 wire 契约；真实准备、worker 与副作用另由 Docker 场景证明。
  daemon.onConnection((connection) =>
    connection.onEvent((event) => {
      if (event.kind !== "message") return;
      const request = event.message as {
        kind: string;
        method: string;
        requestId: string;
        commandId?: unknown;
        params: unknown;
      };
      if (request.kind !== "request") return;
      if (request.method === "initialize")
        connection.send({
          kind: "response",
          requestId: request.requestId,
          result: {
            protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
            daemonGeneration: "ab12cd",
          },
        });
      if (request.method === "spawn") {
        delivered.push({
          commandId: request.commandId,
          params: request.params,
        });
        if (delivered.length === 1) initialObserved();
        else
          connection.send({
            kind: "response",
            requestId: request.requestId,
            result: {
              sessionId: "reader@gab12cd",
              turnId: "t1",
              cwd: original.cwd,
            },
          });
      }
    }),
  );
  await daemon.listen();
  let client: Awaited<ReturnType<typeof manager.control>> | undefined;
  try {
    await manager.initialize();
    client = await manager.control(original.cwd);
    await client.initialize();
    let token = "";
    await expect(
      client.request("spawn", original as never, 0),
    ).rejects.toSatisfy((error: Error) => {
      const unknown = JSON.parse(error.message) as {
        code: string;
        retryToken: string;
      };
      expect(unknown.code).toBe("command_outcome_unknown");
      token = unknown.retryToken;
      return true;
    });
    await initial;
    await expect(client.retry(token, caller)).resolves.toMatchObject({
      result: { cwd: original.cwd },
    });
    expect(admitted).toEqual([original, original]);
    expect(delivered).toEqual([
      { commandId: expect.any(String), params: original },
      { commandId: delivered[0]!.commandId, params: original },
    ]);
  } finally {
    client?.close();
    manager.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
});
