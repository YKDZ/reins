import { resolve } from "node:path";

import {
  parseRetryToken,
  type ProtocolResponseFor,
  type ReinsClient,
} from "@reins/client";
import type {
  DiagnosticsParams,
  PermissionResolution,
  ProtocolMethod,
  ProtocolResult,
} from "@reins/protocol";
import { consumerContextSchema, encodePermissionHandle } from "@reins/protocol";
import * as v from "valibot";

import { connectReinsClient } from "./application-runtime.ts";
import type {
  CommandInvocation,
  CommandInvocationFor,
  CommandName,
} from "./command-spec.ts";
import { machineError, usageError } from "./errors.ts";
import type { OutputMode } from "./output.ts";
import { printDiagnosticsResult, printResolvePermissionAck } from "./output.ts";
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
    : await connectReinsClient({
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
    if (identity.method !== "resolvePermission") {
      throw usageError({
        issue: "invalid_value",
        field: "token",
        hint: "Use the prepared operation credential to recover this request",
      });
    }
    await withClient(ctx, async (client) => {
      const response = await client.retry(token, ctx.options.params);
      const result = requireResult(response);
      switch (identity.method) {
        case "resolvePermission":
          printResolvePermissionAck(
            result as ProtocolResult<"resolvePermission">,
            ctx.mode,
          );
          break;
      }
    });
  },
  diagnostics: runDiagnostics,
  "resolve-permission": runResolvePermission,
} satisfies HandlerMap;

export async function dispatchInvocation(
  invocation: CommandInvocation,
): Promise<void> {
  switch (invocation.command) {
    case "retry":
      return handlers.retry(invocation);
    case "diagnostics":
      return handlers.diagnostics(invocation);
    case "resolve-permission":
      return handlers["resolve-permission"](invocation);
    default:
      return assertNever(invocation);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled command invocation: ${String(value)}`);
}
