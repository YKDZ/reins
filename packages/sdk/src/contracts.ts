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

export type MessageContentPart =
  | {
      type: "text";
      text: string;
      textElements?: {
        byteRange: { start: number; end: number };
        placeholder: string | null;
      }[];
      annotations?: unknown;
    }
  | { type: "thinking"; text: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | {
      type: "image";
      source: "url";
      url: string;
      detail?: "auto" | "low" | "high" | "original";
    }
  | {
      type: "image";
      source: "bytes";
      data: string;
      mediaType?: string;
      detail?: "auto" | "low" | "high" | "original";
    }
  | { type: "image"; source: "unavailable"; reason: "read_failed" }
  | { type: "audio"; source: "url"; url: string }
  | {
      type: "audio";
      source: "bytes";
      data: string;
      mediaType?: string;
    }
  | { type: "audio"; source: "unavailable"; reason: "read_failed" }
  | { type: "reference"; referenceType: "skill" | "mention"; name: string }
  | { type: "tool_call"; toolKey: ToolKey }
  | { type: "tool_result"; toolKey: ToolKey }
  | {
      type: "opaque";
      harness: HarnessId;
      nativeType: string;
      value: unknown;
    };
export type MessageContent = string | MessageContentPart[];

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
export type RecoverableOperationKind = "spawn" | "send";
type OperationResultByKind = { spawn: SpawnResult; send: SendResult };
type OperationRecordForKind<Kind extends RecoverableOperationKind> =
  | {
      status: "unknown" | "unavailable" | "pending";
      operationKey: OperationKey<Kind>;
    }
  | {
      status: "outcome_unknown";
      operationKey: OperationKey<Kind>;
      cause?: ErrorCause;
      cleanupCause?: ErrorCause;
      diagnosticId?: DiagnosticId;
    }
  | {
      status: "succeeded";
      operationKey: OperationKey<Kind>;
      result: OperationResultByKind[Kind];
    }
  | {
      status: "failed";
      operationKey: OperationKey<Kind>;
      error: ReinsFailure;
    }
  | {
      status: "not_accepted_uncommitted" | "not_accepted_unconfirmed";
      operationKey: OperationKey<Kind>;
      error: ReinsFailure;
      cause: ErrorCause;
    }
  | {
      status: "accepted_uncommitted";
      operationKey: OperationKey<Kind>;
      result: OperationResultByKind[Kind];
      cause: ErrorCause;
      cleanupCause?: ErrorCause;
    }
  | {
      status: "accepted_unconfirmed";
      operationKey: OperationKey<Kind>;
      result: OperationResultByKind[Kind];
      cause: ErrorCause;
      cleanupCause?: ErrorCause;
    };
export type OperationRecord<
  Kind extends RecoverableOperationKind = RecoverableOperationKind,
> = Kind extends RecoverableOperationKind
  ? OperationRecordForKind<Kind>
  : never;
export type KillInput = { sessionHandle: SessionHandle };
export type KillResult = {
  sessionHandle: SessionHandle;
  status: "killed" | "not_found";
};
export type SendInput =
  | {
      placement: "new_turn";
      sessionHandle: SessionHandle;
      ifLastCompletedTurn?: TurnHandle;
      message: string;
    }
  | {
      placement: "active_turn";
      turnHandle: TurnHandle;
      ifLastCompletedTurn?: never;
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
type WaitResultFields = {
  completed: CompletedTurn[];
  pending: TurnHandle[];
};
type UnreachableWaitTarget = {
  turnHandle: TurnHandle;
  reason: "previous_generation" | "control_lost" | "commit_unavailable";
};
export type WaitResult =
  | (WaitResultFields & {
      status: "satisfied" | "timeout";
      unreachable?: UnreachableWaitTarget[];
    })
  | (WaitResultFields & {
      status: "unreachable";
      unreachable: UnreachableWaitTarget[];
    });
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
type DiagnosticRecordEnvelope = {
  v: 1;
  diagnosticId: DiagnosticId;
  recordedAt: string;
};
type DiagnosticRecordSession = {
  sessionHandle: SessionHandle;
  turnHandle?: TurnHandle;
};
type DiagnosticRecordNoSession = {
  sessionHandle?: never;
  turnHandle?: never;
};
type DiagnosticControlAssociation =
  | ({
      source: "daemon" | "core";
      harness?: HarnessId;
    } & (DiagnosticRecordNoSession | DiagnosticRecordSession))
  | ({ source: "adapter"; harness: HarnessId } & (
      | DiagnosticRecordNoSession
      | DiagnosticRecordSession
    ));
type DiagnosticAdapterAssociation = {
  source: "adapter";
  harness: HarnessId;
} & (DiagnosticRecordNoSession | DiagnosticRecordSession);
type DiagnosticSessionAssociation =
  | ({
      source: "daemon" | "core";
      harness?: HarnessId;
    } & DiagnosticRecordSession)
  | ({ source: "adapter"; harness: HarnessId } & DiagnosticRecordSession);
type DiagnosticDaemonAssociation = { source: "daemon"; harness?: HarnessId } & (
  | DiagnosticRecordNoSession
  | DiagnosticRecordSession
);
type DiagnosticFieldName = "agent" | "reasoning" | "sandbox";
type DiagnosticPermissionFieldName = "feedback" | "resolution";
type DiagnosticRequestLocation =
  | { operation: "spawn"; stage: "start_session" | "start_turn" | "dispatch" }
  | { operation: "send"; stage: "deliver" | "steer" | "dispatch" }
  | { operation: "wait"; stage: "dispatch" }
  | { operation: "interrupt"; stage: "interrupt" | "dispatch" }
  | { operation: "kill"; stage: "terminate" | "dispatch" }
  | { operation: "list" | "attach" | "diagnostics"; stage: "dispatch" }
  | {
      operation: "resolve_permission";
      stage: "resolve" | "dispatch";
    }
  | { operation: "model_catalog"; stage: "query" | "dispatch" };
type DiagnosticTransportLocation =
  | { operation: "listen"; reason: "io_error" }
  | { operation: "connect"; reason: "io_error" | "timeout" }
  | { operation: "connection"; reason: "io_error" }
  | {
      operation: "read";
      reason: "invalid_frame" | "io_error" | "timeout" | "disconnected";
      inputBytes?: number;
    }
  | {
      operation: "write" | "close";
      reason: "io_error" | "timeout" | "disconnected";
    };
type DiagnosticStorageLocation =
  | {
      operation: "initialize";
      reason: "unavailable" | "io_error" | "corrupt" | "invalid_configuration";
    }
  | {
      operation: "append" | "rotate";
      reason: "unavailable" | "io_error";
    }
  | { operation: "query"; reason: "unavailable" | "io_error" | "corrupt" }
  | { operation: "recover"; reason: "io_error" | "corrupt" }
  | { operation: "lock"; reason: "io_error" | "lock_unavailable" }
  | { operation: "close"; reason: "io_error" }
  | { operation: "allocate_generation"; reason: "io_error" | "corrupt" };
type DiagnosticWorkerEventType =
  | "session.created"
  | "turn.started"
  | "text.delta"
  | "message"
  | "tool.requested"
  | "tool.completed"
  | "permission.requested"
  | "permission.resolved"
  | "turn.completed"
  | "session.killed";
type DiagnosticTurnWorkerEventType =
  | "turn.started"
  | "text.delta"
  | "message"
  | "tool.requested"
  | "tool.completed"
  | "permission.requested"
  | "permission.resolved"
  | "turn.completed";
type DiagnosticActiveTurnAssociation = {
  sessionState: "spawning" | "busy";
  eventTurnId: string;
  activeTurnId: string;
};
type DiagnosticWorkerEventRejection =
  | {
      reason: "unknown_session";
      eventType: DiagnosticWorkerEventType;
      sessionState: "unknown";
      eventTurnId?: string;
    }
  | {
      reason: "session_killed";
      eventType: DiagnosticWorkerEventType;
      sessionState: "killed";
      eventTurnId?: string;
    }
  | {
      reason: "driver_event_forbidden";
      eventType: "session.created" | "turn.started" | "session.killed";
      sessionState: "spawning" | "busy" | "idle";
    }
  | {
      reason: "turn_not_active";
      eventType: DiagnosticTurnWorkerEventType;
      sessionState: "idle";
      eventTurnId: string;
    }
  | ({
      reason: "turn_mismatch";
      eventType: DiagnosticTurnWorkerEventType;
    } & DiagnosticActiveTurnAssociation)
  | {
      reason: "event_after_turn_completed";
      eventType: DiagnosticTurnWorkerEventType;
      sessionState: "idle";
      eventTurnId: string;
    }
  | ({
      reason: "event_after_turn_completed";
      eventType: DiagnosticTurnWorkerEventType;
    } & DiagnosticActiveTurnAssociation)
  | ({
      reason: "message_already_completed";
      eventType: "text.delta" | "message";
      messageId: string;
    } & DiagnosticActiveTurnAssociation)
  | ({
      reason: "tool_already_requested";
      eventType: "tool.requested";
      toolCallId: string;
    } & DiagnosticActiveTurnAssociation)
  | ({
      reason: "tool_already_completed";
      eventType: "tool.completed";
      toolCallId: string;
    } & DiagnosticActiveTurnAssociation)
  | ({
      reason: "permission_id_reused";
      eventType: "permission.requested";
      permissionId: string;
    } & DiagnosticActiveTurnAssociation)
  | ({
      reason: "permission_not_pending";
      eventType: "permission.resolved";
      permissionId: string;
    } & DiagnosticActiveTurnAssociation)
  | ({
      reason: "permission_turn_mismatch";
      eventType: "permission.resolved";
      permissionId: string;
    } & DiagnosticActiveTurnAssociation);

export type DiagnosticRecord =
  | (DiagnosticRecordEnvelope & {
      source: "daemon";
      kind: "lifecycle";
      operation: "daemon";
      reason: "started" | "stopped" | "idle_exit";
      severity: "info";
    })
  | (DiagnosticRecordEnvelope & {
      source: "daemon";
      kind: "lifecycle";
      operation: "daemon";
      reason: "crashed";
      severity: "error";
      message?: DiagnosticTextEvidence;
      stack?: DiagnosticTextEvidence;
    })
  | (DiagnosticRecordEnvelope & {
      source: "adapter";
      harness: HarnessId;
      sessionHandle: SessionHandle;
      turnHandle?: TurnHandle;
      kind: "lifecycle";
      operation: "worker";
      reason: "initialized" | "closed";
      severity: "info";
    })
  | (DiagnosticRecordEnvelope & {
      source: "adapter";
      harness: HarnessId;
      sessionHandle: SessionHandle;
      turnHandle?: TurnHandle;
      kind: "lifecycle";
      operation: "worker";
      reason: "exited_unexpectedly";
      severity: "error";
      message?: DiagnosticTextEvidence;
      stack?: DiagnosticTextEvidence;
    })
  | (DiagnosticRecordEnvelope & {
      source: "core";
      sessionHandle: SessionHandle;
      turnHandle?: TurnHandle;
      kind: "lifecycle";
      operation: "event_delivery";
      reason: "listener_failed";
      severity: "error";
      message?: DiagnosticTextEvidence;
      stack?: DiagnosticTextEvidence;
    })
  | (DiagnosticRecordEnvelope & {
      source: "daemon";
      kind: "lifecycle";
      operation: "diagnostics_store";
      reason: "initialized" | "closed";
      severity: "info";
    })
  | (DiagnosticRecordEnvelope & {
      source: "daemon";
      kind: "lifecycle";
      operation: "diagnostics_store";
      reason: "invariant_failed";
      severity: "error";
      message?: DiagnosticTextEvidence;
      stack?: DiagnosticTextEvidence;
    })
  | (DiagnosticRecordEnvelope &
      DiagnosticAdapterAssociation & {
        kind: "mapping_gap";
        operation: "spawn";
        reason: "unsupported_input";
        fields: [DiagnosticFieldName, ...DiagnosticFieldName[]];
        severity: "warning";
      })
  | (DiagnosticRecordEnvelope &
      DiagnosticAdapterAssociation & {
        kind: "mapping_gap";
        operation: "resolve_permission";
        reason: "unsupported_input";
        fields: [
          DiagnosticPermissionFieldName,
          ...DiagnosticPermissionFieldName[],
        ];
        severity: "warning";
      })
  | (DiagnosticRecordEnvelope &
      DiagnosticAdapterAssociation & {
        kind: "compatibility_gap";
        operation: "receive_worker_request";
        reason: "unsupported_request";
        message?: DiagnosticTextEvidence;
        severity: "warning";
      })
  | (DiagnosticRecordEnvelope &
      DiagnosticControlAssociation & {
        kind: "request_failure";
        reason: "upstream_error" | "timeout" | "closed" | "rejected";
        message: DiagnosticTextEvidence;
        stack?: DiagnosticTextEvidence;
        severity: "error";
      } & DiagnosticRequestLocation)
  | (DiagnosticRecordEnvelope &
      DiagnosticSessionAssociation & {
        kind: "stream_failure";
        operation: "receive_worker_stream";
        reason: "read_error" | "closed_unexpectedly";
        message: DiagnosticTextEvidence;
        severity: "error";
      })
  | (DiagnosticRecordEnvelope &
      DiagnosticSessionAssociation & {
        kind: "turn_failure";
        operation: "run_turn";
        reason: "worker_reported_failure";
        message: DiagnosticTextEvidence;
        severity: "error";
      })
  | (DiagnosticRecordEnvelope &
      DiagnosticSessionAssociation & {
        kind: "authorization_failure";
        operation: "resolve_permission";
        stage: "lookup";
        reason: "target_lost";
        permissionId: string;
        severity: "error";
      })
  | (DiagnosticRecordEnvelope &
      DiagnosticSessionAssociation & {
        kind: "authorization_failure";
        operation: "resolve_permission";
        stage: "deliver";
        reason: "upstream_rejected";
        permissionId: string;
        severity: "error";
      })
  | (DiagnosticRecordEnvelope &
      DiagnosticControlAssociation & {
        kind: "protocol_violation";
        operation: "decode_worker_message";
        reason: "invalid_json" | "invalid_shape" | "unexpected_message";
        message?: DiagnosticTextEvidence;
        severity: "error";
      })
  | (DiagnosticRecordEnvelope &
      DiagnosticAdapterAssociation & {
        kind: "protocol_violation";
        operation: "validate_worker_response" | "validate_worker_event";
        reason: "invalid_shape" | "unexpected_message";
        message?: DiagnosticTextEvidence;
        severity: "error";
      })
  | (DiagnosticRecordEnvelope & {
      source: "core";
      sessionHandle: SessionHandle;
      kind: "protocol_violation";
      operation: "validate_worker_event";
      severity: "error";
    } & DiagnosticWorkerEventRejection)
  | (DiagnosticRecordEnvelope &
      DiagnosticControlAssociation & {
        kind: "protocol_violation";
        operation: "validate_daemon_result" | "emit_domain_event";
        reason: "invalid_shape";
        message?: DiagnosticTextEvidence;
        severity: "error";
      })
  | (DiagnosticRecordEnvelope & {
      source: "daemon";
      kind: "protocol_violation";
      operation: "validate_daemon_request";
      stage: "envelope";
      reason: "invalid_shape";
      severity: "error";
    })
  | (DiagnosticRecordEnvelope &
      DiagnosticDaemonAssociation &
      DiagnosticTransportLocation & {
        kind: "transport_failure";
        severity: "error";
      })
  | (DiagnosticRecordEnvelope &
      DiagnosticDaemonAssociation &
      DiagnosticStorageLocation & {
        kind: "storage_failure";
        message: DiagnosticTextEvidence;
        severity: "error";
      })
  | (DiagnosticRecordEnvelope &
      DiagnosticDaemonAssociation & {
        kind: "storage_failure";
        operation: "recover";
        reason: "tail_repaired";
        affectedBytes: number;
        severity: "warning";
      })
  | (DiagnosticRecordEnvelope & {
      source: "harness";
      harness: HarnessId;
      sessionHandle: SessionHandle;
      turnHandle?: TurnHandle;
      kind: "harness_stderr";
      operation: "worker_process";
      reason: "stderr_output";
      text: DiagnosticTextEvidence;
      severity: "info";
    });
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
      content: MessageContent;
      /** 仅上游明确报告正文截断时出现。 */
      nativeTruncated?: true;
    })
  | (TurnFactBase & {
      type: "tool.requested";
      toolKey: ToolKey;
      name: string;
      input?: unknown;
    })
  | (TurnFactBase & {
      type: "tool.completed";
      toolKey: ToolKey;
      name: string;
      result: unknown;
      error?: unknown;
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
      lastKnownState: "busy";
      lastKnownActiveTurn: TurnHandle;
      lastCompletedTurn?: LastCompletedTurn;
      unreachableReason:
        | "previous_generation"
        | "control_lost"
        | "commit_unavailable";
    })
  | (SessionInfoFields & {
      state: "unreachable";
      lastKnownState: "idle";
      lastKnownActiveTurn?: never;
      lastCompletedTurn: LastCompletedTurn;
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

type ControlEventType =
  | "session.created"
  | "turn.started"
  | "text.delta"
  | "message"
  | "tool.requested"
  | "tool.completed"
  | "permission.requested"
  | "permission.resolved"
  | "turn.completed"
  | "session.killed";

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
    diagnosticId?: DiagnosticId;
  };
  control_store_unavailable:
    | {
        operationKey: OperationKey<OperationKind>;
        stage: "register" | "dispatch" | "commit" | "failure";
        acceptance: "not_dispatched" | "unknown" | "accepted";
        cause: ErrorCause;
        acceptedResult?: SpawnResult | SendResult;
        cleanupCause?: ErrorCause;
      }
    | {
        stage: "event";
        sessionHandle: SessionHandle;
        eventType: ControlEventType;
        turnHandle?: TurnHandle;
        cause: ErrorCause;
        cleanupCause?: ErrorCause;
        cleanupSessionHandle?: SessionHandle;
      }
    | {
        stage: "event_commit";
        operationKey: OperationKey<"kill">;
        acceptance: "accepted";
        sessionHandle: SessionHandle;
        eventType: ControlEventType;
        turnHandle?: TurnHandle;
        cause: ErrorCause;
        cleanupCause?: ErrorCause;
        cleanupSessionHandle?: SessionHandle;
      };
  permission_not_pending: { permissionHandle: PermissionHandle };
  permission_resolution_mismatch: { permissionHandle: PermissionHandle };
  diagnostic_not_found: { diagnosticId: DiagnosticId };
  diagnostics_unavailable: Record<never, never>;
  unknown_harness: { harness: HarnessId; availableHarnesses: HarnessId[] };
  unsupported_feature: { feature: string };
  session_busy: { sessionHandle: SessionHandle };
  turn_precondition_failed: {
    sessionHandle: SessionHandle;
    expected: TurnHandle;
    actual: TurnHandle;
  };
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
  getOperation<Kind extends RecoverableOperationKind>(
    operationKey: OperationKey<Kind>,
  ): Promise<OperationRecord<Kind>>;
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
