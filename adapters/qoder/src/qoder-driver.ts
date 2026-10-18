import { randomUUID } from "node:crypto";

import { createAsyncQueue, HarnessSession } from "@reins/adapter-kit";
import type {
  WorkerDriver,
  AdapterDriverFactory,
  WorkerSpec,
  MachineError,
  DomainEvent,
  MessageId,
  OperationEffect,
} from "@reins/protocol";
import {
  makeTextEvidence,
  WorkerDeliveryFailure,
  WorkerInterruptFailure,
  WorkerStartFailure,
} from "@reins/protocol";

import {
  createQoderMappingState,
  derivePermissionOptions,
  mapSdkMessage,
} from "./mapper.ts";
import type {
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
  QoderOptions,
  QoderSdk,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "./sdk-seam.ts";

type PendingEntry = {
  resolve: (result: PermissionResult) => void;
  reject: (reason: unknown) => void;
  input: Record<string, unknown>;
  toolUseID?: string;
  suggestions: PermissionUpdate[] | undefined;
};

type CallerMessage = { messageId: MessageId; content: string };
type NativePhaseOutcome =
  | { readonly kind: "completed" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "unknown"; readonly error: unknown };
type PhaseStopDisposition = "accepted" | "completed" | "unknown";
type NativePhase = {
  readonly uuid: string;
  readonly turnId: WorkerSpec["turnId"];
  state: "submitted" | "queued" | "started" | "completed" | "cancelled";
  result: SDKResultMessage | undefined;
  terminal: Extract<DomainEvent, { type: "turn.completed" }> | undefined;
  accepted: boolean;
  acceptedPromise: Promise<void>;
  accept: () => void;
  rejectAcceptance: (error: unknown) => void;
  readonly outcome: Promise<NativePhaseOutcome>;
  settleOutcome: (outcome: NativePhaseOutcome) => void;
  outcomeValue: NativePhaseOutcome | undefined;
  queueRemovalConfirmed: boolean;
  steering: boolean;
  permissionsOpen: boolean;
  closed: boolean;
};
type ToolUseOwnerWaiter = {
  readonly phase: NativePhase;
  readonly resolve: (phase: NativePhase) => void;
  readonly reject: (error: unknown) => void;
};
type QoderTaskOwner = {
  readonly phase: NativePhase;
  readonly toolUseId: string;
};

type QoderTaskSystemMessage = Extract<
  SDKMessage,
  {
    type: "system";
    subtype:
      | "task_started"
      | "task_progress"
      | "task_notification"
      | "task_updated"
      | "background_tasks_changed";
  }
>;

class UnownedQueuedInputError extends Error {
  constructor() {
    super("Qoder interrupt returned an unowned queued UUID");
    this.name = "UnownedQueuedInputError";
  }
}

function inputText(content: SDKUserMessage["message"]["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("");
}

function userMessage(
  content: string,
  priority: "next" | "later",
  shouldQuery: boolean,
  uuid: string,
): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    priority,
    shouldQuery,
    uuid,
  };
}

function interruptedReply(value: unknown): { stillQueued: string[] } {
  const candidate = record(value);
  if (candidate === undefined)
    throw new Error("Qoder interrupt response was malformed");
  const keys = Object.keys(candidate).sort();
  if (
    keys.join(",") !== "still_queued" ||
    !Array.isArray(candidate.still_queued) ||
    !candidate.still_queued.every(
      (uuid) =>
        typeof uuid === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          uuid,
        ),
    )
  )
    throw new Error(
      "Qoder interrupt response did not match the pinned CLI shape",
    );
  return { stillQueued: candidate.still_queued as string[] };
}

function makeNativePhase(
  turnId: WorkerSpec["turnId"],
  uuid: string,
): NativePhase {
  let accept!: () => void;
  let rejectAcceptance!: (error: unknown) => void;
  let settleOutcome!: (outcome: NativePhaseOutcome) => void;
  const acceptedPromise = new Promise<void>((resolve, reject) => {
    accept = resolve;
    rejectAcceptance = reject;
  });
  // The initial root is observed through start() and may not have a consumer
  // awaiting this promise. Keep a rejection observed while retaining it for a
  // later delivery waiter.
  void acceptedPromise.catch(() => undefined);
  const outcome = new Promise<NativePhaseOutcome>((resolve) => {
    settleOutcome = resolve;
  });
  return {
    uuid,
    turnId,
    state: "submitted",
    result: undefined,
    terminal: undefined,
    accepted: false,
    acceptedPromise,
    accept,
    rejectAcceptance,
    outcome,
    settleOutcome,
    outcomeValue: undefined,
    queueRemovalConfirmed: false,
    steering: false,
    permissionsOpen: true,
    closed: false,
  };
}

type CommandLifecycle = {
  readonly type: "command_lifecycle";
  readonly command_uuid: string;
  readonly state: "queued" | "started" | "completed" | "cancelled";
  readonly uuid: string;
  readonly session_id: string;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function commandLifecycle(value: unknown): CommandLifecycle | undefined {
  const candidate = record(value);
  if (candidate?.type !== "command_lifecycle") return undefined;
  const keys = Object.keys(candidate).sort();
  if (
    keys.join(",") !== "command_uuid,session_id,state,type,uuid" ||
    typeof candidate.command_uuid !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      candidate.command_uuid,
    ) ||
    typeof candidate.uuid !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      candidate.uuid,
    ) ||
    typeof candidate.session_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      candidate.session_id,
    ) ||
    !["queued", "started", "completed", "cancelled"].includes(
      String(candidate.state),
    )
  )
    throw new Error(
      "Qoder command_lifecycle did not match the pinned CLI shape",
    );
  return candidate as unknown as CommandLifecycle;
}

