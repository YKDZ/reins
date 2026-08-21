import { createAsyncQueue, HarnessSession } from "@reins/adapter-kit";
import type {
  WorkerDriver,
  AdapterDriverFactory,
  WorkerSpec,
} from "@reins/protocol";
import { makeTextEvidence } from "@reins/protocol";

import { derivePermissionOptions, mapSdkMessage } from "./mapper.ts";
import type {
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
  QoderOptions,
  QoderSdk,
  SDKUserMessage,
} from "./sdk-seam.ts";

type PendingEntry = {
  resolve: (result: PermissionResult) => void;
  reject: (reason: unknown) => void;
  input: Record<string, unknown>;
  toolUseID?: string;
  suggestions: PermissionUpdate[] | undefined;
};

function userMessage(
  content: string,
  priority: "next" | "later",
  shouldQuery: boolean,
): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    priority,
    shouldQuery,
  };
}

export function createQoderDriver(deps: {
  sdk: QoderSdk;
}): AdapterDriverFactory {
  return ({ emit, diagnostics: runtimeDiagnostics }) => {
    const diagnosticSink = runtimeDiagnostics;
    let stream: ReturnType<typeof createAsyncQueue<SDKUserMessage>> | null =
      null;
    let query: ReturnType<QoderSdk["query"]> | null = null;
    let abortController: AbortController | null = null;
    let session: HarnessSession<PendingEntry> | null = null;
    let terminating = false;
    let runPromise: Promise<void> | null = null;

    function makeCanUseTool(): CanUseTool {
      return async (toolName, input, options) => {
        if (session === null) {
          // 不变式失败：回调只在 start 注册后才可达。
          throw new Error("canUseTool called before session creation");
        }
        const entry: PendingEntry = {
          resolve: () => {},
          reject: () => {},
          input,
          toolUseID: options.toolUseID,
          suggestions: options.suggestions,
        };
        const permissionId = session.requestPermission(
          `tool:${toolName}`,
          input,
          derivePermissionOptions(options.suggestions),
          entry,
        );
        return await new Promise<PermissionResult>((resolve, reject) => {
          entry.resolve = resolve;
          entry.reject = reject;
          options.signal.addEventListener(
            "abort",
            () => {
              // harness 已取消请求：丢弃登记，SDK 侧由 signal race 自行结束。
              session?.takePending(permissionId);
            },
            { once: true },
          );
        });
      };
    }

    async function run(): Promise<void> {
      if (query === null || stream === null || session === null) return;
      let readFailed = false;
      try {
        for await (const message of query) {
          const events = mapSdkMessage(session, message);
          for (const event of events) {
            emit(event);
          }
        }
      } catch (error) {
        if (!terminating) {
          readFailed = true;
          void session.diagnostic({
            kind: "stream_failure",
            operation: "receive_worker_stream",
            reason: "read_error",
            message: makeTextEvidence(String(error)),
          });
        }
      }
      if (!readFailed && !terminating) {
        await session.diagnostic({
          kind: "lifecycle",
          operation: "worker",
          reason: "exited_unexpectedly",
          message: makeTextEvidence(
            session.turnId === null
              ? "worker stream ended unexpectedly while idle"
              : "worker stream ended before turn completion",
          ),
        });
      }
      if (!terminating) session.failActiveTurn();
    }

    const driver: WorkerDriver = {
      start(spec: WorkerSpec) {
        terminating = false;
        session = new HarnessSession<PendingEntry>({
          sessionId: spec.sessionId,
          emit,
          diagnostics: diagnosticSink,
          onClearPending: () => {
            // 回合终态作废未决请求：直接丢弃，不结算、不写文案。
          },
        });
        session.beginTurn(spec.turnId);
        abortController = new AbortController();
        stream = createAsyncQueue<SDKUserMessage>();
        const unsupportedFields = [
          ...(spec.agent === undefined ? [] : (["agent"] as const)),
          ...(spec.reasoning === undefined ? [] : (["reasoning"] as const)),
          ...(spec.sandbox === undefined ? [] : (["sandbox"] as const)),
        ];
        const [firstUnsupportedField, ...otherUnsupportedFields] =
          unsupportedFields;
        if (firstUnsupportedField !== undefined) {
          void session.diagnostic({
            kind: "mapping_gap",
            operation: "spawn",
            reason: "unsupported_input",
            fields: [firstUnsupportedField, ...otherUnsupportedFields],
          });
        }
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
          void session.diagnostic({
            kind: "request_failure",
            operation: "spawn",
            stage: "start_session",
            reason: "upstream_error",
            message: makeTextEvidence(String(error)),
          });
          session.failActiveTurn();
          return;
        }
        runPromise = (async () => {
          await session?.diagnostic({
            kind: "lifecycle",
            operation: "worker",
            reason: "initialized",
          });
          stream?.push(userMessage(spec.message, "next", true));
          await run();
        })();
      },
      deliver(sessionId, turnId, message) {
        void sessionId;
        session?.setTurnId(turnId);
        stream?.push(userMessage(message, "next", true));
      },
      interrupt(sessionId) {
        void sessionId;
        if (session !== null) session.cancelling = true;
        query?.interrupt().catch((error: unknown) => {
          if (session === null) return;
          void session.diagnostic({
            kind: "request_failure",
            operation: "interrupt",
            stage: "interrupt",
            reason: "upstream_error",
            message: makeTextEvidence(String(error)),
          });
        });
      },
      resolvePermission(sessionId, permissionId, resolution) {
        const entry = session?.takePending(permissionId);
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
          return;
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
        terminating = true;
        abortController?.abort();
        await runPromise;
        await session?.diagnostic({
          kind: "lifecycle",
          operation: "worker",
          reason: "closed",
        });
      },
    };
    return driver;
  };
}
