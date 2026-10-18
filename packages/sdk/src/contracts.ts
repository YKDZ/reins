declare const sessionHandleBrand: unique symbol;
declare const turnHandleBrand: unique symbol;
declare const agentFactIdBrand: unique symbol;
declare const messageKeyBrand: unique symbol;
declare const toolKeyBrand: unique symbol;
declare const resumeCursorBrand: unique symbol;
declare const operationCredentialBrand: unique symbol;
declare const permissionHandleBrand: unique symbol;
declare const diagnosticIdBrand: unique symbol;

export type SessionHandle = string & {
  readonly [sessionHandleBrand]: "SessionHandle";
};
export type TurnHandle = string & {
  readonly [turnHandleBrand]: "TurnHandle";
};
export type AgentFactId = string & {
  readonly [agentFactIdBrand]: "AgentFactId";
};
export type MessageKey = string & { readonly [messageKeyBrand]: "MessageKey" };
export type ToolKey = string & { readonly [toolKeyBrand]: "ToolKey" };
export type ResumeCursor = string & {
  readonly [resumeCursorBrand]: "ResumeCursor";
};
export type PermissionHandle = string & {
  readonly [permissionHandleBrand]: "PermissionHandle";
};
export type DiagnosticId = string & {
  readonly [diagnosticIdBrand]: "DiagnosticId";
};
export type OperationKind =
  | "spawn"
  | "send"
  | "interrupt"
  | "kill"
  | "resolvePermission";
export type OperationCredential<Kind extends OperationKind> = string & {
  readonly [operationCredentialBrand]: Kind;
};

