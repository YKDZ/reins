import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Agent, AssistantStreamFrame } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-projection";
import type {} from "@deepseek-ai/dsh-user-approval";
import type {
  ApprovalOutcome,
  ApprovalRequestEvent,
} from "@deepseek-ai/dsh-user-approval/types";
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

type NativeTurnBindingResult =
  | { readonly status: "bound"; readonly turnId: TurnId }
  | { readonly status: "unavailable" }
  | { readonly status: "cancelled" };

type PendingNativeTurnBinding = {
  readonly promise: Promise<TurnId | undefined>;
  resolve(turnId: TurnId | undefined): void;
};

type NativeApproval = {
  readonly id: string;
  readonly toolName: string;
  readonly callId?: string;
  readonly reason?: string;
  readonly nativeTurn?: number;
  claimed: boolean;
  aborted: boolean;
  outcome?: ApprovalOutcome;
  answer?: (outcome: ApprovalOutcome) => void;
  readonly decided: Promise<ApprovalOutcome>;
  decide(outcome: ApprovalOutcome): void;
  removeAbortListener?: () => void;
};

function createNativeTurnBinding(): PendingNativeTurnBinding {
  let resolvePromise!: (turnId: TurnId | undefined) => void;
  const promise = new Promise<TurnId | undefined>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

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
    placement: v.picklist(["active_turn", "new_turn"]),
    turnId: turnIdSchema,
    messageId: v.optional(messageIdSchema),
    message: v.string(),
  }),
  v.strictObject({
    id: v.number(),
    type: v.literal("interrupt"),
    turnId: turnIdSchema,
  }),
  v.strictObject({
    id: v.number(),
    type: v.literal("bind-turn"),
    nativeTurn: v.number(),
    turnId: turnIdSchema,
  }),
  v.strictObject({
    id: v.number(),
    type: v.literal("cancel-turn-binding"),
    nativeTurn: v.number(),
  }),
  v.strictObject({
    id: v.number(),
    type: v.literal("resolve-approval"),
    approvalId: v.string(),
    outcome: v.picklist(["allowed-once", "rejected", "unavailable"]),
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
  target: "next-turn" | "next-step",
): boolean {
  // steer/followup 的公开签名返回 void；只以目标队列中的精确 ID 确认接受。
  if (
    agent.inbox[target === "next-turn" ? "nextTurn" : "nextStep"].some(
      (message) => message.id === nativeMessageId,
    )
  )
    return true;
  return agent.session
    .snapshotEvents()
    .some(
      (event) =>
        event.type === "agent/inbox/spliced" &&
        event.data.target === target &&
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
  nativeTurn?: number,
): void {
  send({
    type: "session-event",
    event,
    ...(nativeTurn === undefined ? {} : { nativeTurn }),
    ...(turnId === undefined ? {} : { turnId }),
    ...(callerMessageId === undefined ? {} : { callerMessageId }),
  });
}

function sendStreamFrame(
  frame: AssistantStreamFrame,
  turnId?: TurnId,
  nativeTurn?: number,
): void {
  send({
    type: "assistant-stream",
    frame,
    ...(nativeTurn === undefined ? {} : { nativeTurn }),
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
  let approvalSubscription: (() => void) | undefined;
  const pendingNativeTurns: NativeTurn[] = [];
  const nativeTurnIds = new Map<number, TurnId>();
  const pendingNativeTurnBindings = new Map<number, PendingNativeTurnBinding>();
  const nativeMessageTurns = new Map<string, TurnId>();
  const nativeCallerMessageIds = new Map<string, NativeCaller>();
  const activePreSteps = new Map<number, AbortSignal>();
  const nativeApprovals = new Map<string, NativeApproval>();
  const attemptTurnIds = new Map<string, TurnId>();
  const attemptNativeTurns = new Map<string, number>();
  let openNativeTurn: number | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;

  const closeProfile = (): Promise<void> => {
    if (closing !== undefined) return closing;
    closing = (async () => {
      for (const nativeTurn of pendingNativeTurnBindings.keys())
        settleNativeTurnBinding(nativeTurn, undefined);
      const failures: unknown[] = [];
      try {
        await handle?.dispose();
      } catch (error) {
        failures.push(error);
      }
      sessionSubscription?.();
      streamSubscription?.();
      approvalSubscription?.();
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
    if (acceptanceRecorded(agent, message.id, "next-turn")) {
      return { accepted: true, nativeMessageId: message.id };
    }
    const pendingIndex = pendingNativeTurns.indexOf(pending);
    if (pendingIndex !== -1) pendingNativeTurns.splice(pendingIndex, 1);
    return { accepted: false, acceptance: "unknown" };
  };

  const activeNativeTurn = (
    agent: Agent,
    turnId: TurnId,
  ): number | undefined => {
    const boundary = profile.ctx.sessionProjections.stateOf(
      agent.session,
      "turnBoundary",
    );
    if (
      agent.status !== "running" ||
      boundary === undefined ||
      boundary.openTurnStartSeq === null
    )
      return undefined;
    const nativeTurn = boundary.lastTurn;
    const signal = activePreSteps.get(nativeTurn);
    if (
      signal === undefined ||
      signal.aborted ||
      nativeTurnIds.get(nativeTurn) !== turnId
    )
      return undefined;
    return nativeTurn;
  };

  const bindNativeTurn = (
    agent: Agent,
    nativeTurn: number,
    turnId: TurnId,
  ): boolean => {
    const boundary = profile.ctx.sessionProjections.stateOf(
      agent.session,
      "turnBoundary",
    );
    const signal = activePreSteps.get(nativeTurn);
    const existingTurnId = nativeTurnIds.get(nativeTurn);
    if (
      agent.status !== "running" ||
      boundary === undefined ||
      boundary.openTurnStartSeq === null ||
      boundary.lastTurn !== nativeTurn ||
      signal === undefined ||
      signal.aborted ||
      (existingTurnId !== undefined && existingTurnId !== turnId)
    )
      return false;
    setNativeTurnId(nativeTurn, turnId);
    return true;
  };

  function setNativeTurnId(nativeTurn: number, turnId: TurnId): void {
    nativeTurnIds.set(nativeTurn, turnId);
    settleNativeTurnBinding(nativeTurn, turnId);
  }

  function settleNativeTurnBinding(
    nativeTurn: number,
    turnId: TurnId | undefined,
  ): void {
    const binding = pendingNativeTurnBindings.get(nativeTurn);
    if (binding === undefined) return;
    pendingNativeTurnBindings.delete(nativeTurn);
    binding.resolve(turnId);
  }

  async function waitForApprovalTurn(
    approval: NativeApproval,
    signal: AbortSignal | undefined,
  ): Promise<NativeTurnBindingResult> {
    const nativeTurn = approval.nativeTurn;
    if (nativeTurn === undefined) return { status: "unavailable" };
    const boundTurnId = nativeTurnIds.get(nativeTurn);
    if (boundTurnId !== undefined)
      return { status: "bound", turnId: boundTurnId };
    if (signal?.aborted === true) return { status: "cancelled" };
    const agent = handle?.agent;
    const boundary =
      agent === undefined
        ? undefined
        : profile.ctx.sessionProjections.stateOf(agent.session, "turnBoundary");
    const preStepSignal = activePreSteps.get(nativeTurn);
    if (
      agent === undefined ||
      agent.status !== "running" ||
      boundary === undefined ||
      boundary.openTurnStartSeq === null ||
      boundary.lastTurn !== nativeTurn ||
      preStepSignal === undefined ||
      preStepSignal.aborted
    )
      return { status: "unavailable" };
    let binding = pendingNativeTurnBindings.get(nativeTurn);
    if (binding === undefined) {
      binding = createNativeTurnBinding();
      pendingNativeTurnBindings.set(nativeTurn, binding);
    }
    const bindingResult = binding.promise.then((turnId) =>
      turnId === undefined
        ? ({ status: "unavailable" } as const)
        : ({ status: "bound", turnId } as const),
    );
    if (signal === undefined) return await bindingResult;
    let abort!: () => void;
    const cancelled = new Promise<NativeTurnBindingResult>((resolve) => {
      abort = () => resolve({ status: "cancelled" });
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([bindingResult, cancelled]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  const acceptSteer = (
    agent: Agent,
    turnId: TurnId,
    text: string,
    messageId?: MessageId,
  ):
    | { readonly accepted: true; readonly nativeMessageId: string }
    | {
        readonly accepted: false;
        readonly acceptance: "not_accepted" | "unknown";
        readonly failure?: ReturnType<typeof safeFailureFrom>;
      } => {
    if (activeNativeTurn(agent, turnId) === undefined)
      return { accepted: false, acceptance: "not_accepted" };
    const message = createUserMessage({
      content: [{ type: "text", text }],
      source: { kind: "user" },
    });
    nativeMessageTurns.set(message.id, turnId);
    if (messageId !== undefined)
      nativeCallerMessageIds.set(message.id, { turnId, messageId });
    try {
      agent.steer(message);
    } catch (error) {
      return {
        accepted: false,
        acceptance: "unknown",
        failure: safeFailureFrom(error),
      };
    }
    if (acceptanceRecorded(agent, message.id, "next-step"))
      return { accepted: true, nativeMessageId: message.id };
    return { accepted: false, acceptance: "unknown" };
  };

  const reject = (
    id: number,
    acceptance: "not_accepted" | "unknown",
    failure?: ReturnType<typeof safeFailureFrom>,
  ): void => {
    send({
      id,
      type: "rejected",
      acceptance,
      ...(failure === undefined ? {} : { failure }),
    });
  };

  const acceptResponse = (
    id: number,
    accepted: ReturnType<typeof acceptSteer>,
  ): void => {
    if (accepted.accepted) {
      send({
        id,
        type: "accepted",
        nativeMessageId: accepted.nativeMessageId,
      });
    } else {
      reject(id, accepted.acceptance, accepted.failure);
    }
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
          if (event.type === "approval/asked") {
            const nativeTurn = nativeTurnOf(event) ?? openNativeTurn;
            let decide!: (outcome: ApprovalOutcome) => void;
            const decided = new Promise<ApprovalOutcome>((resolve) => {
              decide = resolve;
            });
            nativeApprovals.set(String(event.data.id), {
              id: String(event.data.id),
              toolName: event.data.toolName,
              ...(event.data.callId === undefined
                ? {}
                : { callId: String(event.data.callId) }),
              ...(event.data.reason === undefined
                ? {}
                : { reason: event.data.reason }),
              ...(nativeTurn === undefined ? {} : { nativeTurn }),
              claimed: false,
              aborted: false,
              decided,
              decide,
            });
          } else if (event.type === "approval/decided") {
            const approval = nativeApprovals.get(String(event.data.id));
            if (approval !== undefined) {
              approval.removeAbortListener?.();
              approval.decide(event.data.outcome);
              nativeApprovals.delete(approval.id);
            }
          }
          if (event.type === "turn/start") {
            const pending = pendingNativeTurns.shift();
            if (pending !== undefined)
              setNativeTurnId(event.data.turn, pending.turnId);
          }
          const eventNativeTurn = nativeTurnOf(event);
          const nativeTurn =
            eventNativeTurn ??
            (event.type === "user/message" ? openNativeTurn : undefined);
          const messageTurn =
            event.type === "user/message"
              ? nativeMessageTurns.get(event.data.id)
              : undefined;
          if (nativeTurn !== undefined && messageTurn !== undefined)
            setNativeTurnId(nativeTurn, messageTurn);
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
          sendSessionEvent(event, turnId, caller?.messageId, nativeTurn);
          if (event.type === "turn/start") openNativeTurn = event.data.turn;
          if (event.type === "user/message") {
            nativeCallerMessageIds.delete(event.data.id);
            nativeMessageTurns.delete(event.data.id);
          }
          if (event.type === "turn/end") {
            settleNativeTurnBinding(event.data.turn, undefined);
            activePreSteps.delete(event.data.turn);
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
            if (openNativeTurn === event.data.turn) openNativeTurn = undefined;
          }
        },
      );
      handle.agent.ctx.on("agent/pre-step", ({ turn, signal }, next) => {
        activePreSteps.set(turn, signal);
        return next();
      });
      approvalSubscription = handle.agent.ctx.on(
        "approval/request",
        async (request: ApprovalRequestEvent): Promise<ApprovalOutcome> => {
          const requestAborted = (): boolean =>
            request.signal?.aborted === true;
          const callId =
            request.callId === undefined ? undefined : String(request.callId);
          const candidates = [...nativeApprovals.values()].filter(
            (approval) =>
              !approval.claimed &&
              approval.toolName === request.toolName &&
              approval.callId === callId &&
              approval.reason === request.reason,
          );
          if (
            candidates.length !== 1 ||
            candidates[0]?.nativeTurn === undefined ||
            requestAborted()
          )
            return requestAborted() ? "cancelled" : "unavailable";
          const approval = candidates[0];
          if (approval === undefined) return "unavailable";
          const binding = await waitForApprovalTurn(approval, request.signal);
          if (binding.status !== "bound")
            return binding.status === "cancelled" ? "cancelled" : "unavailable";
          if (
            nativeApprovals.get(approval.id) !== approval ||
            approval.claimed ||
            approval.aborted ||
            approval.outcome !== undefined
          )
            return requestAborted() ? "cancelled" : "unavailable";
          approval.claimed = true;
          return await new Promise<ApprovalOutcome>((resolve) => {
            approval.answer = resolve;
            const abort = (): void => {
              approval.aborted = true;
              if (approval.outcome === undefined) {
                approval.outcome = "unavailable";
                approval.answer?.("unavailable");
              }
            };
            if (request.signal !== undefined) {
              if (request.signal.aborted) abort();
              else {
                request.signal.addEventListener("abort", abort, {
                  once: true,
                });
                approval.removeAbortListener = () =>
                  request.signal?.removeEventListener("abort", abort);
              }
            }
            if (!approval.aborted)
              send({
                type: "approval-requested",
                approvalId: approval.id,
                nativeTurn: approval.nativeTurn!,
                turnId: binding.turnId,
                toolName: approval.toolName,
                ...(approval.callId === undefined
                  ? {}
                  : { callId: approval.callId }),
                ...(approval.reason === undefined
                  ? {}
                  : { reason: approval.reason }),
              });
          });
        },
      );
      streamSubscription = handle.agent.ctx.on(
        "agent/assistant-stream",
        ({ frame }) => {
          if (frame.type === "start") {
            const turnId = nativeTurnIds.get(frame.turn);
            attemptNativeTurns.set(String(frame.attemptId), frame.turn);
            if (turnId !== undefined)
              attemptTurnIds.set(String(frame.attemptId), turnId);
            sendStreamFrame(frame, turnId, frame.turn);
          } else if (frame.type === "chunk") {
            const attemptId = String(frame.attemptId);
            sendStreamFrame(
              frame,
              attemptTurnIds.get(attemptId),
              attemptNativeTurns.get(attemptId),
            );
          } else {
            const attemptId = String(frame.attemptId);
            sendStreamFrame(
              frame,
              attemptTurnIds.get(attemptId),
              attemptNativeTurns.get(attemptId),
            );
            attemptTurnIds.delete(attemptId);
            attemptNativeTurns.delete(attemptId);
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
    if (command.type === "resolve-approval") {
      const approval = nativeApprovals.get(command.approvalId);
      if (
        approval === undefined ||
        !approval.claimed ||
        approval.aborted ||
        approval.outcome !== undefined ||
        approval.answer === undefined
      ) {
        reject(command.id, "not_accepted");
        return;
      }
      approval.outcome = command.outcome;
      approval.answer(command.outcome);
      const outcome = await approval.decided;
      if (outcome === command.outcome)
        send({
          id: command.id,
          type: "approval-decided",
          approvalId: approval.id,
          outcome,
        });
      else reject(command.id, "not_accepted");
      return;
    }
    if (command.type === "bind-turn") {
      if (bindNativeTurn(handle.agent, command.nativeTurn, command.turnId))
        send({ id: command.id, type: "bound" });
      else {
        if (!nativeTurnIds.has(command.nativeTurn))
          settleNativeTurnBinding(command.nativeTurn, undefined);
        reject(command.id, "not_accepted");
      }
      return;
    }
    if (command.type === "cancel-turn-binding") {
      settleNativeTurnBinding(command.nativeTurn, undefined);
      send({ id: command.id, type: "binding-cancelled" });
      return;
    }
    if (command.type === "interrupt") {
      const nativeTurn = activeNativeTurn(handle.agent, command.turnId);
      if (nativeTurn === undefined) {
        reject(command.id, "not_accepted");
        return;
      }
      const signal = activePreSteps.get(nativeTurn);
      if (signal === undefined) {
        reject(command.id, "not_accepted");
        return;
      }
      try {
        handle.agent.cancel({ kind: "user" });
      } catch (error) {
        reject(command.id, "unknown", safeFailureFrom(error));
        return;
      }
      if (signal.aborted) send({ id: command.id, type: "interrupted" });
      else reject(command.id, "unknown");
      return;
    }
    const accepted =
      command.placement === "active_turn"
        ? acceptSteer(
            handle.agent,
            command.turnId,
            command.message,
            command.messageId,
          )
        : await acceptFollowup(
            handle.agent,
            command.turnId,
            command.message,
            command.messageId,
          );
    acceptResponse(command.id, accepted);
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
              placement: command.placement,
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
