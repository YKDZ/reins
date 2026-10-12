import {
  createReinsClient,
  AgentSubscriptionError,
  isCommandOutcomeUnknown,
  OperationCredentialError,
  ReinsClientError,
  createPresentationProjector as createClientPresentationProjector,
  type ReinsClient as ControlClient,
} from "@reins/client/control";
import type {
  AttachParams,
  DiagnosticId as ProtocolDiagnosticId,
  DiagnosticRecord as ProtocolDiagnosticRecord,
  DiagnosticsResult as ProtocolDiagnosticsResult,
  MachineError,
  ProtocolMessage,
  ProtocolParams,
  ProtocolResult,
  SideEffectMethod,
  SessionInfo as ProtocolSessionInfo,
  SessionId,
  TurnId,
  ResumeCursor as ProtocolResumeCursor,
} from "@reins/protocol";
import {
  consumerContextSchema,
  decodePermissionHandle,
  decodeTurnHandle,
  encodePermissionHandle,
  encodeTurnHandle,
  REINS_PROTOCOL_MAJOR_VERSION,
  sessionIdSchema,
  turnHandleSchema,
} from "@reins/protocol";
import { createUnixSocketClient, isTransportError } from "@reins/transport";
import * as v from "valibot";

import {
  type ConnectOptions,
  type DiagnosticId,
  type DiagnosticRecord,
  type DiagnosticsQuery,
  type DiagnosticsResult,
  type OperationCredential,
  type OperationKind,
  type ReinsConnection,
  type ReinsFailure,
  type AgentFact,
  type AgentPresentation,
  type AgentSubscriptionEnd,
  type AgentTarget,
  type ReplayPolicy,
  type ResumeCursor,
  type FactSubscription,
  type SessionHandle,
  type SessionInfo,
  type PermissionHandle,
  type TurnHandle,
  type SendInput,
  type SendResult,
  type WaitInput,
  type WaitResult,
  type InterruptInput,
  type InterruptResult,
} from "./contracts.ts";
import { ReinsSdkError } from "./errors.ts";

export { ReinsSdkError } from "./errors.ts";
export type { ReinsSdkErrorStage } from "./errors.ts";
export type {
  CapabilitiesResult,
  CapabilityFailure,
  CapabilityModel,
  ConnectOptions,
  DiagnosticId,
  DiagnosticRecord,
  DiagnosticsFilter,
  DiagnosticsQuery,
  DiagnosticsResult,
  KillInput,
  KillResult,
  SendInput,
  SendResult,
  WaitInput,
  WaitResult,
  CompletedTurn,
  InterruptInput,
  InterruptResult,
  OperationCredential,
  OperationKind,
  HarnessCapability,
  HarnessFailure,
  LastCompletedTurn,
  ReinsConnection,
  ReinsFailure,
  ReinsFailureCode,
  ReinsHandshake,
  SessionFilter,
  SessionHandle,
  SessionInfo,
  SessionState,
  SpawnInput,
  SpawnResult,
  StopReason,
  TurnHandle,
  AgentFact,
  AgentFactId,
  AgentPresentation,
  AgentSubscriptionEnd,
  AgentSubscriptionEstablishment,
  AgentTarget,
  FactSubscription,
  MessageKey,
  PermissionOption,
  PermissionHandle,
  PermissionResolution,
  ReplayPolicy,
  ResumeCursor,
  ToolKey,
} from "./contracts.ts";

