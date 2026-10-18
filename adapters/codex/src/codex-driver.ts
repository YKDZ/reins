import {
  AlreadyDiagnosedError,
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
  type TurnId,
  type MachineError,
  WorkerDeliveryFailure,
  WorkerStartFailure,
} from "@reins/protocol";

import type { UserInput } from "#/generated/v2/UserInput";

import { initializeCodexTransport } from "./initialization.ts";
import {
  derivePermissionOptions,
  mapNotification,
  resolutionToResponse,
} from "./mapper.ts";
import {
  CodexRequestError,
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
  return ({ emit, diagnostics: runtimeDiagnostics }) => {
    const diagnosticSink = runtimeDiagnostics;
    let transport: CodexTransport | null = null;
    let session: HarnessSession<CodexApproval> | null = null;
    let threadId = "";
    let threadDeleted = false;
    let workerInitialized = false;
    let workerClosed = false;
    let workerExitedUnexpectedly = false;
    let activeTurnId: string | null = null;
    let ended = false;
    let runPromise: Promise<void> | undefined;
    let turnOverrides: { readonly model?: string; readonly effort?: string } =
      {};
    const nativeTurns = new Map<TurnId, Promise<string>>();
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

    async function startTurn(
      message: string,
      messageId: MessageId | undefined,
      onDispatch?: () => void,
    ): Promise<string> {
      if (transport === null || threadId === "" || ended)
        throw new Error("Codex session is unavailable");
      if (onDispatch !== undefined && transport.isClosed())
        throw new Error("codex app-server closed");
      if (messageId !== undefined)
        pendingCallerMessages.push({ messageId, content: message });
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
        if (messageId !== undefined) removePendingCallerMessage(messageId);
        throw error;
      }
      activeTurnId = turn.turn.id;
      const pendingCaller = pendingCallerMessages.find(
        (candidate) => candidate.messageId === messageId,
      );
      if (pendingCaller !== undefined)
        pendingCaller.nativeTurnId = turn.turn.id;
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
            if (message.method === "serverRequest/resolved") {
              const requestId = message.params.requestId;
              const permissionId = pendingByRequest.get(requestId);
              if (permissionId !== undefined) {
                session.takePending(permissionId);
                pendingByRequest.delete(requestId);
              }
              continue;
            }
            if (
              message.method === "turn/completed" &&
              message.params.turn.id !== activeTurnId
            )
              continue;
            const callerMessageId = takeCallerMessage(message);
            const events = await mapNotification(
              session,
              message,
              callerMessageId,
            );
            for (const event of events) {
              if (event.type === "turn.completed") {
                activeTurnId = null;
                pendingByRequest.clear();
              }
              emit(event);
            }
          } else {
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
        if (session.turnId === null) {
          if (evidence !== undefined) await session.diagnostic(evidence);
        } else {
          await session.failActiveTurn(
            {
              failureCategory: "runtime_unavailable",
              retryDisposition: "external_state_change",
            },
            evidence,
          );
        }
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
            ephemeral: true,
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
            await startTurn(spec.message, spec.messageId, () => {
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
        if (session === null || session.sessionId !== sessionId || ended)
          throw new WorkerDeliveryFailure(
            "Codex session is unavailable before turn dispatch",
            "not_accepted",
          );
        if (placement === "new_turn") {
          session.beginTurn(turnId);
          let dispatched = false;
          const ready = startTurn(message, messageId, () => {
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
        if (session.turnId !== turnId || ended || transport === null)
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
          if (error instanceof CodexRequestError && session.turnId !== turnId)
            throw {
              code: "turn_not_active",
              sessionId,
              turnId,
            } satisfies MachineError;
          throw error;
        }
      },
      async interrupt(sessionId, turnId) {
        const ready = nativeTurns.get(turnId);
        if (
          session === null ||
          session.sessionId !== sessionId ||
          ready === undefined ||
          ended
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
          throw error;
        }
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
        pendingByRequest.delete(entry.id);
        transport?.respond(entry.id, resolutionToResponse(entry, resolution));
      },
      async terminate(sessionId) {
        void sessionId;
        if (workerClosed) return;
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
        if (closeFailure !== undefined) {
          if (isAlreadyDiagnosedError(closeFailure)) throw closeFailure;
          const diagnosticId = await session?.diagnostic({
            kind: "request_failure",
            operation: "kill",
            stage: "terminate",
            reason: "upstream_error",
            message: makeTextEvidence(errorMessage(closeFailure)),
          });
          throw new AlreadyDiagnosedError(
            errorMessage(closeFailure),
            diagnosticId,
          );
        }
        if (
          deletionFailure !== undefined &&
          !isAlreadyDiagnosedError(deletionFailure)
        ) {
          await session?.diagnostic({
            kind: "request_failure",
            operation: "kill",
            stage: "terminate",
            reason:
              deletionFailure instanceof TerminateTimeoutError
                ? "timeout"
                : "upstream_error",
            message: makeTextEvidence(errorMessage(deletionFailure)),
          });
        }
        workerClosed = true;
        if (workerInitialized && !workerExitedUnexpectedly) {
          await session?.diagnostic({
            kind: "lifecycle",
            operation: "worker",
            reason: "closed",
          });
        }
      },
    };
    return driver;
  };
}
