import {
  createAsyncQueue,
  HarnessSession,
  noopTranscript,
  type TranscriptSink,
} from "@reins/adapter-kit";
import type {
  WorkerDriver,
  WorkerDriverFactory,
  WorkerSpec,
} from "@reins/protocol";

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
  transcript?: TranscriptSink;
}): WorkerDriverFactory {
  const transcript = deps.transcript ?? noopTranscript;

  return (emit) => {
    let stream: ReturnType<typeof createAsyncQueue<SDKUserMessage>> | null =
      null;
    let query: ReturnType<QoderSdk["query"]> | null = null;
    let abortController: AbortController | null = null;
    let session: HarnessSession<PendingEntry> | null = null;

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
      try {
        for await (const message of query) {
          if (message.type === "result") {
            session.transcript("result", message);
          }
          const events = mapSdkMessage(session, message);
          for (const event of events) {
            emit(event);
          }
        }
      } catch (error) {
        session.transcript("stream_error", { message: String(error) });
      }
      session.failActiveTurn();
    }

    const driver: WorkerDriver = {
      start(spec: WorkerSpec) {
        session = new HarnessSession<PendingEntry>({
          sessionId: spec.sessionId,
          emit,
          transcript,
          onClearPending: () => {
            // 回合终态作废未决请求：直接丢弃，不结算、不写文案。
          },
        });
        session.beginTurn(spec.turnId);
        abortController = new AbortController();
        stream = createAsyncQueue<SDKUserMessage>();
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
        const options: QoderOptions = {
          cwd: spec.cwd,
          persistSession: false,
          includePartialMessages: true,
          abortController,
          permissionMode:
            spec.authorizationMode === "allowAll"
              ? "bypassPermissions"
              : "default",
          ...(spec.model === undefined ? {} : { model: spec.model }),
          ...(spec.authorizationMode === "allowAll"
            ? { allowDangerouslySkipPermissions: true }
            : {}),
          ...(spec.authorizationMode === "interactive"
            ? { canUseTool: makeCanUseTool() }
            : {}),
        };
        query = deps.sdk.query({ prompt: stream, options });
        stream.push(userMessage(spec.message, "next", true));
        void run();
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
          session?.transcript("interrupt_error", { message: String(error) });
        });
      },
      resolvePermission(sessionId, permissionId, resolution) {
        const entry = session?.takePending(permissionId);
        if (entry === undefined) {
          transcript("permission_resolution_lost", { permissionId, sessionId });
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
      terminate(sessionId) {
        void sessionId;
        abortController?.abort();
      },
    };
    return driver;
  };
}
