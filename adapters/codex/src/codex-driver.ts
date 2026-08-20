import {
  HarnessSession,
  noopTranscript,
  type TranscriptSink,
} from "@reins/adapter-kit";
import type {
  WorkerDriver,
  WorkerDriverFactory,
  WorkerSpec,
} from "@reins/protocol";

import type { UserInput } from "#/generated/v2/UserInput";

import {
  derivePermissionOptions,
  isApprovalRequest,
  mapNotification,
  resolutionToResponse,
} from "./mapper.ts";
import type { CodexTransport, InboundMessage } from "./transport.ts";

type CodexApproval = {
  requestId: number;
  method: string;
  params: Record<string, unknown>;
};

function textInput(text: string): UserInput {
  return { type: "text", text, text_elements: [] };
}

export function createCodexDriver(deps: {
  transportFactory: () => CodexTransport;
  transcript?: TranscriptSink;
}): WorkerDriverFactory {
  const transcript = deps.transcript ?? noopTranscript;

  return (emit) => {
    let transport: CodexTransport | null = null;
    let session: HarnessSession<CodexApproval> | null = null;
    let threadId = "";
    let activeTurnId: string | null = null;
    let ended = false;
    const pendingByRequest = new Map<number, string>();

    async function startTurn(message: string): Promise<void> {
      if (transport === null || threadId === "") return;
      try {
        const turn = (await transport.request("turn/start", {
          threadId,
          input: [textInput(message)],
        })) as { turn?: { id?: unknown } };
        activeTurnId = typeof turn.turn?.id === "string" ? turn.turn.id : null;
      } catch (error) {
        session?.transcript("turn_start_error", { message: String(error) });
        session?.failActiveTurn();
      }
    }

    function handleRequest(
      message: Extract<InboundMessage, { kind: "request" }>,
    ): void {
      if (session === null) return;
      if (!isApprovalRequest(message.method)) {
        session.transcript("unhandled_server_request", {
          id: message.id,
          method: message.method,
        });
        transport?.respondError(
          message.id,
          -32601,
          `Unhandled server request: ${message.method}`,
        );
        return;
      }
      const params = (message.params ?? {}) as Record<string, unknown>;
      const permissionId = session.requestPermission(
        message.method === "item/commandExecution/requestApproval"
          ? "tool:commandExecution"
          : message.method === "item/fileChange/requestApproval"
            ? "tool:fileChange"
            : "tool:permissions",
        params,
        derivePermissionOptions(message.method, params),
        { requestId: message.id, method: message.method, params },
      );
      pendingByRequest.set(message.id, permissionId);
    }

    async function run(): Promise<void> {
      if (transport === null || session === null) return;
      try {
        for await (const message of transport.messages) {
          if (message.kind === "notification") {
            if (message.method === "serverRequest/resolved") {
              const requestId = (message.params as { requestId?: number })
                .requestId;
              if (requestId !== undefined) {
                const permissionId = pendingByRequest.get(requestId);
                if (permissionId !== undefined) {
                  session.takePending(permissionId);
                  pendingByRequest.delete(requestId);
                }
              }
              continue;
            }
            const events = mapNotification(
              session,
              message.method,
              message.params,
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
        session.transcript("stream_error", { message: String(error) });
      }
      if (!ended) session.failActiveTurn();
    }

    const driver: WorkerDriver = {
      start(spec: WorkerSpec) {
        session = new HarnessSession<CodexApproval>({
          sessionId: spec.sessionId,
          emit,
          transcript,
        });
        session.beginTurn(spec.turnId);
        transport = deps.transportFactory();
        transport.start();
        if (
          spec.reasoning !== undefined ||
          spec.sandbox !== undefined ||
          spec.agent !== undefined
        ) {
          session.transcript("unmapped_spawn_fields", {
            reasoning: spec.reasoning,
            sandbox: spec.sandbox,
            agent: spec.agent,
          });
        }
        void (async () => {
          try {
            await transport?.request("initialize", {
              clientInfo: { name: "reins", title: null, version: "0.0.0" },
              capabilities: null,
            });
            transport?.notify("initialized", {});
            const thread = (await transport?.request("thread/start", {
              ephemeral: true,
              cwd: spec.cwd,
              approvalPolicy:
                spec.authorizationMode === "allowAll" ? "never" : "on-request",
              ...(spec.model === undefined ? {} : { model: spec.model }),
              ...(spec.authorizationMode === "allowAll"
                ? { sandbox: "danger-full-access" }
                : {}),
            })) as { thread?: { id?: unknown } };
            threadId =
              typeof thread.thread?.id === "string" ? thread.thread.id : "";
            await startTurn(spec.message);
          } catch (error) {
            session?.transcript("start_error", { message: String(error) });
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
          void startTurn(message);
        } else {
          void transport
            ?.request("turn/steer", {
              threadId,
              input: [textInput(message)],
              expectedTurnId: activeTurnId,
            })
            .catch((error: unknown) => {
              session?.transcript("steer_error", { message: String(error) });
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
              session?.transcript("interrupt_error", {
                message: String(error),
              });
            });
        }
      },
      resolvePermission(sessionId, permissionId, resolution) {
        const entry = session?.takePending(permissionId);
        if (entry === undefined) {
          transcript("permission_resolution_lost", {
            sessionId,
            permissionId,
          });
          return;
        }
        pendingByRequest.delete(entry.requestId);
        transport?.respond(
          entry.requestId,
          resolutionToResponse(entry.method, resolution, entry.params),
        );
      },
      terminate(sessionId) {
        void sessionId;
        ended = true;
        void transport
          ?.request("thread/delete", { threadId })
          .catch((error: unknown) => {
            session?.transcript("delete_error", { message: String(error) });
          });
        transport?.close();
      },
    };
    return driver;
  };
}
