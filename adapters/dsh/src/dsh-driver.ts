import { HarnessSession, type DiagnosticSink } from "@reins/adapter-kit";
import type {
  AdapterDriverFactory,
  HarnessFailure,
  MachineError,
  MessageContent,
  MessageContentPart,
  MessageId,
  SessionId,
  TurnId,
  WorkerDriver,
  WorkerSpec,
} from "@reins/protocol";
import {
  makeTextEvidence,
  WorkerDeliveryFailure,
  WorkerStartFailure,
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

function streamFailureEvidence(): TurnFailureEvidence {
  return {
    kind: "stream_failure",
    operation: "receive_worker_stream",
    reason: "read_error",
    message: makeTextEvidence("The official DSH host stopped unexpectedly"),
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
  session: HarnessSession,
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
  return ({ emit, diagnostics }) => {
    const diagnosticSink: DiagnosticSink = diagnostics;
    let host: DshHostClient | undefined;
    let session: HarnessSession | undefined;
    let disposeHostEvents: (() => void) | undefined;
    let disposeHostExit: (() => void) | undefined;
    let terminating = false;
    let termination: Promise<void> | undefined;
    let startAccepted = false;
    const attemptMessageIds = new Map<string, string>();
    const attemptTurns = new Map<string, TurnId>();
    const attemptByEventSeq = new Map<number, string>();
    const assistantByEventSeq = new Map<number, PendingAssistantMessage>();

    function emitFailureTurn(failure: HarnessFailure): void {
      if (session === undefined || session.turnId === null) return;
      void session
        .failActiveTurn(failure, streamFailureEvidence())
        .catch(() => undefined);
    }

    function handleHostExit(): void {
      if (terminating || !startAccepted || session === undefined) return;
      emitFailureTurn({
        failureCategory: "runtime_unavailable",
        retryDisposition: "external_state_change",
      });
    }

    function turnForEvent(event: DshHostEvent): TurnId | undefined {
      return "turnId" in event ? event.turnId : undefined;
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

    function handleSessionEvent(
      event: Extract<DshHostEvent, { type: "session-event" }>,
    ): void {
      if (session === undefined) return;
      const turnId = turnForEvent(event);
      const nativeEvent = event.event;
      if (nativeEvent.type === "turn/end") {
        handleTurnEnd(nativeEvent, turnId);
        return;
      }
      if (turnId === undefined || turnId !== session.turnId) return;
      if (nativeEvent.type === "assistant/message") {
        assistantByEventSeq.set(nativeEvent.seq, {
          event: nativeEvent,
          turnId,
        });
        flushAssistantMessage(nativeEvent.seq);
        return;
      }
      if (nativeEvent.type === "user/message") {
        if (event.callerMessageId === undefined) return;
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
      if (nativeEvent.type === "tool/call") {
        session.toolNames.set(nativeEvent.data.callId, nativeEvent.data.name);
        emit({
          type: "tool.requested",
          sessionId: session.sessionId,
          turnId,
          toolCallId: session.toolCallId(nativeEvent.data.callId),
          name: nativeEvent.data.name,
          input: nativeEvent.data.arguments,
        });
        return;
      }
      if (nativeEvent.type === "tool/result") {
        const nativeCallId = nativeEvent.data.message.source.callId;
        const name = session.toolNames.get(nativeCallId);
        if (name === undefined) return;
        emit({
          type: "tool.completed",
          sessionId: session.sessionId,
          turnId,
          toolCallId: session.toolCallId(nativeCallId),
          name,
          result: nativeContent(nativeEvent.data.message.content, session),
          ...(nativeEvent.data.error === undefined
            ? {}
            : { error: nativeEvent.data.error }),
          isError: nativeEvent.data.message.isError === true,
        });
        session.toolNames.delete(nativeCallId);
      }
    }

    function handleHostEvent(event: DshHostEvent): void {
      if (event.type === "assistant-stream") {
        handleAssistantFrame(event);
      } else if (event.type === "session-event") {
        handleSessionEvent(event);
      } else if (event.type === "fatal") {
        if (!startAccepted || terminating) return;
        emitFailureTurn(failureFromSafeFacts(event.failure));
      }
    }

    function assertHostResponse(
      response: DshHostResponse,
    ): Extract<DshHostResponse, { type: "accepted" }> {
      if (response.type === "accepted") return response;
      throw new DshHostRequestError(
        "The official DSH did not accept the request input",
        "unknown",
      );
    }

    const driver: WorkerDriver = {
      async start(spec: WorkerSpec): Promise<void> {
        const unsupported =
          spec.agent !== undefined
            ? "agent"
            : spec.sandbox !== undefined
              ? "sandbox"
              : spec.authorizationMode === "interactive"
                ? "interactive_authorization"
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
        attemptMessageIds.clear();
        attemptTurns.clear();
        attemptByEventSeq.clear();
        assistantByEventSeq.clear();
        session = new HarnessSession({
          sessionId: spec.sessionId,
          emit,
          diagnostics: diagnosticSink,
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
          disposeHostEvents = host.onEvent(handleHostEvent);
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
        if (placement === "active_turn")
          throw {
            code: "unsupported_feature",
            feature: "active_turn",
          } satisfies MachineError;
        session.beginTurn(turnId);
        try {
          const response = await host.request({
            type: "deliver",
            turnId,
            ...(messageId === undefined ? {} : { messageId }),
            message,
          });
          assertHostResponse(response);
        } catch (error) {
          const acceptance =
            error instanceof DshHostRequestError ? error.acceptance : "unknown";
          if (acceptance === "not_accepted") session.turnId = null;
          throw new WorkerDeliveryFailure(
            "The official DSH host did not confirm new-turn message acceptance",
            acceptance,
            { cause: error },
          );
        }
      },
      async interrupt(): Promise<void> {
        throw {
          code: "unsupported_feature",
          feature: "interrupt",
        } satisfies MachineError;
      },
      resolvePermission(): void {
        throw {
          code: "unsupported_feature",
          feature: "interactive_authorization",
        } satisfies MachineError;
      },
      async terminate(sessionId: SessionId): Promise<void> {
        if (session === undefined || session.sessionId !== sessionId) return;
        if (termination !== undefined) return termination;
        terminating = true;
        const currentHost = host;
        termination = (async () => {
          try {
            if (currentHost !== undefined) await currentHost.close();
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
