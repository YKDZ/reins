import type {
  AttachParams,
  KillResult,
  ListFilter,
  PermissionResolution,
  ProtocolResponse,
  SendAck,
  SessionId,
  SessionInfo,
  SpawnParams,
  StopReason,
  WaitResult,
} from "@reins/protocol";
import {
  permissionIdSchema,
  sessionIdSchema,
  sessionNameSchema,
} from "@reins/protocol";
import * as v from "valibot";

import { runAndWait, runAttach } from "./attach.ts";
import { CapabilityStore } from "./capabilities.ts";
import { createReinsClient, type ReinsClient } from "./client.ts";
import type { CommandName, RunContext } from "./command-spec.ts";
import { ensureDaemon } from "./daemon.ts";
import { ExitError, EXIT_TIMEOUT } from "./errors.ts";
import type { OutputMode } from "./output.ts";
import {
  printCapabilitiesResult,
  printInterruptResult,
  printKillResult,
  printListResult,
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

function requireResult(response: ProtocolResponse): unknown {
  if ("error" in response) throw response.error;
  return response.result;
}

function spawnParamsFromOptions(
  harness: string,
  messageParts: readonly string[],
  options: Record<string, unknown>,
): SpawnParams {
  const authorizationMode =
    options.authorizationMode === "interactive"
      ? ("interactive" as const)
      : options.authorizationMode === "allow-all"
        ? ("allowAll" as const)
        : undefined;
  const params: SpawnParams = {
    harness,
    message: messageParts.join(" "),
    sessionName: v.parse(sessionNameSchema, options.name),
    ...(options.agent === undefined ? {} : { agent: options.agent as string }),
    ...(options.model === undefined ? {} : { model: options.model as string }),
    ...(options.reasoning === undefined
      ? {}
      : { reasoning: options.reasoning as string }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd as string }),
    ...(authorizationMode === undefined ? {} : { authorizationMode }),
    ...(options.sandbox === undefined
      ? {}
      : { sandbox: options.sandbox as string }),
  };
  if (options.meta !== undefined) {
    params.meta = JSON.parse(options.meta as string) as Record<string, unknown>;
  }
  return params;
}

async function runSpawn(ctx: RunContext): Promise<void> {
  const harness = ctx.args[0] as string;
  const messageParts = ctx.args[1] as readonly string[];
  const params = spawnParamsFromOptions(harness, messageParts, ctx.options);
  await withClient(ctx.mode, async (client) => {
    const validation = await new CapabilityStore(client).validateSpawn(params);
    if (validation !== null) throw validation;
    const response = await client.request("spawn", params);
    printSpawnResult(
      requireResult(response) as { sessionId: SessionId },
      ctx.mode,
    );
  });
}

async function runSend(ctx: RunContext): Promise<void> {
  const sessionId = v.parse(sessionIdSchema, ctx.args[0]);
  const messageParts = ctx.args[1] as readonly string[];
  await withClient(ctx.mode, async (client) => {
    const response = await client.request("send", {
      sessionId,
      message: messageParts.join(" "),
    });
    printSendAck(requireResult(response) as SendAck, ctx.mode);
  });
}

async function runWait(ctx: RunContext): Promise<void> {
  const ids = (ctx.args[0] as readonly string[]).map((id) =>
    v.parse(sessionIdSchema, id),
  );
  const timeoutMs = Number(ctx.options.timeout);
  await withClient(ctx.mode, async (client) => {
    const response = await client.request(
      "wait",
      {
        ids: [...ids],
        timeoutMs,
      },
      timeoutMs + 5000,
    );
    const result = requireResult(response) as WaitResult;
    printWaitResult(result, ctx.mode);
    if (result.status === "timeout") throw new ExitError(EXIT_TIMEOUT);
  });
}