export async function connect(
  options: ConnectOptions,
): Promise<ReinsConnection> {
  let client: ControlClient | undefined;
  let stage: "connect" | "handshake" = "connect";
  try {
    const consumerContext = v.safeParse(
      consumerContextSchema,
      options.consumerContext,
    );
    if (!consumerContext.success)
      throw new ReinsSdkError(
        {
          code: "consumer_context_required",
          facts: {},
        },
        stage,
      );
    const transport = await createUnixSocketClient<ProtocolMessage>(
      options.socketPath,
    );
    client = createReinsClient(transport, {
      consumerContext: consumerContext.output,
    });
    stage = "handshake";
    const handshakeResponse = await client.initialize(options.timeoutMs);
    if ("error" in handshakeResponse)
      throw new ReinsSdkError(projectFailure(handshakeResponse.error), stage);
    if (
      handshakeResponse.result.protocolMajorVersion !==
      REINS_PROTOCOL_MAJOR_VERSION
    )
      throw new ReinsSdkError(
        {
          code: "protocol_version_mismatch",
          facts: {
            requestedProtocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
            supportedProtocolMajorVersion:
              handshakeResponse.result.protocolMajorVersion,
          },
        },
        stage,
      );
    const handshake = {
      protocolMajorVersion: handshakeResponse.result.protocolMajorVersion,
      daemonGeneration: handshakeResponse.result.daemonGeneration,
    };

    return {
      handshake,
      async capabilities() {
        const result = await query(client!, "capabilities", {});
        return {
          capabilities: result.capabilities,
          failures: result.failures.map(
            ({ code: _code, diagnosticId, failure, harness }) => ({
              harness,
              ...failure,
              ...(diagnosticId === undefined ? {} : { diagnosticId }),
            }),
          ),
        };
      },
      async list(filter) {
        const { sessionHandle, ...rest } = filter ?? {};
        const params = {
          ...rest,
          ...(sessionHandle === undefined
            ? {}
            : { sessionId: sessionHandle as unknown as SessionId }),
        } as ProtocolParams<"list">;
        return (await query(client!, "list", params)).map(mapSessionInfo);
      },
      async diagnostics(filter) {
        const result = await query(
          client!,
          "diagnostics",
          projectDiagnosticsParams(filter),
        );
        return projectDiagnosticsResult(result);
      },
      async attach(target, replay, signal) {
        let source: Awaited<ReturnType<ControlClient["subscribeFacts"]>>;
        try {
          source = await client!.subscribeFacts(
            projectAttachParams(target, replay),
            signal,
          );
        } catch (error) {
          throw projectSubscriptionError(error);
        }
        const done = source.done.catch((error: unknown) => {
          throw projectSubscriptionError(error);
        });
        void done.catch(() => undefined);
        let finished = false;
        const subscription: FactSubscription = {
          establishment:
            source.establishment as unknown as FactSubscription["establishment"],
          done: done as unknown as Promise<AgentSubscriptionEnd>,
          get checkpoint() {
            return source.checkpoint as unknown as ResumeCursor;
          },
          async next() {
            if (finished) return { value: undefined, done: true };
            try {
              const item = await source.next();
              if (item.done) {
                finished = true;
                return { value: undefined, done: true };
              }
              return { value: item.value as unknown as AgentFact, done: false };
            } catch (error) {
              throw projectSubscriptionError(error);
            }
          },
          async return() {
            finished = true;
            await source.return?.();
            return { value: undefined, done: true };
          },
          async throw(error?: unknown) {
            finished = true;
            await source.throw?.(error);
            throw error;
          },
          [Symbol.asyncIterator]() {
            return subscription;
          },
          close() {
            finished = true;
            source.close();
          },
        };
        return subscription;
      },
      prepareOperation(kind) {
        try {
          return client!.prepareOperation(kind) as OperationCredential<
            typeof kind
          >;
        } catch (error) {
          if (error instanceof ReinsClientError)
            throw new ReinsSdkError(
              projectClientFailure(error.failure),
              "operation",
            );
          throw new ReinsSdkError(
            { code: "unexpected_failure", facts: {} },
            "operation",
          );
        }
      },
      async spawn(input, credential) {
        const result = await perform(
          client!,
          "spawn",
          input as unknown as ProtocolParams<"spawn">,
          credential,
        );
        return {
          sessionHandle: result.sessionId as unknown as SessionHandle,
          turnHandle: encodeTurnHandle({
            sessionId: result.sessionId,
            turnId: result.turnId,
          }) as unknown as TurnHandle,
          cwd: result.cwd,
        };
      },
      async kill(input, credential) {
        const result = await perform(
          client!,
          "kill",
          {
            sessionId: input.sessionHandle as unknown as SessionId,
          },
          credential,
        );
        return {
          sessionHandle: result.sessionId as unknown as SessionHandle,
          status: result.status,
        };
      },
      async resolvePermission(permissionHandle, resolution, credential) {
        let target: ReturnType<typeof decodePermissionHandle>;
        try {
          target = decodePermissionHandle(permissionHandle);
        } catch {
          throw new ReinsSdkError(
            {
              code: "invalid_params",
              facts: {
                issues: [{ issue: "invalid_value", path: "permissionHandle" }],
              },
            },
            "operation",
          );
        }
        const result = await perform(
          client!,
          "resolvePermission",
          { ...target, resolution },
          credential,
          permissionHandle,
        );
        return {
          permissionHandle: encodePermissionHandle(result) as PermissionHandle,
          status: "resolved",
        };
      },
      async send(input: SendInput, credential) {
        if (
          typeof input !== "object" ||
          input === null ||
          (input.placement !== "active_turn" && input.placement !== "new_turn")
        )
          throw invalidInput("placement", "operation");
        let params: ProtocolParams<"send">;
        if (input.placement === "active_turn") {
          const target = targetFromHandle(input.turnHandle, "turnHandle");
          params = {
            placement: "active_turn",
            ...target,
            message: input.message,
          };
        } else {
          if (!v.safeParse(sessionIdSchema, input.sessionHandle).success)
            throw invalidInput("sessionHandle", "operation");
          params = {
            placement: "new_turn",
            sessionId: input.sessionHandle as unknown as SessionId,
            message: input.message,
          };
        }
        const result = await perform(client!, "send", params, credential);
        return {
          sessionHandle: result.sessionId as unknown as SessionHandle,
          turnHandle: encodeTurnHandle({
            sessionId: result.sessionId,
            turnId: result.turnId,
          }) as unknown as TurnHandle,
          messageId: result.messageId,
          deliveryPoint: result.deliveryPoint,
        } satisfies SendResult;
      },
      async wait(input: WaitInput) {
        if (!Array.isArray(input.targets) || input.targets.length === 0)
          throw invalidInput("targets", "query");
        const targets = input.targets.map((handle) =>
          targetFromHandle(handle, "targets", "query"),
        );
        if (
          new Set(
            targets.map(({ sessionId, turnId }) => `${sessionId}/${turnId}`),
          ).size !== targets.length
        )
          throw invalidInput("targets", "query");
        if (input.completion !== "any" && input.completion !== "all")
          throw invalidInput("completion", "query");
        if (
          input.timeoutMs !== undefined &&
          (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 0)
        )
          throw invalidInput("timeoutMs", "query");
        const result = await query(client!, "wait", {
          targets,
          completion: input.completion,
          ...(input.timeoutMs === undefined
            ? {}
            : { timeoutMs: input.timeoutMs }),
        });
        return {
          status: result.status,
          completed: result.completed.map(projectCompletedTurn),
          pending: result.pending.map(
            (target) => encodeTurnHandle(target) as unknown as TurnHandle,
          ),
        } satisfies WaitResult;
      },
      async interrupt(input: InterruptInput, credential) {
        const target = targetFromHandle(input.turnHandle, "turnHandle");
        await perform(client!, "interrupt", target, credential);
        return {
          turnHandle: input.turnHandle,
          status: "accepted",
        } satisfies InterruptResult;
      },
      close() {
        client?.close();
      },
    };
  } catch (error) {
    client?.close();
    if (error instanceof ReinsSdkError) throw error;
    if (error instanceof ReinsClientError)
      throw new ReinsSdkError(projectClientFailure(error.failure), stage);
    if (isTransportError(error))
      throw new ReinsSdkError(
        {
          code: "daemon_disconnected",
          facts: {},
        },
        stage,
      );
    throw new ReinsSdkError(
      {
        code: "unexpected_failure",
        facts: {},
      },
      stage,
    );
  }
}

