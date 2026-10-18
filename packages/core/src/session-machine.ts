import {
  spawnParamsSchema,
  type DomainEvent,
  type DiagnosticId,
  type CoreDiagnosticFact,
  type InterruptAck,
  type InterruptParams,
  type InvalidParamIssue,
  interruptParamsSchema,
  type KillParams,
  type KillResult,
  killParamsSchema,
  type ListFilter,
  type MachineError,
  machineErrorSchema,
  makeErrorCause,
  type MessageId,
  messageIdSchema,
  type PermissionId,
  type PermissionOption,
  permissionResolutionSchemaFor,
  type ResolvePermissionParams,
  resolvePermissionParamsSchema,
  type SendAck,
  type SendParams,
  sendParamsSchema,
  type SessionId,
  type ToolCallId,
  type TurnId,
  turnIdSchema,
  type SessionName,
  type SessionInfo,
  type SpawnParams,
  type SpawnAck,
  type TurnTarget,
  turnTargetSchema,
  type TurnCompleted,
  type WaitParams,
  type WaitResult,
  waitParamsSchema,
  type WorkerDriver,
  type WorkerDriverFactory,
  type WorkerEventRejection,
} from "@reins/protocol";
import * as v from "valibot";

import type { DiagnosticEmitter } from "#/diagnostic-emitter";
import { createEventBus, type EventBus } from "#/event-bus";

type SessionRecord = {
  readonly id: SessionId;
  readonly harness: string;
  readonly model: string | null;
  readonly reasoning: string | null;
  readonly cwd: string;
  readonly sessionName: SpawnParams["sessionName"];
  readonly spawnedAt: string;
  state: "busy" | "idle" | "killed";
  currentTurnId: TurnId | null;
  activeTurn: TurnScope | null;
  pendingPermissions: Map<
    PermissionId,
    { turnId: TurnId; options: PermissionOption[] }
  >;
  usedPermissionIds: Set<PermissionId>;
  turns: TurnCompleted[];
};

type TurnScope = {
  readonly turnId: TurnId;
  readonly messages: Map<MessageId, "streaming" | "complete">;
  readonly tools: Map<ToolCallId, "requested" | "complete">;
};

type PendingSpawn = {
  readonly token: symbol;
  readonly turn: TurnScope;
  readonly permissionIds: Set<PermissionId>;
  readonly pendingPermissions: SessionRecord["pendingPermissions"];
  completedTurnId: TurnId | null;
  accepting: boolean;
};

type IngressProjection = {
  state: SessionRecord["state"];
  currentTurnId: TurnId | null;
  activeTurn: TurnScope | null;
  readonly completedTurnIds: Set<TurnId>;
  readonly pendingPermissions: SessionRecord["pendingPermissions"];
  readonly usedPermissionIds: Set<PermissionId>;
};

type IngressActionFrame = {
  accepting: boolean;
  readonly projections: Map<SessionId, IngressProjection>;
};

type PendingDelivery = {
  readonly projection: IngressProjection;
  readonly events: DomainEvent[];
  readonly creating: boolean;
  readonly settled: Promise<void>;
  readonly settle: () => void;
  count: number;
};

function createPendingDelivery(
  projection: IngressProjection,
  creating: boolean,
): PendingDelivery {
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { projection, creating, events: [], count: 0, settled, settle };
}

type WorkerEventIngressDecision =
  | { status: "accepted" }
  | { status: "rejected"; rejection: WorkerEventRejection };

function createTurnScope(turnId: TurnId): TurnScope {
  return { turnId, messages: new Map(), tools: new Map() };
}

function machineError(error: MachineError): MachineError {
  return error;
}

function evidence(error: unknown): {
  text: string;
  truncated: boolean;
  originalBytes: number;
} {
  const original = error instanceof Error ? error.message : String(error);
  const originalBytes = Buffer.byteLength(original, "utf8");
  if (originalBytes <= 64 * 1024) {
    return { text: original, truncated: false, originalBytes };
  }
  let bytes = 0;
  let text = "";
  for (const character of original) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > 64 * 1024) break;
    text += character;
    bytes += characterBytes;
  }
  return { text, truncated: true, originalBytes };
}

async function recordedDiagnostic(
  diagnostics: DiagnosticEmitter,
  input: CoreDiagnosticFact,
): Promise<DiagnosticId | undefined> {
  try {
    return await diagnostics.record(input);
  } catch {
    return undefined;
  }
}

async function unexpectedFailure(
  diagnostics: DiagnosticEmitter,
  error: unknown,
  input: CoreDiagnosticFact,
): Promise<MachineError> {
  const known = v.safeParse(machineErrorSchema, error);
  if (known.success) return known.output;
  const diagnosticId = await recordedDiagnostic(diagnostics, input);
  return {
    code: "internal_error",
    cause: makeErrorCause(
      "exception",
      error instanceof Error ? error.message : String(error),
    ),
    ...(diagnosticId === undefined ? {} : { diagnosticId }),
  };
}