async function runInterrupt(ctx: RunContext): Promise<void> {
  const ids = (ctx.args[0] as readonly string[]).map((id) =>
    v.parse(sessionIdSchema, id),
  );
  await withClient(ctx.mode, async (client) => {
    const response = await client.request("interrupt", {
      ids: [...ids],
    });
    printInterruptResult(
      requireResult(response) as Array<{
        sessionId: string;
        status: string;
        turnId?: string;
      }>,
      ctx.mode,
    );
  });
}

async function runKill(ctx: RunContext): Promise<void> {
  const ids = (ctx.args[0] as readonly string[]).map((id) =>
    v.parse(sessionIdSchema, id),
  );
  await withClient(ctx.mode, async (client) => {
    const response = await client.request("kill", { ids: [...ids] });
    printKillResult(requireResult(response) as KillResult[], ctx.mode);
  });
}

async function runList(ctx: RunContext): Promise<void> {
  const options = ctx.options;
  await withClient(ctx.mode, async (client) => {
    const params: ListFilter = {
      ...(options.harness === undefined
        ? {}
        : { harness: options.harness as string }),
      ...(options.state === undefined
        ? {}
        : { state: options.state as ListFilter["state"] }),
      ...(options.name === undefined
        ? {}
        : { sessionName: v.parse(sessionNameSchema, options.name) }),
      ...(options.model === undefined
        ? {}
        : { model: options.model as string }),
    };
    const response = await client.request("list", params);
    printListResult(requireResult(response) as SessionInfo[], ctx.mode);
  });
}

async function runAttachCommand(ctx: RunContext): Promise<void> {
  const sessionId = v.parse(sessionIdSchema, ctx.args[0]);
  const options = ctx.options;
  const params: AttachParams = { sessionId };
  if (options.replay !== undefined) {
    params.replay = Number(options.replay);
  }
  if (options.exitOn !== undefined) {
    params.exitOn = [...(options.exitOn as readonly StopReason[])];
  }
  await withClient(ctx.mode, async (client) => {
    await runAttach(client, { params, mode: ctx.mode });
  });
}

async function runRun(ctx: RunContext): Promise<void> {
  const harness = ctx.args[0] as string;
  const messageParts = ctx.args[1] as readonly string[];
  const params = spawnParamsFromOptions(harness, messageParts, ctx.options);
  await withClient(ctx.mode, async (client) => {
    const validation = await new CapabilityStore(client).validateSpawn(params);
    if (validation !== null) throw validation;
    await runAndWait(client, { spawn: params, mode: ctx.mode });
  });
}

async function runCapabilities(ctx: RunContext): Promise<void> {
  await withClient(ctx.mode, async (client) => {
    const store = new CapabilityStore(client);
    printCapabilitiesResult(await store.result(), ctx.mode);
  });
}

async function runResolvePermission(ctx: RunContext): Promise<void> {
  const sessionId = v.parse(sessionIdSchema, ctx.args[0]);
  const permissionId = v.parse(permissionIdSchema, ctx.args[1]);
  const options = ctx.options;
  const outcome = options.outcome as string;
  let resolution: PermissionResolution;
  if (outcome === "allow") {
    const scope = (options.scope as string | undefined) ?? "once";
    resolution = {
      outcome: "allow",
      scope: scope === "session" ? "session" : "once",
    };
  } else {
    const feedback = options.feedback as string | undefined;
    resolution =
      feedback === undefined
        ? { outcome: "deny" }
        : { outcome: "deny", feedback };
  }
  await withClient(ctx.mode, async (client) => {
    const response = await client.request("resolvePermission", {
      sessionId,
      permissionId,
      resolution,
    });
    requireResult(response);
    if (ctx.mode === "pretty") {
      process.stdout.write(`Resolved ${permissionId}\n`);
    }
  });
}

export const handlers: {
  readonly [K in CommandName]: (ctx: RunContext) => Promise<void>;
} = {
  spawn: runSpawn,
  send: runSend,
  wait: runWait,
  interrupt: runInterrupt,
  kill: runKill,
  list: runList,
  attach: runAttachCommand,
  run: runRun,
  capabilities: runCapabilities,
  "resolve-permission": runResolvePermission,
};