export function createPresentationProjector(): (
  fact: AgentFact,
) => AgentPresentation[] {
  return createClientPresentationProjector() as unknown as (
    fact: AgentFact,
  ) => AgentPresentation[];
}

function projectAttachParams(
  target: AgentTarget,
  replay: ReplayPolicy,
): AttachParams {
  const protocolReplay =
    replay.mode === "after"
      ? {
          mode: "after" as const,
          cursor: replay.cursor as unknown as ProtocolResumeCursor,
        }
      : replay;
  if (target.scope === "session")
    return {
      scope: "session",
      sessionId: target.sessionHandle as unknown as SessionId,
      replay: protocolReplay,
    };
  return {
    scope: "turn",
    ...decodeTurnHandle(target.turnHandle),
    replay: protocolReplay,
  };
}

function projectSubscriptionError(error: unknown): ReinsSdkError | Error {
  if (error instanceof Error && error.name === "AbortError") return error;
  if (error instanceof ReinsSdkError) return error;
  if (error instanceof AgentSubscriptionError) {
    const failure = projectFailure(error.failure);
    if (
      failure.code === "daemon_disconnected" &&
      error.resumeCursor !== undefined
    )
      return new ReinsSdkError({
        code: "daemon_disconnected",
        facts: {
          resumeCursor: error.resumeCursor as unknown as ResumeCursor,
        },
      });
    return new ReinsSdkError(failure);
  }
  if (error instanceof ReinsClientError)
    return new ReinsSdkError(projectClientFailure(error.failure));
  if (isTransportError(error))
    return new ReinsSdkError({ code: "daemon_disconnected", facts: {} });
  return new ReinsSdkError({ code: "unexpected_failure", facts: {} });
}
async function perform<M extends SideEffectMethod>(
  client: ControlClient,
  method: M,
  params: ProtocolParams<M>,
  credential: OperationCredential<M & OperationKind>,
  permissionHandle?: PermissionHandle,
): Promise<ProtocolResult<M>> {
  try {
    const response = await client.executeOperation(method, params, credential);
    if ("error" in response)
      throw new ReinsSdkError(
        projectFailure(response.error, permissionHandle),
        "operation",
      );
    return response.result;
  } catch (error) {
    if (error instanceof ReinsSdkError) throw error;
    if (error instanceof OperationCredentialError)
      throw new ReinsSdkError(
        { code: "operation_credential_invalid", facts: {} },
        "operation",
      );
    if (error instanceof ReinsClientError)
      throw new ReinsSdkError(projectClientFailure(error.failure), "operation");
    throw new ReinsSdkError(
      { code: "unexpected_failure", facts: {} },
      "operation",
    );
  }
}