function recordBestEffort(
  diagnostics: DiagnosticEmitter,
  input: CoreDiagnosticFact,
): void {
  try {
    void diagnostics.record(input).catch(() => undefined);
  } catch {
    // Event observation has no response channel and remains best effort.
  }
}

const invalidTypeExpectations = [
  "string",
  "number",
  "boolean",
  "array",
  "object",
] as const;

function invalidParamsError(
  issues: readonly v.BaseIssue<unknown>[],
): MachineError {
  const normalized = issues.map((issue): InvalidParamIssue => {
    const path = v.getDotPath(issue) ?? "";
    if (issue.input === undefined) {
      return { issue: "missing_required", path };
    }
    const expected = invalidTypeExpectations.find((candidate) =>
      issue.expected?.includes(candidate),
    );
    if (expected !== undefined) {
      return {
        issue: "invalid_type",
        path,
        expected,
      };
    }
    return { issue: "invalid_value", path };
  });
  const [first, ...rest] = normalized;
  if (first === undefined) throw new Error("Validation failed without issues");
  return { code: "invalid_params", issues: [first, ...rest] };
}

function toInfo(session: SessionRecord): SessionInfo {
  const lastTurn = session.turns[session.turns.length - 1];

  const common = {
    sessionId: session.id,
    sessionName: session.sessionName,
    harness: session.harness,
    model: session.model,
    reasoning: session.reasoning,
    cwd: session.cwd,
    spawnedAt: session.spawnedAt,
    turns: session.turns.length,
    ...(lastTurn === undefined
      ? {}
      : {
          lastCompletedTurn: {
            turnId: lastTurn.turnId,
            stopReason: lastTurn.stopReason,
          },
        }),
  };
  if (session.state === "busy")
    return { ...common, state: "busy", activeTurnId: session.currentTurnId! };
  if (session.state === "idle")
    return {
      ...common,
      state: "idle",
      lastCompletedTurn: {
        turnId: lastTurn!.turnId,
        stopReason: lastTurn!.stopReason,
      },
    };
  return { ...common, state: "killed" };
}

export type SessionMachine = {
  spawn(params: SpawnParams): Promise<SpawnAck>;
  send(params: SendParams): Promise<SendAck>;
  wait(params: WaitParams): Promise<WaitResult>;
  interrupt(params: InterruptParams): Promise<InterruptAck>;
  resolvePermission(params: ResolvePermissionParams): Promise<void>;
  kill(params: KillParams): Promise<KillResult>;
  list(filter?: ListFilter): SessionInfo[];
  assertTurnTarget(target: TurnTarget): void;
  subscribe(listener: (event: DomainEvent) => void): () => void;
};

// identity seam 由 daemon 世代持有者实现；核心只申请 caller-authored name 的地址。
export type SessionIdentity = {
  session(sessionName: SessionName): SessionId;
};

