import {
  HarnessSession,
  isAlreadyDiagnosedError,
  type DiagnosticSink,
} from "@reins/adapter-kit";
import {
  makeTextEvidence,
  type WorkerDriver,
  type AdapterDriverFactory,
  type WorkerSpec,
  type PermissionId,
  type MessageId,
  type MessageContent,
  type TurnId,
  type MachineError,
  WorkerDeliveryFailure,
  WorkerInterruptFailure,
  WorkerPermissionFailure,
  WorkerStartFailure,
  makeErrorCause,
} from "@reins/protocol";

import type { UserInput } from "#/generated/v2/UserInput";

import { initializeCodexTransport } from "./initialization.ts";
import {
  derivePermissionOptions,
  codexMessageBody,
  mapNotification,
  resolutionToResponse,
} from "./mapper.ts";
import {
  CodexRequestError,
  CodexTransportClosedError,
  type CodexApprovalRequest,
  type CodexInboundItem,
  type CodexTransport,
  type InboundMessage,
} from "./transport.ts";

type CodexApproval = CodexApprovalRequest;

function textInput(text: string): UserInput {
  return { type: "text", text, text_elements: [] };
}

class TerminateTimeoutError extends Error {}
class TerminateTransportClosedError extends Error {}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "string") return error;
  return "Unknown upstream failure";
}

function withTerminateTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new TerminateTimeoutError("thread delete timed out")),
      ms,
    );
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export function createCodexDriver(deps: {
  transportFactory: (options: {
    captureHarnessStderr?: boolean;
    diagnostics: DiagnosticSink;
    diagnosticContext: () => {
      sessionId: WorkerSpec["sessionId"];
      turnId: WorkerSpec["turnId"] | null;
    } | null;
  }) => CodexTransport;
  terminateTimeoutMs?: number;
}): AdapterDriverFactory {
  return ({
    emit,
    diagnostics: runtimeDiagnostics,
    markControlUnavailable = () => undefined,
  }) => {
    const diagnosticSink = runtimeDiagnostics;
    let transport: CodexTransport | null = null;
    let session: HarnessSession<CodexApproval> | null = null;
    let threadId = "";
    let threadDeleted = false;
    let workerInitialized = false;
    let workerClosed = false;
    let terminationFailure: MachineError | undefined;
    let terminationPromise: Promise<void> | null = null;
    let workerExitedUnexpectedly = false;
    let controlLost = false;
    let activeTurnId: string | null = null;
    let ended = false;
    let runPromise: Promise<void> | undefined;
    let turnOverrides: { readonly model?: string; readonly effort?: string } =
      {};
    const nativeTurns = new Map<TurnId, Promise<string>>();
    const nativeTurnToReins = new Map<string, TurnId>();
    const pendingNativeStartTurnIds = new Set<TurnId>();
    const pendingTurnNotifications: Array<{
      message: Extract<InboundMessage, { kind: "notification" }>;
      callerContent?: Promise<MessageContent>;
    }> = [];
    const pendingTurnRequests: CodexApprovalRequest[] = [];
    const nativeToolTurnOwners = new Set<string>();
    const pendingByRequest = new Map<number, PermissionId>();
    const pendingCallerMessages: Array<{
      readonly messageId: MessageId;
      readonly content: string;
      nativeTurnId?: string;
    }> = [];

    function callerText(
      item: Extract<CodexInboundItem, { type: "userMessage" }>,
    ): string | null {
      const textInputs = item.content.filter((input) => input.type === "text");
      if (textInputs.length === 0) return null;
      return textInputs.map((input) => input.text).join("");
    }

    function takeCallerMessage(
      message: Extract<InboundMessage, { kind: "notification" }>,
    ): MessageId | undefined {
      if (
        message.method !== "item/completed" ||
        message.params.item.type !== "userMessage"
      )
        return undefined;
      const content = callerText(message.params.item);
      if (content === null) return undefined;
      const nativeTurnId = message.params.turnId ?? activeTurnId;
      const index = pendingCallerMessages.findIndex(
        (candidate) =>
          candidate.content === content &&
          (candidate.nativeTurnId === nativeTurnId ||
            (candidate.nativeTurnId === undefined &&
              nativeTurnId !== activeTurnId)),
      );
      if (index < 0) return undefined;
      return pendingCallerMessages.splice(index, 1)[0]?.messageId;
    }

    function removePendingCallerMessage(messageId: MessageId): void {
      const index = pendingCallerMessages.findIndex(
        (candidate) => candidate.messageId === messageId,
      );
      if (index >= 0) pendingCallerMessages.splice(index, 1);
    }

    function nativeToolOwnerKey(nativeTurnId: string, itemId: string): string {
      return `${nativeTurnId}\u0000${itemId}`;
    }

    function rejectApprovalRequest(
      message: CodexApprovalRequest,
      reason: string,
    ): void {
      transport?.respondError(message.id, -32602, reason);
    }

    function nativeTurnIdOf(
      message: Extract<InboundMessage, { kind: "notification" }>,
    ): string | undefined {
      if (message.method === "turn/completed") return message.params.turn.id;
      if (
        message.method === "item/started" ||
        message.method === "item/completed"
      )
        return message.params.turnId;
      return undefined;
    }

    async function processNotification(
      message: Extract<InboundMessage, { kind: "notification" }>,
      callerContent?: Promise<MessageContent>,
    ): Promise<void> {
      if (session === null) return;
      if (message.method === "serverRequest/resolved") {
        const requestId = message.params.requestId;
        const permissionId = pendingByRequest.get(requestId);
        if (permissionId !== undefined) {
          session.takePending(permissionId);
          pendingByRequest.delete(requestId);
        } else {
          const queuedRequest = pendingTurnRequests.findIndex(
            (request) => request.id === requestId,
          );
          if (queuedRequest >= 0) pendingTurnRequests.splice(queuedRequest, 1);
        }
        return;
      }
      if (
        message.method === "turn/completed" &&
        message.params.turn.id !== activeTurnId
      )
        return;
      const callerMessageId = takeCallerMessage(message);
      const factTurnId =
        message.method === "item/started" || message.method === "item/completed"
          ? message.params.turnId === undefined
            ? undefined
            : (nativeTurnToReins.get(message.params.turnId) ?? null)
          : undefined;
      const events = await mapNotification(
        session,
        message,
        callerMessageId,
        factTurnId,
        callerContent === undefined ? undefined : await callerContent,
      );
      for (const event of events) {
        if (event.type === "turn.completed") {
          activeTurnId = null;
          pendingByRequest.clear();
        }
        emit(event);
      }
      if (
        message.method === "item/started" &&
        message.params.turnId !== undefined &&
        session.toolNames.has(message.params.item.id)
      )
        nativeToolTurnOwners.add(
          nativeToolOwnerKey(message.params.turnId, message.params.item.id),
        );
    }

    async function flushPendingTurnNotifications(
      nativeTurnId: string,
    ): Promise<void> {
      const matching = pendingTurnNotifications.filter(
        ({ message }) => nativeTurnIdOf(message) === nativeTurnId,
      );
      for (let index = pendingTurnNotifications.length - 1; index >= 0; index--)
        if (
          nativeTurnIdOf(pendingTurnNotifications[index]!.message) ===
          nativeTurnId
        )
          pendingTurnNotifications.splice(index, 1);
      for (const pending of matching)
        await processNotification(pending.message, pending.callerContent);
      if (pendingNativeStartTurnIds.size === 0)
        pendingTurnNotifications.length = 0;
    }

    async function flushPendingTurnRequests(
      nativeTurnId: string,
    ): Promise<void> {
      const matching = pendingTurnRequests.filter(
        (message) => message.nativeTurnId === nativeTurnId,
      );
      for (let index = pendingTurnRequests.length - 1; index >= 0; index -= 1)
        if (pendingTurnRequests[index]?.nativeTurnId === nativeTurnId)
          pendingTurnRequests.splice(index, 1);
      for (const message of matching) handleRequest(message);
      if (pendingNativeStartTurnIds.size === 0) {
        for (const message of pendingTurnRequests.splice(0))
          rejectApprovalRequest(
            message,
            "Approval request does not target an active Codex turn",
          );
      }
    }

    async function startTurn(
      reinsTurnId: TurnId,
      message: string,
      messageId: MessageId | undefined,
      onDispatch?: () => void,
    ): Promise<string> {
      if (transport === null || threadId === "" || ended || controlLost)
        throw new Error("Codex session is unavailable");
      if (onDispatch !== undefined && transport.isClosed())
        throw new Error("codex app-server closed");
      if (messageId !== undefined)
        pendingCallerMessages.push({ messageId, content: message });
      pendingNativeStartTurnIds.add(reinsTurnId);
      const pendingTurn = transport.request("turn/start", {
        threadId,
        input: [textInput(message)],
        ...turnOverrides,
      });
      onDispatch?.();
      let turn: Awaited<typeof pendingTurn>;
      try {
        turn = await pendingTurn;
      } catch (error) {
        pendingNativeStartTurnIds.delete(reinsTurnId);
        if (pendingNativeStartTurnIds.size === 0) {
          pendingTurnNotifications.length = 0;
          for (const message of pendingTurnRequests.splice(0))
            rejectApprovalRequest(
              message,
              "Approval request does not target an active Codex turn",
            );
        }
        if (messageId !== undefined) removePendingCallerMessage(messageId);
        throw error;
      }
      activeTurnId = turn.turn.id;
      nativeTurnToReins.set(turn.turn.id, reinsTurnId);
      const pendingCaller = pendingCallerMessages.find(
        (candidate) => candidate.messageId === messageId,
      );
      if (pendingCaller !== undefined)
        pendingCaller.nativeTurnId = turn.turn.id;
      pendingNativeStartTurnIds.delete(reinsTurnId);
      await flushPendingTurnNotifications(turn.turn.id);
      await flushPendingTurnRequests(turn.turn.id);
      return turn.turn.id;
    }

    function handleRequest(
      message: Extract<InboundMessage, { kind: "request" }>,
    ): void {
      if (session === null) return;
      if (message.method === "unsupported") {
        void session.diagnostic({
          kind: "compatibility_gap",
          operation: "receive_worker_request",
          reason: "unsupported_request",
          message: makeTextEvidence(message.nativeMethod),
        });
        transport?.respondError(
          message.id,
          -32601,
          `Unhandled server request: ${message.nativeMethod}`,
        );
        return;
      }
      if (
        message.nativeThreadId !== threadId ||
        message.nativeTurnId === undefined ||
        activeTurnId !== message.nativeTurnId ||
        nativeTurnToReins.get(message.nativeTurnId) !== session.turnId
      ) {
        rejectApprovalRequest(
          message,
          "Approval request does not match the active Codex turn",
        );
        return;
      }
      if (
        message.itemId !== undefined &&
        session.toolNames.has(message.itemId) &&
        !nativeToolTurnOwners.has(
          nativeToolOwnerKey(message.nativeTurnId, message.itemId),
        )
      ) {
        rejectApprovalRequest(
          message,
          "Approval request does not match the active Codex tool",
        );
        return;
      }
      const options = derivePermissionOptions(message);
      if (options.length === 0) {
        void session.diagnostic({
          kind: "compatibility_gap",
          operation: "receive_worker_request",
          reason: "unsupported_request",
          message: makeTextEvidence("No supported approval decisions"),
        });
        transport?.respondError(
          message.id,
          -32601,
          "No supported approval decisions",
        );
        return;
      }
      const permissionId = session.requestPermission(
        message.method === "item/commandExecution/requestApproval"
          ? "tool:commandExecution"
          : message.method === "item/fileChange/requestApproval"
            ? "tool:fileChange"
            : "tool:permissions",
        message.input,
        options,
        message,
        message.itemId !== undefined &&
          session.toolNames.has(message.itemId) &&
          nativeToolTurnOwners.has(
            nativeToolOwnerKey(message.nativeTurnId, message.itemId),
          )
          ? session.toolCallId(message.itemId)
          : undefined,
      );
      pendingByRequest.set(message.id, permissionId);
    }

    async function run(): Promise<void> {
      if (transport === null || session === null) return;
      let readFailed = false;
      let evidence: Parameters<HarnessSession["failActiveTurn"]>[1];
      try {
        for await (const message of transport.messages) {
          if (message.kind === "notification") {
            const nativeTurnId = nativeTurnIdOf(message);
            if (
              nativeTurnId !== undefined &&
              !nativeTurnToReins.has(nativeTurnId) &&
              pendingNativeStartTurnIds.size > 0
            ) {
              pendingTurnNotifications.push({
                message,
                ...(message.method === "item/completed" &&
                message.params.item.type === "userMessage"
                  ? {
                      callerContent: codexMessageBody(
                        message.params.item.content,
                      ),
                    }
                  : {}),
              });
              continue;
            }
            await processNotification(message);
          } else {
            if (
              message.method !== "unsupported" &&
              message.nativeTurnId !== undefined &&
              !nativeTurnToReins.has(message.nativeTurnId) &&
              pendingNativeStartTurnIds.size > 0
            ) {
              pendingTurnRequests.push(message);
              continue;
            }
            handleRequest(message);
          }
        }
      } catch (error) {
        if (!ended) {
          readFailed = true;
          evidence = {
            kind: "stream_failure",
            operation: "receive_worker_stream",
            reason: "read_error",
            message: makeTextEvidence(String(error)),
          };
        }
      }
      if (!readFailed && !ended) {
        workerExitedUnexpectedly = true;
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
      if (!ended) {
        // new_turn 的原生受理若先失败，它并未产生可提交的运行中回合。
        const pendingTurn = session.turnId;
        if (pendingTurn !== null && activeTurnId === null) {
          try {
            await nativeTurns.get(pendingTurn);
          } catch {
            /* deliver/start 负责该请求拒绝。 */
          }
          if (ended) return;
        }
        controlLost = true;
        markControlUnavailable();
        if (evidence !== undefined) await session.diagnostic(evidence);
      }
    }

    const driver: WorkerDriver = {
      async start(spec: WorkerSpec) {
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
        session = new HarnessSession<CodexApproval>({
          sessionId: spec.sessionId,
          emit,
          diagnostics: diagnosticSink,
        });
        session.beginTurn(spec.turnId);
        transport = deps.transportFactory({
          diagnostics: diagnosticSink,
          diagnosticContext: () =>
            session === null
              ? null
              : { sessionId: session.sessionId, turnId: session.turnId },
          ...(spec.captureHarnessStderr === true
            ? { captureHarnessStderr: true }
            : {}),
        });
        turnOverrides = {
          ...(spec.model === undefined ? {} : { model: spec.model }),
          ...(spec.reasoning === undefined ? {} : { effort: spec.reasoning }),
        };
        let resolveInitial!: (nativeId: string) => void;
        let rejectInitial!: (error: unknown) => void;
        const initialReady = new Promise<string>((resolve, reject) => {
          resolveInitial = resolve;
          rejectInitial = reject;
        });
        nativeTurns.set(spec.turnId, initialReady);
        void initialReady.catch(() => undefined);
        const startingTransport = transport;
        if (startingTransport === null)
          throw new Error("Codex transport is unavailable");
        let initialTurnDispatched = false;
        try {
          await initializeCodexTransport(startingTransport);
          const thread = await startingTransport.request("thread/start", {
            ephemeral: false,
            cwd: spec.cwd,
            ...(spec.authorizationMode === "allowAll"
              ? {
                  approvalPolicy: "never",
                  sandbox: "danger-full-access",
                }
              : spec.authorizationMode === "interactive"
                ? { approvalPolicy: "on-request" }
                : {}),
          });
          threadId = thread?.thread.id ?? "";
          workerInitialized = true;
          resolveInitial(
            await startTurn(spec.turnId, spec.message, spec.messageId, () => {
              initialTurnDispatched = true;
            }),
          );
        } catch (error) {
          rejectInitial(error);
          if (threadId !== "" && !threadDeleted) {
            try {
              await startingTransport.request("thread/delete", { threadId });
              threadDeleted = true;
            } catch {
              // 启动拒绝保持为主因；停止失败由随后关闭尝试保留。
            }
          }
          await startingTransport.close().catch(() => undefined);
          throw new WorkerStartFailure(
            errorMessage(error),
            initialTurnDispatched && !(error instanceof CodexRequestError)
              ? "unknown"
              : "not_accepted",
            { cause: error },
          );
        }
        runPromise = run();
        void session?.diagnostic({
          kind: "lifecycle",
          operation: "worker",
          reason: "initialized",
        });
      },
      async deliver(sessionId, turnId, message, placement, messageId) {
        if (
          session === null ||
          session.sessionId !== sessionId ||
          ended ||
          controlLost
        )
          throw new WorkerDeliveryFailure(
            "Codex session is unavailable before turn dispatch",
            "not_accepted",
          );
        if (placement === "new_turn") {
          session.beginTurn(turnId);
          let dispatched = false;
          const ready = startTurn(turnId, message, messageId, () => {
            dispatched = true;
          });
          nativeTurns.set(turnId, ready);
          try {
            await ready;
          } catch (error) {
            session.turnId = null;
            throw new WorkerDeliveryFailure(
              errorMessage(error),
              dispatched && !(error instanceof CodexRequestError)
                ? "unknown"
                : "not_accepted",
              { cause: error },
            );
          }
          return;
        }
        const ready = nativeTurns.get(turnId);
        if (ready === undefined)
          throw {
            code: "turn_not_active",
            sessionId,
            turnId,
          } satisfies MachineError;
        const expectedTurnId = await ready;
        if (
          session.turnId !== turnId ||
          ended ||
          controlLost ||
          transport === null
        )
          throw {
            code: "turn_not_active",
            sessionId,
            turnId,
          } satisfies MachineError;
        try {
          if (messageId !== undefined)
            pendingCallerMessages.push({
              messageId,
              content: message,
              nativeTurnId: expectedTurnId,
            });
          const accepted = await transport.request("turn/steer", {
            threadId,
            input: [textInput(message)],
            expectedTurnId,
          });
          if (accepted.turnId !== expectedTurnId)
            throw new Error("Codex accepted a different turn");
        } catch (error) {
          if (messageId !== undefined) removePendingCallerMessage(messageId);
          if (error instanceof CodexRequestError) {
            if (session.turnId !== turnId)
              throw {
                code: "turn_not_active",
                sessionId,
                turnId,
              } satisfies MachineError;
            throw new WorkerDeliveryFailure(
              `Codex rejected the active-turn continuation: ${errorMessage(error)}`,
              "not_accepted",
              { cause: error },
            );
          }
          throw error;
        }
      },
      async interrupt(sessionId, turnId) {
        const ready = nativeTurns.get(turnId);
        if (
          session === null ||
          session.sessionId !== sessionId ||
          ready === undefined ||
          ended ||
          controlLost
        )
          throw {
            code: "turn_not_active",
            sessionId,
            turnId,
          } satisfies MachineError;
        const nativeTurnId = await ready;
        if (session.turnId !== turnId || ended || transport === null)
          throw {
            code: "turn_not_active",
            sessionId,
            turnId,
          } satisfies MachineError;
        try {
          await transport.request("turn/interrupt", {
            threadId,
            turnId: nativeTurnId,
          });
        } catch (error) {
          if (error instanceof CodexRequestError && session.turnId !== turnId)
            throw {
              code: "turn_not_active",
              sessionId,
              turnId,
            } satisfies MachineError;
          if (error instanceof CodexRequestError)
            throw new WorkerInterruptFailure(
              "Codex rejected the interrupt request",
              "not_accepted",
              { cause: error },
            );
          throw new WorkerInterruptFailure(
            "Codex interrupt acceptance is unknown",
            "unknown",
            { cause: error },
          );
        }
      },
      resolvePermission(sessionId, permissionId, resolution) {
        if (controlLost)
          throw new WorkerPermissionFailure(
            "Codex app-server control is unavailable",
            "not_accepted",
          );
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
        pendingByRequest.delete(entry.id);
        transport?.respond(entry.id, resolutionToResponse(entry, resolution));
      },
      async terminate(sessionId) {
        void sessionId;
        if (terminationPromise !== null) return await terminationPromise;
        if (workerClosed) {
          if (terminationFailure !== undefined) throw terminationFailure;
          return;
        }
        const attempt = (async () => {
          const closingTransport = transport;
          const transportAlreadyClosed = closingTransport?.isClosed() ?? true;
          let deletionFailure: unknown;
          try {
            if (
              closingTransport !== null &&
              !transportAlreadyClosed &&
              threadId !== "" &&
              !threadDeleted
            ) {
              await withTerminateTimeout(
                closingTransport.request("thread/delete", { threadId }),
                deps.terminateTimeoutMs ?? 5_000,
              );
              threadDeleted = true;
            } else if (threadId !== "" && !threadDeleted) {
              deletionFailure = new TerminateTransportClosedError(
                "Codex app-server closed before thread deletion was confirmed",
              );
            }
          } catch (error) {
            deletionFailure = error;
          }
          ended = true;
          let closeFailure: unknown;
          try {
            await closingTransport?.close();
            // 已收到的终态先完成有界证据接受；成功停止不能把它抢成 killed。
            await runPromise;
          } catch (error) {
            closeFailure = error;
          }
          workerClosed = closeFailure === undefined;
          if (workerClosed && workerInitialized && !workerExitedUnexpectedly) {
            await session?.diagnostic({
              kind: "lifecycle",
              operation: "worker",
              reason: "closed",
            });
          }
          const closeError = deletionFailure ?? closeFailure;
          if (closeError !== undefined) {
            const alreadyDiagnosed = isAlreadyDiagnosedError(closeError);
            const transportClosed =
              closeError instanceof TerminateTransportClosedError ||
              closeError instanceof CodexTransportClosedError;
            const diagnosticId = alreadyDiagnosed
              ? closeError.diagnosticId
              : await session?.diagnostic({
                  kind: "request_failure",
                  operation: "kill",
                  stage: "terminate",
                  reason:
                    closeError instanceof TerminateTimeoutError
                      ? "timeout"
                      : transportClosed
                        ? "closed"
                        : "upstream_error",
                  message: makeTextEvidence(errorMessage(closeError)),
                });
            const failure: MachineError = {
              code: "internal_error",
              cause: makeErrorCause(
                closeError instanceof TerminateTimeoutError
                  ? "timeout"
                  : transportClosed || closeError === closeFailure
                    ? "closed"
                    : "upstream",
                errorMessage(closeError),
              ),
              ...(diagnosticId === undefined ? {} : { diagnosticId }),
              ...(threadDeleted
                ? {
                    effect: {
                      kind: "session_closed",
                      sessionId,
                    },
                  }
                : {}),
              ...(deletionFailure === undefined || closeFailure === undefined
                ? {}
                : {
                    cleanupCause: makeErrorCause(
                      "closed",
                      errorMessage(closeFailure),
                    ),
                  }),
            };
            if (workerClosed) terminationFailure = failure;
            throw failure;
          }
          workerClosed = true;
        })();
        terminationPromise = attempt;
        try {
          await attempt;
        } finally {
          if (terminationPromise === attempt) terminationPromise = null;
        }
      },
    };
    return driver;
  };
}
