import {
  connect,
  ReinsSdkError,
  type CapabilityFailure,
  type CapabilitiesResult,
  type HarnessFailure,
  type LastCompletedTurn,
  type ReinsConnection,
  type ReinsFailure,
  type ReinsSdkErrorStage,
  type SessionHandle,
  type SessionInfo,
  type TurnHandle,
} from "@ykdz/reins-sdk";

declare const process: {
  env: Record<string, string | undefined>;
};

function inspectFailure(failure: ReinsFailure): string {
  switch (failure.code) {
    case "protocol_version_mismatch":
      return String(failure.facts.requestedProtocolMajorVersion);
    case "invalid_params":
      return failure.facts.issues
        .map((issue) =>
          issue.issue === "invalid_combination"
            ? issue.paths.join(",")
            : issue.path,
        )
        .join(",");
    case "session_not_found":
    case "session_killed":
    case "session_terminating":
      return failure.facts.sessionHandle;
    case "daemon_start_failed":
      return failure.facts.transportCode ?? failure.facts.cause?.kind ?? "";
    case "capability_query_failed":
    case "internal_error":
    case "diagnostics_store_corrupt":
      return failure.facts.diagnosticId ?? failure.facts.cause?.kind ?? "";
    case "unknown_harness":
      return failure.facts.availableHarnesses.join(",");
    case "command_outcome_unknown":
      return failure.facts.operation;
    case "session_name_conflict":
      return failure.facts.sessionName;
    case "session_busy":
      return failure.facts.sessionHandle;
    case "turn_not_active":
      return failure.facts.turnHandle;
    case "unsupported_feature":
      return failure.facts.feature;
    case "event_cursor_expired":
      return `${failure.facts.oldest ?? "empty"}:${failure.facts.head ?? "empty"}`;
    case "method_not_found":
      return failure.facts.method;
    case "command_id_conflict":
    case "stale_command_id":
    case "operation_credential_invalid":
      return failure.code;
    case "unexpected_failure":
      return failure.facts.remoteCode ?? "";
    case "consumer_context_required":
    case "protocol_error":
    case "daemon_timeout":
    case "invalid_daemon_response":
    case "daemon_disconnected":
    case "daemon_shutting_down":
    case "workspace_detaching":
      return failure.code;
  }
}

function inspectCapabilities(
  result: CapabilitiesResult,
): Array<
  [HarnessFailure["failureCategory"], HarnessFailure["retryDisposition"]]
> {
  const typedFailures: CapabilityFailure[] = result.failures;
  return typedFailures.map(({ failureCategory, retryDisposition }) => [
    failureCategory,
    retryDisposition,
  ]);
}

function inspectSession(session: SessionInfo): string {
  if (session.state === "busy") {
    const activeTurn: TurnHandle = session.activeTurn;
    return activeTurn;
  }
  if (session.state === "idle") {
    const last: LastCompletedTurn = session.lastCompletedTurn;
    return last.turnHandle;
  }
  return session.lastCompletedTurn?.stopReason ?? session.sessionHandle;
}

function inspectConnection(connection: ReinsConnection): string {
  const majorVersion: number = connection.handshake.protocolMajorVersion;
  const generation: string = connection.handshake.daemonGeneration;
  return `${majorVersion}:${generation}`;
}

async function main(): Promise<void> {
  const socketPath = process.env.REINS_SOCKET;
  const consumerContext = process.env.REINS_CONSUMER_CONTEXT;
  if (socketPath === undefined || consumerContext === undefined)
    throw new Error(
      "The installed SDK query fixture needs socket and consumer context",
    );

  const connection = await connect({ socketPath, consumerContext });
  try {
    const capabilities = await connection.capabilities();
    const sessions = await connection.list();
    if (
      capabilities.capabilities[0]?.harness !== "fixture" ||
      inspectCapabilities(capabilities).length !== 0 ||
      sessions.length !== 0
    )
      throw new Error("The installed SDK returned unexpected query results");
    inspectConnection(connection);
    for (const session of sessions) inspectSession(session);

    let invalidParams: ReinsSdkError | undefined;
    try {
      await connection.list({ sessionHandle: "" as SessionHandle });
    } catch (error) {
      if (error instanceof ReinsSdkError) invalidParams = error;
      else throw error;
    }
    if (
      invalidParams === undefined ||
      invalidParams.stage !== "query" ||
      invalidParams.failure.code !== "invalid_params"
    )
      throw new Error(
        "The installed SDK did not return a typed invalid-params failure",
      );

    const path = inspectFailure(invalidParams.failure);
    if (!path.split(",").includes("sessionHandle"))
      throw new Error(
        `The SDK failure did not expose its public parameter path: ${path}`,
      );

    const typedStage: ReinsSdkErrorStage = invalidParams.stage;
    if (typedStage !== "query")
      throw new Error("The SDK failure stage was not query");
  } finally {
    connection.close();
  }
}

await main();
