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
import { STOP_REASONS } from "@reins/protocol";

import type { ReinsClient } from "./client.ts";
import {
  ExitError,
  EXIT_RESOURCE,
  exitCodeForStopReason,
  inputError,
} from "./errors.ts";
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

type PermissionRequestedEvent = Extract<
  DomainEvent,
  { type: "permission.requested" }
>;

type PromptInput = {
  next(signal: AbortSignal): Promise<PromptRead>;
  close(): void;
};

type PromptRead =
  | { readonly kind: "line"; readonly value: string }
  | { readonly kind: "aborted" }
  | { readonly kind: "eof" };

function createPromptInput(input: NodeJS.ReadableStream): PromptInput {
  const readline = createInterface({ input, output: process.stdout });
  const queued: string[] = [];
  const waiters: Array<(result: PromptRead) => void> = [];
  let closed = false;
  readline.on("line", (line: string) => {
    const waiter = waiters.shift();
    if (waiter === undefined) queued.push(line);
    else waiter({ kind: "line", value: line });
  });
  readline.once("close", () => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter({ kind: "eof" });
  });
  return {
    async next(signal) {
      if (signal.aborted) return { kind: "aborted" };
      const line = queued.shift();
      if (line !== undefined) return { kind: "line", value: line };
      if (closed) return { kind: "eof" };
      return await new Promise<PromptRead>((resolve) => {
        const complete = (result: PromptRead): void => {
          signal.removeEventListener("abort", onAbort);
          const index = waiters.indexOf(complete);
          if (index !== -1) waiters.splice(index, 1);
          resolve(result);
        };
        const onAbort = (): void => complete({ kind: "aborted" });
        signal.addEventListener("abort", onAbort, { once: true });
        waiters.push(complete);
      });
    },
    close() {
      readline.close();
    },
  };
}

async function resolveFromMenu(
  prompt: PromptInput,
  sessionId: Extract<
    DomainEvent,
    { type: "permission.requested" }
  >["sessionId"],
  permissionId: Extract<
    DomainEvent,
    { type: "permission.requested" }
  >["permissionId"],
  event: PermissionRequestedEvent,
  client: ReinsClient,
  signal: AbortSignal,
): Promise<void> {
  process.stdout.write(
    `Permission requested: ${event.kind} (${permissionId}) on session ${sessionId}\n`,
  );
  if (event.input !== undefined) {
    process.stdout.write(`${JSON.stringify(event.input)}\n`);
  }
  event.options.forEach((option, index) => {
    process.stdout.write(`${optionLabel(option, index + 1)}\n`);
  });
  process.stdout.write(`Choose (1-${event.options.length}): `);
  const answer = await prompt.next(signal);
  if (answer.kind === "aborted" || signal.aborted) return;
  if (answer.kind === "eof") throw inputError("permission_choice_eof");
  const choice = Number.parseInt(answer.value, 10);
  const option = event.options[choice - 1];
  if (option === undefined) {
    process.stderr.write(`Invalid choice: ${answer.value}\n`);
    throw new ExitError(EXIT_RESOURCE, "invalid permission choice");
  }
  let resolution: PermissionResolution;
  if (option.outcome === "allow") {
    resolution = { outcome: "allow", scope: option.scope };
  } else if (option.feedback) {
    process.stdout.write("Feedback for the worker: ");
    const feedback = await prompt.next(signal);
    if (feedback.kind === "aborted" || signal.aborted) return;
    if (feedback.kind === "eof") throw inputError("permission_feedback_eof");
    resolution = { outcome: "deny", feedback: feedback.value };
  } else {
    resolution = { outcome: "deny" };
  }
  const response = await client.request("resolvePermission", {
    sessionId,
    permissionId,
    resolution,
  });
  if ("error" in response) throw response.error;
}

// attach：等待 attach.ended 或连接关闭；pretty 模式下在会话内处理权限决议。
export async function runAttach(
  client: ReinsClient,
  options: AttachRuntimeOptions,
): Promise<AttachEnded> {
  const input = options.input ?? process.stdin;
  const ended = new Promise<AttachEnded>((resolve, reject) => {
    let settled = false;
    let attachReady = false;
    let consumingPermissions = false;
    const permissionQueue: string[] = [];
    const pendingPermissions = new Map<string, PermissionRequestedEvent>();
    const seenPermissions = new Set<string>();
    let activePermission:
      | { readonly key: string; readonly controller: AbortController }
      | undefined;
    let prompt: PromptInput | undefined;

    // oxlint-disable-next-line unicorn/consistent-function-scoping
    let unsubscribe = (): void => {};
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    let unsubscribeClosed = (): void => {};

    const cleanup = (): void => {
      activePermission?.controller.abort();
      activePermission = undefined;
      permissionQueue.length = 0;
      pendingPermissions.clear();
      prompt?.close();
      unsubscribe();
      unsubscribeClosed();
    };
    const consumePermissions = async (): Promise<void> => {
      if (consumingPermissions || settled || !attachReady) return;
      consumingPermissions = true;
      try {
        while (!settled) {
          const key = permissionQueue.shift();
          if (key === undefined) return;
          const event = pendingPermissions.get(key);
          if (event === undefined) continue;
          prompt ??= createPromptInput(input);
          const controller = new AbortController();
          activePermission = { key, controller };
          await resolveFromMenu(
            prompt,
            event.sessionId,
            event.permissionId,
            event,
            client,
            controller.signal,
          );
          if (activePermission?.key === key) activePermission = undefined;
          pendingPermissions.delete(key);
        }
      } finally {
        activePermission = undefined;
        consumingPermissions = false;
      }
    };
    unsubscribe = client.onNotification(
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
          settled = true;
          cleanup();
          resolve(notification.params);
          return;
        }
        if (
          options.mode === "pretty" &&
          notification.method === "event" &&
          notification.params.type === "permission.requested"
        ) {
          const key = `${notification.params.sessionId}:${notification.params.permissionId}`;
          if (seenPermissions.has(key)) return;
          seenPermissions.add(key);
          pendingPermissions.set(key, notification.params);
          permissionQueue.push(key);
          void consumePermissions().catch((error: unknown) => {
            settled = true;
            cleanup();
            reject(error);
          });
          return;
        }
        if (
          options.mode === "pretty" &&
          notification.method === "event" &&
          notification.params.type === "permission.resolved"
        ) {
          const key = `${notification.params.sessionId}:${notification.params.permissionId}`;
          pendingPermissions.delete(key);
          const queuedIndex = permissionQueue.indexOf(key);
          if (queuedIndex !== -1) permissionQueue.splice(queuedIndex, 1);
          if (activePermission?.key === key) {
            activePermission.controller.abort();
            activePermission = undefined;
          }
        }
      },
    );
    unsubscribeClosed = client.onClosed((reason) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(reason);
    });
    client
      .request("attach", options.params)
      .then((response) => {
        if ("error" in response) {
          if (settled) return;
          settled = true;
          cleanup();
          reject(response.error);
          return;
        }
        attachReady = true;
        void consumePermissions().catch((error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        });
      })
      .catch((error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
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
  const sessionId = spawnResponse.result.sessionId;
  const holder: {
    finalTurn: Extract<DomainEvent, { type: "turn.completed" }> | null;
  } = { finalTurn: null };
  const ended = await runAttach(client, {
    params: {
      sessionId,
      exitOn: [...STOP_REASONS],
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
