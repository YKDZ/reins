import { statSync } from "node:fs";
import { resolve } from "node:path";

import {
  createReinsClient,
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
import { consumerContextSchema } from "@reins/protocol";
import * as v from "valibot";

import { runAttach } from "./attach.ts";
import { CapabilityStore } from "./capabilities.ts";
import type {
  CommandInvocation,
  CommandInvocationFor,
  CommandName,
} from "./command-spec.ts";
import { ensureDaemon } from "./daemon.ts";
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

// 握手属于"daemon 可用"判定的一部分，与 ensureDaemon 的 5s 就绪预算同源。
const HANDSHAKE_TIMEOUT_MS = 5_000;

async function withClient<T>(
  mode: OutputMode,
  run: (client: ReinsClient) => Promise<T>,
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
  const { connection } = await ensureDaemon(process.env);
  const client = createReinsClient(connection, {
    consumerContext: consumerContext.output,
  });
  try {
    const handshake = await client.initialize(HANDSHAKE_TIMEOUT_MS);
    if ("error" in handshake) throw handshake.error;
    return await run(client);
  } finally {
    client.close();
  }
}

function requireResult<M extends ProtocolMethod>(
  response: ProtocolResponseFor<M>,
): ProtocolResult<M> {
  if ("error" in response) throw response.error;
  return response.result;
}

type WorkerOptions = CommandInvocationFor<"spawn">["options"];

function spawnParamsFromOptions(
  harness: string,
  messageParts: readonly string[],
  options: WorkerOptions,
): SpawnParams {
  const cwd = resolve(options.cwd ?? process.cwd());
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
  const params = spawnParamsFromOptions(harness, messageParts, ctx.options);
  await withClient(ctx.mode, async (client) => {
    const validation = await new CapabilityStore(client).validateSpawn(params);
    if (validation !== null) throw validation;
    const response = await client.request("spawn", params);
    printSpawnResult(requireResult(response), ctx.mode);
  });
}

async function runSend(ctx: CommandInvocationFor<"send">): Promise<void> {
  const [sessionId, messageParts] = ctx.args;
  await withClient(ctx.mode, async (client) => {
    const response = await client.request("send", {
      sessionId,
      message: messageParts.join(" "),
    });
    printSendAck(requireResult(response), ctx.mode);
  });
}

async function runWait(ctx: CommandInvocationFor<"wait">): Promise<void> {
  const [ids] = ctx.args;
  const timeoutMs = ctx.options.timeout;
  await withClient(ctx.mode, async (client) => {
    const response = await client.request(
      "wait",
      { ids: [...ids], timeoutMs },
      timeoutMs + 5000,
    );
    const result = requireResult(response);
    printWaitResult(result, ctx.mode);
    if (result.status === "timeout") throw new ExitError(EXIT_TIMEOUT);
  });
}

async function runInterrupt(
  ctx: CommandInvocationFor<"interrupt">,
): Promise<void> {
  const [ids] = ctx.args;
  await withClient(ctx.mode, async (client) => {
    const response = await client.request("interrupt", { ids: [...ids] });
    printInterruptResult(requireResult(response), ctx.mode);
  });
}

async function runKill(ctx: CommandInvocationFor<"kill">): Promise<void> {
  const [ids] = ctx.args;
  await withClient(ctx.mode, async (client) => {
    const response = await client.request("kill", { ids: [...ids] });
    printKillResult(requireResult(response), ctx.mode);
  });
}

async function runList(ctx: CommandInvocationFor<"list">): Promise<void> {
  const options = ctx.options;
  await withClient(ctx.mode, async (client) => {
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
  const [sessionId] = ctx.args;
  const params: AttachParams = {
    sessionId,
    ...(ctx.options.replay === undefined ? {} : { replay: ctx.options.replay }),
    ...(ctx.options.exitOn === undefined
      ? {}
      : { exitOn: [...ctx.options.exitOn] }),
  };
  await withClient(ctx.mode, async (client) => {
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
  await withClient(ctx.mode, async (client) => {
    const response = await client.request("diagnostics", params);
    printDiagnosticsResult(requireResult(response), ctx.mode);
  });
}

async function runCapabilities(
  ctx: CommandInvocationFor<"capabilities">,
): Promise<void> {
  await withClient(ctx.mode, async (client) => {
    const store = new CapabilityStore(client);
    printCapabilitiesResult(await store.result(), ctx.mode);
  });
}

async function runResolvePermission(
  ctx: CommandInvocationFor<"resolve-permission">,
): Promise<void> {
  const [sessionId, permissionId] = ctx.args;
  const resolution: PermissionResolution =
    ctx.options.outcome === "allow"
      ? { outcome: "allow", scope: ctx.options.scope ?? "once" }
      : ctx.options.feedback === undefined
        ? { outcome: "deny" }
        : { outcome: "deny", feedback: ctx.options.feedback };
  await withClient(ctx.mode, async (client) => {
    const response = await client.request("resolvePermission", {
      sessionId,
      permissionId,
      resolution,
    });
    printResolvePermissionAck(requireResult(response), ctx.mode);
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
    await withClient(ctx.mode, async (client) => {
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
