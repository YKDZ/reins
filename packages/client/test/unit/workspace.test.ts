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

test("keeps known wait and subscription end facts when publication discovery fails", async () => {
  const directory = await mkdtemp(
    join(
      process.platform === "linux" ? "/dev/shm" : tmpdir(),
      "reins-wrr27-client-",
    ),
  );
  const socket = join(directory, "daemon.sock");
  const daemon = createUnixSocketServer<
    import("@reins/protocol").ProtocolMessage
  >({ path: socket });
  const wire = createInMemoryTransportPair<WorkspaceMessage>();
  const manager = createWorkspaceClient(wire.client, {
    consumerContext: "alpha" as never,
  });
  const target = { sessionId: "reader@gab12cd", turnId: "t1" } as const;
  const completed = {
    ...target,
    stopReason: "end_turn",
    finalReply: "known worker reply",
  };
  wire.server.onEvent((event) => {
    if (event.kind !== "message" || event.message.kind !== "request") return;
    const request = event.message;
    if (request.method === "publication.list") {
      wire.server.send({
        kind: "response",
        requestId: request.requestId,
        error: { code: "publication_not_found" },
      });
      return;
    }
    const result =
      request.method === "initialize"
        ? { protocolMajorVersion: 1 }
        : request.method === "workspace.route"
          ? { cwd: "/project", socket }
          : request.method === "publication.observe"
            ? []
            : request.method === "publication.unobserve"
              ? null
              : { cwd: "/project" };
    wire.server.send({
      kind: "response",
      requestId: request.requestId,
      result,
    });
  });
  // 公开 wire 合同的受控后端只构造查询失败；真实worker与保存事实由Docker场景覆盖。
  daemon.onConnection((connection) =>
    connection.onEvent((event) => {
      if (event.kind !== "message" || event.message.kind !== "request") return;
      const request = event.message;
      if (request.method === "initialize")
        connection.send({
          kind: "response",
          requestId: request.requestId,
          result: {
            protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
            daemonGeneration: "ab12cd",
          },
        });
      if (request.method === "wait")
        connection.send({
          kind: "response",
          requestId: request.requestId,
          result: { status: "satisfied", completed: [completed], pending: [] },
        });
      if (request.method === "attach") {
        const attached = {
          sessionId: target.sessionId,
          subscriptionId: "sub-1",
          target: { scope: "turn", ...target },
          window: { oldest: 1, head: 1, truncated: false },
          replayed: 0,
        };
        connection.send({
          kind: "response",
          requestId: request.requestId,
          result: attached,
        });
        connection.send({
          kind: "notification",
          method: "attach.ended",
          params: {
            sessionId: target.sessionId,
            subscriptionId: "sub-1",
            target: attached.target,
            lastEventId: 1,
            reason: "end_turn",
          },
        } as never);
      }
    }),
  );
  await daemon.listen();
  let client: Awaited<ReturnType<typeof manager.control>> | undefined;
  try {
    await manager.initialize();
    client = await manager.control("/project");
    await client.initialize();
    const outcomes = await Promise.allSettled([
      client.request("wait", { targets: [target], completion: "all" } as never),
      client
        .subscribe({
          scope: "turn",
          ...target,
          replay: { mode: "none" },
        } as never)
        .then((subscription) => subscription.done),
    ]);
    expect(outcomes).toMatchObject([
      {
        status: "fulfilled",
        value: {
          result: {
            status: "satisfied",
            completed: [completed],
            pending: [],
            publicationError: { code: "publication_not_found" },
          },
        },
      },
      {
        status: "fulfilled",
        value: {
          reason: "end_turn",
          lastEventId: 1,
          publicationError: { code: "publication_not_found" },
        },
      },
    ]);
  } finally {
    client?.close();
    manager.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
});
