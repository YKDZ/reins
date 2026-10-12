import {
  createReinsClient,
  ReinsClientError,
  type ReinsClient as ControlClient,
} from "@reins/client/control";
import type {
  MachineError,
  ProtocolMessage,
  ProtocolParams,
  ProtocolResult,
  SessionInfo as ProtocolSessionInfo,
  SessionId,
} from "@reins/protocol";
import {
  consumerContextSchema,
  encodeTurnHandle,
  REINS_PROTOCOL_MAJOR_VERSION,
} from "@reins/protocol";
import { createUnixSocketClient, isTransportError } from "@reins/transport";
import * as v from "valibot";

import {
  type ConnectOptions,
  type ReinsConnection,
  type ReinsFailure,
  type SessionHandle,
  type SessionInfo,
  type TurnHandle,
} from "./contracts.ts";
import { ReinsSdkError } from "./errors.ts";

export { ReinsSdkError } from "./errors.ts";
export type { ReinsSdkErrorStage } from "./errors.ts";
export type {
  CapabilitiesResult,
  CapabilityFailure,
  CapabilityModel,
  ConnectOptions,
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
  StopReason,
  TurnHandle,
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

async function query<M extends "capabilities" | "list">(
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

function projectClientFailure(
  failure: ReinsClientError["failure"],
): ReinsFailure {
  if ("retryToken" in failure)
    return {
      code: "unexpected_failure",
      facts: { remoteCode: failure.code },
    };
  return projectFailure(failure);
}

function projectFailure(failure: MachineError): ReinsFailure {
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
    case "session_not_found":
    case "session_killed":
    case "session_terminating":
      return {
        code: failure.code,
        facts: {
          sessionHandle: failure.sessionId as unknown as SessionHandle,
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
