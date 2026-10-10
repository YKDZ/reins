import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createWorkspaceClient } from "@reins/client";
import { consumerContextSchema } from "@reins/protocol";
import { createUnixSocketClient } from "@reins/transport";
import {
  workspaceErrorSchema,
  type WorkspaceMessage,
  type WorkspaceMethod,
  type WorkspaceParams,
} from "@reins/workspace-protocol";
import { Command } from "commander";
import * as v from "valibot";

import { ExitError } from "./errors.ts";

export function registerWorkspaceCommands(program: Command): void {
  const workspace = program
    .command("workspace")
    .description("Prepare an existing native Git worktree");
  const invoke = async <M extends WorkspaceMethod>(
    method: M,
    params: WorkspaceParams[M],
  ) => {
    try {
      const context = v.safeParse(
        consumerContextSchema,
        process.env.REINS_CONSUMER_CONTEXT ?? "",
      );
      if (!context.success) throw { code: "consumer_context_required" };
      const stateDirectory =
        process.env.REINS_WORKSPACE_MANAGER_STATE_DIR ??
        join(
          process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
          "reins",
          "workspace-manager",
        );
      const socket =
        process.env.REINS_WORKSPACE_MANAGER_SOCKET ??
        join(stateDirectory, "manager.sock");
      const client = createWorkspaceClient(
        await connectManager(socket, stateDirectory),
        { consumerContext: context.output },
      );
      try {
        await client.initialize();
        const result = await client.request(method, params);
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } finally {
        client.close();
      }
    } catch (error) {
      const parsed = v.safeParse(workspaceErrorSchema, error);
      process.stdout.write(
        `${JSON.stringify(parsed.success ? parsed.output : { code: "manager_disconnected" })}\n`,
      );
      throw new ExitError(1, "workspace_failed");
    }
  };
  workspace
    .command("harnesses")
    .description("Discover explicit project harness bindings")
    .option("-C <path>", "native directory context")
    .action((options: { C?: string }) =>
      invoke("workspace.harnesses", {
        cwd: resolve(options.C ?? process.cwd()),
      }),
    );
  workspace
    .command("attach")
    .description(
      "Prepare explicitly selected harness bindings without starting a worker",
    )
    .option("-C <path>", "native directory context")
    .requiredOption(
      "--binding <refs...>",
      "explicit harness binding references",
    )
    .action((options: { C?: string; binding: string[] }) =>
      invoke("workspace.attach", {
        cwd: resolve(options.C ?? process.cwd()),
        bindings: options.binding,
      }),
    );
  workspace
    .command("status")
    .description("Inspect native worktree preparation facts")
    .option("-C <path>", "native directory context")
    .action((options: { C?: string }) =>
      invoke("workspace.status", { cwd: resolve(options.C ?? process.cwd()) }),
    );
  workspace
    .command("detach")
    .description("Release an environment that has no sessions")
    .option("-C <path>", "native directory context")
    .requiredOption("--session-disposition <value>", "require_none")
    .action((options: { C?: string; sessionDisposition: string }) => {
      if (options.sessionDisposition !== "require_none")
        throw new ExitError(64, "Invalid session disposition");
      return invoke("workspace.detach", {
        cwd: resolve(options.C ?? process.cwd()),
        sessionDisposition: "require_none",
      });
    });
}
async function connectManager(socket: string, stateDirectory: string) {
  try {
    return await createUnixSocketClient<WorkspaceMessage>(socket);
  } catch {
    /* 启动部署显式指定的 Manager。 */
  }
  const binary =
    process.env.REINS_WORKSPACE_MANAGER_BIN ??
    join(dirname(fileURLToPath(import.meta.url)), "reins-workspace-manager.js");
  await access(binary);
  const child = spawn(
    process.execPath,
    [
      ...process.execArgv.filter((arg) => arg.startsWith("--conditions=")),
      binary,
    ],
    {
      env: {
        ...process.env,
        REINS_WORKSPACE_MANAGER_SOCKET: socket,
        REINS_WORKSPACE_MANAGER_STATE_DIR: stateDirectory,
      },
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      return await createUnixSocketClient<WorkspaceMessage>(socket);
    } catch {
      if (
        Date.now() >= deadline ||
        child.exitCode !== null ||
        child.signalCode !== null
      )
        throw { code: "manager_disconnected" };
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
