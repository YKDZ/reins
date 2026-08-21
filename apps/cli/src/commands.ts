import type {
  AttachParams,
  DiagnosticsParams,
  ListFilter,
  PermissionResolution,
  ProtocolMethod,
  ProtocolResult,
  SpawnParams,
} from "@reins/protocol";

import { runAndWait, runAttach } from "./attach.ts";
import { CapabilityStore } from "./capabilities.ts";
import {
  createReinsClient,
  type ProtocolResponseFor,
  type ReinsClient,
} from "./client.ts";
import type {
  CommandInvocation,
  CommandInvocationFor,
  CommandName,
} from "./command-spec.ts";
import { ensureDaemon } from "./daemon.ts";
import { ExitError, EXIT_TIMEOUT } from "./errors.ts";
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

async function withClient<T>(
  mode: OutputMode,
  run: (client: ReinsClient) => Promise<T>,
): Promise<T> {
  const { connection } = await ensureDaemon(process.env);
  const client = createReinsClient(connection);
  try {
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

type WorkerOptions =
  | CommandInvocationFor<"spawn">["options"]
  | CommandInvocationFor<"run">["options"];

function spawnParamsFromOptions(
  harness: string,
  messageParts: readonly string[],
  options: WorkerOptions,
): SpawnParams {
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
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(authorizationMode === undefined ? {} : { authorizationMode }),
    ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
    ...(options.captureHarnessStderr === true
      ? { captureHarnessStderr: true }
      : {}),
    ...("meta" in options && options.meta !== undefined
      ? { meta: options.meta }
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

async function runRun(ctx: CommandInvocationFor<"run">): Promise<void> {
  const [harness, messageParts] = ctx.args;
  const params = spawnParamsFromOptions(harness, messageParts, ctx.options);
  await withClient(ctx.mode, async (client) => {
    const validation = await new CapabilityStore(client).validateSpawn(params);
    if (validation !== null) throw validation;
    await runAndWait(client, { spawn: params, mode: ctx.mode });
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
  spawn: runSpawn,
  send: runSend,
  wait: runWait,
  interrupt: runInterrupt,
  kill: runKill,
  list: runList,
  attach: runAttachCommand,
  run: runRun,
  diagnostics: runDiagnostics,
  capabilities: runCapabilities,
  "resolve-permission": runResolvePermission,
} satisfies HandlerMap;

export async function dispatchInvocation(
  invocation: CommandInvocation,
): Promise<void> {
  switch (invocation.command) {
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
    case "run":
      return handlers.run(invocation);
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
