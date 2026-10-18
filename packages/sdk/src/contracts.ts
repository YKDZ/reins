declare const sessionHandleBrand: unique symbol;
declare const turnHandleBrand: unique symbol;
declare const agentFactIdBrand: unique symbol;
declare const messageKeyBrand: unique symbol;
declare const toolKeyBrand: unique symbol;
declare const resumeCursorBrand: unique symbol;
declare const operationKeyBrand: unique symbol;
declare const permissionHandleBrand: unique symbol;
declare const diagnosticIdBrand: unique symbol;
declare const runtimeScopeIdBrand: unique symbol;

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
export type RuntimeScopeId = string & {
  readonly [runtimeScopeIdBrand]: "RuntimeScopeId";
};
export type OperationKind =
  | "spawn"
  | "send"
  | "interrupt"
  | "kill"
  | "resolvePermission";
export type OperationKey<Kind extends OperationKind> = string & {
  readonly [operationKeyBrand]: Kind;
};
export type OperationOptions<Kind extends OperationKind> = {
  operationKey?: OperationKey<Kind>;
};

export type HarnessId = "codex" | "qoder";

export type SpawnInput = {
  sessionLabel?: string;
  harness: HarnessId;
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
export type OperationRecord =
  | {
      status: "unknown" | "unavailable" | "pending";
      operationKey: OperationKey<"spawn">;
    }
  | {
      status: "outcome_unknown";
      operationKey: OperationKey<"spawn">;
      cause?: ErrorCause;
      cleanupCause?: ErrorCause;
    }
  | {
      status: "succeeded";
      operationKey: OperationKey<"spawn">;
      result: SpawnResult;
    }
  | {
      status: "failed";
      operationKey: OperationKey<"spawn">;
      error: ReinsFailure;
    }
  | {
      status: "accepted_uncommitted";
      operationKey: OperationKey<"spawn">;
      result: SpawnResult;
      cause: ErrorCause;
      cleanupCause?: ErrorCause;
    }
  | {
      status: "accepted_unconfirmed";
      operationKey: OperationKey<"spawn">;
      result: SpawnResult;
      cause: ErrorCause;
      cleanupCause?: ErrorCause;
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
  diagnosticId?: DiagnosticId;
  stopReason: StopReason;
} & (
  | { stopReason: "failed"; failure: HarnessFailure }
  | { stopReason: "end_turn" | "cancelled" | "killed" }
);
export type WaitResult = {
  status: "satisfied" | "timeout" | "unreachable";
  completed: CompletedTurn[];
  pending: TurnHandle[];
  unreachable?: Array<{
    turnHandle: TurnHandle;
    reason: "previous_generation" | "control_lost" | "commit_unavailable";
  }>;
};
export type InterruptInput = { turnHandle: TurnHandle };
export type InterruptResult = {
  turnHandle: TurnHandle;
  status: "accepted";
};

export type StopReason = "end_turn" | "cancelled" | "failed" | "killed";
export type SessionState = "busy" | "idle" | "killed" | "unreachable";
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

export type ModelCatalogEntry = {
  id: string;
  displayName: string;
  reasoningEfforts: string[];
};
export type HarnessModelCatalog = {
  harness: HarnessId;
  models: ModelCatalogEntry[];
};
export type ModelCatalogFailure = HarnessFailure & {
  harness: HarnessId;
  diagnosticId?: DiagnosticId;
};
export type ModelCatalogResult = {
  catalogs: HarnessModelCatalog[];
  failures: ModelCatalogFailure[];
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
  harness?: HarnessId;
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
  harness?: HarnessId;
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
      harness: HarnessId;
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
  harness?: HarnessId;
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
  harness: HarnessId;
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
    })
  | (SessionInfoFields & {
      state: "unreachable";
      lastKnownState: "busy" | "idle";
      lastKnownActiveTurn?: TurnHandle;
      lastCompletedTurn?: LastCompletedTurn;
      unreachableReason:
        | "previous_generation"
        | "control_lost"
        | "commit_unavailable";
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
  runtime_scope_invalid: Record<never, never>;
  runtime_scope_mismatch: {
    requestedRuntimeScopeId: RuntimeScopeId;
    actualRuntimeScopeId: RuntimeScopeId;
  };
  runtime_scope_unavailable: {
    reason: "state_root" | "scope_identity";
  };
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
  operation_key_conflict: Record<never, never>;
  operation_key_scope_mismatch: Record<never, never>;
  stale_operation_key: Record<never, never>;
  operation_pending: { operationKey: OperationKey<OperationKind> };
  operation_outcome_unknown: {
    operationKey: OperationKey<OperationKind>;
    cause?: ErrorCause;
    cleanupCause?: ErrorCause;
  };
  control_store_unavailable: {
    operationKey: OperationKey<OperationKind>;
    stage: "register" | "dispatch" | "commit" | "failure";
    acceptance: "not_dispatched" | "unknown" | "accepted";
    cause: ErrorCause;
    acceptedResult?: SpawnResult;
    cleanupCause?: ErrorCause;
  };
  permission_not_pending: { permissionHandle: PermissionHandle };
  permission_resolution_mismatch: { permissionHandle: PermissionHandle };
  diagnostic_not_found: { diagnosticId: DiagnosticId };
  diagnostics_unavailable: Record<never, never>;
  unknown_harness: { harness: HarnessId; availableHarnesses: HarnessId[] };
  unsupported_feature: { feature: string };
  session_busy: { sessionHandle: SessionHandle };
  session_not_found: { sessionHandle: SessionHandle };
  session_killed: { sessionHandle: SessionHandle };
  session_terminating: { sessionHandle: SessionHandle };
  turn_not_active: { turnHandle: TurnHandle };
  model_catalog_query_failed: {
    cause?: ErrorCause;
    diagnosticId?: DiagnosticId;
  };
  internal_error: {
    cause?: ErrorCause;
    diagnosticId?: DiagnosticId;
    cleanupCause?: ErrorCause;
  };
  diagnostics_store_corrupt: {
    cause?: ErrorCause;
    diagnosticId?: DiagnosticId;
  };
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
  runtimeScopeId: RuntimeScopeId;
};
export type ControlRuntimeTarget = {
  readonly command: string;
  readonly args: readonly string[];
  readonly runtimeScopeId: RuntimeScopeId;
};
export type ControlChannelTermination = {
  readonly exitCode: number | null;
  readonly signal: string | null;
};
export type ControlByteChannel = {
  readonly readable: AsyncIterable<Uint8Array>;
  readonly diagnostics: AsyncIterable<Uint8Array>;
  write(bytes: Uint8Array): Promise<void>;
  /** 关闭通道并解除阻塞的读写；已收到的 readable 字节仍须先按序交付。 */
  close(): Promise<void>;
  readonly terminated: Promise<ControlChannelTermination>;
};
export type ControlChannelOpener = (
  target: ControlRuntimeTarget,
  signal: AbortSignal,
) => Promise<ControlByteChannel>;
type ConnectBaseOptions = {
  consumerContext: string;
  timeoutMs?: number;
};
export type ConnectOptions = ConnectBaseOptions & {
  socketPath: string;
  runtimeScopeId?: RuntimeScopeId;
  runtimeTarget?: never;
  openControlChannel?: never;
  signal?: never;
};
export type OpenControlOptions = ConnectBaseOptions & {
  socketPath?: never;
  runtimeScopeId?: never;
  runtimeTarget: ControlRuntimeTarget;
  openControlChannel: ControlChannelOpener;
  signal?: AbortSignal;
};
export type ReinsConnection = {
  readonly handshake: ReinsHandshake;
  modelCatalog(): Promise<ModelCatalogResult>;
  list(filter?: SessionFilter): Promise<SessionInfo[]>;
  attach(
    target: AgentTarget,
    replay: ReplayPolicy,
    signal?: AbortSignal,
  ): Promise<FactSubscription>;
  prepareOperation<Kind extends OperationKind>(kind: Kind): OperationKey<Kind>;
  getOperation(operationKey: OperationKey<"spawn">): Promise<OperationRecord>;
  spawn(
    input: SpawnInput,
    options?: OperationOptions<"spawn">,
  ): Promise<SpawnResult>;
  kill(
    input: KillInput,
    options?: OperationOptions<"kill">,
  ): Promise<KillResult>;
  resolvePermission(
    permissionHandle: PermissionHandle,
    resolution: PermissionResolution,
    options?: OperationOptions<"resolvePermission">,
  ): Promise<{ permissionHandle: PermissionHandle; status: "resolved" }>;
  diagnostics(query?: DiagnosticsQuery): Promise<DiagnosticsResult>;
  send(
    input: SendInput,
    options?: OperationOptions<"send">,
  ): Promise<SendResult>;
  wait(input: WaitInput): Promise<WaitResult>;
  interrupt(
    input: InterruptInput,
    options?: OperationOptions<"interrupt">,
  ): Promise<InterruptResult>;
  close(): void;
};
