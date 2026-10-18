import type { JobRegisteredData } from "@deepseek-ai/dsh-jobs";
import type {} from "@deepseek-ai/dsh-tool-jobs";
import { HarnessSession, type DiagnosticSink } from "@reins/adapter-kit";
import type {
  BackgroundActivityCause,
  BackgroundActivitySource,
  AdapterDriverFactory,
  HarnessFailure,
  MachineError,
  MessageContent,
  MessageContentPart,
  MessageId,
  PermissionId,
  PermissionResolution,
  SessionId,
  TurnId,
  ToolCallId,
  WorkerDriver,
  WorkerSpec,
} from "@reins/protocol";
import {
  makeTextEvidence,
  WorkerDeliveryFailure,
  WorkerInterruptFailure,
  WorkerPermissionFailure,
  WorkerStartFailure,
  isPermissionResolutionAllowed,
} from "@reins/protocol";

import { DshHostClient, DshHostRequestError } from "./dsh-host-client.ts";
import { failureFromSafeFacts, safeFailureFrom } from "./dsh-host-protocol.ts";
import type { DshHostEvent, DshHostResponse } from "./dsh-host-protocol.ts";
import { decodeDshModelId } from "./model-catalog.ts";

type AssistantSessionEvent = Extract<
  import("@deepseek-ai/dsh-session").SessionEvent,
  { readonly type: "assistant/message" }
>;

type PendingAssistantMessage = {
  readonly event: AssistantSessionEvent;
  readonly turnId: TurnId;
};

type NativeToolCall = {
  readonly turnId: TurnId;
  readonly toolCallId: ToolCallId;
};

type NativeJob = {
  readonly source: BackgroundActivitySource;
  readonly causedBy?: BackgroundActivityCause;
};

type NativeApproval = {
  readonly approvalId: string;
  readonly callId?: string;
  readonly toolCallId?: ToolCallId;
};

type NativeTurnBindingResult =
  | { readonly status: "bound"; readonly turnId: TurnId }
  | {
      readonly status: "unavailable";
      readonly turnId?: TurnId;
      readonly cause?: unknown;
    };

type PendingNativeTurnBinding = {
  readonly promise: Promise<NativeTurnBindingResult>;
  resolve(result: NativeTurnBindingResult): void;
};