export type SpawnInput = {
  sessionLabel?: string;
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
export type SendInput =
  | {
      placement: "new_turn";
      sessionHandle: SessionHandle;
      message: string;
    }
  | {
      placement: "active_turn";
      turnHandle: TurnHandle;
      message: string;
    };
export type SendResult = {
  sessionHandle: SessionHandle;
  turnHandle: TurnHandle;
  messageKey: MessageKey;
  deliveryPoint: "active_turn" | "new_turn";
};
export type WaitInput = {
  targets: TurnHandle[];
  completion: "any" | "all";
  timeoutMs?: number;
};
export type CompletedTurn = {
  turnHandle: TurnHandle;
  finalReply: string | null;
  usage?: Record<string, unknown>;
  diagnosticId?: string;
  stopReason: StopReason;
} & (
  | { stopReason: "failed"; failure: HarnessFailure }
  | { stopReason: "end_turn" | "cancelled" | "killed" }
);
export type WaitResult = {
  status: "satisfied" | "timeout";
  completed: CompletedTurn[];
  pending: TurnHandle[];
};
export type InterruptInput = { turnHandle: TurnHandle };
export type InterruptResult = {
  turnHandle: TurnHandle;
  status: "accepted";
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

export type AgentTarget =
  | { scope: "session"; sessionHandle: SessionHandle }
  | { scope: "turn"; turnHandle: TurnHandle };
export type ReplayPolicy =
  | { mode: "none" }
  | { mode: "available" }
  | { mode: "after"; cursor: ResumeCursor };
export type AgentSubscriptionEstablishment = {
  target: AgentTarget;
  window: { oldest: number | null; head: number | null; truncated: boolean };
  replayed: number;
};
export type AgentSubscriptionEnd = {
  target: AgentTarget;
  reason:
    | "end_turn"
    | "cancelled"
    | "failed"
    | "killed"
    | "session_killed"
    | "closed";
};
type FactBase = {
  factId: AgentFactId;
  sessionHandle: SessionHandle;
};
type TurnFactBase = FactBase & { turnHandle: TurnHandle };
export type PermissionOption =
  | { outcome: "allow"; scope: "once" | "session" }
  | { outcome: "deny"; feedback: boolean };
export type PermissionResolution =
  | { outcome: "allow"; scope: "once" | "session" }
  | { outcome: "deny"; feedback?: string };
export type DiagnosticSource = "daemon" | "core" | "adapter" | "harness";
export type DiagnosticSeverity = "debug" | "info" | "warning" | "error";
export type DiagnosticKind =
  | "lifecycle"
  | "mapping_gap"
  | "compatibility_gap"
  | "request_failure"
  | "stream_failure"
  | "turn_failure"
  | "authorization_failure"
  | "protocol_violation"
  | "transport_failure"
  | "storage_failure"
  | "harness_stderr";
export type DiagnosticTextEvidence = {
  text: string;
  truncated: boolean;
  originalBytes: number;
};
export type DiagnosticsFilter = {
  harness?: string;
  sources?: DiagnosticSource[];
  kinds?: DiagnosticKind[];
  minSeverity?: DiagnosticSeverity;
  since?: string;
  until?: string;
  limit?: number;
};
export type DiagnosticsQuery =
  | { diagnosticId: DiagnosticId }
  | (DiagnosticsFilter & {
      sessionHandle?: SessionHandle;
      turnHandle?: never;
    })
  | (DiagnosticsFilter & {
      sessionHandle?: SessionHandle;
      turnHandle: TurnHandle;
    });
export type DiagnosticRecord = {
  v: 1;
  diagnosticId: DiagnosticId;
  recordedAt: string;
  severity: DiagnosticSeverity;
  source: DiagnosticSource;
  harness?: string;
  sessionHandle?: SessionHandle;
  turnHandle?: TurnHandle;
  kind: DiagnosticKind;
  operation?: string;
  stage?: string;
  reason?: string;
  message?: DiagnosticTextEvidence;
  [field: string]: unknown;
};
export type DiagnosticsResult =
  | { record: DiagnosticRecord }
  | { records: DiagnosticRecord[]; truncated: boolean };
export type AgentFact =
  | (FactBase & {
      type: "session.created";
      harness: string;
      model: string | null;
      reasoning: string | null;
      cwd: string;
      sessionLabel?: string;
      spawnedAt: string;
    })
  | (TurnFactBase & { type: "turn.started" })
  | (TurnFactBase & {
      type: "text.delta";
      messageKey: MessageKey;
      delta: string;
    })
  | (TurnFactBase & {
      type: "message";
      messageKey: MessageKey;
      role: "caller" | "worker";
      content: string;
    })
  | (TurnFactBase & { type: "tool.requested"; toolKey: ToolKey; name: string })
  | (TurnFactBase & {
      type: "tool.completed";
      toolKey: ToolKey;
      name: string;
      result: string | null;
      isError: boolean;
    })
  | (TurnFactBase & {
      type: "permission.requested";
      permissionHandle: PermissionHandle;
      kind: string;
      input?: unknown;
      options: PermissionOption[];
    })
  | (TurnFactBase & {
      type: "permission.resolved";
      permissionHandle: PermissionHandle;
      resolution: PermissionResolution;
    })
  | (TurnFactBase & {
      type: "turn.completed";
      finalReply: string | null;
      usage?: Record<string, unknown>;
      diagnosticId?: DiagnosticId;
      stopReason: "failed";
      failure: HarnessFailure;
    })
  | (TurnFactBase & {
      type: "turn.completed";
      finalReply: string | null;
      usage?: Record<string, unknown>;
      diagnosticId?: DiagnosticId;
      stopReason: "end_turn" | "cancelled" | "killed";
    })
  | (FactBase & { type: "session.killed" });
export type FactSubscription = AsyncIterableIterator<AgentFact> & {
  readonly establishment: AgentSubscriptionEstablishment;
  readonly done: Promise<AgentSubscriptionEnd>;
  readonly checkpoint: ResumeCursor;
  close(): void;
};

export type SessionFilter = {
  sessionHandle?: SessionHandle;
  harness?: string;
  state?: SessionState;
  sessionLabel?: string;
  model?: string;
};
export type LastCompletedTurn = {
  turnHandle: TurnHandle;
  stopReason: StopReason;
};
type SessionInfoFields = {
  sessionHandle: SessionHandle;
  sessionLabel?: string;
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
  daemon_disconnected: { resumeCursor?: ResumeCursor };
  daemon_shutting_down: Record<never, never>;
  workspace_detaching: Record<never, never>;
  command_id_conflict: Record<never, never>;
  stale_command_id: Record<never, never>;
  command_outcome_unknown: {
    cause: "timeout" | "disconnected" | "invalid_daemon_response";
    operation: OperationKind;
  };
  operation_credential_invalid: Record<never, never>;
  permission_not_pending: { permissionHandle: PermissionHandle };
  permission_resolution_mismatch: { permissionHandle: PermissionHandle };
  diagnostic_not_found: { diagnosticId: DiagnosticId };
  diagnostics_unavailable: Record<never, never>;
  unknown_harness: { harness: string; availableHarnesses: string[] };
  unsupported_feature: { feature: string };
  session_busy: { sessionHandle: SessionHandle };
  session_not_found: { sessionHandle: SessionHandle };
  session_killed: { sessionHandle: SessionHandle };
  session_terminating: { sessionHandle: SessionHandle };
  turn_not_active: { turnHandle: TurnHandle };
  capability_query_failed: { cause?: ErrorCause; diagnosticId?: string };
  internal_error: { cause?: ErrorCause; diagnosticId?: string };
  diagnostics_store_corrupt: { cause?: ErrorCause; diagnosticId?: string };
  daemon_start_failed: {
    cause?: ErrorCause;
    systemCode?: string;
    transportCode?: string;
  };
  unexpected_failure: { remoteCode?: string };
  event_cursor_expired: { oldest: number | null; head: number | null };
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
  attach(
    target: AgentTarget,
    replay: ReplayPolicy,
    signal?: AbortSignal,
  ): Promise<FactSubscription>;
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
  resolvePermission(
    permissionHandle: PermissionHandle,
    resolution: PermissionResolution,
    credential: OperationCredential<"resolvePermission">,
  ): Promise<{ permissionHandle: PermissionHandle; status: "resolved" }>;
  diagnostics(query?: DiagnosticsQuery): Promise<DiagnosticsResult>;
  send(
    input: SendInput,
    credential: OperationCredential<"send">,
  ): Promise<SendResult>;
  wait(input: WaitInput): Promise<WaitResult>;
  interrupt(
    input: InterruptInput,
    credential: OperationCredential<"interrupt">,
  ): Promise<InterruptResult>;
  close(): void;
};
