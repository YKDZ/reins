import { createInterface } from "node:readline/promises";

import type {
  AttachEnded,
  AttachParams,
  DomainEvent,
  PermissionOption,
  PermissionResolution,
  ProtocolNotification,
  SpawnParams,
} from "@reins/protocol";

import type { ReinsClient } from "./client.ts";
import { ExitError, EXIT_RESOURCE, exitCodeForStopReason } from "./errors.ts";
import type { OutputMode } from "./output.ts";
import { printNotification, printRunResult } from "./output.ts";

export type AttachRuntimeOptions = {
  params: AttachParams;
  mode: OutputMode;
  input?: NodeJS.ReadableStream;
  quiet?: boolean;
  onTurnCompleted?: (
    event: Extract<DomainEvent, { type: "turn.completed" }>,
  ) => void;
};

function optionLabel(option: PermissionOption, index: number): string {
  if (option.outcome === "allow") {
    return `${index}. Allow ${option.scope === "once" ? "once" : "for session"}`;
  }
  return option.feedback ? `${index}. Deny with feedback` : `${index}. Deny`;
}

async function resolveFromMenu(
  input: NodeJS.ReadableStream,
  sessionId: string,
  permissionId: string,
  event: Extract<DomainEvent, { type: "permission.requested" }>,
  client: ReinsClient,
): Promise<void> {
  const rl = createInterface({ input, output: process.stdout });
  try {
    process.stdout.write(
      `Permission requested: ${event.kind} (${permissionId}) on session ${sessionId}\n`,
    );
    if (event.input !== undefined) {
      process.stdout.write(`${JSON.stringify(event.input)}\n`);
    }
    event.options.forEach((option, index) => {
      process.stdout.write(`${optionLabel(option, index + 1)}\n`);
    });
    const answer = await rl.question(`Choose (1-${event.options.length}): `);
    const choice = Number.parseInt(answer, 10);
    const option = event.options[choice - 1];
    if (option === undefined) {
      process.stderr.write(`Invalid choice: ${answer}\n`);
      throw new ExitError(EXIT_RESOURCE, "invalid permission choice");
    }
    let resolution: PermissionResolution;
    if (option.outcome === "allow") {
      resolution = { outcome: "allow", scope: option.scope };
    } else if (option.feedback) {
      const feedback = await rl.question("Feedback for the worker: ");
      resolution = { outcome: "deny", feedback };
    } else {
      resolution = { outcome: "deny" };
    }
    const response = await client.request("resolvePermission", {
      sessionId,
      permissionId,
      resolution,
    });
    if ("error" in response) throw response.error;
  } finally {
    rl.close();
  }
}

// attach：等待 attach.ended 或连接关闭；pretty 模式下在会话内处理权限决议。
export async function runAttach(
  client: ReinsClient,
  options: AttachRuntimeOptions,
): Promise<AttachEnded> {
  const input = options.input ?? process.stdin;
  const ended = new Promise<AttachEnded>((resolve, reject) => {
    const unsubscribe = client.onNotification(
      (notification: ProtocolNotification) => {
        if (options.quiet !== true) {
          printNotification(
            notification.method,
            notification.params,
            options.mode,
          );
        }
        if (
          notification.method === "event" &&
          notification.params.type === "turn.completed"
        ) {
          options.onTurnCompleted?.(notification.params);
        }
        if (notification.method === "attach.ended") {
          unsubscribe();
          resolve(notification.params);
          return;
        }
        if (
          options.mode === "pretty" &&
          notification.method === "event" &&
          notification.params.type === "permission.requested"
        ) {
          void resolveFromMenu(
            input,
            notification.params.sessionId,
            notification.params.permissionId,
            notification.params,
            client,
          ).catch((error: unknown) => {
            unsubscribe();
            reject(error);
          });
        }
      },
    );
    client
      .request("attach", options.params)
      .then((response) => {
        if ("error" in response) {
          unsubscribe();
          reject(response.error);
        }
      })
      .catch((error: unknown) => {
        unsubscribe();
        reject(error);
      });
  });
  return await ended;
}

// run：spawn 后 attach 首个回合（exitOn 覆盖全部终态），按终态抛退出码。
export async function runAndWait(
  client: ReinsClient,
  params: { spawn: SpawnParams; mode: OutputMode },
): Promise<never> {
  const spawnResponse = await client.request("spawn", params.spawn);
  if ("error" in spawnResponse) throw spawnResponse.error;
  const sessionId = (spawnResponse.result as { sessionId: string }).sessionId;
  const holder: {
    finalTurn: Extract<DomainEvent, { type: "turn.completed" }> | null;
  } = { finalTurn: null };
  const ended = await runAttach(client, {
    params: {
      sessionId,
      exitOn: ["end_turn", "failed", "cancelled", "killed"],
    },
    mode: params.mode,
    quiet: true,
    onTurnCompleted: (event) => {
      holder.finalTurn = event;
    },
  });
  if (ended.reason === "session_killed") {
    printRunResult(
      { sessionId, stopReason: "killed", finalReply: null },
      params.mode,
    );
    throw new ExitError(exitCodeForStopReason("killed"), "session killed");
  }
  if (holder.finalTurn !== null) {
    printRunResult(
      {
        sessionId,
        stopReason: holder.finalTurn.stopReason,
        finalReply: holder.finalTurn.finalReply,
        ...(holder.finalTurn.usage === undefined
          ? {}
          : { usage: holder.finalTurn.usage }),
      },
      params.mode,
    );
    throw new ExitError(
      exitCodeForStopReason(holder.finalTurn.stopReason),
      `run ended: ${holder.finalTurn.stopReason}`,
    );
  }
  // 理论不可达：attach 的 exitOn 覆盖全部终态，只会在 turn.completed 或
  // session_killed 时结束；兜底按 ended.reason 退出。
  throw new ExitError(
    exitCodeForStopReason(ended.reason),
    `run ended: ${ended.reason}`,
  );
}
