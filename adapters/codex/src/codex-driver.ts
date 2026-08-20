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
} from "@reins/protocol";

import type { UserInput } from "#/generated/v2/UserInput";

import {
  derivePermissionOptions,
  mapNotification,
  resolutionToResponse,
} from "./mapper.ts";
import {
  type CodexApprovalRequest,
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
    let activeTurnId: string | null = null;
    let ended = false;
    const pendingByRequest = new Map<number, PermissionId>();

    async function startTurn(
      message: string,
      context:
        | { operation: "spawn"; stage: "start_turn" }
        | { operation: "send"; stage: "deliver" },
    ): Promise<void> {
      if (transport === null || threadId === "") return;
      try {
        const turn = await transport.request("turn/start", {
          threadId,
          input: [textInput(message)],
        });
        activeTurnId = turn.turn.id;
      } catch (error) {
        if (isAlreadyDiagnosedError(error)) {
          session?.failActiveTurn();
        } else if (session !== null && context.operation === "spawn") {
          void session.diagnostic({
            source: "adapter",
            harness: "codex",
            kind: "request_failure",
            operation: "spawn",
            stage: "start_turn",
            reason: "upstream_error",
            message: makeTextEvidence(String(error)),
          });
        } else if (session !== null) {
          void session.diagnostic({
            source: "adapter",
            harness: "codex",
            kind: "request_failure",
            operation: "send",
            stage: "deliver",
            reason: "upstream_error",
            message: makeTextEvidence(String(error)),
          });
        }
        session?.failActiveTurn();
      }
    }

    function handleRequest(
      message: Extract<InboundMessage, { kind: "request" }>,
    ): void {
      if (session === null) return;
      if (message.method === "unsupported") {
        void session.diagnostic({
          source: "adapter",
          harness: "codex",
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
      const permissionId = session.requestPermission(
        message.method === "item/commandExecution/requestApproval"
          ? "tool:commandExecution"
          : message.method === "item/fileChange/requestApproval"
            ? "tool:fileChange"
            : "tool:permissions",
        message.input,
        derivePermissionOptions(message),
        message,
      );
      pendingByRequest.set(message.id, permissionId);
    }

    async function run(): Promise<void> {
      if (transport === null || session === null) return;
      let readFailed = false;
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
            const events = mapNotification(session, message);
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
        readFailed = true;
        void session.diagnostic({
          source: "adapter",
          harness: "codex",
          kind: "stream_failure",
          operation: "receive_worker_stream",
          reason: "read_error",
          message: makeTextEvidence(String(error)),
        });
      }
      if (!readFailed && !ended && session.turnId !== null) {
        void session.diagnostic({
          source: "adapter",
          harness: "codex",
          kind: "stream_failure",
          operation: "receive_worker_stream",
          reason: "closed_unexpectedly",
          message: makeTextEvidence(
            "worker stream ended before turn completion",
          ),
        });
      }
      if (!ended) session.failActiveTurn();
    }

    const driver: WorkerDriver = {
      start(spec: WorkerSpec) {
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
        transport.start();
        const unsupportedFields = [
          ...(spec.agent === undefined ? [] : (["agent"] as const)),
          ...(spec.reasoning === undefined ? [] : (["reasoning"] as const)),
          ...(spec.sandbox === undefined ? [] : (["sandbox"] as const)),
        ];
        if (unsupportedFields.length > 0) {
          void session.diagnostic({
            source: "adapter",
            harness: "codex",
            kind: "mapping_gap",
            operation: "spawn",
            reason: "unsupported_input",
            fields: unsupportedFields as [
              "agent" | "reasoning" | "sandbox",
              ...("agent" | "reasoning" | "sandbox")[],
            ],
          });
        }
        void (async () => {
          try {
            await transport?.request("initialize", {
              clientInfo: { name: "reins", title: null, version: "0.0.0" },
              capabilities: null,
            });
            transport?.notify("initialized", {});
            const thread = await transport?.request("thread/start", {
              ephemeral: true,
              cwd: spec.cwd,
              approvalPolicy:
                spec.authorizationMode === "allowAll" ? "never" : "on-request",
              ...(spec.model === undefined ? {} : { model: spec.model }),
              ...(spec.authorizationMode === "allowAll"
                ? { sandbox: "danger-full-access" }
                : {}),
            });
            threadId = thread?.thread.id ?? "";
            await startTurn(spec.message, {
              operation: "spawn",
              stage: "start_turn",
            });
          } catch (error) {
            if (session !== null && !isAlreadyDiagnosedError(error)) {
              void session.diagnostic({
                source: "adapter",
                harness: "codex",
                kind: "request_failure",
                operation: "spawn",
                stage: "start_session",
                reason: "upstream_error",
                message: makeTextEvidence(String(error)),
              });
            }
            session?.failActiveTurn();
          }
          await run();
        })();
      },
      deliver(sessionId, turnId, message) {
        void sessionId;
        session?.setTurnId(turnId);
        if (ended) return;
        if (activeTurnId === null) {
          void startTurn(message, { operation: "send", stage: "deliver" });
        } else {
          void transport
            ?.request("turn/steer", {
              threadId,
              input: [textInput(message)],
              expectedTurnId: activeTurnId,
            })
            .catch((error: unknown) => {
              if (session !== null && !isAlreadyDiagnosedError(error)) {
                void session.diagnostic({
                  source: "adapter",
                  harness: "codex",
                  kind: "request_failure",
                  operation: "send",
                  stage: "steer",
                  reason: "upstream_error",
                  message: makeTextEvidence(String(error)),
                });
              }
            });
        }
      },
      interrupt(sessionId) {
        void sessionId;
        if (session !== null) session.cancelling = true;
        if (activeTurnId !== null) {
          void transport
            ?.request("turn/interrupt", { threadId, turnId: activeTurnId })
            .catch((error: unknown) => {
              if (session !== null && !isAlreadyDiagnosedError(error)) {
                void session.diagnostic({
                  source: "adapter",
                  harness: "codex",
                  kind: "request_failure",
                  operation: "interrupt",
                  stage: "interrupt",
                  reason: "upstream_error",
                  message: makeTextEvidence(String(error)),
                });
              }
            });
        }
      },
      resolvePermission(sessionId, permissionId, resolution) {
        const entry = session?.takePending(permissionId);
        if (entry === undefined) {
          if (session !== null) {
            void session.diagnostic({
              source: "adapter",
              harness: "codex",
              kind: "authorization_failure",
              operation: "resolve_permission",
              stage: "lookup",
              reason: "target_lost",
              permissionId,
            });
          }
          return;
        }
        pendingByRequest.delete(entry.id);
        transport?.respond(entry.id, resolutionToResponse(entry, resolution));
      },
      terminate(sessionId) {
        void sessionId;
        ended = true;
        void (async () => {
          const closingTransport = transport;
          let failure: unknown;
          try {
            if (closingTransport !== null) {
              await withTerminateTimeout(
                closingTransport.request("thread/delete", { threadId }),
                deps.terminateTimeoutMs ?? 5_000,
              );
            }
          } catch (error) {
            failure = error;
          }
          try {
            await closingTransport?.close();
          } catch (error) {
            if (failure === undefined) {
              failure = error;
            }
          }
          if (
            failure !== undefined &&
            session !== null &&
            !isAlreadyDiagnosedError(failure)
          ) {
            void session.diagnostic({
              source: "adapter",
              harness: "codex",
              kind: "request_failure",
              operation: "kill",
              stage: "terminate",
              reason:
                failure instanceof TerminateTimeoutError
                  ? "timeout"
                  : "upstream_error",
              message: makeTextEvidence(errorMessage(failure)),
            });
          }
        })();
      },
    };
    return driver;
  };
}