function sdkMessage(value: unknown): value is SDKMessage {
  const candidate = record(value);
  if (candidate === undefined || typeof candidate.type !== "string")
    return false;
  if (
    !["stream_event", "assistant", "user", "system", "result"].includes(
      candidate.type,
    ) ||
    typeof candidate.uuid !== "string" ||
    typeof candidate.session_id !== "string"
  )
    return false;
  if (candidate.type === "stream_event")
    return record(candidate.event) !== undefined;
  if (candidate.type === "assistant" || candidate.type === "user")
    return record(candidate.message) !== undefined;
  if (candidate.type === "system") return typeof candidate.subtype === "string";
  return typeof candidate.subtype === "string";
}

function systemInit(value: unknown): string | undefined {
  const candidate = record(value);
  if (candidate?.type !== "system" || candidate.subtype !== "init")
    return undefined;
  if (typeof candidate.qodercli_version !== "string")
    throw new Error("Qoder system/init omitted qodercli_version");
  return candidate.qodercli_version;
}

function qoderTaskMessage(message: SDKMessage): QoderTaskSystemMessage | null {
  if (message.type !== "system") return null;
  switch (message.subtype) {
    case "task_started":
    case "task_progress":
    case "task_notification":
    case "task_updated":
    case "background_tasks_changed":
      return message;
    default:
      return null;
  }
}

