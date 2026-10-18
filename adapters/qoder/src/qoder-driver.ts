import { randomUUID } from "node:crypto";

import { createAsyncQueue, HarnessSession } from "@reins/adapter-kit";
import type {
  WorkerDriver,
  AdapterDriverFactory,
  WorkerSpec,
  MachineError,
} from "@reins/protocol";
import {
  makeTextEvidence,
  WorkerDeliveryFailure,
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
  SDKUserMessage,
} from "./sdk-seam.ts";

type PendingEntry = {
  resolve: (result: PermissionResult) => void;
  reject: (reason: unknown) => void;
  input: Record<string, unknown>;
  toolUseID?: string;
  suggestions: PermissionUpdate[] | undefined;
};

type PendingDelivery = {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
};

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

export function createQoderDriver(deps: {
  sdk: QoderSdk;
  expectedCliVersion?: string;
}): AdapterDriverFactory {
  return ({ emit, diagnostics: runtimeDiagnostics }) => {
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
    let initialInputSent = false;
    let nativeSessionId: string | null = null;
    let startSettled = false;
    let resolveStart: (() => void) | undefined;
    let rejectStart: ((error: unknown) => void) | undefined;
    const pendingDeliveries = new Map<string, PendingDelivery>();

    function rejectPendingDeliveries(error: unknown): void {
      for (const [uuid, pending] of pendingDeliveries) {
        pendingDeliveries.delete(uuid);
        pending.reject(
          new WorkerDeliveryFailure(
            "Qoder stream ended before confirming the queued command",
            "unknown",
            { cause: error },
          ),
        );
      }
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
            if (
              lifecycle.command_uuid === initialInputUuid &&
              lifecycle.state === "queued"
            )
              settleStart();
            if (lifecycle.state === "queued") {
              const pending = pendingDeliveries.get(lifecycle.command_uuid);
              if (pending !== undefined) {
                pendingDeliveries.delete(lifecycle.command_uuid);
                pending.resolve();
              }
            } else if (lifecycle.state === "cancelled") {
              const pending = pendingDeliveries.get(lifecycle.command_uuid);
              if (pending !== undefined) {
                pendingDeliveries.delete(lifecycle.command_uuid);
                pending.reject(
                  new WorkerDeliveryFailure(
                    "Qoder cancelled the command before queue acceptance",
                    "not_accepted",
                  ),
                );
              }
            }
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
          const events = await mapSdkMessage(session, mappingState, rawMessage);
          for (const event of events) {
            emit(event);
          }
        }
      } catch (error) {
        rejectPendingDeliveries(error);
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
        rejectPendingDeliveries(
          new Error("Qoder stream ended before queue acceptance"),
        );
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
        pendingDeliveries.clear();
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
          onClearPending: () => {
            // 回合终态作废未决请求：直接丢弃，不结算、不写文案。
          },
        });
        mappingState = createQoderMappingState();
        session.beginTurn(spec.turnId);
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
      async deliver(sessionId, turnId, message, placement) {
        if (placement === "active_turn") {
          throw { code: "unsupported_feature", feature: "active_turn" };
        }
        if (
          session === null ||
          session.sessionId !== sessionId ||
          stream === null
        )
          throw new WorkerDeliveryFailure(
            "Qoder session is unavailable before command dispatch",
            "not_accepted",
          );
        if (session?.turnId !== turnId) {
          mappingState = createQoderMappingState();
        }
        session?.setTurnId(turnId);
        const uuid = randomUUID();
        const queued = new Promise<void>((resolve, reject) => {
          pendingDeliveries.set(uuid, { resolve, reject });
        });
        try {
          stream.push(userMessage(message, "next", true, uuid));
        } catch (error) {
          pendingDeliveries.delete(uuid);
          throw new WorkerDeliveryFailure(
            "Qoder did not receive the command input",
            "not_accepted",
            { cause: error },
          );
        }
        await queued;
      },
      async interrupt() {
        throw { code: "unsupported_feature", feature: "interrupt" };
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
          rejectPendingDeliveries(
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