function createNativeTurnBinding(): PendingNativeTurnBinding {
  let resolvePromise!: (result: NativeTurnBindingResult) => void;
  const promise = new Promise<NativeTurnBindingResult>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

type TurnFailureEvidence = Parameters<HarnessSession["failTurn"]>[1];

function turnFailureEvidence(): TurnFailureEvidence {
  return {
    kind: "turn_failure",
    operation: "run_turn",
    reason: "worker_reported_failure",
    message: makeTextEvidence(
      "The official DSH turn did not complete normally",
    ),
  };
}

function textContent(
  content: readonly { readonly type: string; readonly text?: string }[],
): string | null {
  const textBlocks = content.filter(
    (block): block is { readonly type: "text"; readonly text: string } =>
      block.type === "text" && typeof block.text === "string",
  );
  return textBlocks.length === 0
    ? null
    : textBlocks.map((block) => block.text).join("");
}

function nativeContent(
  content: readonly import("@deepseek-ai/dsh-llm").ContentBlock[],
  session: HarnessSession<NativeApproval>,
): MessageContent {
  const parts: MessageContentPart[] = content.map((block) => {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "reasoning":
        return { type: "thinking", text: block.text };
      case "tool-call":
        return {
          type: "tool_call",
          toolCallId: session.toolCallId(block.id),
        };
      default: {
        const nativeBlock: unknown = block;
        const nativeType =
          isRecord(nativeBlock) && typeof nativeBlock.type === "string"
            ? nativeBlock.type
            : "unknown";
        return {
          type: "opaque",
          harness: "dsh",
          nativeType,
          value: nativeBlock,
        };
      }
    }
  });
  return parts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createDshDriver(): AdapterDriverFactory {
  return ({
    emit,
    beginAutonomousTurn,
    diagnostics,
    markControlUnavailable = () => undefined,
  }) => {
    const diagnosticSink: DiagnosticSink = diagnostics;
    let host: DshHostClient | undefined;
    let session: HarnessSession<NativeApproval> | undefined;
    let disposeHostEvents: (() => void) | undefined;
    let disposeHostExit: (() => void) | undefined;
    let terminating = false;
    let termination: Promise<void> | undefined;
    let startAccepted = false;
    let controlUnavailable = false;
    const attemptMessageIds = new Map<string, string>();
    const attemptTurns = new Map<string, TurnId>();
    const attemptByEventSeq = new Map<number, string>();
    const assistantByEventSeq = new Map<number, PendingAssistantMessage>();
    const nativeTurns = new Map<number, TurnId>();
    const pendingNativeTurnBindings = new Map<
      number,
      PendingNativeTurnBinding
    >();
    const nativeToolCalls = new Map<string, NativeToolCall>();
    const nativeJobs = new Map<string, NativeJob>();
    const nativeApprovals = new Map<PermissionId, NativeApproval>();
    let hostEventQueue = Promise.resolve();

    function markHostControlUnavailable(): void {
      if (controlUnavailable || session === undefined) return;
      controlUnavailable = true;
      markControlUnavailable();
    }

    function handleHostExit(): void {
      if (terminating || !startAccepted || session === undefined) return;
      markHostControlUnavailable();
      void session
        .diagnostic({
          kind: "lifecycle",
          operation: "worker",
          reason: "exited_unexpectedly",
          message: makeTextEvidence(
            "The official DSH host exited unexpectedly",
          ),
        })
        .catch(() => undefined);
    }

    function turnForEvent(event: DshHostEvent): TurnId | undefined {
      if ("turnId" in event && event.turnId !== undefined) return event.turnId;
      return "nativeTurn" in event && event.nativeTurn !== undefined
        ? nativeTurns.get(event.nativeTurn)
        : undefined;
    }

    async function waitForNativeTurnBinding(
      turnId: TurnId,
    ): Promise<NativeTurnBindingResult | undefined> {
      const pending = Array.from(pendingNativeTurnBindings.values());
      if (pending.length === 0) return undefined;
      const results = await Promise.all(
        pending.map((binding) => binding.promise),
      );
      return (
        results.find((result) => result.turnId === turnId) ?? {
          status: "unavailable",
          cause: new Error("The autonomous DSH turn target did not match"),
        }
      );
    }

    function jobCause(data: JobRegisteredData): NativeJob {
      const rootCallId = data.toolCall?.rootCallId;
      const call =
        rootCallId === undefined ? undefined : nativeToolCalls.get(rootCallId);
      return {
        source: { kind: "tool-jobs", id: String(data.jobId) },
        ...(call === undefined
          ? {}
          : {
              causedBy: {
                turnId: call.turnId,
                toolCallId: call.toolCallId,
              },
            }),
      };
    }

    function emitJobActivity(
      data: JobRegisteredData,
      status: "active" | "completed" | "failed" | "cancelled",
    ): NativeJob {
      const job = nativeJobs.get(String(data.jobId)) ?? jobCause(data);
      nativeJobs.set(String(data.jobId), job);
      if (session === undefined) return job;
      emit({
        type: "background.activity",
        sessionId: session.sessionId,
        source: job.source,
        status,
        ...(job.causedBy === undefined ? {} : { causedBy: job.causedBy }),
      });
      return job;
    }

    function nativeNoticeJobId(
      event: Extract<
        import("@deepseek-ai/dsh-session").SessionEvent,
        { readonly type: "user/message" }
      >,
    ): string | undefined {
      const text = textContent(event.data.content);
      return /^background job ([^\s]+)/u.exec(text ?? "")?.[1];
    }

    function flushAssistantMessage(seq: number): void {
      const pending = assistantByEventSeq.get(seq);
      const attemptId = attemptByEventSeq.get(seq);
      if (
        pending === undefined ||
        attemptId === undefined ||
        session === undefined
      )
        return;
      assistantByEventSeq.delete(seq);
      const message = pending.event.data.message;
      const content = textContent(message.content);
      const nativeId =
        attemptMessageIds.get(attemptId) ??
        pending.event.data.message.id ??
        attemptId;
      const messageId = session.messageId(nativeId);
      if (content !== null) session.setFinalText(content);
      emit({
        type: "message",
        sessionId: session.sessionId,
        turnId: pending.turnId,
        messageId,
        role: "worker",
        content: nativeContent(message.content, session),
      });
      if ("usage" in pending.event.data && isRecord(pending.event.data.usage))
        session.setUsage(pending.event.data.usage);
      attemptByEventSeq.delete(seq);
    }

    function handleAssistantFrame(
      event: Extract<DshHostEvent, { type: "assistant-stream" }>,
    ): void {
      if (session === undefined) return;
      const { frame } = event;
      const turnId = turnForEvent(event);
      const attemptId = String(frame.attemptId);
      if (frame.type === "start") {
        if (turnId !== undefined) attemptTurns.set(attemptId, turnId);
        attemptMessageIds.set(attemptId, `dsh-attempt:${attemptId}`);
        return;
      }
      if (frame.type === "chunk") {
        const activeTurnId = turnId ?? attemptTurns.get(attemptId);
        if (
          frame.chunk.type !== "text-delta" ||
          activeTurnId === undefined ||
          activeTurnId !== session.turnId
        )
          return;
        emit({
          type: "text.delta",
          sessionId: session.sessionId,
          turnId: activeTurnId,
          messageId: session.messageId(
            attemptMessageIds.get(attemptId) ?? `dsh-attempt:${attemptId}`,
          ),
          delta: frame.chunk.text,
        });
        return;
      }
      attemptTurns.delete(attemptId);
      if (
        frame.outcome.kind === "committed" &&
        frame.outcome.eventType === "assistant/message"
      ) {
        attemptByEventSeq.set(frame.outcome.seq, attemptId);
        flushAssistantMessage(frame.outcome.seq);
      }
    }

    function handleTurnEnd(
      event: Extract<
        import("@deepseek-ai/dsh-session").SessionEvent,
        { readonly type: "turn/end" }
      >,
      turnId: TurnId | undefined,
    ): void {
      if (
        session === undefined ||
        turnId === undefined ||
        session.turnId !== turnId
      )
        return;
      const reason = event.data.reason;
      if (reason.kind === "completed") {
        emit(session.endTurn("end_turn"));
      } else if (reason.kind === "aborted") {
        emit(session.endTurn("cancelled"));
      } else {
        const failure =
          reason.kind === "error"
            ? failureFromSafeFacts(safeFailureFrom(reason.error))
            : ({
                failureCategory: "unclassified",
                retryDisposition: "unknown",
              } satisfies HarnessFailure);
        void session
          .failTurn(failure, turnFailureEvidence())
          .then(emit)
          .catch(() => undefined);
      }
    }

    async function handleSessionEvent(
      event: Extract<DshHostEvent, { type: "session-event" }>,
    ): Promise<void> {
      if (session === undefined) return;
      const turnId = turnForEvent(event);
      const nativeEvent = event.event;
      if (nativeEvent.type === "turn/end") {
        handleTurnEnd(nativeEvent, turnId);
        if (event.nativeTurn !== undefined)
          nativeTurns.delete(event.nativeTurn);
        return;
      }
      if (nativeEvent.type === "job/registered") {
        emitJobActivity(nativeEvent.data, "active");
        return;
      }
      if (nativeEvent.type === "job/settled") {
        const status =
          nativeEvent.data.status === "completed"
            ? "completed"
            : nativeEvent.data.status === "failed"
              ? "failed"
              : "cancelled";
        emitJobActivity(nativeEvent.data, status);
        return;
      }
      if (nativeEvent.type === "assistant/message") {
        if (turnId === undefined || turnId !== session.turnId) return;
        assistantByEventSeq.set(nativeEvent.seq, {
          event: nativeEvent,
          turnId,
        });
        flushAssistantMessage(nativeEvent.seq);
        return;
      }
      if (nativeEvent.type === "user/message") {
        if (event.callerMessageId !== undefined) {
          if (turnId === undefined || turnId !== session.turnId) return;
          emit({
            type: "message",
            sessionId: session.sessionId,
            turnId,
            messageId: event.callerMessageId,
            role: "caller",
            content: nativeContent(nativeEvent.data.content, session),
          });
          return;
        }
        if (
          nativeEvent.data.source.kind !== "tool-jobs" ||
          nativeEvent.data.source.form !== "notice"
        )
          return;
        const nativeJobId = nativeNoticeJobId(nativeEvent);
        const job =
          nativeJobId === undefined ? undefined : nativeJobs.get(nativeJobId);
        const source = job?.source ?? {
          kind: "tool-jobs",
          id: nativeJobId ?? String(nativeEvent.data.id),
        };
        let messageTurnId = turnId;
        if (messageTurnId === undefined) {
          if (
            event.nativeTurn === undefined ||
            beginAutonomousTurn === undefined
          )
            return;
          const nativeTurn = event.nativeTurn;
          const binding = createNativeTurnBinding();
          pendingNativeTurnBindings.set(nativeTurn, binding);
          try {
            messageTurnId = await beginAutonomousTurn({
              source,
              ...(job?.causedBy === undefined
                ? {}
                : { causedBy: job.causedBy }),
            });
            session.beginTurn(messageTurnId);
            nativeTurns.set(nativeTurn, messageTurnId);
          } catch (error) {
            binding.resolve({
              status: "unavailable",
              ...(messageTurnId === undefined ? {} : { turnId: messageTurnId }),
              cause: error,
            });
            if (pendingNativeTurnBindings.get(nativeTurn) === binding)
              pendingNativeTurnBindings.delete(nativeTurn);
            const currentHost = host;
            if (currentHost !== undefined) {
              try {
                const response = await currentHost.request({
                  type: "cancel-turn-binding",
                  nativeTurn,
                });
                if (response.type !== "binding-cancelled")
                  throw new Error(
                    "The official DSH host did not release the pending turn binding",
                  );
              } catch (cleanupCause) {
                throw new AggregateError(
                  [error, cleanupCause],
                  "The autonomous DSH turn could not be bound or released",
                );
              }
            }
            throw error;
          }
          try {
            const currentHost = host;
            if (currentHost === undefined)
              throw new Error("The official DSH host is unavailable");
            const response = await currentHost.request({
              type: "bind-turn",
              nativeTurn,
              turnId: messageTurnId,
            });
            if (response.type !== "bound")
              throw new Error("The official DSH host did not bind the turn");
            binding.resolve({ status: "bound", turnId: messageTurnId });
          } catch (error) {
            binding.resolve({
              status: "unavailable",
              turnId: messageTurnId,
              cause: error,
            });
          } finally {
            if (pendingNativeTurnBindings.get(nativeTurn) === binding)
              pendingNativeTurnBindings.delete(nativeTurn);
          }
        }
        if (messageTurnId !== session.turnId) return;
        emit({
          type: "message",
          sessionId: session.sessionId,
          turnId: messageTurnId,
          messageId: session.messageId(nativeEvent.data.id),
          role: "harness",
          source,
          content: nativeContent(nativeEvent.data.content, session),
        });
        return;
      }
      if (nativeEvent.type === "tool/result") {
        const nativeCallId = nativeEvent.data.message.source.callId;
        const name = session.toolNames.get(nativeCallId);
        const nativeCall = nativeToolCalls.get(nativeCallId);
        if (name === undefined || nativeCall === undefined) return;
        emit({
          type: "tool.completed",
          sessionId: session.sessionId,
          turnId: nativeCall.turnId,
          toolCallId: nativeCall.toolCallId,
          name,
          result: nativeContent(nativeEvent.data.message.content, session),
          ...(nativeEvent.data.error === undefined
            ? {}
            : { error: nativeEvent.data.error }),
          isError: nativeEvent.data.message.isError === true,
        });
        session.toolNames.delete(nativeCallId);
        nativeToolCalls.delete(nativeCallId);
        return;
      }
      if (turnId === undefined || turnId !== session.turnId) return;
      if (nativeEvent.type === "tool/call") {
        session.toolNames.set(nativeEvent.data.callId, nativeEvent.data.name);
        const toolCallId = session.toolCallId(nativeEvent.data.callId);
        nativeToolCalls.set(nativeEvent.data.callId, { turnId, toolCallId });
        emit({
          type: "tool.requested",
          sessionId: session.sessionId,
          turnId,
          toolCallId,
          name: nativeEvent.data.name,
          input: nativeEvent.data.arguments,
        });
      }
    }

    async function handleHostEvent(event: DshHostEvent): Promise<void> {
      if (event.type === "assistant-stream") {
        handleAssistantFrame(event);
      } else if (event.type === "session-event") {
        await handleSessionEvent(event);
      } else if (event.type === "approval-requested") {
        if (session === undefined || session.turnId !== event.turnId) {
          try {
            await host?.request({
              type: "resolve-approval",
              approvalId: event.approvalId,
              outcome: "unavailable",
            });
          } catch {
            // 原生问询因目标回合已失效而失败关闭。
          }
          return;
        }
        const nativeCall =
          event.callId === undefined
            ? undefined
            : nativeToolCalls.get(event.callId);
        const approval: NativeApproval = {
          approvalId: event.approvalId,
          ...(event.callId === undefined ? {} : { callId: event.callId }),
          ...(nativeCall === undefined
            ? {}
            : { toolCallId: nativeCall.toolCallId }),
        };
        const permissionId = session.requestPermission(
          `tool:${event.toolName}`,
          {
            toolName: event.toolName,
            ...(event.reason === undefined ? {} : { reason: event.reason }),
          },
          [
            { outcome: "allow", scope: "once" },
            { outcome: "deny", feedback: false },
          ],
          approval,
          nativeCall?.toolCallId,
        );
        nativeApprovals.set(permissionId, approval);
      } else if (event.type === "fatal") {
        if (!startAccepted || terminating) return;
        markHostControlUnavailable();
        void session
          ?.diagnostic({
            kind: "lifecycle",
            operation: "worker",
            reason: "exited_unexpectedly",
            message: makeTextEvidence(
              "The official DSH host reported a fatal failure",
            ),
          })
          .catch(() => undefined);
      }
    }

    function enqueueHostEvent(event: DshHostEvent): void {
      hostEventQueue = hostEventQueue
        .then(() => handleHostEvent(event))
        .catch(() => {
          markHostControlUnavailable();
        });
    }

    function assertHostResponse(
      response: DshHostResponse,
    ): Extract<DshHostResponse, { type: "accepted" }> {
      if (response.type === "accepted") return response;
      throw new DshHostRequestError(
        "The official DSH did not accept the request input",
        response.type === "rejected" ? response.acceptance : "unknown",
        "failure" in response ? response.failure : undefined,
      );
    }

    const driver: WorkerDriver = {
      async start(spec: WorkerSpec): Promise<void> {
        const unsupported =
          spec.agent !== undefined
            ? "agent"
            : spec.sandbox !== undefined
              ? "sandbox"
              : undefined;
        if (unsupported !== undefined)
          throw {
            code: "unsupported_feature",
            feature: unsupported,
          } satisfies MachineError;
        if (spec.captureHarnessStderr === true)
          throw {
            code: "unsupported_feature",
            feature: "capture_harness_stderr",
          } satisfies MachineError;

        terminating = false;
        startAccepted = false;
        controlUnavailable = false;
        hostEventQueue = Promise.resolve();
        attemptMessageIds.clear();
        attemptTurns.clear();
        attemptByEventSeq.clear();
        assistantByEventSeq.clear();
        nativeTurns.clear();
        pendingNativeTurnBindings.clear();
        nativeToolCalls.clear();
        nativeJobs.clear();
        nativeApprovals.clear();
        session = new HarnessSession({
          sessionId: spec.sessionId,
          emit,
          diagnostics: diagnosticSink,
          onClearPending(attachments) {
            for (const approval of attachments) {
              for (const [permissionId, pending] of nativeApprovals) {
                if (pending === approval) nativeApprovals.delete(permissionId);
              }
            }
          },
        });
        session.beginTurn(spec.turnId);
        let hostStartSent = false;
        try {
          const modelRoute =
            spec.model === undefined ? undefined : decodeDshModelId(spec.model);
          const environment =
            spec.authorizationMode === "allowAll"
              ? { ...process.env, DSH_PERMISSION_MODE: "danger-full-access" }
              : process.env;
          host = new DshHostClient({ cwd: spec.cwd, env: environment });
          disposeHostEvents = host.onEvent(enqueueHostEvent);
          disposeHostExit = host.onExit(handleHostExit);
          await host.readyHost();
          hostStartSent = true;
          const response = await host.request({
            type: "start",
            sessionId: spec.sessionId,
            turnId: spec.turnId,
            ...(spec.messageId === undefined
              ? {}
              : { messageId: spec.messageId }),
            message: spec.message,
            cwd: spec.cwd,
            ...(modelRoute === undefined
              ? {}
              : { provider: modelRoute.provider, model: modelRoute.model }),
            ...(spec.reasoning === undefined
              ? {}
              : { reasoningEffort: spec.reasoning }),
          });
          assertHostResponse(response);
          startAccepted = true;
        } catch (error) {
          const acceptance =
            error instanceof DshHostRequestError
              ? error.acceptance
              : hostStartSent
                ? "unknown"
                : "not_accepted";
          throw new WorkerStartFailure(
            "The official DSH host did not confirm initial message acceptance",
            acceptance,
            { cause: error },
          );
        }
      },
      async deliver(
        sessionId: SessionId,
        turnId: TurnId,
        message: string,
        placement: "active_turn" | "new_turn",
        messageId?: MessageId,
      ): Promise<void> {
        if (
          host === undefined ||
          session === undefined ||
          session.sessionId !== sessionId
        )
          throw { code: "session_not_found", sessionId } satisfies MachineError;
        if (placement === "new_turn") session.beginTurn(turnId);
        if (placement === "active_turn") {
          const binding = await waitForNativeTurnBinding(turnId);
          if (binding?.status === "unavailable")
            throw new WorkerDeliveryFailure(
              "The official DSH host could not confirm the exact autonomous turn",
              "not_accepted",
              binding.cause === undefined
                ? undefined
                : { cause: binding.cause },
            );
        }
        try {
          const response = await host.request({
            type: "deliver",
            placement,
            turnId,
            ...(messageId === undefined ? {} : { messageId }),
            message,
          });
          assertHostResponse(response);
        } catch (error) {
          const acceptance =
            error instanceof DshHostRequestError ? error.acceptance : "unknown";
          if (placement === "new_turn" && acceptance === "not_accepted")
            session.turnId = null;
          throw new WorkerDeliveryFailure(
            `The official DSH host did not confirm ${placement} message acceptance`,
            acceptance,
            { cause: error },
          );
        }
      },
      async interrupt(sessionId: SessionId, turnId: TurnId): Promise<void> {
        if (
          host === undefined ||
          session === undefined ||
          session.sessionId !== sessionId
        )
          throw { code: "session_not_found", sessionId } satisfies MachineError;
        const binding = await waitForNativeTurnBinding(turnId);
        if (binding?.status === "unavailable")
          throw new WorkerInterruptFailure(
            "The official DSH host could not confirm the exact autonomous turn",
            "not_accepted",
            binding.cause === undefined ? undefined : { cause: binding.cause },
          );
        try {
          const response = await host.request({ type: "interrupt", turnId });
          if (response.type === "interrupted") return;
          throw new DshHostRequestError(
            "The official DSH host did not confirm interruption",
            response.type === "rejected" ? response.acceptance : "unknown",
            "failure" in response ? response.failure : undefined,
          );
        } catch (error) {
          const acceptance =
            error instanceof DshHostRequestError ? error.acceptance : "unknown";
          throw new WorkerInterruptFailure(
            "The official DSH host did not confirm interruption acceptance",
            acceptance,
            { cause: error },
          );
        }
      },
      async resolvePermission(
        sessionId: SessionId,
        permissionId: PermissionId,
        resolution: PermissionResolution,
      ): Promise<void> {
        const currentSession = session;
        const currentHost = host;
        if (
          currentSession === undefined ||
          currentSession.sessionId !== sessionId ||
          currentHost === undefined
        )
          throw new WorkerPermissionFailure(
            "The official DSH approval request is unavailable",
            "not_accepted",
          );
        const approval = nativeApprovals.get(permissionId);
        if (approval === undefined)
          throw {
            code: "permission_not_pending",
            sessionId,
            permissionId,
          } satisfies MachineError;
        if (
          !isPermissionResolutionAllowed(
            [
              { outcome: "allow", scope: "once" },
              { outcome: "deny", feedback: false },
            ],
            resolution,
          )
        )
          throw {
            code: "permission_resolution_mismatch",
            sessionId,
            permissionId,
          } satisfies MachineError;
        const expectedOutcome =
          resolution.outcome === "allow" ? "allowed-once" : "rejected";
        try {
          const response = await currentHost.request({
            type: "resolve-approval",
            approvalId: approval.approvalId,
            outcome: expectedOutcome,
          });
          if (
            response.type !== "approval-decided" ||
            response.approvalId !== approval.approvalId
          )
            throw new DshHostRequestError(
              "The official DSH did not confirm its approval decision",
              "unknown",
            );
          if (response.outcome !== expectedOutcome)
            throw new WorkerPermissionFailure(
              "The official DSH approval request settled with another outcome",
              "not_accepted",
            );
          currentSession.takePending(permissionId, resolution);
          nativeApprovals.delete(permissionId);
        } catch (error) {
          if (error instanceof WorkerPermissionFailure) throw error;
          const acceptance =
            error instanceof DshHostRequestError ? error.acceptance : "unknown";
          throw new WorkerPermissionFailure(
            "The official DSH approval decision was not confirmed",
            acceptance,
            { cause: error },
          );
        }
      },
      async terminate(sessionId: SessionId): Promise<void> {
        if (session === undefined || session.sessionId !== sessionId) return;
        if (termination !== undefined) return termination;
        terminating = true;
        const currentHost = host;
        termination = (async () => {
          try {
            if (currentHost !== undefined) await currentHost.close();
            await hostEventQueue;
          } finally {
            disposeHostEvents?.();
            disposeHostExit?.();
            disposeHostEvents = undefined;
            disposeHostExit = undefined;
            host = undefined;
          }
        })();
        return termination;
      },
    };
    return driver;
  };
}