export function createQoderDriver(deps: {
  sdk: QoderSdk;
  expectedCliVersion?: string;
}): AdapterDriverFactory {
  return ({
    emit,
    diagnostics: runtimeDiagnostics,
    markControlUnavailable = () => undefined,
  }) => {
    const diagnosticSink = runtimeDiagnostics;
    let stream: ReturnType<typeof createAsyncQueue<SDKUserMessage>> | null =
      null;
    let query: ReturnType<QoderSdk["query"]> | null = null;
    let abortController: AbortController | null = null;
    let session: HarnessSession<PendingEntry> | null = null;
    let mappingState = createQoderMappingState();
    let terminating = false;
    let runPromise: Promise<void> | null = null;
    let terminationComplete = false;
    let terminationPromise: Promise<void> | null = null;
    let queryClosePromise: Promise<void> | null = null;
    let closedDiagnosticEmitted = false;
    let initialInputUuid: string | null = null;
    const callerMessagesByUuid = new Map<string, CallerMessage>();
    const phasesByUuid = new Map<string, NativePhase>();
    let currentPhase: NativePhase | null = null;
    const phaseByToolUseId = new Map<string, NativePhase>();
    const qoderTaskOwners = new Map<string, QoderTaskOwner | null>();
    const toolUseOwnerWaiters = new Map<string, Set<ToolUseOwnerWaiter>>();
    let initialInputSent = false;
    let nativeSessionId: string | null = null;
    let startSettled = false;
    let resolveStart: (() => void) | undefined;
    let rejectStart: ((error: unknown) => void) | undefined;
    let operationTail: Promise<void> = Promise.resolve();

    async function exclusive<T>(action: () => Promise<T>): Promise<T> {
      const previous = operationTail;
      let release!: () => void;
      operationTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await action();
      } finally {
        release();
      }
    }

    function executionPhaseEffect(phase: NativePhase): OperationEffect {
      return {
        kind: "execution_phase_cancelled",
        sessionId: session!.sessionId,
        turnId: phase.turnId,
      };
    }

    function qoderTaskCause(
      taskId: string,
      toolUseId?: string,
      sealUnknown = false,
    ): QoderTaskOwner | undefined {
      const known = qoderTaskOwners.get(taskId);
      if (known !== undefined) {
        return known !== null &&
          (toolUseId === undefined || known.toolUseId === toolUseId)
          ? known
          : undefined;
      }
      if (toolUseId === undefined) {
        if (sealUnknown) qoderTaskOwners.set(taskId, null);
        return undefined;
      }
      const phase = phaseByToolUseId.get(toolUseId);
      if (phase === undefined) {
        qoderTaskOwners.set(taskId, null);
        return undefined;
      }
      const owner = { phase, toolUseId };
      qoderTaskOwners.set(taskId, owner);
      return owner;
    }

    function qoderTaskActivity(
      taskId: string,
      status: Extract<DomainEvent, { type: "background.activity" }>["status"],
      toolUseId?: string,
      sealUnknown = false,
    ): DomainEvent {
      const owner = qoderTaskCause(taskId, toolUseId, sealUnknown);
      return {
        type: "background.activity",
        sessionId: session!.sessionId,
        source: { kind: "qoder_task", id: taskId },
        status,
        ...(owner === undefined
          ? {}
          : {
              causedBy: {
                turnId: owner.phase.turnId,
                toolCallId: session!.toolCallId(owner.toolUseId),
              },
            }),
      };
    }

    function qoderTaskActivities(
      message: QoderTaskSystemMessage,
    ): DomainEvent[] {
      switch (message.subtype) {
        case "task_started":
        case "task_progress": {
          if (
            typeof message.task_id !== "string" ||
            message.task_id.length === 0
          )
            throw new Error(`Qoder ${message.subtype} omitted task_id`);
          return [
            qoderTaskActivity(
              message.task_id,
              "active",
              typeof message.tool_use_id === "string"
                ? message.tool_use_id
                : undefined,
              message.subtype === "task_started",
            ),
          ];
        }
        case "task_notification": {
          if (
            typeof message.task_id !== "string" ||
            message.task_id.length === 0
          )
            throw new Error("Qoder task_notification omitted task_id");
          const status =
            message.status === "completed"
              ? "completed"
              : message.status === "failed"
                ? "failed"
                : message.status === "stopped"
                  ? "cancelled"
                  : undefined;
          if (status === undefined)
            throw new Error("Qoder task_notification had an unknown status");
          return [
            qoderTaskActivity(
              message.task_id,
              status,
              typeof message.tool_use_id === "string"
                ? message.tool_use_id
                : undefined,
            ),
          ];
        }
        case "task_updated": {
          if (
            typeof message.task_id !== "string" ||
            message.task_id.length === 0
          )
            throw new Error("Qoder task_updated omitted task_id");
          const status = message.patch.status;
          const activityStatus =
            status === "pending" || status === "running" || status === "paused"
              ? "active"
              : status === "completed"
                ? "completed"
                : status === "failed"
                  ? "failed"
                  : status === "killed"
                    ? "cancelled"
                    : undefined;
          return activityStatus === undefined
            ? []
            : [qoderTaskActivity(message.task_id, activityStatus)];
        }
        case "background_tasks_changed": {
          if (!Array.isArray(message.tasks))
            throw new Error("Qoder background_tasks_changed omitted tasks");
          return message.tasks.flatMap((task) => {
            if (typeof task.task_id !== "string" || task.task_id.length === 0)
              throw new Error(
                "Qoder background_tasks_changed contained a task without task_id",
              );
            return [qoderTaskActivity(task.task_id, "active")];
          });
        }
      }
    }

    function phaseIsFailed(phase: NativePhase): boolean {
      return (
        phase.result?.is_error === true ||
        phase.result?.subtype.startsWith("error") === true
      );
    }

    function phaseStopDisposition(
      phase: NativePhase,
    ): PhaseStopDisposition | undefined {
      if (phase.outcomeValue?.kind === "unknown") return "unknown";
      if (
        phase.outcomeValue?.kind === "completed" ||
        phase.state === "completed" ||
        (phase.result !== undefined && !phaseIsFailed(phase))
      )
        return "completed";
      if (
        phase.outcomeValue?.kind === "cancelled" ||
        phase.state === "cancelled"
      )
        return "accepted";
      if (phase.closed) return "unknown";
      return undefined;
    }

    function stopPhasePermissions(phase: NativePhase): void {
      phase.permissionsOpen = false;
      session?.clearPending();
      for (const [toolUseId, waiters] of toolUseOwnerWaiters) {
        for (const waiter of waiters) {
          if (waiter.phase !== phase) continue;
          waiters.delete(waiter);
          waiter.reject(
            new Error(
              "Qoder permission callback belongs to a closed input root",
            ),
          );
        }
        if (waiters.size === 0) toolUseOwnerWaiters.delete(toolUseId);
      }
    }

    function recordToolUseOwners(
      message: SDKMessage,
      phase: NativePhase,
    ): void {
      if (message.type !== "assistant") return;
      for (const block of message.message.content) {
        if (block.type !== "tool_use" || typeof block.id !== "string") continue;
        phaseByToolUseId.set(block.id, phase);
        const waiters = toolUseOwnerWaiters.get(block.id);
        if (waiters === undefined) continue;
        for (const waiter of waiters) {
          waiters.delete(waiter);
          if (waiter.phase === phase) waiter.resolve(phase);
          else
            waiter.reject(
              new Error(
                "Qoder permission callback belongs to a closed input root",
              ),
            );
        }
        if (waiters.size === 0) toolUseOwnerWaiters.delete(block.id);
      }
    }

    function waitForToolUseOwner(
      toolUseId: string,
      phase: NativePhase,
      signal: AbortSignal,
    ): Promise<NativePhase> {
      return new Promise<NativePhase>((resolve, reject) => {
        let waiter!: ToolUseOwnerWaiter;
        const abort = () => {
          const waiters = toolUseOwnerWaiters.get(toolUseId);
          waiters?.delete(waiter);
          if (waiters?.size === 0) toolUseOwnerWaiters.delete(toolUseId);
          waiter.reject(new Error("Qoder permission request was aborted"));
        };
        waiter = {
          phase,
          resolve: (owner) => {
            signal.removeEventListener("abort", abort);
            resolve(owner);
          },
          reject: (error) => {
            signal.removeEventListener("abort", abort);
            reject(error);
          },
        };
        if (signal.aborted) {
          abort();
          return;
        }
        let waiters = toolUseOwnerWaiters.get(toolUseId);
        if (waiters === undefined) {
          waiters = new Set();
          toolUseOwnerWaiters.set(toolUseId, waiters);
        }
        waiters.add(waiter);
        signal.addEventListener("abort", abort, { once: true });
      });
    }

    async function settlePhase(phase: NativePhase): Promise<void> {
      if (phase.closed) return;
      if (phase.state !== "completed" && phase.state !== "cancelled") return;
      stopPhasePermissions(phase);

      let outcome: NativePhaseOutcome;
      if (phase.state === "cancelled") {
        if (phase.result === undefined && !phase.queueRemovalConfirmed) return;
        if (phase.result !== undefined && !phaseIsFailed(phase))
          throw new Error(
            "Qoder cancelled a root input without an error result",
          );
        outcome = { kind: "cancelled" };
        if (session === null) return;
        if (phase.steering) {
          session.beginTurn(phase.turnId);
        } else {
          if (session.turnId !== phase.turnId) session.beginTurn(phase.turnId);
          phase.terminal = session.endTurn("cancelled") as Extract<
            DomainEvent,
            { type: "turn.completed" }
          >;
          emit(phase.terminal);
        }
      } else {
        if (phase.result === undefined) return;
        if (session === null) return;
        if (phaseIsFailed(phase)) {
          if (phase.terminal?.stopReason !== "failed") {
            if (session.turnId !== phase.turnId)
              session.beginTurn(phase.turnId);
            phase.terminal = (await session.failTurn(
              {
                failureCategory: "unclassified",
                retryDisposition: "unknown",
              },
              {
                kind: "turn_failure",
                operation: "run_turn",
                reason: "worker_reported_failure",
                message: makeTextEvidence("worker reported a failed turn"),
              },
            )) as Extract<DomainEvent, { type: "turn.completed" }>;
          }
          if (phase.terminal === undefined)
            throw new Error("Qoder failure ended without a turn result");
          emit(phase.terminal);
          outcome = { kind: "completed" };
        } else {
          if (session.turnId === phase.turnId) {
            const completed = session.endTurn("end_turn");
            if (phase.terminal === undefined)
              phase.terminal = completed as Extract<
                DomainEvent,
                { type: "turn.completed" }
              >;
          } else if (phase.terminal === undefined) {
            session.beginTurn(phase.turnId);
            phase.terminal = session.endTurn("end_turn") as Extract<
              DomainEvent,
              { type: "turn.completed" }
            >;
          }
          emit(phase.terminal);
          outcome = { kind: "completed" };
        }
      }

      phase.closed = true;
      if (currentPhase === phase) currentPhase = null;
      phase.outcomeValue = outcome;
      phase.settleOutcome(outcome);
    }

    function failOpenPhases(error: unknown): void {
      for (const phase of phasesByUuid.values()) {
        if (phase.closed) continue;
        stopPhasePermissions(phase);
        phase.closed = true;
        if (!phase.accepted) {
          phase.rejectAcceptance(
            new WorkerDeliveryFailure(
              "Qoder stream ended before confirming the queued command",
              "unknown",
              { cause: error },
            ),
          );
        }
        const outcome: NativePhaseOutcome = { kind: "unknown", error };
        phase.outcomeValue = outcome;
        phase.settleOutcome(outcome);
      }
      currentPhase = null;
    }

    function makePhase(
      turnId: WorkerSpec["turnId"],
      uuid: string,
    ): NativePhase {
      const phase = makeNativePhase(turnId, uuid);
      phasesByUuid.set(uuid, phase);
      currentPhase = phase;
      return phase;
    }

    async function confirmQueuedCancellation(
      phase: NativePhase,
      stillQueued: readonly string[],
    ): Promise<boolean> {
      if (phase.closed) return true;
      let allRemoved = true;
      for (const uuid of stillQueued) {
        const queuedPhase = phasesByUuid.get(uuid);
        if (queuedPhase === undefined || queuedPhase !== phase)
          throw new UnownedQueuedInputError();
        const cancelled = await query!.cancelAsyncMessage(uuid);
        if (typeof cancelled !== "boolean")
          throw new Error("Qoder cancelAsyncMessage response was malformed");
        if (cancelled) {
          if (phase.state !== "queued" && phase.state !== "cancelled")
            throw new Error(
              "Qoder removed an input that was not in the queued lifecycle state",
            );
          phase.queueRemovalConfirmed = true;
          phase.state = "cancelled";
          await settlePhase(phase);
        } else allRemoved = false;
      }
      return allRemoved;
    }

    async function confirmPhaseStop(
      phase: NativePhase,
      stillQueued: readonly string[],
    ): Promise<PhaseStopDisposition> {
      let disposition = phaseStopDisposition(phase);
      if (disposition !== undefined) return disposition;

      const removed = await confirmQueuedCancellation(phase, stillQueued);
      disposition = phaseStopDisposition(phase);
      if (disposition !== undefined) return disposition;
      if (removed) return "accepted";

      // false means the exact queued UUID was not removed. If its lifecycle
      // now proves the root started, interrupt that active root and check the
      // queue once more before treating the stop request as accepted.
      if (phase.state !== "started" || phase.result !== undefined)
        return "unknown";
      const retry = interruptedReply(await query!.interrupt());
      disposition = phaseStopDisposition(phase);
      if (disposition !== undefined) return disposition;

      const retryRemoved = await confirmQueuedCancellation(
        phase,
        retry.stillQueued,
      );
      disposition = phaseStopDisposition(phase);
      if (disposition !== undefined) return disposition;
      if (!retryRemoved || retry.stillQueued.includes(phase.uuid))
        return "unknown";
      if (phase.state !== "started") return "unknown";
      return "accepted";
    }

    function settleStart(error?: unknown): void {
      if (startSettled) return;
      startSettled = true;
      if (error === undefined) resolveStart?.();
      else rejectStart?.(error);
    }

    function makeCanUseTool(): CanUseTool {
      return async (toolName, input, options) => {
        if (session === null) {
          // 不变式失败：回调只在 start 注册后才可达。
          throw new Error("canUseTool called before session creation");
        }
        if (options.signal.aborted)
          throw new Error("Qoder permission request was aborted");
        const owner = phaseByToolUseId.get(options.toolUseID);
        let phase: NativePhase;
        if (owner !== undefined) {
          phase = owner;
        } else {
          // SDK control 回调与消息迭代独立派发；未知 ID 等待精确 assistant
          // tool_use 消息归属，不按回调抵达时的当前 phase 授权。
          const candidate = currentPhase;
          if (
            candidate === null ||
            candidate.closed ||
            !candidate.permissionsOpen ||
            candidate.turnId !== session.turnId
          )
            throw new Error(
              "Qoder permission callback belongs to a closed input root",
            );
          phase = await waitForToolUseOwner(
            options.toolUseID,
            candidate,
            options.signal,
          );
        }
        if (options.signal.aborted)
          throw new Error("Qoder permission request was aborted");
        if (
          phase !== currentPhase ||
          phase.closed ||
          !phase.permissionsOpen ||
          phase.turnId !== session.turnId
        )
          throw new Error(
            "Qoder permission callback belongs to a closed input root",
          );
        if (owner === undefined) phaseByToolUseId.set(options.toolUseID, phase);
        const entry: PendingEntry = {
          resolve: () => {},
          reject: () => {},
          input,
          toolUseID: options.toolUseID,
          suggestions: options.suggestions,
        };
        return await new Promise<PermissionResult>((resolve, reject) => {
          entry.resolve = resolve;
          entry.reject = reject;
          const permissionId = session!.requestPermission(
            `tool:${toolName}`,
            input,
            derivePermissionOptions(options.suggestions),
            entry,
            session!.toolCallId(options.toolUseID),
          );
          const removePending = () => {
            session?.takePending(permissionId);
            reject(new Error("Qoder permission request was aborted"));
          };
          if (options.signal.aborted) {
            removePending();
          } else {
            options.signal.addEventListener("abort", removePending, {
              once: true,
            });
          }
        });
      };
    }

    async function run(): Promise<void> {
      if (query === null || stream === null || session === null) return;
      let readFailed = false;
      let evidence: Parameters<HarnessSession["failActiveTurn"]>[1];
      try {
        for await (const rawMessage of query) {
          const lifecycle = commandLifecycle(rawMessage);
          if (lifecycle !== undefined) {
            if (nativeSessionId === null) {
              nativeSessionId = lifecycle.session_id;
            } else if (nativeSessionId !== lifecycle.session_id) {
              throw new Error("Qoder command_lifecycle changed session_id");
            }
            const phase = phasesByUuid.get(lifecycle.command_uuid);
            if (phase === undefined)
              throw new Error(
                "Qoder command_lifecycle referenced an unowned input UUID",
              );
            if (phase.closed) {
              if (phase.state !== lifecycle.state)
                throw new Error("Qoder changed a closed input lifecycle");
              continue;
            }
            if (phase.state === lifecycle.state) continue;
            const nextState = lifecycle.state;
            const validTransition =
              (phase.state === "submitted" && nextState === "queued") ||
              (phase.state === "queued" &&
                ["started", "completed", "cancelled"].includes(nextState)) ||
              (phase.state === "started" &&
                ["completed", "cancelled"].includes(nextState));
            if (!validTransition)
              throw new Error("Qoder input lifecycle moved out of order");
            phase.state = nextState;
            if (nextState === "queued") {
              phase.accepted = true;
              phase.accept();
              if (lifecycle.command_uuid === initialInputUuid) settleStart();
            } else if (nextState === "cancelled" && !phase.accepted) {
              const rejection = new WorkerDeliveryFailure(
                "Qoder cancelled the command before confirming it queued",
                "not_accepted",
              );
              phase.rejectAcceptance(rejection);
              if (lifecycle.command_uuid === initialInputUuid)
                settleStart(
                  new WorkerStartFailure(
                    "Qoder cancelled the initial command before queue acceptance",
                    "not_accepted",
                  ),
                );
            }
            await settlePhase(phase);
            continue;
          }
          const version = systemInit(rawMessage);
          if (version !== undefined) {
            if (
              deps.expectedCliVersion !== undefined &&
              version !== deps.expectedCliVersion
            )
              throw new Error(
                `Qoder CLI version ${version} does not match the configured ${deps.expectedCliVersion}`,
              );
            continue;
          }
          if (!sdkMessage(rawMessage))
            throw new Error("Qoder SDK returned an unrecognized message");
          const taskMessage = qoderTaskMessage(rawMessage);
          if (taskMessage !== null) {
            for (const event of qoderTaskActivities(taskMessage)) emit(event);
            continue;
          }
          const phase = currentPhase;
          if (rawMessage.type === "result") {
            if (phase === null || phase.closed)
              throw new Error(
                "Qoder returned a result without an open input root",
              );
            if (phase.result !== undefined)
              throw new Error(
                "Qoder returned multiple results for one input root",
              );
            phase.result = rawMessage;
            if (record(rawMessage.usage) !== undefined)
              session.setUsage(record(rawMessage.usage)!);
            await settlePhase(phase);
            continue;
          }
          if (phase === null || phase.closed) continue;
          recordToolUseOwners(rawMessage, phase);
          const callerReplay =
            rawMessage.type === "user" && rawMessage.uuid === phase.uuid;
          if (phase.terminal !== undefined && !callerReplay) continue;
          if (session.turnId !== phase.turnId) session.setTurnId(phase.turnId);
          let callerMessageId: MessageId | undefined;
          if (rawMessage.type === "user" && rawMessage.uuid !== undefined) {
            const callerMessage = callerMessagesByUuid.get(rawMessage.uuid);
            if (
              callerMessage !== undefined &&
              inputText(rawMessage.message.content) === callerMessage.content
            )
              callerMessageId = callerMessage.messageId;
          }
          const events = await mapSdkMessage(
            session,
            mappingState,
            rawMessage,
            callerMessageId,
          );
          if (
            callerMessageId !== undefined &&
            rawMessage.type === "user" &&
            rawMessage.uuid !== undefined
          )
            callerMessagesByUuid.delete(rawMessage.uuid);
          for (const event of events) {
            if (event.type === "turn.completed") {
              stopPhasePermissions(phase);
              if (phase.terminal !== undefined)
                throw new Error(
                  "Qoder emitted more than one terminal for an input root",
                );
              phase.terminal = event;
            } else {
              emit(event);
            }
          }
        }
      } catch (error) {
        failOpenPhases(error);
        if (!startSettled)
          settleStart(
            error instanceof WorkerStartFailure
              ? error
              : new WorkerStartFailure(
                  "Qoder did not confirm the initial command as queued",
                  initialInputSent ? "unknown" : "not_accepted",
                  { cause: error },
                ),
          );
        if (!terminating) {
          readFailed = true;
          evidence = {
            kind: "stream_failure",
            operation: "receive_worker_stream",
            reason: "read_error",
            message: makeTextEvidence(String(error)),
          };
        }
      }
      if (!readFailed && !terminating) {
        const streamEnd = new Error(
          "Qoder stream ended before queue acceptance",
        );
        failOpenPhases(streamEnd);
        if (!startSettled)
          settleStart(
            new WorkerStartFailure(
              "Qoder stream ended before the initial command was confirmed queued",
              initialInputSent ? "unknown" : "not_accepted",
            ),
          );
        evidence = {
          kind: "lifecycle",
          operation: "worker",
          reason: "exited_unexpectedly",
          message: makeTextEvidence(
            session.turnId === null
              ? "worker stream ended unexpectedly while idle"
              : "worker stream ended before turn completion",
          ),
        };
      }
      if (!terminating) {
        if (session.turnId === null && evidence !== undefined) {
          const unresolved = [...phasesByUuid.values()].find(
            (phase) => phase.outcomeValue?.kind === "unknown",
          );
          if (unresolved !== undefined) session.setTurnId(unresolved.turnId);
        }
        markControlUnavailable();
        if (evidence !== undefined) await session.diagnostic(evidence);
      }
    }

    const driver: WorkerDriver = {
      start(spec: WorkerSpec) {
        const unsupported =
          spec.agent !== undefined
            ? "agent"
            : spec.reasoning !== undefined
              ? "reasoning"
              : spec.sandbox !== undefined
                ? "sandbox"
                : undefined;
        if (unsupported !== undefined)
          throw {
            code: "unsupported_feature",
            feature: unsupported,
          } satisfies MachineError;
        terminating = false;
        terminationComplete = false;
        terminationPromise = null;
        queryClosePromise = null;
        closedDiagnosticEmitted = false;
        initialInputUuid = randomUUID();
        phasesByUuid.clear();
        phaseByToolUseId.clear();
        currentPhase = null;
        operationTail = Promise.resolve();
        callerMessagesByUuid.clear();
        if (spec.messageId !== undefined)
          callerMessagesByUuid.set(initialInputUuid, {
            messageId: spec.messageId,
            content: spec.message,
          });
        initialInputSent = false;
        nativeSessionId = null;
        startSettled = false;
        const accepted = new Promise<void>((resolve, reject) => {
          resolveStart = resolve;
          rejectStart = reject;
        });
        session = new HarnessSession<PendingEntry>({
          sessionId: spec.sessionId,
          emit,
          diagnostics: diagnosticSink,
          onClearPending: (entries) => {
            for (const entry of entries) {
              entry.reject(
                new Error(
                  "Qoder execution phase ended before permission resolution",
                ),
              );
            }
          },
        });
        mappingState = createQoderMappingState();
        session.beginTurn(spec.turnId);
        makePhase(spec.turnId, initialInputUuid);
        abortController = new AbortController();
        stream = createAsyncQueue<SDKUserMessage>();
        const options: QoderOptions = {
          cwd: spec.cwd,
          persistSession: false,
          includePartialMessages: true,
          abortController,
          ...(spec.model === undefined ? {} : { model: spec.model }),
          ...(spec.authorizationMode === "allowAll"
            ? {
                permissionMode: "bypassPermissions",
                allowDangerouslySkipPermissions: true,
              }
            : spec.authorizationMode === "interactive"
              ? {
                  permissionMode: "default",
                  canUseTool: makeCanUseTool(),
                }
              : {}),
        };
        try {
          query = deps.sdk.query({ prompt: stream, options });
        } catch (error) {
          throw new WorkerStartFailure(
            "Qoder query could not be created",
            "not_accepted",
            { cause: error },
          );
        }
        void session.diagnostic({
          kind: "lifecycle",
          operation: "worker",
          reason: "initialized",
        });
        // reader先启动；首条输入等待官方initialize响应后再提交。
        runPromise = run();
        const initialQuery = query;
        const initialStream = stream;
        const initialUuid = initialInputUuid;
        void Promise.resolve()
          .then(async () => {
            await initialQuery.initializationResult();
            if (startSettled || terminating) return;
            initialInputSent = true;
            initialStream.push(
              userMessage(spec.message, "next", true, initialUuid),
            );
          })
          .catch((error: unknown) => {
            settleStart(
              new WorkerStartFailure(
                "Qoder initialization failed before the initial command",
                "not_accepted",
                { cause: error },
              ),
            );
          });
        return accepted;
      },
      async deliver(sessionId, turnId, message, placement, messageId) {
        await exclusive(async () => {
          if (
            session === null ||
            session.sessionId !== sessionId ||
            stream === null ||
            query === null
          )
            throw new WorkerDeliveryFailure(
              "Qoder session is unavailable before command dispatch",
              "not_accepted",
            );

          if (placement === "new_turn") {
            if (session.turnId !== null || currentPhase !== null)
              throw {
                code: "turn_not_active",
                sessionId,
                turnId,
              } satisfies MachineError;
            mappingState = createQoderMappingState();
            const uuid = randomUUID();
            const phase = makePhase(turnId, uuid);
            if (messageId !== undefined)
              callerMessagesByUuid.set(uuid, { messageId, content: message });
            try {
              stream.push(userMessage(message, "next", true, uuid));
            } catch (error) {
              phase.closed = true;
              currentPhase = null;
              callerMessagesByUuid.delete(uuid);
              throw new WorkerDeliveryFailure(
                "Qoder did not receive the command input",
                "not_accepted",
                { cause: error },
              );
            }
            session.beginTurn(turnId);
            await phase.acceptedPromise;
            return;
          }

          const phase = currentPhase;
          if (
            phase === null ||
            phase.closed ||
            phase.turnId !== turnId ||
            (session.turnId !== turnId && phase.terminal === undefined)
          )
            throw {
              code: "turn_not_active",
              sessionId,
              turnId,
            } satisfies MachineError;

          phase.steering = true;
          session.cancelling = true;
          let acknowledgement: { stillQueued: string[] };
          try {
            acknowledgement = interruptedReply(await query.interrupt());
            if (phase.closed && phase.outcomeValue?.kind === "completed")
              throw {
                code: "turn_not_active",
                sessionId,
                turnId,
              } satisfies MachineError;
            const disposition = await confirmPhaseStop(
              phase,
              acknowledgement.stillQueued,
            );
            if (disposition === "completed")
              throw {
                code: "turn_not_active",
                sessionId,
                turnId,
              } satisfies MachineError;
            if (disposition === "unknown")
              throw new Error(
                "Qoder could not confirm stopping the exact active input",
              );
          } catch (error) {
            if (error instanceof UnownedQueuedInputError) {
              phase.steering = false;
              session.cancelling = false;
              throw new WorkerDeliveryFailure(
                "Qoder reported an input outside the active Reins phase",
                "unknown",
                { cause: error },
                phase.outcomeValue?.kind === "cancelled"
                  ? executionPhaseEffect(phase)
                  : undefined,
              );
            }
            if (
              phase.outcomeValue?.kind === "cancelled" ||
              phase.state === "cancelled"
            ) {
              const outcome = phase.outcomeValue ?? (await phase.outcome);
              if (outcome.kind === "unknown")
                throw new WorkerDeliveryFailure(
                  "Qoder stopped the execution but its terminal result is unknown",
                  "not_accepted",
                  { cause: outcome.error ?? error },
                  executionPhaseEffect(phase),
                );
              if (outcome.kind === "completed")
                throw {
                  code: "turn_not_active",
                  sessionId,
                  turnId,
                } satisfies MachineError;
              if (session.turnId !== turnId) session.beginTurn(turnId);
              const cancelled = session.endTurn("cancelled");
              emit(cancelled);
              throw new WorkerDeliveryFailure(
                "Qoder stopped the execution but did not confirm the continuation request",
                "not_accepted",
                { cause: error },
                executionPhaseEffect(phase),
              );
            }
            if (phaseStopDisposition(phase) === "completed") {
              const outcome = phase.outcomeValue ?? (await phase.outcome);
              if (outcome.kind === "unknown")
                throw new WorkerDeliveryFailure(
                  "Qoder completed the execution but its terminal result is unknown",
                  "unknown",
                  { cause: outcome.error ?? error },
                );
              if (outcome.kind === "cancelled")
                throw new WorkerDeliveryFailure(
                  "Qoder stopped the execution but did not confirm the continuation request",
                  "not_accepted",
                  { cause: error },
                  executionPhaseEffect(phase),
                );
              throw {
                code: "turn_not_active",
                sessionId,
                turnId,
              } satisfies MachineError;
            }
            phase.steering = false;
            session.cancelling = false;
            throw new WorkerDeliveryFailure(
              "Qoder interrupt acceptance is unknown; continuation was not sent",
              "unknown",
              { cause: error },
            );
          }

          const outcome = phase.outcomeValue ?? (await phase.outcome);
          if (outcome.kind === "completed")
            throw {
              code: "turn_not_active",
              sessionId,
              turnId,
            } satisfies MachineError;
          if (outcome.kind === "unknown")
            throw new WorkerDeliveryFailure(
              "Qoder execution stop could not be confirmed",
              "unknown",
              { cause: outcome.error },
            );

          if (session.turnId !== turnId) session.beginTurn(turnId);
          const uuid = randomUUID();
          const continuation = makePhase(turnId, uuid);
          if (messageId !== undefined)
            callerMessagesByUuid.set(uuid, { messageId, content: message });
          try {
            stream.push(userMessage(message, "next", true, uuid));
          } catch (error) {
            continuation.closed = true;
            currentPhase = null;
            callerMessagesByUuid.delete(uuid);
            const cancelled = session.endTurn("cancelled");
            emit(cancelled);
            throw new WorkerDeliveryFailure(
              "Qoder stopped the previous execution but rejected the continuation before input dispatch",
              "not_accepted",
              { cause: error },
              executionPhaseEffect(phase),
            );
          }
          try {
            await continuation.acceptedPromise;
          } catch (error) {
            if (
              error instanceof WorkerDeliveryFailure &&
              error.acceptance === "not_accepted"
            ) {
              if (session.turnId !== turnId) session.beginTurn(turnId);
              const cancelled = session.endTurn("cancelled");
              emit(cancelled);
              throw new WorkerDeliveryFailure(
                "Qoder stopped the previous execution but did not queue the continuation",
                "not_accepted",
                { cause: error },
                executionPhaseEffect(phase),
              );
            }
            throw new WorkerDeliveryFailure(
              "Qoder continuation acceptance is unknown after stopping the previous execution",
              "unknown",
              { cause: error },
              executionPhaseEffect(phase),
            );
          }
        });
      },
      async interrupt(sessionId, turnId) {
        await exclusive(async () => {
          if (
            session === null ||
            session.sessionId !== sessionId ||
            query === null
          )
            throw {
              code: "turn_not_active",
              sessionId,
              turnId,
            } satisfies MachineError;
          const phase = currentPhase;
          if (
            phase === null ||
            phase.closed ||
            phase.turnId !== turnId ||
            (session.turnId !== turnId && phase.terminal === undefined)
          )
            throw {
              code: "turn_not_active",
              sessionId,
              turnId,
            } satisfies MachineError;
          session.cancelling = true;
          try {
            const acknowledgement = interruptedReply(await query.interrupt());
            const disposition = await confirmPhaseStop(
              phase,
              acknowledgement.stillQueued,
            );
            if (disposition === "completed")
              throw {
                code: "turn_not_active",
                sessionId,
                turnId,
              } satisfies MachineError;
            if (disposition === "unknown")
              throw new Error(
                "Qoder could not confirm stopping the exact active input",
              );
          } catch (error) {
            const disposition = phaseStopDisposition(phase);
            if (disposition === "completed")
              throw {
                code: "turn_not_active",
                sessionId,
                turnId,
              } satisfies MachineError;
            throw new WorkerInterruptFailure(
              "Qoder interrupt acceptance is unknown",
              "unknown",
              { cause: error },
            );
          }
        });
      },
      resolvePermission(sessionId, permissionId, resolution) {
        const entry = session?.takePending(permissionId, resolution);
        if (entry === undefined) {
          if (session !== null) {
            void session.diagnostic({
              kind: "authorization_failure",
              operation: "resolve_permission",
              stage: "lookup",
              reason: "target_lost",
              permissionId,
            });
          }
          throw {
            code: "permission_not_pending",
            sessionId,
            permissionId,
          } satisfies MachineError;
        }
        if (resolution.outcome === "allow") {
          const sessionRules =
            resolution.scope === "session"
              ? (entry.suggestions ?? []).filter(
                  (update) =>
                    update.type === "addRules" &&
                    update.destination === "session",
                )
              : [];
          entry.resolve({
            behavior: "allow",
            updatedInput: entry.input,
            ...(entry.toolUseID === undefined
              ? {}
              : { toolUseID: entry.toolUseID }),
            ...(sessionRules.length > 0
              ? { updatedPermissions: sessionRules }
              : {}),
          });
        } else {
          if (resolution.feedback === undefined) {
            entry.reject(
              new Error("deny resolution missing caller-provided text"),
            );
            return;
          }
          entry.resolve({
            behavior: "deny",
            message: resolution.feedback,
            ...(entry.toolUseID === undefined
              ? {}
              : { toolUseID: entry.toolUseID }),
          });
        }
      },
      async terminate(sessionId) {
        void sessionId;
        if (terminationComplete) return;
        if (terminationPromise !== null) return terminationPromise;

        const pending = (async () => {
          terminating = true;
          failOpenPhases(
            new Error("Qoder worker was terminated before queue acceptance"),
          );
          // 先结束 Reins 提供的 prompt，再主动调用并保存 SDK 的首次 close。
          // SDK 的 AbortSignal listener 会 fire-and-forget close；一旦它先置
          // closed，后续 close() 会直接返回，无法等待首次关闭完成。
          stream?.end();
          if (query !== null && queryClosePromise === null) {
            try {
              queryClosePromise = Promise.resolve(query.close());
            } catch (error) {
              queryClosePromise = Promise.reject(error);
            }
          }
          abortController?.abort();
          if (queryClosePromise !== null) await queryClosePromise;
          await runPromise;
          if (session !== null && !closedDiagnosticEmitted) {
            await session.diagnostic({
              kind: "lifecycle",
              operation: "worker",
              reason: "closed",
            });
            closedDiagnosticEmitted = true;
          }
          terminationComplete = true;
          query = null;
          queryClosePromise = null;
          abortController = null;
          stream = null;
          runPromise = null;
          session = null;
        })();
        terminationPromise = pending;
        try {
          await pending;
        } finally {
          if (terminationPromise === pending) terminationPromise = null;
        }
      },
    };
    return driver;
  };
}
