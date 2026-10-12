import { statSync } from "node:fs";
import { resolve } from "node:path";

import {
  parseRetryToken,
  type ProtocolResponseFor,
  type ReinsClient,
} from "@reins/client";
import type {
  AttachParams,
  DiagnosticsParams,
  ListFilter,
  PermissionResolution,
  ProtocolMethod,
  ProtocolResult,
  SpawnParams,
} from "@reins/protocol";
import {
  consumerContextSchema,
  encodePermissionHandle,
  decodeTurnHandle,
  turnHandleSchema,
  sessionIdSchema,
} from "@reins/protocol";
import * as v from "valibot";

import { connectReins } from "./application.ts";
import { runAttach } from "./attach.ts";
import { CapabilityStore } from "./capabilities.ts";
import type {
  CommandInvocation,
  CommandInvocationFor,
  CommandName,
} from "./command-spec.ts";
import { ExitError, EXIT_TIMEOUT, machineError, usageError } from "./errors.ts";
import type { OutputMode } from "./output.ts";
import {
  printCapabilitiesResult,
  printDiagnosticsResult,
  printInterruptResult,
  printKillResult,
  printListResult,
  printResolvePermissionAck,
  printSendAck,
  printSpawnResult,
  printWaitResult,
} from "./output.ts";
import { openWorkspaceControl } from "./workspace.ts";

// 启动与协议握手共享五秒就绪预算。
const DAEMON_READY_TIMEOUT_MS = 5_000;

async function withClient<T>(
  ctx: { mode: OutputMode; contextCwd?: string },
  run: (client: ReinsClient) => Promise<T>,
  executionCwd?: string,
): Promise<T> {
  // 消费者绑定由 launcher 环境显式给出；缺失或非法即在触达 daemon 前拒绝，
  // 不采用全局默认，也不把它暴露成 agent 参数。
  const consumerContext = v.safeParse(
    consumerContextSchema,
    process.env.REINS_CONSUMER_CONTEXT ?? "",
  );
  if (!consumerContext.success) {
    throw machineError({ code: "consumer_context_required" });
  }
  const usesWorkspaceControl =
    ctx.contextCwd !== undefined || !process.env.REINS_SOCKET;
  const client = usesWorkspaceControl
    ? await openWorkspaceControl(
        resolve(ctx.contextCwd ?? executionCwd ?? process.cwd()),
      )
    : await connectReins({
        consumerContext: consumerContext.output,
        env: process.env,
        timeoutMs: DAEMON_READY_TIMEOUT_MS,
      });
  try {
    if (usesWorkspaceControl) {
      const handshake = await client.initialize(DAEMON_READY_TIMEOUT_MS);
      if ("error" in handshake) throw handshake.error;
    }
    return await run(client);
  } finally {
    client.close();
  }
}

function requireResult<M extends ProtocolMethod>(
  response: ProtocolResponseFor<M>,
): import("@reins/client").ClientResult<M> {
  if ("error" in response) throw response.error;
  return response.result;
}

type WorkerOptions = CommandInvocationFor<"spawn">["options"];

function spawnParamsFromOptions(
  harness: string,
  messageParts: readonly string[],
  options: WorkerOptions,
  contextCwd?: string,
): SpawnParams {
  const cwd = resolve(options.cwd ?? contextCwd ?? process.cwd());
  let cwdIdentity: NonNullable<SpawnParams["cwdIdentity"]>;
  try {
    const directory = statSync(cwd, { bigint: true });
    if (!directory.isDirectory()) throw new Error("Not a directory");
    cwdIdentity = {
      device: String(directory.dev),
      inode: String(directory.ino),
    };
  } catch {
    throw machineError({
      code: "invalid_params",
      issues: [{ issue: "invalid_value", path: "cwd" }],
    });
  }
  const authorizationMode =
    options.authorizationMode === "interactive"
      ? ("interactive" as const)
      : options.authorizationMode === "allow-all"
        ? ("allowAll" as const)
        : undefined;
  return {
    harness,
    message: messageParts.join(" "),
    sessionName: options.name,
    ...(options.agent === undefined ? {} : { agent: options.agent }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.reasoning === undefined
      ? {}
      : { reasoning: options.reasoning }),
    cwd,
    cwdIdentity,
    ...(authorizationMode === undefined ? {} : { authorizationMode }),
    ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
    ...(options.captureHarnessStderr === true
      ? { captureHarnessStderr: true }
      : {}),
  };
}

async function runSpawn(ctx: CommandInvocationFor<"spawn">): Promise<void> {
  const [harness, messageParts] = ctx.args;
  const params = spawnParamsFromOptions(
    harness,
    messageParts,
    ctx.options,
    ctx.contextCwd,
  );
  await withClient(
    ctx,
    async (client) => {
      const validation = await new CapabilityStore(client).validateSpawn(
        params,
      );
      if (validation !== null) throw validation;
      const response = await client.request("spawn", params);
      printSpawnResult(requireResult(response), ctx.mode);
    },
    params.cwd,
  );
}

