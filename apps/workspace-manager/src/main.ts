#!/usr/bin/env node
import { lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname } from "node:path";

import type { ConsumerContext } from "@reins/protocol";
import { createUnixSocketServer } from "@reins/transport";
import {
  WORKSPACE_PROTOCOL_MAJOR_VERSION,
  workspaceRequestSchema,
  workspaceErrorSchema,
  type WorkspaceMessage,
  type WorkspaceError,
} from "@reins/workspace-protocol";
import {
  workspaceHarnesses,
  workspaceFailure,
  openWorkspaceRuntime,
  parseCodexAuthBindings,
  parseQoderAuthBindings,
} from "@reins/workspace-runtime";
import lockfile from "proper-lockfile";
import * as v from "valibot";

async function main() {
  const codexAuthBindings = parseCodexAuthBindings(
    process.env.REINS_CODEX_AUTH_BINDINGS,
  );
  const qoderAuthBindings = parseQoderAuthBindings(
    process.env.REINS_QODER_AUTH_BINDINGS,
  );
  const socket = process.env.REINS_WORKSPACE_MANAGER_SOCKET;
  if (socket === undefined)
    throw new Error("REINS_WORKSPACE_MANAGER_SOCKET is required");
  const stateDirectory = process.env.REINS_WORKSPACE_MANAGER_STATE_DIR;
  if (stateDirectory === undefined)
    throw new Error("REINS_WORKSPACE_MANAGER_STATE_DIR is required");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await mkdir(dirname(socket), { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(stateDirectory);
  let runtime: Awaited<ReturnType<typeof openWorkspaceRuntime>>;
  try {
    await removeStaleSocket(socket);
    runtime = await openWorkspaceRuntime({
      stateDirectory,
      codexAuthBindings,
      qoderAuthBindings,
      ...(process.env.REINS_WORKSPACE_RESOURCE_PREFIX === undefined
        ? {}
        : { resourcePrefix: process.env.REINS_WORKSPACE_RESOURCE_PREFIX }),
    });
  } catch (error) {
    await release();
    throw error;
  }
  const transport = createUnixSocketServer<WorkspaceMessage>({ path: socket });
  let connections = 0;
  let idle: NodeJS.Timeout | undefined;
  let stopping: Promise<void> | undefined;
  const requests = new Set<Promise<void>>();
  const stop = () => {
    stopping ??= (async () => {
      clearTimeout(idle);
      await transport.close();
      await Promise.all(requests);
      await runtime.close();
      await release();
    })();
    return stopping;
  };
  const scheduleIdle = () => {
    if (connections !== 0 || runtime.hasAttachments()) return;
    idle = setTimeout(() => {
      void stop();
    }, 1000);
  };
  transport.onConnection((connection) => {
    if (stopping !== undefined) {
      connection.close();
      return;
    }
    connections += 1;
    clearTimeout(idle);
    let consumer: ConsumerContext | undefined;
    const send = (message: WorkspaceMessage) => {
      try {
        connection.send(message);
      } catch {
        connection.close();
      }
    };
    connection.onEvent((event) => {
      if (event.kind !== "message") {
        if (event.kind === "closed") {
          connections -= 1;
          scheduleIdle();
        }
        return;
      }
      if (stopping !== undefined) {
        connection.close();
        return;
      }
      const parsed = v.safeParse(workspaceRequestSchema, event.message);
      if (!parsed.success) {
        const message: unknown = event.message;
        if (
          typeof message === "object" &&
          message !== null &&
          "requestId" in message &&
          typeof message.requestId === "string"
        )
          send({
            kind: "response",
            requestId: message.requestId,
            error: workspaceFailure("invalid_request"),
          });
        else connection.close();
        return;
      }
      const request = parsed.output;
      const operation = (async () => {
        if (request.method === "initialize") {
          if (
            request.params.protocolMajorVersion !==
            WORKSPACE_PROTOCOL_MAJOR_VERSION
          )
            throw workspaceFailure("protocol_version_mismatch");
          if (
            consumer !== undefined &&
            consumer !== request.params.consumerContext
          )
            throw workspaceFailure("consumer_context_conflict");
          consumer = request.params.consumerContext;
          return { protocolMajorVersion: WORKSPACE_PROTOCOL_MAJOR_VERSION };
        }
        if (consumer === undefined)
          throw workspaceFailure("initialization_required");
        switch (request.method) {
          case "workspace.harnesses":
            return workspaceHarnesses(
              request.params.cwd,
              codexAuthBindings,
              qoderAuthBindings,
            );
          case "workspace.attach":
            return runtime.attach(
              request.params.cwd,
              request.params.bindings,
              consumer,
            );
          case "workspace.route":
            return runtime.route(request.params.cwd, consumer);
          case "workspace.admit":
            return runtime.admit(
              request.params.cwd,
              consumer,
              request.params.action,
              request.params.params,
            );
          case "workspace.status":
            return runtime.status(request.params.cwd, consumer);
          case "workspace.detach":
            return runtime.detach(request.params.cwd, consumer);
        }
      })().then(
        (result) =>
          send({ kind: "response", requestId: request.requestId, result }),
        (error: unknown) =>
          send({
            kind: "response",
            requestId: request.requestId,
            error: normalizeError(error),
          }),
      );
      requests.add(operation);
      void operation.finally(() => requests.delete(operation));
    });
  });
  process.on("SIGTERM", () => {
    void stop();
  });
  process.on("SIGINT", () => {
    void stop();
  });
  try {
    await transport.listen();
    scheduleIdle();
  } catch (error) {
    await stop();
    throw error;
  }
}
// 同 state 的独占 lease 已取得；只移除失主留下且无法连接的 Unix socket。
async function removeStaleSocket(path: string): Promise<void> {
  try {
    if (!(await lstat(path)).isSocket())
      throw new Error("Workspace Manager socket path is not a socket");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const stale = await new Promise<boolean>((resolve, reject) => {
    const connection = createConnection(path);
    connection.once("connect", () => {
      connection.destroy();
      resolve(false);
    });
    connection.once("error", (error: NodeJS.ErrnoException) => {
      connection.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT")
        resolve(true);
      else reject(error);
    });
  });
  if (!stale) throw new Error("Workspace Manager socket is already in use");
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
function normalizeError(error: unknown): WorkspaceError {
  const parsed = v.safeParse(workspaceErrorSchema, error);
  return parsed.success ? parsed.output : workspaceFailure("provider_failed");
}
void main().catch((error: unknown) => {
  console.error("Workspace Manager failed to start", error);
  process.exitCode = 1;
});