async function query<
  M extends "capabilities" | "list" | "diagnostics" | "wait",
>(
  client: ControlClient,
  method: M,
  params: ProtocolParams<M>,
): Promise<ProtocolResult<M>> {
  try {
    const response = await client.request(method, params);
    if ("error" in response)
      throw new ReinsSdkError(projectFailure(response.error));
    return response.result;
  } catch (error) {
    if (error instanceof ReinsSdkError) throw error;
    if (error instanceof ReinsClientError)
      throw new ReinsSdkError(projectClientFailure(error.failure));
    throw new ReinsSdkError({ code: "unexpected_failure", facts: {} });
  }
}

function projectDiagnosticsParams(
  query: DiagnosticsQuery | undefined,
): ProtocolParams<"diagnostics"> {
  if (query === undefined) return {};
  if ("diagnosticId" in query)
    return {
      diagnosticId: query.diagnosticId as unknown as ProtocolDiagnosticId,
    };
  const { sessionHandle, turnHandle, ...filters } = query;
  if (turnHandle !== undefined) {
    const target = decodeTurnHandle(turnHandle);
    if (
      sessionHandle !== undefined &&
      sessionHandle !== (target.sessionId as unknown as SessionHandle)
    )
      throw new ReinsSdkError({
        code: "invalid_params",
        facts: {
          issues: [
            {
              issue: "invalid_combination",
              paths: ["sessionHandle", "turnHandle"],
            },
          ],
        },
      });
    return { ...filters, ...target } as ProtocolParams<"diagnostics">;
  }
  return {
    ...filters,
    ...(sessionHandle === undefined
      ? {}
      : { sessionId: sessionHandle as unknown as SessionId }),
  } as ProtocolParams<"diagnostics">;
}

