declare const sessionHandleBrand: unique symbol;
declare const turnHandleBrand: unique symbol;
declare const operationCredentialBrand: unique symbol;

export type SessionHandle = string & {
  readonly [sessionHandleBrand]: "SessionHandle";
};
export type TurnHandle = string & {
  readonly [turnHandleBrand]: "TurnHandle";
};
export type OperationKind = "spawn" | "kill";
export type OperationCredential<Kind extends OperationKind> = string & {
  readonly [operationCredentialBrand]: Kind;
};

export type SpawnInput = {
  sessionName: string;
  harness: string;
  message: string;
  cwd: string;
  agent?: string;
  model?: string;
  reasoning?: string;
  authorizationMode?: "interactive" | "allowAll";
  sandbox?: string;
  captureHarnessStderr?: boolean;
};
export type SpawnResult = {
  sessionHandle: SessionHandle;
  turnHandle: TurnHandle;
  cwd: string;
};
export type KillInput = { sessionHandle: SessionHandle };
export type KillResult = {
  sessionHandle: SessionHandle;
  status: "killed" | "not_found";
};

export type StopReason = "end_turn" | "cancelled" | "failed" | "killed";
export type SessionState = "busy" | "idle" | "killed";
export type HarnessFailure = {
  failureCategory:
    | "credential_rejected"
    | "quota_exhausted"
    | "balance_exhausted"
    | "account_unavailable"
    | "rate_limited"
    | "model_unavailable"
    | "request_rejected"
    | "provider_unavailable"
    | "runtime_unavailable"
    | "unclassified";
  retryDisposition:
    | "wait"
    | "external_state_change"
    | "input_change"
    | "unknown";
};

export type CapabilityModel = {
  id: string;
  displayName: string;
  reasoningEfforts: string[];
};
export type HarnessCapability = {
  harness: string;
  models: CapabilityModel[];
};
export type CapabilityFailure = HarnessFailure & {
  harness: string;
  diagnosticId?: string;
};
export type CapabilitiesResult = {
  capabilities: HarnessCapability[];
  failures: CapabilityFailure[];
};

export type SessionFilter = {
  sessionHandle?: SessionHandle;
  harness?: string;
  state?: SessionState;
  sessionName?: string;
  model?: string;
};
export type LastCompletedTurn = {
  turnHandle: TurnHandle;
  stopReason: StopReason;
};
type SessionInfoFields = {
  sessionHandle: SessionHandle;
  sessionName: string;
  harness: string;
  model: string | null;
  reasoning: string | null;
  cwd: string;
  spawnedAt: string;
  turns: number;
};
export type SessionInfo =
  | (SessionInfoFields & {
      state: "busy";
      activeTurn: TurnHandle;
      lastCompletedTurn?: LastCompletedTurn;
    })
  | (SessionInfoFields & {
      state: "idle";
      lastCompletedTurn: LastCompletedTurn;
    })
  | (SessionInfoFields & {
      state: "killed";
      lastCompletedTurn?: LastCompletedTurn;
    });

export type InvalidParameterIssue =
  | {
      issue: "missing_required";
      path: string;
    }
  | {
      issue: "invalid_type";
      path: string;
      expected: "string" | "number" | "boolean" | "array" | "object";
    }
  | {
      issue: "invalid_value";
      path: string;
    }
  | {
      issue: "invalid_combination";
      paths: string[];
    };

export type ErrorCause = {
  kind: "exception" | "upstream" | "io" | "timeout" | "closed";
  message: string;
};

type FailureFactsByCode = {
  consumer_context_required: Record<never, never>;
  protocol_version_mismatch: {
    requestedProtocolMajorVersion: number;
    supportedProtocolMajorVersion: number;
  };
  invalid_params: { issues: InvalidParameterIssue[] };
  method_not_found: { method: string };
  protocol_error: Record<never, never>;
  daemon_timeout: Record<never, never>;
  invalid_daemon_response: Record<never, never>;
  daemon_disconnected: Record<never, never>;
  daemon_shutting_down: Record<never, never>;
  workspace_detaching: Record<never, never>;
  command_id_conflict: Record<never, never>;
  stale_command_id: Record<never, never>;
  command_outcome_unknown: {
    cause: "timeout" | "disconnected" | "invalid_daemon_response";
    operation: OperationKind;
  };
  operation_credential_invalid: Record<never, never>;
  unknown_harness: { harness: string; availableHarnesses: string[] };
  unsupported_feature: { feature: string };
  session_name_conflict: { sessionName: string };
  session_not_found: { sessionHandle: SessionHandle };
  session_killed: { sessionHandle: SessionHandle };
  session_terminating: { sessionHandle: SessionHandle };
  capability_query_failed: { cause?: ErrorCause; diagnosticId?: string };
  internal_error: { cause?: ErrorCause; diagnosticId?: string };
  diagnostics_store_corrupt: { cause?: ErrorCause; diagnosticId?: string };
  daemon_start_failed: {
    cause?: ErrorCause;
    systemCode?: string;
    transportCode?: string;
  };
  unexpected_failure: { remoteCode?: string };
};

/** 失败事实按 code 区分，并使用 SDK 公开术语表达。 */
export type ReinsFailure = {
  [Code in keyof FailureFactsByCode]: {
    code: Code;
    facts: FailureFactsByCode[Code];
  };
}[keyof FailureFactsByCode];
export type ReinsFailureCode = ReinsFailure["code"];

export type ReinsHandshake = {
  protocolMajorVersion: number;
  daemonGeneration: string;
};
export type ConnectOptions = {
  socketPath: string;
  consumerContext: string;
  timeoutMs?: number;
};
export type ReinsConnection = {
  readonly handshake: ReinsHandshake;
  capabilities(): Promise<CapabilitiesResult>;
  list(filter?: SessionFilter): Promise<SessionInfo[]>;
  prepareOperation<Kind extends OperationKind>(
    kind: Kind,
  ): OperationCredential<Kind>;
  spawn(
    input: SpawnInput,
    credential: OperationCredential<"spawn">,
  ): Promise<SpawnResult>;
  kill(
    input: KillInput,
    credential: OperationCredential<"kill">,
  ): Promise<KillResult>;
  close(): void;
};
