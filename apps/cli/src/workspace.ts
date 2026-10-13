import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createWorkspaceClient, type ReinsClient } from "@reins/client";
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
import { Command, CommanderError } from "commander";
import * as v from "valibot";

import {
  parseDeclaredInput,
  usageFor,
  valueHint,
  workspaceCommandSpecs,
  type CommandSpec,
} from "./command-spec.ts";
import { ExitError, exitCodeForError, toCliError } from "./errors.ts";
import { commanderToUsageError } from "./grammar.ts";
import { printError, printResult } from "./output.ts";

export function registerWorkspaceCommands(program: Command): void {
  const workspace = program
    .command("workspace")
    .description(
      "Prepare native Git worktrees and receive explicit source inputs",
    )
    .option("--pretty", "human-readable output (default: NDJSON)");
  const nativeCwd = (path?: string) =>
    resolve(path ?? (program.opts().C as string | undefined) ?? process.cwd());
  const invoke = async <M extends WorkspaceMethod>(
    spec: CommandSpec,
    mode: "json" | "pretty",
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
        printResult(result, mode);
        if (preparation?.runtime.status === "failed")
          throw new ExitError(1, "workspace_failed");
        if (
          result !== null &&
          typeof result === "object" &&
          "state" in result &&
          result.state === "failed"
        )
          throw new ExitError(1, "copy_cleanup_failed");
      } finally {
        client.close();
      }
    } catch (error) {
      if (error instanceof ExitError) throw error;
      const cliError = toCliError(error);
      const parsed = v.safeParse(workspaceErrorSchema, error);
      if (mode === "json")
        process.stdout.write(
          `${JSON.stringify(parsed.success ? parsed.output : { code: "manager_disconnected" })}\n`,
        );
      else printError(cliError, mode, spec);
      throw new ExitError(1, cliError.code);
    }
  };
  for (const spec of workspaceCommandSpecs) {
    const leaf = spec.name.slice("workspace ".length);
    const command = workspace
      .command(leaf)
      .description(spec.description)
      .usage(usageFor(spec));
    for (const arg of spec.args) {
      command.argument(
        "variadic" in arg && arg.variadic === true
          ? `[${arg.name}...]`
          : `[${arg.name}]`,
        arg.description,
      );
    }
    for (const option of spec.options) {
      const hint = valueHint(option.kind);
      command.option(
        option.flags,
        hint === undefined || option.description.includes(hint)
          ? option.description
          : `${option.description}; ${hint}`,
      );
    }
    command.option("--pretty", "human-readable output (default: NDJSON)");
    command.action(async (...values: unknown[]) => {
      const { args, options } = unsafeCommanderCallbackInput(values);
      const mode =
        options.pretty === true ||
        workspace.opts().pretty === true ||
        program.opts().pretty === true
          ? "pretty"
          : "json";
      try {
        const parsed = parseDeclaredInput(spec, args, options);
        await runWorkspaceCommand(
          leaf,
          parsed.options,
          spec,
          mode,
          invoke,
          nativeCwd,
        );
      } catch (error) {
        if (error instanceof ExitError) throw error;
        const cliError = toCliError(
          error instanceof CommanderError
            ? commanderToUsageError(error, spec)
            : error,
        );
        printError(cliError, mode, spec);
        throw new ExitError(exitCodeForError(cliError), cliError.code);
      }
    });
  }
}

function unsafeCommanderCallbackInput(values: readonly unknown[]): {
  readonly args: readonly unknown[];
  readonly options: Record<string, unknown>;
} {
  return {
    args: values.slice(0, -2),
    options: values.at(-2) as Record<string, unknown>,
  };
}

async function runWorkspaceCommand(
  name: string,
  options: Record<string, unknown>,
  spec: CommandSpec,
  mode: "json" | "pretty",
  invoke: <M extends WorkspaceMethod>(
    spec: CommandSpec,
    mode: "json" | "pretty",
    method: M,
    input: WorkspaceParams[M] | (() => Promise<WorkspaceParams[M]>),
    operation?: (
      client: ReturnType<typeof createWorkspaceClient>,
    ) => Promise<unknown>,
  ) => Promise<void>,
  nativeCwd: (path?: string) => string,
): Promise<void> {
  const option = <T>(field: string) => options[field] as T;
  switch (name) {
    case "handoff": {
      const repository = resolve(option<string>("repository"));
      const commit = option<string>("commit");
      const indexFile = option<string[] | undefined>("indexFile");
      const worktreeFile = option<string[] | undefined>("worktreeFile");
      return invoke(spec, mode, "workspace.handoff", async () => ({
        material:
          indexFile === undefined && worktreeFile === undefined
            ? await captureFixedCommit(repository, commit)
            : await captureSelectedWorkingFiles(repository, commit, [
                ...(indexFile ?? []).map((path) => ({
                  path,
                  source: "index" as const,
                })),
                ...(worktreeFile ?? []).map((path) => ({
                  path,
                  source: "worktree" as const,
                })),
              ]),
        subdirectory: option<string>("subdirectory"),
        bindings: option<string[]>("binding"),
      }));
    }
    case "harnesses":
      return invoke(spec, mode, "workspace.harnesses", {
        cwd: nativeCwd(option<string | undefined>("C")),
      });
    case "attach":
      return invoke(spec, mode, "workspace.attach", {
        cwd: nativeCwd(option<string | undefined>("C")),
        bindings: option<string[]>("binding"),
      });
    case "status":
      return invoke(spec, mode, "workspace.status", {
        cwd: nativeCwd(option<string | undefined>("C")),
      });
    case "detach":
      return invoke(spec, mode, "workspace.detach", {
        cwd: nativeCwd(option<string | undefined>("C")),
        sessionDisposition: option<"require_none" | "kill">(
          "sessionDisposition",
        ),
      });
    default:
      throw new Error(`Unhandled workspace command: ${name}`);
  }
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
