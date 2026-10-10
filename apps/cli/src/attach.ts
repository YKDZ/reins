import { createInterface } from "node:readline/promises";

import type { ReinsClient } from "@reins/client";
import type {
  AttachEnded,
  AttachParams,
  DomainEvent,
  PermissionOption,
  PermissionResolution,
  ProtocolNotification,
} from "@reins/protocol";

import {
  createPrettyAttachPresenter,
  type PrettyAttachPresenter,
} from "./attach-presenter.ts";
import { ExitError, EXIT_RESOURCE, inputError } from "./errors.ts";
import type { OutputMode } from "./output.ts";
import { printNotification } from "./output.ts";

export type AttachRuntimeOptions = {
  params: AttachParams;
  mode: OutputMode;
  input?: NodeJS.ReadableStream;
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
  activate(owner: string): void;
  deactivate(owner: string): void;
  next(owner: string, signal: AbortSignal): Promise<PromptRead>;
  close(): void;
};

type PromptRead =
  | { readonly kind: "line"; readonly value: string }
  | { readonly kind: "aborted" }
  | { readonly kind: "eof" };

function createPromptInput(input: NodeJS.ReadableStream): PromptInput {
  const readline = createInterface({ input, output: process.stdout });
  const queued: string[] = [];
  const waiters: Array<{
    readonly owner: string;
    readonly complete: (result: PromptRead) => void;
  }> = [];
  let activeOwner: string | undefined;
  let closed = false;
  readline.on("line", (line: string) => {
    if (activeOwner === undefined) return;
    const waiterIndex = waiters.findIndex(
      (waiter) => waiter.owner === activeOwner,
    );
    const waiter =
      waiterIndex === -1 ? undefined : waiters.splice(waiterIndex, 1)[0];
    if (waiter === undefined) queued.push(line);
    else waiter.complete({ kind: "line", value: line });
  });
  readline.once("close", () => {
    closed = true;
    if (queued.length === 0) {
      for (const waiter of waiters.splice(0)) {
        waiter.complete({ kind: "eof" });
      }
    }
  });
  const deactivate = (owner: string): void => {
    if (activeOwner !== owner) return;
    activeOwner = undefined;
    queued.length = 0;
    for (const waiter of waiters.filter(
      (candidate) => candidate.owner === owner,
    )) {
      waiter.complete({ kind: "aborted" });
    }
  };
  return {
    activate(owner) {
      if (activeOwner !== undefined) deactivate(activeOwner);
      queued.length = 0;
      activeOwner = owner;
    },
    deactivate,
    async next(owner, signal) {
      if (signal.aborted || activeOwner !== owner) return { kind: "aborted" };
      const line = queued.shift();
      if (line !== undefined) return { kind: "line", value: line };
      if (closed) return { kind: "eof" };
      return await new Promise<PromptRead>((resolve) => {
        const complete = (result: PromptRead): void => {
          signal.removeEventListener("abort", onAbort);
          const index = waiters.findIndex(
            (waiter) => waiter.complete === complete,
          );
          if (index !== -1) waiters.splice(index, 1);
          resolve(result);
        };
        const onAbort = (): void => complete({ kind: "aborted" });
        signal.addEventListener("abort", onAbort, { once: true });
        waiters.push({ owner, complete });
      });
    },
    close() {
      activeOwner = undefined;
      queued.length = 0;
      readline.close();
    },
  };
}

async function resolveFromMenu(
  prompt: PromptInput,
  owner: string,
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
  prompt.activate(owner);
  const answer = await prompt.next(owner, signal);
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
    const feedback = await prompt.next(owner, signal);
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
      | {
          readonly key: string;
          readonly sessionId: PermissionRequestedEvent["sessionId"];
          readonly turnId: PermissionRequestedEvent["turnId"];
          readonly controller: AbortController;
        }
      | undefined;
    const prompt =
      options.mode === "pretty" ? createPromptInput(input) : undefined;
    let pendingEnd: AttachEnded | undefined;
    const presenter: PrettyAttachPresenter | undefined =
      options.mode === "pretty" ? createPrettyAttachPresenter() : undefined;

    // oxlint-disable-next-line unicorn/consistent-function-scoping
    let unsubscribe = (): void => {};
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    let unsubscribeClosed = (): void => {};

    const cleanup = (): void => {
      if (activePermission !== undefined) {
        prompt?.deactivate(activePermission.key);
        activePermission.controller.abort();
      }
      activePermission = undefined;
      permissionQueue.length = 0;
      pendingPermissions.clear();
      presenter?.clear();
      prompt?.close();
      unsubscribe();
      unsubscribeClosed();
    };
    const clearPermissionsForTurn = (
      sessionId: PermissionRequestedEvent["sessionId"],
      turnId: PermissionRequestedEvent["turnId"],
    ): void => {
      const matchingKeys = new Set<string>();
      for (const [key, event] of pendingPermissions) {
        if (event.sessionId === sessionId && event.turnId === turnId) {
          matchingKeys.add(key);
          pendingPermissions.delete(key);
        }
      }
      for (let index = permissionQueue.length - 1; index >= 0; index -= 1) {
        const key = permissionQueue[index];
        if (key !== undefined && matchingKeys.has(key)) {
          permissionQueue.splice(index, 1);
        }
      }
      if (
        activePermission?.sessionId === sessionId &&
        activePermission.turnId === turnId
      ) {
        prompt?.deactivate(activePermission.key);
        activePermission.controller.abort();
        activePermission = undefined;
      }
    };
    const consumePermissions = async (): Promise<void> => {
      if (
        consumingPermissions ||
        settled ||
        !attachReady ||
        prompt === undefined
      )
        return;
      consumingPermissions = true;
      try {
        while (!settled) {
          const key = permissionQueue.shift();
          if (key === undefined) return;
          const event = pendingPermissions.get(key);
          if (event === undefined) continue;
          const controller = new AbortController();
          activePermission = {
            key,
            sessionId: event.sessionId,
            turnId: event.turnId,
            controller,
          };
          try {
            await resolveFromMenu(
              prompt,
              key,
              event.sessionId,
              event.permissionId,
              event,
              client,
              controller.signal,
            );
          } finally {
            prompt.deactivate(key);
          }
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
        if (presenter === undefined) {
          printNotification(
            notification.method,
            notification.params,
            options.mode,
          );
        } else if (attachReady) {
          presenter.present(notification);
        } else {
          presenter.bufferInitial(notification);
        }
        if (
          notification.method === "event" &&
          notification.params.type === "turn.completed"
        ) {
          clearPermissionsForTurn(
            notification.params.sessionId,
            notification.params.turnId,
          );
        }
        if (notification.method === "attach.ended") {
          if (!attachReady) {
            pendingEnd = notification.params;
            return;
          }
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
            prompt?.deactivate(key);
            activePermission.controller.abort();
            activePermission = undefined;
          }
        }
        if (options.mode === "pretty") {
          void consumePermissions().catch((error: unknown) => {
            settled = true;
            cleanup();
            reject(error);
          });
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
        presenter?.flushInitial();
        if (pendingEnd !== undefined) {
          settled = true;
          const result = pendingEnd;
          cleanup();
          resolve(result);
          return;
        }
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
