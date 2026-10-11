import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createWorkspaceClient,
  projectWorkspaceHistory,
  type ReinsClient,
} from "@reins/client";
import { consumerContextSchema } from "@reins/protocol";
import { createUnixSocketClient } from "@reins/transport";
import {
  workspaceErrorSchema,
  type WorkspaceMessage,
  type WorkspaceMethod,
  type WorkspaceParams,
  type WorkspaceResults,
  type ManagedWorkspaceInfo,
} from "@reins/workspace-protocol";
import {
  captureFixedCommit,
  captureSelectedWorkingFiles,
} from "@reins/workspace-source";
import { Command } from "commander";
import * as v from "valibot";

import { ExitError } from "./errors.ts";

export function registerWorkspaceCommands(program: Command): void {
  const workspace = program
    .command("workspace")
    .description(
      "Prepare native Git worktrees and receive explicit source inputs",
    );
  const nativeCwd = (path?: string) =>
    resolve(path ?? (program.opts().C as string | undefined) ?? process.cwd());
  const invoke = async <M extends WorkspaceMethod>(
    method: M,
    input: WorkspaceParams[M] | (() => Promise<WorkspaceParams[M]>),
    operation?: (
      client: ReturnType<typeof createWorkspaceClient>,
    ) => Promise<unknown>,
  ) => {
    try {
      const params = typeof input === "function" ? await input() : input;
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
        let result =
          operation === undefined
            ? await client.request(method, params)
            : await operation(client);
        let preparation: ManagedWorkspaceInfo | undefined;
        // CLI 等待被受理的准备；handoff 的目标 cwd 来自物化结果。
        if (method === "workspace.attach" || method === "workspace.handoff") {
          preparation =
            method === "workspace.handoff"
              ? (result as WorkspaceResults["workspace.handoff"]).workspace
              : (result as ManagedWorkspaceInfo);
          while (preparation.runtime.status === "preparing") {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            try {
              preparation = await client.request("workspace.status", {
                cwd: preparation.cwd,
              });
            } catch (error) {
              const parsed = v.safeParse(workspaceErrorSchema, error);
              if (!parsed.success || parsed.output.code !== "manager_timeout")
                throw error;
            }
          }
          result =
            method === "workspace.handoff"
              ? {
                  ...(result as WorkspaceResults["workspace.handoff"]),
                  workspace: preparation,
                }
              : preparation;
        }
        process.stdout.write(
          `${JSON.stringify(method === "workspace.history" ? projectWorkspaceHistory(result as WorkspaceResults["workspace.history"]) : result)}\n`,
        );
        if (preparation?.runtime.status === "failed")
          throw new ExitError(1, "workspace_failed");
      } finally {
        client.close();
      }
    } catch (error) {
      if (error instanceof ExitError) throw error;
      const parsed = v.safeParse(workspaceErrorSchema, error);
      process.stdout.write(
        `${JSON.stringify(parsed.success ? parsed.output : { code: "manager_disconnected" })}\n`,
      );
      throw new ExitError(1, "workspace_failed");
    }
  };
  workspace
    .command("import-git")
    .description(
      "Import a published Git bundle into a new reference without checkout or merge",
    )
    .argument("<publication>")
    .requiredOption("--repository <path>", "target Git repository")
    .requiredOption("--ref <reference>", "new fully qualified Git reference")
    .requiredOption(
      "--commit <object>",
      "full commit object name advertised by the bundle",
    )
    .action(
      (
        publicationId: string,
        options: { repository: string; ref: string; commit: string },
      ) =>
        invoke("publication.read", { publicationId }, (client) =>
          client.importGitPublication(publicationId, {
            repository: resolve(options.repository),
            reference: options.ref,
            commit: options.commit,
          }),
        ),
    );
  workspace
    .command("publications")
    .description("Query files explicitly published from this worktree")
    .option("-C <path>", "native directory context")
    .action((options: { C?: string }) =>
      invoke("publication.list", { cwd: nativeCwd(options.C) }),
    );
  workspace
    .command("receive")
    .description(
      "Explicitly receive one fixed publication outside the active tree",
    )
    .argument("<publication>")
    .requiredOption("--directory <path>", "local receipt directory")
    .requiredOption("--active-root <path>", "active Git worktree root")
    .action(
      (
        publicationId: string,
        options: { directory: string; activeRoot: string },
      ) =>
        invoke("publication.read", { publicationId }, (client) =>
          client.receivePublication(publicationId, {
            directory: resolve(options.directory),
            activeRoot: resolve(options.activeRoot),
          }),
        ),
    );
  workspace
    .command("receipts")
    .description(
      "List this consumer's received files, sources and actual locations",
    )
    .requiredOption("--directory <path>", "local receipt directory")
    .action((options: { directory: string }) =>
      invoke("publication.list", { cwd: nativeCwd() }, (client) =>
        client.receipts(resolve(options.directory)),
      ),
    );
  workspace
    .command("handoff")
    .description(
      "Transfer a fixed commit and explicitly selected files to a new Git worktree",
    )
    .requiredOption("--repository <path>", "one caller-native Git root")
    .requiredOption("--commit <sha>", "full fixed commit object name")
    .requiredOption(
      "--subdirectory <path>",
      "relative target working directory",
    )
    .requiredOption(
      "--binding <refs...>",
      "explicit harness binding references",
    )
    .option(
      "--index-file <paths...>",
      "explicit repository-relative staged file versions",
    )
    .option(
      "--worktree-file <paths...>",
      "explicit repository-relative working file versions",
    )
    .action(
      async (options: {
        indexFile?: string[];
        worktreeFile?: string[];
        repository: string;
        commit: string;
        subdirectory: string;
        binding: string[];
      }) =>
        invoke("workspace.handoff", async () => ({
          material:
            options.indexFile === undefined &&
            options.worktreeFile === undefined
              ? await captureFixedCommit(
                  resolve(options.repository),
                  options.commit,
                )
              : await captureSelectedWorkingFiles(
                  resolve(options.repository),
                  options.commit,
                  [
                    ...(options.indexFile ?? []).map((path) => ({
                      path,
                      source: "index" as const,
                    })),
                    ...(options.worktreeFile ?? []).map((path) => ({
                      path,
                      source: "worktree" as const,
                    })),
                  ],
                ),
          subdirectory: options.subdirectory,
          bindings: options.binding,
        })),
    );
  workspace
    .command("harnesses")
    .description("Discover explicit project harness bindings")
    .option("-C <path>", "native directory context")
    .action((options: { C?: string }) =>
      invoke("workspace.harnesses", {
        cwd: nativeCwd(options.C),
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
        cwd: nativeCwd(options.C),
        bindings: options.binding,
      }),
    );
  workspace
    .command("history")
    .description("Query durable consumed events across worktree attachments")
    .option("-C <path>", "native directory context")
    .option("--all-worktrees", "query this consumer's worktrees")
    .action((options: { C?: string; allWorktrees?: boolean }) =>
      invoke("workspace.history", {
        cwd: nativeCwd(options.C),
        ...(options.allWorktrees === undefined
          ? {}
          : { allWorktrees: options.allWorktrees }),
      }),
    );
  workspace
    .command("status")
    .description("Inspect native worktree preparation facts")
    .option("-C <path>", "native directory context")
    .action((options: { C?: string }) =>
      invoke("workspace.status", { cwd: nativeCwd(options.C) }),
    );
  workspace
    .command("detach")
    .description("Release an environment with an explicit session disposition")
    .option("-C <path>", "native directory context")
    .requiredOption("--session-disposition <value>", "require_none or kill")
    .action((options: { C?: string; sessionDisposition: string }) => {
      if (
        options.sessionDisposition !== "require_none" &&
        options.sessionDisposition !== "kill"
      )
        throw new ExitError(64, "Invalid session disposition");
      return invoke("workspace.detach", {
        cwd: nativeCwd(options.C),
        sessionDisposition: options.sessionDisposition,
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

export async function openWorkspaceControl(cwd: string): Promise<ReinsClient> {
  const context = v.parse(
    consumerContextSchema,
    process.env.REINS_CONSUMER_CONTEXT ?? "",
  );
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
  const manager = createWorkspaceClient(
    await connectManager(socket, stateDirectory),
    { consumerContext: context },
  );
  try {
    await manager.initialize();
    const client = await manager.control(cwd);
    return {
      ...client,
      close() {
        client.close();
        manager.close();
      },
    };
  } catch (error) {
    manager.close();
    throw error;
  }
}
