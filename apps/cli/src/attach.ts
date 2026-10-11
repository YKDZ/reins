import { createInterface } from "node:readline/promises";

import type {
  AgentEvent,
  AgentSubscriptionEnd,
  ReinsClient,
} from "@reins/client";
import type {
  AttachParams,
  PermissionOption,
  PermissionResolution,
} from "@reins/protocol";
import { decodePermissionHandle } from "@reins/protocol";

import { ExitError, EXIT_RESOURCE, inputError } from "./errors.ts";
import type { OutputMode } from "./output.ts";
import { printAgentEvent } from "./output.ts";

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
  AgentEvent,
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
  event: PermissionRequestedEvent,
  client: ReinsClient,
  signal: AbortSignal,
): Promise<void> {
  process.stdout.write(
    `Permission requested: ${event.kind} (${event.permissionHandle})\n`,
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
    ...decodePermissionHandle(event.permissionHandle),
    resolution,
  });
  if ("error" in response) throw response.error;
}

// CLI 仅负责呈现与交互；关联、去重和订阅生命期由共享 client 负责。
export async function runAttach(
  client: ReinsClient,
  options: AttachRuntimeOptions,
): Promise<AgentSubscriptionEnd> {
  const subscription = await client.subscribe(options.params);
  if (options.mode === "json")
    process.stdout.write(
      JSON.stringify({
        type: "subscription.established",
        ...subscription.establishment,
      }) + "\n",
    );
  if (options.mode === "pretty") {
    const window = subscription.establishment.window;
    process.stdout.write(
      `Event window: ${window.oldest ?? "empty"} through ${window.head ?? "empty"} (${window.truncated ? "truncated" : "complete"})\n`,
    );
  }
  const prompt =
    options.mode === "pretty"
      ? createPromptInput(options.input ?? process.stdin)
      : undefined;
  const pending = new Map<string, PermissionRequestedEvent>();
  const queue: PermissionRequestedEvent[] = [];
  let active:
    | { event: PermissionRequestedEvent; controller: AbortController }
    | undefined;
  let consuming: Promise<void> | undefined;
  let menuFailure: unknown;
  const abort = () => {
    if (active !== undefined) {
      prompt?.deactivate(active.event.permissionHandle);
      active.controller.abort();
      active = undefined;
    }
  };
  const consume = (): void => {
    if (prompt === undefined || consuming !== undefined) return;
    consuming = (async () => {
      while (queue.length > 0) {
        const event = queue.shift()!;
        if (!pending.has(event.permissionHandle)) continue;
        const controller = new AbortController();
        active = { event, controller };
        try {
          await resolveFromMenu(
            prompt,
            event.permissionHandle,
            event,
            client,
            controller.signal,
          );
        } finally {
          prompt.deactivate(event.permissionHandle);
        }
        pending.delete(event.permissionHandle);
        if (active?.event.permissionHandle === event.permissionHandle)
          active = undefined;
      }
    })()
      .catch((error) => {
        menuFailure = error;
        subscription.close();
      })
      .finally(() => {
        consuming = undefined;
      });
  };
  try {
    const unsubscribe = subscription.onEvent((event) => {
      printAgentEvent(event, options.mode);
      if (event.type === "permission.requested" && prompt !== undefined) {
        if (!pending.has(event.permissionHandle)) {
          pending.set(event.permissionHandle, event);
          queue.push(event);
        }
        consume();
      } else if (event.type === "permission.resolved") {
        pending.delete(event.permissionHandle);
        if (active?.event.permissionHandle === event.permissionHandle) abort();
      } else if (event.type === "turn.completed") {
        for (const [key, permission] of pending)
          if (permission.turnHandle === event.turnHandle) pending.delete(key);
        if (active?.event.turnHandle === event.turnHandle) abort();
      }
    });
    const ended = await subscription.done;
    unsubscribe();
    if (menuFailure !== undefined) throw menuFailure;
    const publicEnd = { type: "subscription.ended", ...ended };
    if (options.mode === "json")
      process.stdout.write(JSON.stringify(publicEnd) + "\n");
    else process.stdout.write("[attach ended] " + ended.reason + "\n");
    return ended;
  } finally {
    abort();
    prompt?.close();
    subscription.close();
  }
}
