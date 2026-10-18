import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Agent, AssistantStreamFrame } from "@deepseek-ai/dsh-agent";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { runProfile } from "@deepseek-ai/dsh/profile-boot";
import {
  messageIdSchema,
  turnIdSchema,
  type MessageId,
  type TurnId,
} from "@reins/protocol";
import * as v from "valibot";

import {
  safeFailureFrom,
  type DshHostCommand,
  type DshHostEvent,
  type DshHostResponse,
} from "./dsh-host-protocol.ts";

type NativeTurn = {
  readonly turnId: TurnId;
  readonly nativeMessageId: string;
};

type NativeCaller = {
  readonly turnId: TurnId;
  readonly messageId: MessageId;
};

const hostCommandSchema = v.union([
  v.strictObject({
    id: v.number(),
    type: v.literal("start"),
    sessionId: v.string(),
    turnId: turnIdSchema,
    messageId: v.optional(messageIdSchema),
    message: v.string(),
    cwd: v.string(),
    provider: v.optional(v.string()),
    model: v.optional(v.string()),
    reasoningEffort: v.optional(v.string()),
  }),
  v.strictObject({
    id: v.number(),
    type: v.literal("deliver"),
    turnId: turnIdSchema,
    messageId: v.optional(messageIdSchema),
    message: v.string(),
  }),
  v.strictObject({ id: v.number(), type: v.literal("close") }),
  v.strictObject({ id: v.number(), type: v.literal("catalog") }),
]);

type DshProfileRuntime = {
  readonly ctx: Awaited<ReturnType<typeof runProfile>>["ctx"];
  readonly shutdown: Awaited<ReturnType<typeof runProfile>>["shutdown"];
  readonly profileDirectory: string;
};

function send(message: DshHostEvent | DshHostResponse): void {
  if (process.send === undefined || !process.connected) return;
  process.send(message);
}

