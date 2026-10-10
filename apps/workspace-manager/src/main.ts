#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
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
} from "@reins/workspace-runtime";
import lockfile from "proper-lockfile";
import * as v from "valibot";

async function main() {
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
    runtime = await openWorkspaceRuntime({
      stateDirectory,
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
  const stop = () => {
    stopping ??= (async () => {
      clearTimeout(idle);
      runtime.close();
      await transport.close();
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
      const parsed = v.safeParse(workspaceRequestSchema, event.message);
      if (!parsed.success) {
        connection.close();
        return;
      }
      const request = parsed.output;
      void (async () => {
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
            return workspaceHarnesses(request.params.cwd);
          case "workspace.attach":
            return runtime.attach(
              request.params.cwd,
              request.params.bindings,
              consumer,
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
function normalizeError(error: unknown): WorkspaceError {
  const parsed = v.safeParse(workspaceErrorSchema, error);
  return parsed.success ? parsed.output : workspaceFailure("provider_failed");
}
void main().catch((error: unknown) => {
  console.error("Workspace Manager failed to start", error);
  process.exitCode = 1;
});