function projectDiagnosticsResult(
  result: ProtocolDiagnosticsResult,
): DiagnosticsResult {
  if ("record" in result)
    return { record: projectDiagnosticRecord(result.record) };
  return {
    records: result.records.map(projectDiagnosticRecord),
    truncated: result.truncated,
  };
}

function projectDiagnosticRecord(
  record: ProtocolDiagnosticRecord,
): DiagnosticRecord {
  const address = record as ProtocolDiagnosticRecord & {
    sessionId?: SessionId;
    turnId?: TurnId;
  };
  const { sessionId, turnId, diagnosticId, ...fields } = address;
  return {
    ...fields,
    diagnosticId: diagnosticId as unknown as DiagnosticId,
    ...(sessionId === undefined
      ? {}
      : { sessionHandle: sessionId as unknown as SessionHandle }),
    ...(turnId === undefined || sessionId === undefined
      ? {}
      : {
          turnHandle: encodeTurnHandle({
            sessionId,
            turnId,
          }) as unknown as TurnHandle,
        }),
  } as DiagnosticRecord;
}

function targetFromHandle(
  handle: unknown,
  path: string,
  stage: "query" | "operation" = "operation",
): {
  sessionId: SessionId;
  turnId: ReturnType<typeof decodeTurnHandle>["turnId"];
} {
  if (
    typeof handle !== "string" ||
    !v.safeParse(turnHandleSchema, handle).success
  )
    throw invalidInput(path, stage);
  return decodeTurnHandle(handle);
}

function invalidInput(
  path: string,
  stage: "query" | "operation",
): ReinsSdkError {
  return new ReinsSdkError(
    {
      code: "invalid_params",
      facts: { issues: [{ issue: "invalid_value", path }] },
    },
    stage,
  );
}

function projectCompletedTurn(
  turn: ProtocolResult<"wait">["completed"][number],
): import("./contracts.ts").CompletedTurn {
  const { sessionId, turnId, usage, diagnosticId, ...fields } = turn;
  return {
    ...fields,
    turnHandle: encodeTurnHandle({
      sessionId,
      turnId,
    }) as unknown as TurnHandle,
    ...(usage === undefined ? {} : { usage }),
    ...(diagnosticId === undefined ? {} : { diagnosticId }),
  } as import("./contracts.ts").CompletedTurn;
}

function projectClientFailure(
  failure: ReinsClientError["failure"],
): ReinsFailure {
  if (isCommandOutcomeUnknown(failure)) {
    if (
      failure.method !== "spawn" &&
      failure.method !== "send" &&
      failure.method !== "interrupt" &&
      failure.method !== "kill" &&
      failure.method !== "resolvePermission"
    )
      return {
        code: "unexpected_failure",
        facts: { remoteCode: failure.code },
      };
    return {
      code: "command_outcome_unknown",
      facts: { cause: failure.cause, operation: failure.method },
    };
  }
  return projectFailure(failure);
}