export function createSessionMachine(options: {
  driverFactory: WorkerDriverFactory;
  identity: SessionIdentity;
  diagnostics: DiagnosticEmitter;
  onListenerError?: (error: unknown, event: DomainEvent) => void;
}): SessionMachine {
  const sessions = new Map<SessionId, SessionRecord>();
  const usedSessionNames = new Set<SessionName>();
  const waiters: Array<{
    targets: readonly TurnTarget[];
    completion: WaitParams["completion"];
    resolve: (result: WaitResult) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }> = [];
  let sessionSeq = 0;
  let turnSeq = 0;
  let messageSeq = 0;
  const pendingSpawns = new Map<SessionId, PendingSpawn>();
  const terminations = new Map<SessionId, Promise<void>>();
  const ingressActions: IngressActionFrame[] = [];
  // 接受响应与终态通知可能在同一轮到达；只暂存本会话事件，
  // 保证已接受 caller 事实先于该回合终态，拒绝后仍释放真实终态。
  const pendingDeliveries = new Map<SessionId, PendingDelivery>();

  let bus: EventBus;
  let driver: WorkerDriver;
  let ingestDriverEvent: (event: DomainEvent) => void = () => undefined;

  driver = options.driverFactory((event) => ingestDriverEvent(event));

  function assertNotTerminating(sessionId: SessionId): void {
    if (terminations.has(sessionId)) {
      throw machineError({ code: "session_terminating", sessionId });
    }
  }

  // 事件折叠：只改状态，不做任何订阅通知；总线在折叠后发布已提交事件。
  const apply = (event: DomainEvent): void => {
    const session = sessions.get(event.sessionId);
    if (session !== undefined && session.state === "killed") return;
    switch (event.type) {
      case "session.created": {
        sessions.set(event.sessionId, {
          id: event.sessionId,
          harness: event.harness,
          model: event.model,
          reasoning: event.reasoning,
          cwd: event.cwd,
          sessionName: event.sessionName,
          spawnedAt: event.spawnedAt,
          state: "busy",
          currentTurnId: null,
          activeTurn: null,
          pendingPermissions: new Map(),
          usedPermissionIds: new Set(),
          turns: [],
        });
        break;
      }
      case "turn.started":
        if (session !== undefined) {
          session.state = "busy";
          session.currentTurnId = event.turnId;
          if (session.activeTurn?.turnId !== event.turnId) {
            session.activeTurn = createTurnScope(event.turnId);
          }
        }
        break;
      case "text.delta":
        session?.activeTurn?.messages.set(event.messageId, "streaming");
        break;
      case "message":
        session?.activeTurn?.messages.set(event.messageId, "complete");
        break;
      case "tool.requested":
        session?.activeTurn?.tools.set(event.toolCallId, "requested");
        break;
      case "tool.completed":
        session?.activeTurn?.tools.set(event.toolCallId, "complete");
        break;
      case "turn.completed":
        if (session !== undefined) {
          const { type: _type, ...completed } = event;
          session.turns.push(completed);
          session.state = "idle";
          session.currentTurnId = null;
          session.activeTurn = null;
          session.pendingPermissions.clear();
        }
        break;
      case "session.killed":
        if (session !== undefined) {
          session.state = "killed";
          session.currentTurnId = null;
          session.activeTurn = null;
          session.pendingPermissions.clear();
          session.usedPermissionIds.clear();
        }
        pendingSpawns.delete(event.sessionId);
        break;
      case "permission.requested":
        if (session !== undefined) {
          session.usedPermissionIds.add(event.permissionId);
          session.pendingPermissions.set(event.permissionId, {
            turnId: event.turnId,
            options: event.options,
          });
        }
        break;
      case "permission.resolved":
        session?.pendingPermissions.delete(event.permissionId);
        break;
      default:
        break;
    }
    settleWaiters();
  };

  function activeProjection(
    sessionId: SessionId,
  ): IngressProjection | undefined {
    for (let index = ingressActions.length - 1; index >= 0; index -= 1) {
      const frame = ingressActions[index];
      if (frame?.accepting !== true) continue;
      const projection = frame.projections.get(sessionId);
      if (projection !== undefined) return projection;
    }
    return pendingDeliveries.get(sessionId)?.projection;
  }

  function projectSession(sessionId: SessionId): IngressProjection {
    const inherited = activeProjection(sessionId);
    const session = sessions.get(sessionId);
    const source = inherited ?? session;
    if (source === undefined) {
      throw new Error("Cannot project an unknown session");
    }
    const activeTurn = source.activeTurn;
    return {
      state: source.state,
      currentTurnId: source.currentTurnId,
      activeTurn:
        activeTurn === null
          ? null
          : {
              turnId: activeTurn.turnId,
              messages: new Map(activeTurn.messages),
              tools: new Map(activeTurn.tools),
            },
      completedTurnIds:
        inherited === undefined
          ? new Set(session?.turns.map(({ turnId }) => turnId))
          : new Set(inherited.completedTurnIds),
      pendingPermissions: new Map(source.pendingPermissions),
      usedPermissionIds: new Set(source.usedPermissionIds),
    };
  }

  function driverTransaction(
    lead: readonly DomainEvent[],
    projections: Map<SessionId, IngressProjection>,
    run: () => void,
  ): void {
    for (const event of lead) {
      const projection = projections.get(event.sessionId);
      if (projection !== undefined) projectEvent(projection, event);
    }
    const frame: IngressActionFrame = { accepting: true, projections };
    ingressActions.push(frame);
    let committed = false;
    try {
      bus.transaction(lead, () => {
        try {
          run();
        } finally {
          frame.accepting = false;
        }
      });
      committed = true;
    } finally {
      ingressActions.pop();
      if (committed) {
        const parent = ingressActions.at(-1);
        if (parent !== undefined) {
          for (const [sessionId, projection] of frame.projections) {
            parent.projections.set(sessionId, projection);
          }
        }
      }
    }
  }

  function projectEvent(
    projection: IngressProjection,
    event: DomainEvent,
  ): void {
    switch (event.type) {
      case "turn.started":
        projection.state = "busy";
        projection.currentTurnId = event.turnId;
        projection.activeTurn = createTurnScope(event.turnId);
        break;
      case "text.delta":
        projection.activeTurn?.messages.set(event.messageId, "streaming");
        break;
      case "message":
        projection.activeTurn?.messages.set(event.messageId, "complete");
        break;
      case "tool.requested":
        projection.activeTurn?.tools.set(event.toolCallId, "requested");
        break;
      case "tool.completed":
        projection.activeTurn?.tools.set(event.toolCallId, "complete");
        break;
      case "turn.completed":
        projection.state = "idle";
        projection.currentTurnId = null;
        projection.activeTurn = null;
        projection.completedTurnIds.add(event.turnId);
        projection.pendingPermissions.clear();
        break;
      case "session.killed":
        projection.state = "killed";
        projection.currentTurnId = null;
        projection.activeTurn = null;
        projection.pendingPermissions.clear();
        projection.usedPermissionIds.clear();
        break;
      case "permission.requested":
        projection.usedPermissionIds.add(event.permissionId);
        projection.pendingPermissions.set(event.permissionId, {
          turnId: event.turnId,
          options: event.options,
        });
        break;
      case "permission.resolved":
        projection.pendingPermissions.delete(event.permissionId);
        break;
      case "session.created":
        break;
    }
  }

  bus = createEventBus({
    apply,
    onListenerError(error, event) {
      recordBestEffort(options.diagnostics, {
        sessionId: event.sessionId,
        ...("turnId" in event ? { turnId: event.turnId } : {}),
        kind: "lifecycle",
        operation: "event_delivery",
        reason: "listener_failed",
        message: evidence(error),
      });
      try {
        options.onListenerError?.(error, event);
      } catch {
        // Listener-error observation has no response channel and is best effort.
      }
    },
  });

  function decideDriverEvent(event: DomainEvent): WorkerEventIngressDecision {
    const session = sessions.get(event.sessionId);
    const projected = activeProjection(event.sessionId);
    const current = projected ?? session;
    const spawning =
      current === undefined ? pendingSpawns.get(event.sessionId) : undefined;
    const eventTurnId = "turnId" in event ? event.turnId : undefined;
    if (current === undefined && spawning?.accepting !== true)
      return {
        status: "rejected",
        rejection: {
          reason: "unknown_session",
          eventType: event.type,
          sessionState: "unknown",
          ...(eventTurnId === undefined ? {} : { eventTurnId }),
        },
      };
    if (current?.state === "killed")
      return {
        status: "rejected",
        rejection: {
          reason: "session_killed",
          eventType: event.type,
          sessionState: "killed",
          ...(eventTurnId === undefined ? {} : { eventTurnId }),
        },
      };
    const sessionState =
      spawning === undefined
        ? current!.state
        : spawning.completedTurnId === null
          ? "spawning"
          : "idle";
    if (
      event.type === "session.created" ||
      event.type === "turn.started" ||
      event.type === "session.killed"
    )
      return {
        status: "rejected",
        rejection: {
          reason: "driver_event_forbidden",
          eventType: event.type,
          sessionState,
        },
      };
    let turnScope: TurnScope | undefined;
    if ("turnId" in event) {
      const activeTurnId =
        current?.currentTurnId ??
        (spawning?.completedTurnId === null ? spawning.turn.turnId : null);
      const eventTurnCompleted =
        projected?.completedTurnIds.has(event.turnId) === true ||
        session?.turns.some(({ turnId }) => turnId === event.turnId) === true ||
        spawning?.completedTurnId === event.turnId;
      if (eventTurnCompleted)
        return {
          status: "rejected",
          rejection: {
            reason: "event_after_turn_completed",
            eventType: event.type,
            eventTurnId: event.turnId,
            ...(activeTurnId === null
              ? { sessionState: "idle" as const }
              : {
                  sessionState: sessionState as "busy" | "spawning",
                  activeTurnId,
                }),
          },
        };
      if (event.type === "permission.resolved" && activeTurnId !== null) {
        const pendingPermissions =
          current?.pendingPermissions ?? spawning?.pendingPermissions;
        const pending = pendingPermissions?.get(event.permissionId);
        if (pending === undefined)
          return {
            status: "rejected",
            rejection: {
              reason: "permission_not_pending",
              eventType: event.type,
              sessionState: sessionState as "busy" | "spawning",
              eventTurnId: event.turnId,
              activeTurnId,
              permissionId: event.permissionId,
            },
          };
        if (pending.turnId !== event.turnId)
          return {
            status: "rejected",
            rejection: {
              reason: "permission_turn_mismatch",
              eventType: event.type,
              sessionState: sessionState as "busy" | "spawning",
              eventTurnId: event.turnId,
              activeTurnId,
              permissionId: event.permissionId,
            },
          };
      }
      if (activeTurnId === null) {
        return {
          status: "rejected",
          rejection: {
            reason: "turn_not_active",
            eventType: event.type,
            sessionState: "idle",
            eventTurnId: event.turnId,
          },
        };
      }
      if (event.turnId !== activeTurnId)
        return {
          status: "rejected",
          rejection: {
            reason: "turn_mismatch",
            eventType: event.type,
            sessionState: sessionState as "busy" | "spawning",
            eventTurnId: event.turnId,
            activeTurnId,
          },
        };
      turnScope =
        current?.activeTurn ??
        (spawning?.completedTurnId === null ? spawning.turn : undefined);
      if (turnScope === undefined || turnScope.turnId !== event.turnId)
        return {
          status: "rejected",
          rejection: {
            reason: "turn_mismatch",
            eventType: event.type,
            sessionState: sessionState as "busy" | "spawning",
            eventTurnId: event.turnId,
            activeTurnId,
          },
        };
    }
    if (event.type === "text.delta") {
      if (turnScope?.messages.get(event.messageId) === "complete")
        return {
          status: "rejected",
          rejection: {
            reason: "message_already_completed",
            eventType: event.type,
            sessionState: sessionState as "busy" | "spawning",
            eventTurnId: event.turnId,
            activeTurnId: event.turnId,
            messageId: event.messageId,
          },
        };
    }
    if (event.type === "message") {
      if (turnScope?.messages.get(event.messageId) === "complete")
        return {
          status: "rejected",
          rejection: {
            reason: "message_already_completed",
            eventType: event.type,
            sessionState: sessionState as "busy" | "spawning",
            eventTurnId: event.turnId,
            activeTurnId: event.turnId,
            messageId: event.messageId,
          },
        };
    }
    if (event.type === "tool.requested") {
      if (turnScope?.tools.has(event.toolCallId) === true)
        return {
          status: "rejected",
          rejection: {
            reason: "tool_already_requested",
            eventType: event.type,
            sessionState: sessionState as "busy" | "spawning",
            eventTurnId: event.turnId,
            activeTurnId: event.turnId,
            toolCallId: event.toolCallId,
          },
        };
    }
    if (event.type === "tool.completed") {
      if (turnScope?.tools.get(event.toolCallId) === "complete")
        return {
          status: "rejected",
          rejection: {
            reason: "tool_already_completed",
            eventType: event.type,
            sessionState: sessionState as "busy" | "spawning",
            eventTurnId: event.turnId,
            activeTurnId: event.turnId,
            toolCallId: event.toolCallId,
          },
        };
    }
    if (event.type === "permission.requested") {
      const used = current?.usedPermissionIds ?? spawning?.permissionIds;
      if (used === undefined || used.has(event.permissionId))
        return {
          status: "rejected",
          rejection: {
            reason: "permission_id_reused",
            eventType: event.type,
            sessionState: sessionState as "busy" | "spawning",
            eventTurnId: event.turnId,
            activeTurnId: event.turnId,
            permissionId: event.permissionId,
          },
        };
    }
    return { status: "accepted" };
  }

  function protocolViolation(
    sessionId: SessionId,
    rejection: WorkerEventRejection,
  ): void {
    recordBestEffort(options.diagnostics, {
      sessionId,
      kind: "protocol_violation",
      operation: "validate_worker_event",
      ...rejection,
    });
  }

  ingestDriverEvent = (event) => {
    const decision = decideDriverEvent(event);
    switch (decision.status) {
      case "rejected":
        protocolViolation(event.sessionId, decision.rejection);
        return;
      case "accepted":
        break;
      default:
        decision satisfies never;
    }
    const projection = activeProjection(event.sessionId);
    if (projection !== undefined) projectEvent(projection, event);
    else {
      const spawning = pendingSpawns.get(event.sessionId);
      if (spawning?.accepting === true) {
        if (event.type === "text.delta")
          spawning.turn.messages.set(event.messageId, "streaming");
        else if (event.type === "message")
          spawning.turn.messages.set(event.messageId, "complete");
        else if (event.type === "tool.requested")
          spawning.turn.tools.set(event.toolCallId, "requested");
        else if (event.type === "tool.completed")
          spawning.turn.tools.set(event.toolCallId, "complete");
        else if (event.type === "permission.requested") {
          spawning.permissionIds.add(event.permissionId);
          spawning.pendingPermissions.set(event.permissionId, {
            turnId: event.turnId,
            options: event.options,
          });
        } else if (event.type === "permission.resolved")
          spawning.pendingPermissions.delete(event.permissionId);
        else if (event.type === "turn.completed") {
          spawning.completedTurnId = event.turnId;
          spawning.pendingPermissions.clear();
        }
      }
    }
    const delivering = pendingDeliveries.get(event.sessionId);
    if (delivering === undefined) bus.publish(event);
    else delivering.events.push(event);
  };

  function assertTurnTarget(target: TurnTarget): void {
    const parsed = v.safeParse(turnTargetSchema, target);
    if (!parsed.success) throw invalidParamsError(parsed.issues);
    const session = sessions.get(parsed.output.sessionId);
    if (session === undefined)
      throw machineError({
        code: "session_not_found",
        sessionId: parsed.output.sessionId,
      });
    if (
      session.currentTurnId !== parsed.output.turnId &&
      !session.turns.some((turn) => turn.turnId === parsed.output.turnId)
    ) {
      throw machineError({
        code: "invalid_params",
        issues: [{ issue: "invalid_value", path: "turnId" }],
      });
    }
  }

  function collectOutcomes(
    targets: readonly TurnTarget[],
  ): Pick<WaitResult, "completed" | "pending"> {
    const completed: TurnCompleted[] = [];
    const pending: TurnTarget[] = [];
    for (const target of targets) {
      const turn = sessions
        .get(target.sessionId)
        ?.turns.find((turn) => turn.turnId === target.turnId);
      if (turn === undefined) pending.push(target);
      else completed.push(turn);
    }
    return { completed, pending };
  }

  function isSatisfied(
    snapshot: Pick<WaitResult, "completed" | "pending">,
    completion: WaitParams["completion"],
  ): boolean {
    return completion === "any"
      ? snapshot.completed.length > 0
      : snapshot.pending.length === 0;
  }

  function settleWaiters(): void {
    const satisfied: {
      waiter: (typeof waiters)[number];
      snapshot: Pick<WaitResult, "completed" | "pending">;
    }[] = [];
    for (const waiter of waiters) {
      const snapshot = collectOutcomes(waiter.targets);
      if (isSatisfied(snapshot, waiter.completion)) {
        satisfied.push({ waiter, snapshot });
      }
    }
    for (const { waiter, snapshot } of satisfied) {
      if (waiter.timer !== null) clearTimeout(waiter.timer);
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve({ status: "satisfied", ...snapshot });
    }
  }

  function nextTurnId(_sessionId: SessionId): TurnId {
    turnSeq += 1;
    return v.parse(turnIdSchema, `t${turnSeq}`);
  }

  return {
    async spawn(params) {
      const parsed = v.safeParse(spawnParamsSchema, params);
      if (!parsed.success) {
        throw invalidParamsError(parsed.issues);
      }
      const spec = parsed.output;
      if (usedSessionNames.has(spec.sessionName)) {
        throw machineError({
          code: "session_name_conflict",
          sessionName: spec.sessionName,
        });
      }
      usedSessionNames.add(spec.sessionName);
      sessionSeq += 1;
      const sessionId = options.identity.session(spec.sessionName);
      const turnId = nextTurnId(sessionId);
      const cwd = spec.cwd;
      const spawnScope: PendingSpawn = {
        token: Symbol(spec.sessionName),
        turn: createTurnScope(turnId),
        permissionIds: new Set(),
        pendingPermissions: new Map(),
        completedTurnId: null,
        accepting: true,
      };
      pendingSpawns.set(sessionId, spawnScope);
      try {
        bus.transaction(
          [
            {
              type: "session.created",
              sessionId,
              harness: spec.harness,
              model: spec.model ?? null,
              reasoning: spec.reasoning ?? null,
              cwd,
              sessionName: spec.sessionName,
              spawnedAt: new Date().toISOString(),
            },
            { type: "turn.started", sessionId, turnId },
          ],
          () => {
            try {
              driver.start({
                sessionId,
                turnId,
                harness: spec.harness,
                message: spec.message,
                cwd,
                ...(spec.authorizationMode === undefined
                  ? {}
                  : { authorizationMode: spec.authorizationMode }),
                ...(spec.agent === undefined ? {} : { agent: spec.agent }),
                ...(spec.model === undefined ? {} : { model: spec.model }),
                ...(spec.reasoning === undefined
                  ? {}
                  : { reasoning: spec.reasoning }),
                ...(spec.sandbox === undefined
                  ? {}
                  : { sandbox: spec.sandbox }),
                ...(spec.captureHarnessStderr === undefined
                  ? {}
                  : { captureHarnessStderr: spec.captureHarnessStderr }),
                sessionName: spec.sessionName,
              });
            } finally {
              spawnScope.accepting = false;
            }
          },
        );
      } catch (error) {
        spawnScope.accepting = false;
        if (pendingSpawns.get(sessionId)?.token === spawnScope.token) {
          pendingSpawns.delete(sessionId);
        }
        throw await unexpectedFailure(options.diagnostics, error, {
          sessionId,
          turnId,
          kind: "request_failure",
          operation: "spawn",
          stage: "start_session",
          reason: "upstream_error",
          message: evidence(error),
        });
      }
      if (pendingSpawns.get(sessionId)?.token === spawnScope.token) {
        pendingSpawns.delete(sessionId);
      }
      return { sessionId, turnId, cwd };
    },
    async send(params) {
      const parsed = v.safeParse(sendParamsSchema, params);
      if (!parsed.success) {
        throw invalidParamsError(parsed.issues);
      }
      const { sessionId, message } = parsed.output;
      const session = sessions.get(sessionId);
      if (session === undefined) {
        throw machineError({ code: "session_not_found", sessionId });
      }
      if (session.state === "killed") {
        throw machineError({ code: "session_killed", sessionId });
      }
      assertNotTerminating(sessionId);
      if (
        parsed.output.placement === "new_turn" &&
        (session.state !== "idle" || pendingDeliveries.has(sessionId))
      ) {
        throw machineError({ code: "session_busy", sessionId });
      }
      messageSeq += 1;
      const messageId = v.parse(messageIdSchema, `m${messageSeq}`);
      if (parsed.output.placement === "new_turn") {
        const turnId = nextTurnId(sessionId);
        const started: DomainEvent = {
          type: "turn.started",
          sessionId,
          turnId,
        };
        const projection = projectSession(sessionId);
        projectEvent(projection, started);
        const delivery = createPendingDelivery(projection, true);
        pendingDeliveries.set(sessionId, delivery);
        try {
          await driver.deliver(sessionId, turnId, message, "new_turn");
          bus.publish([
            started,
            {
              type: "message",
              sessionId,
              turnId,
              messageId,
              role: "caller",
              content: message,
            },
            ...delivery.events,
          ]);
        } catch (error) {
          throw await unexpectedFailure(options.diagnostics, error, {
            sessionId,
            turnId,
            kind: "request_failure",
            operation: "send",
            stage: "deliver",
            reason: "upstream_error",
            message: evidence(error),
          });
        } finally {
          pendingDeliveries.delete(sessionId);
          delivery.settle();
        }
        return { sessionId, turnId, messageId, deliveryPoint: "new_turn" };
      }
      const turnId = parsed.output.turnId;
      if (pendingDeliveries.get(sessionId)?.creating)
        throw machineError({ code: "turn_not_active", sessionId, turnId });
      const current = activeProjection(sessionId) ?? session;
      if (current.currentTurnId !== turnId) {
        if (
          session.turns.some((turn) => turn.turnId === turnId) ||
          activeProjection(sessionId)?.completedTurnIds.has(turnId)
        )
          throw machineError({ code: "turn_not_active", sessionId, turnId });
        throw machineError({
          code: "invalid_params",
          issues: [{ issue: "invalid_value", path: "turnId" }],
        });
      }
      const delivery =
        pendingDeliveries.get(sessionId) ??
        createPendingDelivery(projectSession(sessionId), false);
      delivery.count += 1;
      pendingDeliveries.set(sessionId, delivery);
      try {
        await driver.deliver(sessionId, turnId, message, "active_turn");
        bus.publish({
          type: "message",
          sessionId,
          turnId,
          messageId,
          role: "caller",
          content: message,
        });
      } catch (error) {
        throw await unexpectedFailure(options.diagnostics, error, {
          sessionId,
          turnId,
          kind: "request_failure",
          operation: "send",
          stage: "steer",
          reason: "upstream_error",
          message: evidence(error),
        });
      } finally {
        delivery.count -= 1;
        if (delivery.count === 0) {
          try {
            bus.publish(delivery.events);
          } finally {
            pendingDeliveries.delete(sessionId);
            delivery.settle();
          }
        }
      }
      return { sessionId, turnId, messageId, deliveryPoint: "active_turn" };
    },
    async wait(params) {
      const parsed = v.safeParse(waitParamsSchema, params);
      if (!parsed.success) {
        throw invalidParamsError(parsed.issues);
      }
      const { targets, completion, timeoutMs } = parsed.output;
      for (const target of targets) assertTurnTarget(target);
      const immediate = collectOutcomes(targets);
      if (isSatisfied(immediate, completion))
        return { status: "satisfied", ...immediate };
      if (timeoutMs === 0) return { status: "timeout", ...immediate };
      return await new Promise<WaitResult>((resolve) => {
        const waiter: (typeof waiters)[number] = {
          targets,
          completion,
          resolve,
          timer: null,
        };
        const deadline =
          timeoutMs === undefined ? undefined : performance.now() + timeoutMs;
        function observeDeadline(): void {
          if (deadline === undefined) return;
          const remaining = deadline - performance.now();
          if (remaining > 0) {
            // Node 超过单次计时上限会钳为 1ms；分段只观察同一个单调截止点。
            waiter.timer = setTimeout(
              observeDeadline,
              Math.min(remaining, 2_147_483_647),
            );
            return;
          }
          waiters.splice(waiters.indexOf(waiter), 1);
          resolve({ status: "timeout", ...collectOutcomes(targets) });
        }
        waiters.push(waiter);
        observeDeadline();
      });
    },
    async interrupt(params) {
      const parsed = v.safeParse(interruptParamsSchema, params);
      if (!parsed.success) throw invalidParamsError(parsed.issues);
      const { sessionId, turnId } = parsed.output;
      const session = sessions.get(sessionId);
      if (session === undefined)
        throw machineError({ code: "session_not_found", sessionId });
      if (session.state === "killed")
        throw machineError({ code: "session_killed", sessionId });
      assertNotTerminating(sessionId);
      if (pendingDeliveries.get(sessionId)?.creating)
        throw machineError({ code: "turn_not_active", sessionId, turnId });
      const current = activeProjection(sessionId) ?? session;
      if (current.currentTurnId !== turnId) {
        if (
          session.turns.some((turn) => turn.turnId === turnId) ||
          activeProjection(sessionId)?.completedTurnIds.has(turnId)
        )
          throw machineError({ code: "turn_not_active", sessionId, turnId });
        throw machineError({
          code: "invalid_params",
          issues: [{ issue: "invalid_value", path: "turnId" }],
        });
      }
      try {
        await driver.interrupt(sessionId, turnId);
      } catch (error) {
        throw await unexpectedFailure(options.diagnostics, error, {
          sessionId,
          turnId,
          kind: "request_failure",
          operation: "interrupt",
          stage: "interrupt",
          reason: "upstream_error",
          message: evidence(error),
        });
      }
      return { sessionId, turnId };
    },
    async resolvePermission(params) {
      const parsed = v.safeParse(resolvePermissionParamsSchema, params);
      if (!parsed.success) {
        throw invalidParamsError(parsed.issues);
      }
      const { sessionId, turnId, permissionId, resolution } = parsed.output;
      const session = sessions.get(sessionId);
      if (session === undefined) {
        throw machineError({ code: "session_not_found", sessionId });
      }
      if (session.state === "killed") {
        throw machineError({ code: "session_killed", sessionId });
      }
      assertNotTerminating(sessionId);
      const pending = session.pendingPermissions.get(permissionId);
      if (pending === undefined) {
        throw machineError({
          code: "permission_not_pending",
          sessionId,
          permissionId,
        });
      }
      if (pending.turnId !== turnId)
        throw machineError({
          code: "invalid_params",
          issues: [{ issue: "invalid_value", path: "turnId" }],
        });
      const inMenu = v.safeParse(
        permissionResolutionSchemaFor(pending.options),
        resolution,
      );
      if (!inMenu.success) {
        throw machineError({
          code: "permission_resolution_mismatch",
          sessionId,
          permissionId,
        });
      }
      // 转交抛错时整个帧回滚：不产生 resolved、未决请求保留可重试。
      try {
        driverTransaction(
          [
            {
              type: "permission.resolved",
              sessionId,
              turnId: pending.turnId,
              permissionId,
              resolution,
            },
          ],
          new Map([[sessionId, projectSession(sessionId)]]),
          () => {
            driver.resolvePermission(sessionId, permissionId, resolution);
          },
        );
      } catch (error) {
        throw await unexpectedFailure(options.diagnostics, error, {
          sessionId,
          turnId: pending.turnId,
          kind: "authorization_failure",
          operation: "resolve_permission",
          stage: "deliver",
          reason: "upstream_rejected",
          permissionId,
        });
      }
      session.pendingPermissions.delete(permissionId);
    },
    async kill(params) {
      const parsed = v.safeParse(killParamsSchema, params);
      if (!parsed.success) {
        throw invalidParamsError(parsed.issues);
      }
      const id = parsed.output.sessionId;
      const session = sessions.get(id);
      if (session === undefined) {
        return { sessionId: id, status: "not_found" };
      }
      if (session.state === "killed") {
        return { sessionId: id, status: "killed" };
      }
      let termination = terminations.get(id);
      if (termination === undefined) {
        termination = (async () => {
          try {
            // terminate 的 resolve 是资源清理完成的承诺；成功前不得发布终态。
            await driver.terminate(id);
            // 停止后先结算原生已接受或拒绝的消息，避免 kill 越过其事实。
            await pendingDeliveries.get(id)?.settled;
            // 停止期间自然终态可能已提交；只补仍活动的回合，且先于会话终态。
            const terminalEvents: DomainEvent[] = [];
            if (session.currentTurnId !== null) {
              terminalEvents.push({
                type: "turn.completed",
                sessionId: id,
                turnId: session.currentTurnId,
                stopReason: "killed",
                finalReply: null,
              });
            }
            terminalEvents.push({ type: "session.killed", sessionId: id });
            bus.transaction(terminalEvents, () => {});
          } catch (error) {
            throw await unexpectedFailure(options.diagnostics, error, {
              sessionId: id,
              ...(session.currentTurnId === null
                ? {}
                : { turnId: session.currentTurnId }),
              kind: "request_failure",
              operation: "kill",
              stage: "terminate",
              reason: "upstream_error",
              message: evidence(error),
            });
          }
        })();
        terminations.set(id, termination);
        const clearTermination = () => {
          if (terminations.get(id) === termination) terminations.delete(id);
        };
        void termination.then(clearTermination, clearTermination);
      }
      await termination;
      return { sessionId: id, status: "killed" };
    },
    list(filter) {
      const matches =
        filter === undefined
          ? [...sessions.values()]
          : [...sessions.values()].filter(
              (session) =>
                (filter.sessionId === undefined ||
                  session.id === filter.sessionId) &&
                (filter.harness === undefined ||
                  session.harness === filter.harness) &&
                (filter.state === undefined ||
                  session.state === filter.state) &&
                (filter.sessionName === undefined ||
                  session.sessionName === filter.sessionName) &&
                (filter.model === undefined || session.model === filter.model),
            );
      return (
        matches
          // 创建事务尚未折叠首回合时，不投影缺少活动回合的中间状态。
          .filter(
            (session) =>
              session.state !== "busy" || session.currentTurnId !== null,
          )
          .map(toInfo)
          .toSorted((left, right) =>
            left.sessionId.localeCompare(right.sessionId),
          )
      );
    },
    assertTurnTarget,
    subscribe(listener) {
      return bus.subscribe(listener);
    },
  };
}