async function createOfficialProfile(): Promise<DshProfileRuntime> {
  const [
    { loadLayeredEnv, loadProfileDirectory },
    { INSTALL_ANCHOR, runProfile },
  ] = await Promise.all([
    import("@deepseek-ai/dsh-app-boot"),
    import("@deepseek-ai/dsh/profile-boot"),
  ]);
  const profileDirectory = await mkdtemp(
    join(tmpdir(), `reins-dsh-profile-${process.pid}-`),
  );
  try {
    await writeFile(
      join(profileDirectory, "package.json"),
      JSON.stringify({
        name: `reins-dsh-profile-${process.pid}`,
        private: true,
        type: "module",
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
      }),
    );
    const profile = loadProfileDirectory(
      "reins",
      profileDirectory,
      INSTALL_ANCHOR,
    );
    if (
      profile.skippedBundles.length > 0 ||
      profile.layers.length !== 1 ||
      profile.layers[0]?.packageName !== "@deepseek-ai/dsh-base"
    )
      throw Object.assign(
        new Error("The official DSH base profile is unavailable"),
        {
          code: "DSH_PROFILE_UNAVAILABLE",
        },
      );
    const environment = loadLayeredEnv("reins", process.cwd());
    const runtime = await runProfile({
      environment,
      profile: "reins",
      resolvedProfile: { profile, installAnchor: INSTALL_ANCHOR },
      patchFiles: [],
      args: [],
    });
    return { ...runtime, profileDirectory };
  } catch (error) {
    await rm(profileDirectory, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw error;
  }
}

function acceptanceRecorded(
  agent: import("@deepseek-ai/dsh-agent").Agent,
  nativeMessageId: string,
): boolean {
  // followup 的公开签名返回 void；只以同一原生 turn 队列中的精确 ID 确认接受。
  if (agent.inbox.nextTurn.some((message) => message.id === nativeMessageId))
    return true;
  return agent.session
    .snapshotEvents()
    .some(
      (event) =>
        event.type === "agent/inbox/spliced" &&
        event.data.target === "next-turn" &&
        event.data.inserted.some((message) => message.id === nativeMessageId),
    );
}

function nativeTurnOf(event: SessionEvent): number | undefined {
  if ("turn" in event.data && typeof event.data.turn === "number")
    return event.data.turn;
  return undefined;
}

function sendSessionEvent(
  event: SessionEvent,
  turnId?: TurnId,
  callerMessageId?: MessageId,
): void {
  send({
    type: "session-event",
    event,
    ...(turnId === undefined ? {} : { turnId }),
    ...(callerMessageId === undefined ? {} : { callerMessageId }),
  });
}

function sendStreamFrame(frame: AssistantStreamFrame, turnId?: TurnId): void {
  send({
    type: "assistant-stream",
    frame,
    ...(turnId === undefined ? {} : { turnId }),
  });
}

async function listModels(
  ctx: DshProfileRuntime["ctx"],
): Promise<Extract<DshHostResponse, { type: "catalog" }>["models"]> {
  const models: {
    provider: string;
    model: string;
    displayName: string;
    reasoningEfforts: string[];
  }[] = [];
  for (const provider of ctx.llm.listProviders()) {
    for (const model of await ctx.llm.listModels(provider.id)) {
      const resolved = await ctx.llm.resolveModelInfo(provider.id, model.id);
      models.push({
        provider: provider.id,
        model: model.id,
        displayName: model.name,
        reasoningEfforts:
          resolved.reasoning?.efforts.map((effort) => effort.id) ?? [],
      });
    }
  }
  return models;
}

export async function runDshRuntimeHost(): Promise<void> {
  if (process.send === undefined)
    throw new Error("DSH runtime host requires a parent IPC connection");
  let disconnected = !process.connected;
  let disconnectCleanup: (() => Promise<void>) | undefined;
  process.once("disconnect", () => {
    disconnected = true;
    void disconnectCleanup?.().catch(() => {
      process.exitCode = 1;
    });
  });
  if (disconnected) return;
  let profile: DshProfileRuntime;
  try {
    profile = await createOfficialProfile();
  } catch (error) {
    if (!disconnected) send({ type: "fatal", failure: safeFailureFrom(error) });
    process.exitCode = 1;
    if (process.connected) process.disconnect();
    return;
  }
  let handle: import("@deepseek-ai/dsh-agent").AgentHandle | undefined;
  let sessionSubscription: (() => void) | undefined;
  let streamSubscription: (() => void) | undefined;
  const pendingNativeTurns: NativeTurn[] = [];
  const nativeTurnIds = new Map<number, TurnId>();
  const nativeMessageTurns = new Map<string, TurnId>();
  const nativeCallerMessageIds = new Map<string, NativeCaller>();
  const attemptTurnIds = new Map<string, TurnId>();
  let closed = false;
  let closing: Promise<void> | undefined;

  const closeProfile = (): Promise<void> => {
    if (closing !== undefined) return closing;
    closing = (async () => {
      const failures: unknown[] = [];
      try {
        await handle?.dispose();
      } catch (error) {
        failures.push(error);
      }
      sessionSubscription?.();
      streamSubscription?.();
      try {
        await profile.shutdown.shutdown(0);
      } catch (error) {
        failures.push(error);
      }
      await rm(profile.profileDirectory, { recursive: true, force: true });
      handle = undefined;
      closed = true;
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, "DSH profile shutdown failed");
    })();
    return closing;
  };
  disconnectCleanup = closeProfile;
  if (disconnected) {
    await closeProfile();
    return;
  }

  const failHost = (error: unknown): void => {
    send({ type: "fatal", failure: safeFailureFrom(error) });
  };

  const acceptFollowup = async (
    agent: Agent,
    turnId: TurnId,
    text: string,
    messageId?: MessageId,
  ): Promise<
    | { readonly accepted: true; readonly nativeMessageId: string }
    | {
        readonly accepted: false;
        readonly acceptance: "not_accepted" | "unknown";
        readonly failure?: ReturnType<typeof safeFailureFrom>;
      }
  > => {
    const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
    const message = createUserMessage({
      content: [{ type: "text", text }],
      source: { kind: "user" },
    });
    const pending: NativeTurn = {
      turnId,
      nativeMessageId: message.id,
    };
    pendingNativeTurns.push(pending);
    nativeMessageTurns.set(message.id, turnId);
    if (messageId !== undefined)
      nativeCallerMessageIds.set(message.id, { turnId, messageId });
    try {
      agent.followup(message);
    } catch (error) {
      const pendingIndex = pendingNativeTurns.indexOf(pending);
      if (pendingIndex !== -1) pendingNativeTurns.splice(pendingIndex, 1);
      return {
        accepted: false,
        acceptance: "unknown",
        failure: safeFailureFrom(error),
      };
    }
    if (acceptanceRecorded(agent, message.id)) {
      return { accepted: true, nativeMessageId: message.id };
    }
    const pendingIndex = pendingNativeTurns.indexOf(pending);
    if (pendingIndex !== -1) pendingNativeTurns.splice(pendingIndex, 1);
    return { accepted: false, acceptance: "unknown" };
  };

  const handleCommand = async (command: DshHostCommand): Promise<void> => {
    if (command.type === "catalog") {
      try {
        send({
          id: command.id,
          type: "catalog",
          models: await listModels(profile.ctx),
        });
      } catch (error) {
        send({
          id: command.id,
          type: "catalog-failed",
          failure: safeFailureFrom(error),
        });
      }
      return;
    }
    if (command.type === "close") {
      try {
        await closeProfile();
        send({ id: command.id, type: "closed" });
        process.disconnect();
      } catch (error) {
        send({
          id: command.id,
          type: "fatal",
          failure: safeFailureFrom(error),
        });
        process.exitCode = 1;
        process.disconnect();
      }
      return;
    }
    if (command.type === "start") {
      if (handle !== undefined) {
        send({
          id: command.id,
          type: "rejected",
          acceptance: "not_accepted",
        });
        return;
      }
      try {
        if (command.cwd !== process.cwd())
          throw Object.assign(
            new Error("The DSH host working directory changed"),
            {
              code: "DSH_PROFILE_UNAVAILABLE",
            },
          );
        handle = await profile.ctx.agents.create({
          sessionId: (await import("@deepseek-ai/dsh-session")).SessionId(
            command.sessionId,
          ),
          meta: { cwd: command.cwd },
          agentOptions: {
            ...(command.provider === undefined
              ? {}
              : { provider: command.provider }),
            ...(command.model === undefined ? {} : { model: command.model }),
            ...(command.reasoningEffort === undefined
              ? {}
              : {
                  reasoningEffort: (
                    await import("@deepseek-ai/dsh-llm/brand")
                  ).ReasoningEffortId(command.reasoningEffort),
                }),
          },
        });
      } catch (error) {
        send({
          id: command.id,
          type: "rejected",
          acceptance: "not_accepted",
          failure: safeFailureFrom(error),
        });
        return;
      }
      sessionSubscription = profile.ctx.on(
        "session/event",
        (nativeSession, event) => {
          if (nativeSession.id !== handle?.agent.session.id) return;
          if (event.type === "turn/start") {
            const pending = pendingNativeTurns.shift();
            if (pending !== undefined)
              nativeTurnIds.set(event.data.turn, pending.turnId);
          }
          const nativeTurn = nativeTurnOf(event);
          const messageTurn =
            event.type === "user/message"
              ? nativeMessageTurns.get(event.data.id)
              : undefined;
          if (nativeTurn !== undefined && messageTurn !== undefined)
            nativeTurnIds.set(nativeTurn, messageTurn);
          const turnId =
            event.type === "user/message"
              ? messageTurn
              : nativeTurn === undefined
                ? undefined
                : nativeTurnIds.get(nativeTurn);
          const caller =
            event.type === "user/message"
              ? nativeCallerMessageIds.get(event.data.id)
              : undefined;
          sendSessionEvent(event, turnId, caller?.messageId);
          if (event.type === "user/message") {
            nativeCallerMessageIds.delete(event.data.id);
            nativeMessageTurns.delete(event.data.id);
          }
          if (event.type === "turn/end") {
            nativeTurnIds.delete(event.data.turn);
            for (const [
              nativeMessageId,
              pendingCaller,
            ] of nativeCallerMessageIds) {
              if (pendingCaller.turnId === turnId) {
                nativeCallerMessageIds.delete(nativeMessageId);
                nativeMessageTurns.delete(nativeMessageId);
              }
            }
          }
        },
      );
      streamSubscription = handle.agent.ctx.on(
        "agent/assistant-stream",
        ({ frame }) => {
          if (frame.type === "start") {
            const turnId = nativeTurnIds.get(frame.turn);
            if (turnId !== undefined)
              attemptTurnIds.set(String(frame.attemptId), turnId);
            sendStreamFrame(frame, turnId);
          } else if (frame.type === "chunk") {
            sendStreamFrame(frame, attemptTurnIds.get(String(frame.attemptId)));
          } else {
            sendStreamFrame(frame, attemptTurnIds.get(String(frame.attemptId)));
            attemptTurnIds.delete(String(frame.attemptId));
          }
        },
      );
      const accepted = await acceptFollowup(
        handle.agent,
        command.turnId,
        command.message,
        command.messageId,
      );
      if (accepted.accepted) {
        send({
          id: command.id,
          type: "accepted",
          nativeMessageId: accepted.nativeMessageId,
        });
      } else {
        send({
          id: command.id,
          type: "rejected",
          acceptance: accepted.acceptance,
          ...(accepted.failure === undefined
            ? {}
            : { failure: accepted.failure }),
        });
      }
      return;
    }
    if (handle === undefined || closed) {
      send({
        id: command.id,
        type: "rejected",
        acceptance: "not_accepted",
      });
      return;
    }
    const accepted = await acceptFollowup(
      handle.agent,
      command.turnId,
      command.message,
      command.messageId,
    );
    if (accepted.accepted) {
      send({
        id: command.id,
        type: "accepted",
        nativeMessageId: accepted.nativeMessageId,
      });
    } else {
      send({
        id: command.id,
        type: "rejected",
        acceptance: accepted.acceptance,
        ...(accepted.failure === undefined
          ? {}
          : { failure: accepted.failure }),
      });
    }
  };

  process.on("message", (value: unknown) => {
    const parsed = v.safeParse(hostCommandSchema, value);
    if (!parsed.success) {
      failHost(new Error("Invalid command from Reins host"));
      process.exitCode = 1;
      process.disconnect();
      return;
    }
    const command = parsed.output;
    const normalizedCommand: DshHostCommand =
      command.type === "start"
        ? {
            id: command.id,
            type: "start",
            sessionId: command.sessionId,
            turnId: command.turnId,
            ...(command.messageId === undefined
              ? {}
              : { messageId: command.messageId }),
            message: command.message,
            cwd: command.cwd,
            ...(command.provider === undefined
              ? {}
              : { provider: command.provider }),
            ...(command.model === undefined ? {} : { model: command.model }),
            ...(command.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: command.reasoningEffort }),
          }
        : command.type === "deliver"
          ? {
              id: command.id,
              type: "deliver",
              turnId: command.turnId,
              ...(command.messageId === undefined
                ? {}
                : { messageId: command.messageId }),
              message: command.message,
            }
          : command;
    void handleCommand(normalizedCommand).catch((error: unknown) => {
      send({
        id: normalizedCommand.id,
        type: "fatal",
        failure: safeFailureFrom(error),
      });
      process.exitCode = 1;
      process.disconnect();
    });
  });
  send({ type: "ready" });
}