function projectFailure(
  failure: MachineError,
  permissionHandle?: PermissionHandle,
): ReinsFailure {
  switch (failure.code) {
    case "consumer_context_required":
    case "protocol_error":
    case "daemon_timeout":
    case "invalid_daemon_response":
    case "daemon_shutting_down":
    case "workspace_detaching":
      return { code: failure.code, facts: {} };
    case "daemon_disconnected":
      return { code: failure.code, facts: {} };
    case "event_cursor_expired":
      return {
        code: failure.code,
        facts: { oldest: failure.oldest, head: failure.head },
      };
    case "command_id_conflict":
    case "stale_command_id":
      return { code: failure.code, facts: {} };
    case "protocol_version_mismatch":
      return {
        code: failure.code,
        facts: {
          requestedProtocolMajorVersion: failure.requestedProtocolMajorVersion,
          supportedProtocolMajorVersion: failure.supportedProtocolMajorVersion,
        },
      };
    case "invalid_params":
      return {
        code: failure.code,
        facts: {
          issues: failure.issues.map((issue) =>
            issue.issue === "invalid_combination"
              ? {
                  ...issue,
                  paths: issue.paths.map(publicParameterPath),
                }
              : { ...issue, path: publicParameterPath(issue.path) },
          ),
        },
      };
    case "method_not_found":
      return { code: failure.code, facts: { method: failure.method } };
    case "unknown_harness":
      return {
        code: failure.code,
        facts: {
          harness: failure.harness,
          availableHarnesses: failure.availableHarnesses,
        },
      };
    case "unsupported_feature":
      return { code: failure.code, facts: { feature: failure.feature } };
    case "session_name_conflict":
      return {
        code: failure.code,
        facts: { sessionName: failure.sessionName },
      };
    case "session_busy":
      return {
        code: failure.code,
        facts: {
          sessionHandle: failure.sessionId as unknown as SessionHandle,
        },
      };
    case "session_not_found":
    case "session_killed":
    case "session_terminating":
      return {
        code: failure.code,
        facts: {
          sessionHandle: failure.sessionId as unknown as SessionHandle,
        },
      };
    case "permission_not_pending":
    case "permission_resolution_mismatch":
      return permissionHandle === undefined
        ? { code: "unexpected_failure", facts: { remoteCode: failure.code } }
        : { code: failure.code, facts: { permissionHandle } };
    case "diagnostic_not_found":
      return {
        code: failure.code,
        facts: {
          diagnosticId: failure.diagnosticId as unknown as DiagnosticId,
        },
      };
    case "diagnostics_unavailable":
      return { code: failure.code, facts: {} };
    case "turn_not_active":
      return {
        code: failure.code,
        facts: {
          turnHandle: encodeTurnHandle({
            sessionId: failure.sessionId,
            turnId: failure.turnId,
          }) as unknown as TurnHandle,
        },
      };
    case "capability_query_failed":
    case "internal_error":
    case "diagnostics_store_corrupt":
      return {
        code: failure.code,
        facts: {
          ...(failure.cause === undefined ? {} : { cause: failure.cause }),
          ...(failure.diagnosticId === undefined
            ? {}
            : { diagnosticId: failure.diagnosticId }),
        },
      };
    case "daemon_start_failed":
      return {
        code: failure.code,
        facts: { cause: failure.cause },
      };
    default:
      return {
        code: "unexpected_failure",
        facts: { remoteCode: failure.code },
      };
  }
}

function publicParameterPath(path: string): string {
  return path.replace(/(^|\.)sessionId(?=\.|$)/gu, "$1sessionHandle");
}

function mapSessionInfo(session: ProtocolSessionInfo): SessionInfo {
  const sessionHandle = session.sessionId as unknown as SessionHandle;
  const common = {
    sessionHandle,
    sessionName: session.sessionName,
    harness: session.harness,
    model: session.model,
    reasoning: session.reasoning,
    cwd: session.cwd,
    spawnedAt: session.spawnedAt,
    turns: session.turns,
  };
  const lastCompletedTurn =
    session.lastCompletedTurn === undefined
      ? undefined
      : {
          turnHandle: encodeTurnHandle({
            sessionId: session.sessionId,
            turnId: session.lastCompletedTurn.turnId,
          }) as unknown as TurnHandle,
          stopReason: session.lastCompletedTurn.stopReason,
        };

  if (session.state === "busy") {
    return {
      ...common,
      state: "busy",
      activeTurn: encodeTurnHandle({
        sessionId: session.sessionId,
        turnId: session.activeTurnId,
      }) as unknown as TurnHandle,
      ...(lastCompletedTurn === undefined ? {} : { lastCompletedTurn }),
    };
  }
  if (session.state === "idle")
    return {
      ...common,
      state: "idle",
      lastCompletedTurn: lastCompletedTurn!,
    };
  return {
    ...common,
    state: "killed",
    ...(lastCompletedTurn === undefined ? {} : { lastCompletedTurn }),
  };
}