async function runSend(ctx: CommandInvocationFor<"send">): Promise<void> {
  const [target, messageParts] = ctx.args;
  const placement = ctx.options.placement;
  const parsed = v.safeParse(
    placement === "active_turn" ? turnHandleSchema : sessionIdSchema,
    target,
  );
  if (!parsed.success)
    throw usageError({
      issue: "invalid_value",
      target: "argument",
      field: "target",
      value: target,
      hint:
        placement === "active_turn"
          ? "Expected a valid TurnHandle"
          : "Expected a valid SessionHandle",
    });
  const address =
    placement === "active_turn"
      ? { placement, ...decodeTurnHandle(target) }
      : { placement, sessionId: v.parse(sessionIdSchema, target) };
  await withClient(ctx, async (client) => {
    const response = await client.request("send", {
      ...address,
      message: messageParts.join(" "),
    });
    printSendAck(requireResult(response), ctx.mode);
  });
}

async function runWait(ctx: CommandInvocationFor<"wait">): Promise<void> {
  const [targets] = ctx.args;
  const timeoutMs = ctx.options.timeout;
  await withClient(ctx, async (client) => {
    const response = await client.request("wait", {
      targets: [...targets],
      completion: ctx.options.completion,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    const result = requireResult(response);
    printWaitResult(result, ctx.mode);
    const exitCode =
      result.status === "timeout"
        ? EXIT_TIMEOUT
        : result.completed.some((turn) => turn.stopReason === "failed")
          ? 1
          : result.completed.some((turn) => turn.stopReason === "killed")
            ? 3
            : result.completed.some((turn) => turn.stopReason === "cancelled")
              ? 2
              : 0;
    if (exitCode !== 0) throw new ExitError(exitCode);
  });
}

async function runInterrupt(
  ctx: CommandInvocationFor<"interrupt">,
): Promise<void> {
  const [target] = ctx.args;
  if (!v.safeParse(turnHandleSchema, target).success)
    throw usageError({
      issue: "invalid_value",
      target: "argument",
      field: "target",
      value: target,
      hint: "Expected a valid TurnHandle",
    });
  const address = decodeTurnHandle(target);
  await withClient(ctx, async (client) => {
    const response = await client.request("interrupt", address);
    printInterruptResult(requireResult(response), ctx.mode);
  });
}

async function runKill(ctx: CommandInvocationFor<"kill">): Promise<void> {
  const [sessionId] = ctx.args;
  await withClient(ctx, async (client) => {
    const response = await client.request("kill", { sessionId });
    printKillResult(requireResult(response), ctx.mode);
  });
}

async function runList(ctx: CommandInvocationFor<"list">): Promise<void> {
  const options = ctx.options;
  await withClient(ctx, async (client) => {
    const params: ListFilter = {
      ...(options.session === undefined ? {} : { sessionId: options.session }),
      ...(options.harness === undefined ? {} : { harness: options.harness }),
      ...(options.state === undefined ? {} : { state: options.state }),
      ...(options.name === undefined ? {} : { sessionName: options.name }),
      ...(options.model === undefined ? {} : { model: options.model }),
    };
    const response = await client.request("list", params);
    printListResult(requireResult(response), ctx.mode);
  });
}

async function runAttachCommand(
  ctx: CommandInvocationFor<"attach">,
): Promise<void> {
  const [target] = ctx.args;
  if (ctx.options.replay === "after" && ctx.options.cursor === undefined)
    throw usageError({
      issue: "missing_argument",
      target: "option",
      field: "--cursor",
      hint: "after requires a complete ResumeCursor from interrupted attach",
    });
  if (ctx.options.replay !== "after" && ctx.options.cursor !== undefined)
    throw usageError({
      issue: "invalid_combination",
      field: "--cursor",
      hint: "--cursor is only accepted with --replay after",
    });
  const replay: AttachParams["replay"] =
    ctx.options.replay === "after"
      ? { mode: "after", cursor: ctx.options.cursor! }
      : { mode: ctx.options.replay };
  let params: AttachParams;
  try {
    params =
      ctx.options.scope === "turn"
        ? {
            scope: "turn",
            ...decodeTurnHandle(target),
            replay,
          }
        : {
            scope: "session",
            sessionId: v.parse(sessionIdSchema, target),
            replay,
          };
  } catch {
    throw usageError({
      issue: "invalid_value",
      field: "target",
      value: target,
      hint: "Expected a complete handle for the selected scope",
    });
  }
  await withClient(ctx, async (client) => {
    await runAttach(client, { params, mode: ctx.mode });
  });
}

async function runDiagnostics(
  ctx: CommandInvocationFor<"diagnostics">,
): Promise<void> {
  const options = ctx.options;
  const filters = {
    ...(options.harness === undefined ? {} : { harness: options.harness }),
    ...(options.source === undefined ? {} : { sources: [...options.source] }),
    ...(options.kind === undefined ? {} : { kinds: [...options.kind] }),
    ...(options.minSeverity === undefined
      ? {}
      : { minSeverity: options.minSeverity }),
    ...(options.since === undefined ? {} : { since: options.since }),
    ...(options.until === undefined ? {} : { until: options.until }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  };
  let params: DiagnosticsParams;
  if (options.id !== undefined) {
    params = { diagnosticId: options.id };
  } else if (options.turn === undefined) {
    params = {
      ...filters,
      ...(options.session === undefined ? {} : { sessionId: options.session }),
    };
  } else {
    if (options.session === undefined) {
      throw new Error("Validated diagnostic turn filter is missing session");
    }
    params = {
      ...filters,
      sessionId: options.session,
      turnId: options.turn,
    };
  }
  await withClient(ctx, async (client) => {
    const response = await client.request("diagnostics", params);
    printDiagnosticsResult(requireResult(response), ctx.mode);
  });
}

async function runCapabilities(
  ctx: CommandInvocationFor<"capabilities">,
): Promise<void> {
  await withClient(ctx, async (client) => {
    const store = new CapabilityStore(client);
    printCapabilitiesResult(await store.result(), ctx.mode);
  });
}

async function runResolvePermission(
  ctx: CommandInvocationFor<"resolve-permission">,
): Promise<void> {
  const [target] = ctx.args;
  const resolution: PermissionResolution =
    ctx.options.outcome === "allow"
      ? { outcome: "allow", scope: ctx.options.scope ?? "once" }
      : ctx.options.feedback === undefined
        ? { outcome: "deny" }
        : { outcome: "deny", feedback: ctx.options.feedback };
  await withClient(ctx, async (client) => {
    const response = await client.request("resolvePermission", {
      ...target,
      resolution,
    });
    requireResult(response);
    if (ctx.mode === "json")
      process.stdout.write(
        JSON.stringify({
          permissionHandle: encodePermissionHandle(target),
          status: "resolved",
        }) + "\n",
      );
    else process.stdout.write("Permission resolved\n");
  });
}

type HandlerMap = {
  readonly [N in CommandName]: (
    invocation: CommandInvocationFor<N>,
  ) => Promise<void>;
};

export const handlers = {
  retry: async (ctx: CommandInvocationFor<"retry">) => {
    const [token] = ctx.args;
    let identity: ReturnType<typeof parseRetryToken>;
    try {
      identity = parseRetryToken(token);
    } catch {
      throw usageError({
        issue: "invalid_value",
        field: "token",
        hint: "Use the RetryToken from command_outcome_unknown",
      });
    }
    await withClient(ctx, async (client) => {
      const response = await client.retry(token, ctx.options.params);
      const result = requireResult(response);
      {
        // 恢复保留原方法的输出；不显示内部命令身份。
        switch (identity.method) {
          case "spawn":
            printSpawnResult(result as ProtocolResult<"spawn">, ctx.mode);
            break;
          case "send":
            printSendAck(result as ProtocolResult<"send">, ctx.mode);
            break;
          case "interrupt":
            printInterruptResult(
              result as ProtocolResult<"interrupt">,
              ctx.mode,
            );
            break;
          case "kill":
            printKillResult(result as ProtocolResult<"kill">, ctx.mode);
            break;
          case "resolvePermission":
            printResolvePermissionAck(
              result as ProtocolResult<"resolvePermission">,
              ctx.mode,
            );
            break;
        }
      }
    });
  },
  spawn: runSpawn,
  send: runSend,
  wait: runWait,
  interrupt: runInterrupt,
  kill: runKill,
  list: runList,
  attach: runAttachCommand,
  diagnostics: runDiagnostics,
  capabilities: runCapabilities,
  "resolve-permission": runResolvePermission,
} satisfies HandlerMap;

export async function dispatchInvocation(
  invocation: CommandInvocation,
): Promise<void> {
  switch (invocation.command) {
    case "retry":
      return handlers.retry(invocation);
    case "spawn":
      return handlers.spawn(invocation);
    case "send":
      return handlers.send(invocation);
    case "wait":
      return handlers.wait(invocation);
    case "interrupt":
      return handlers.interrupt(invocation);
    case "kill":
      return handlers.kill(invocation);
    case "list":
      return handlers.list(invocation);
    case "attach":
      return handlers.attach(invocation);
    case "diagnostics":
      return handlers.diagnostics(invocation);
    case "capabilities":
      return handlers.capabilities(invocation);
    case "resolve-permission":
      return handlers["resolve-permission"](invocation);
    default:
      return assertNever(invocation);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled command invocation: ${String(value)}`);
}
