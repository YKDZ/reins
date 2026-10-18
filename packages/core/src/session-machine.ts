import {
  spawnParamsSchema,
  autonomousTurnCauseSchema,
  harnessIdSchema,
  type AutonomousTurnCause,
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
  type MessageId,
  machineErrorSchema,
  makeErrorCause,
  messageIdSchema,
  type PermissionId,
  type PermissionOption,
  permissionResolutionSchemaFor,
  type ResolvePermissionAck,
  type ResolvePermissionParams,
  resolvePermissionParamsSchema,
  type SendAck,
  type SendParams,
  sendParamsSchema,
  type SessionId,
  type ToolCallId,
  type TurnId,
  type TurnOrigin,
  turnIdSchema,
  sessionIdSchema,
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
  WorkerStartFailure,
  WorkerDeliveryFailure,
  WorkerInterruptFailure,
  WorkerPermissionFailure,
} from "@reins/protocol";
import * as v from "valibot";

import type { DiagnosticEmitter } from "#/diagnostic-emitter";
import { createEventBus, type EventBus } from "#/event-bus";

type SessionRecord = {
  readonly id: SessionId;
  readonly harness: SpawnParams["harness"];
  readonly model: string | null;
  readonly reasoning: string | null;
  readonly cwd: string;
  readonly sessionLabel?: string;
  readonly spawnedAt: string;
  state: "busy" | "idle" | "killed";
  currentTurnId: TurnId | null;
  activeTurn: TurnScope | null;
  pendingPermissions: Map<
    PermissionId,
    { turnId: TurnId; options: PermissionOption[] }
  >;
  usedPermissionIds: Set<PermissionId>;
  backgroundToolCalls: Map<TurnId, Set<ToolCallId>>;
  turns: TurnCompleted[];
};

type TurnScope = {
  readonly turnId: TurnId;
  readonly origin?: TurnOrigin;
  readonly cause?: AutonomousTurnCause;
  readonly messages: Map<MessageId, "streaming" | "complete">;
  readonly nativeCallerCompletions: Set<MessageId>;
  readonly tools: Map<ToolCallId, "requested" | "complete">;
};

type PendingSpawn = {
  readonly token: symbol;
  readonly turn: TurnScope;
  readonly events: DomainEvent[];
  readonly lateEvents: DomainEvent[];
  readonly permissionIds: Set<PermissionId>;
  readonly pendingPermissions: SessionRecord["pendingPermissions"];
  readonly backgroundToolCalls: SessionRecord["backgroundToolCalls"];
  completedTurnId: TurnId | null;
  phase: "accepting" | "committing" | "closing";
};

type IngressProjection = {
  state: SessionRecord["state"];
  currentTurnId: TurnId | null;
  activeTurn: TurnScope | null;
  readonly completedTurnIds: Set<TurnId>;
  readonly backgroundToolCalls: SessionRecord["backgroundToolCalls"];
  readonly pendingPermissions: SessionRecord["pendingPermissions"];
  readonly usedPermissionIds: Set<PermissionId>;
};

type IngressActionFrame = {
  accepting: boolean;
  readonly projections: Map<SessionId, IngressProjection>;
  readonly nativeEvents: DomainEvent[];
};

type PendingDelivery = {
  readonly projection: IngressProjection;
  readonly events: DomainEvent[];
  readonly lateEvents: DomainEvent[];
  readonly creating: boolean;
  phase: "accepting" | "committing";
  readonly settled: Promise<void>;
  readonly settle: () => void;
  count: number;
};

type PendingTermination = {
  readonly result: Promise<{
    readonly result: KillResult;
    readonly events: readonly DomainEvent[];
  }>;
  published: boolean;
  requiresCommit: boolean;
  committedByCallback: boolean;
};

function createPendingDelivery(
  projection: IngressProjection,
  creating: boolean,
): PendingDelivery {
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return {
    projection,
    creating,
    phase: "accepting",
    events: [],
    lateEvents: [],
    count: 0,
    settled,
    settle,
  };
}

type WorkerEventIngressDecision =
  | { status: "accepted" }
  | { status: "rejected"; rejection: WorkerEventRejection };

const autonomousTurnParamsSchema = v.strictObject({
  sessionId: sessionIdSchema,
  harness: harnessIdSchema,
  cause: v.optional(autonomousTurnCauseSchema),
});

function createTurnScope(
  turnId: TurnId,
  origin?: TurnOrigin,
  cause?: AutonomousTurnCause,
): TurnScope {
  return {
    turnId,
    ...(origin === undefined ? {} : { origin }),
    ...(cause === undefined ? {} : { cause }),
    messages: new Map(),
    nativeCallerCompletions: new Set(),
    tools: new Map(),
  };
}

function copyBackgroundToolCalls(
  source: SessionRecord["backgroundToolCalls"],
): SessionRecord["backgroundToolCalls"] {
  return new Map(
    Array.from(source, ([turnId, toolCallIds]) => [
      turnId,
      new Set(toolCallIds),
    ]),
  );
}

function noteBackgroundToolCall(
  backgroundToolCalls: SessionRecord["backgroundToolCalls"],
  event: Extract<DomainEvent, { type: "background.activity" }>,
  activeTurn: TurnScope | null,
): void {
  const causedBy = event.causedBy;
  if (
    event.status !== "active" ||
    causedBy?.toolCallId === undefined ||
    activeTurn?.turnId !== causedBy.turnId ||
    activeTurn.tools.get(causedBy.toolCallId) !== "requested"
  )
    return;
  let toolCallIds = backgroundToolCalls.get(causedBy.turnId);
  if (toolCallIds === undefined) {
    toolCallIds = new Set();
    backgroundToolCalls.set(causedBy.turnId, toolCallIds);
  }
  toolCallIds.add(causedBy.toolCallId);
}

function consumeBackgroundToolCall(
  backgroundToolCalls: SessionRecord["backgroundToolCalls"],
  turnId: TurnId,
  toolCallId: ToolCallId,
): void {
  const toolCallIds = backgroundToolCalls.get(turnId);
  toolCallIds?.delete(toolCallId);
  if (toolCallIds?.size === 0) backgroundToolCalls.delete(turnId);
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
    ...(session.sessionLabel === undefined
      ? {}
      : { sessionLabel: session.sessionLabel }),
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
            ...(lastTurn.origin === undefined
              ? {}
              : { origin: lastTurn.origin }),
            stopReason: lastTurn.stopReason,
          },
        }),
  };
  if (session.state === "busy")
    return {
      ...common,
      state: "busy",
      activeTurnId: session.currentTurnId!,
      ...(session.activeTurn?.origin === undefined
        ? {}
        : { activeTurnOrigin: session.activeTurn.origin }),
    };
  if (session.state === "idle")
    return {
      ...common,
      state: "idle",
      lastCompletedTurn: {
        turnId: lastTurn!.turnId,
        ...(lastTurn!.origin === undefined ? {} : { origin: lastTurn!.origin }),
        stopReason: lastTurn!.stopReason,
      },
    };
  return { ...common, state: "killed" };
}

export type SessionMachine = {
  spawn(
    params: SpawnParams,
    commit?: (
      result: SpawnAck,
      events: readonly DomainEvent[],
    ) => void | Promise<void>,
  ): Promise<SpawnAck>;
  send(
    params: SendParams,
    hooks?: {
      readonly beforeDispatch?: () => void | Promise<void>;
      readonly commit?: (
        result: SendAck,
        events: readonly DomainEvent[],
      ) => void | Promise<void>;
    },
  ): Promise<SendAck>;
  beginAutonomousTurn(
    params: {
      readonly sessionId: SessionId;
      readonly harness: SpawnParams["harness"];
      readonly cause?: AutonomousTurnCause;
    },
    commit: (event: DomainEvent, session: SessionInfo) => void,
  ): TurnId;
  wait(params: WaitParams): Promise<WaitResult>;
  interrupt(
    params: InterruptParams,
    hooks?: {
      readonly beforeDispatch?: () => void | Promise<void>;
      readonly commit?: (result: InterruptAck) => void | Promise<void>;
    },
  ): Promise<InterruptAck>;
  resolvePermission(
    params: ResolvePermissionParams,
    hooks?: {
      readonly beforeDispatch?: () => void;
      readonly commit?: (
        result: ResolvePermissionAck,
        event: Extract<DomainEvent, { type: "permission.resolved" }>,
      ) => void;
    },
  ): Promise<ResolvePermissionAck>;
  kill(
    params: KillParams,
    // ControlStore 使用同步事务；返回 undefined 可避免异步回调越过事件提交截点。
    commit?: (result: KillResult, events: readonly DomainEvent[]) => undefined,
  ): Promise<KillResult>;
  list(filter?: ListFilter): SessionInfo[];
  assertTurnTarget(target: TurnTarget): void;
  subscribe(listener: (event: DomainEvent) => void): () => void;
  pendingSpawnIds(): SessionId[];
  terminatePendingSpawns(): Promise<void>;
};

export class SpawnCommitFailure extends Error {
  readonly sessionId: SessionId;
  readonly result: SpawnAck;
  readonly commitError: unknown;
  readonly terminationError: unknown;

  constructor(
    sessionId: SessionId,
    result: SpawnAck,
    commitError: unknown,
    terminationError: unknown,
  ) {
    super("Spawn was accepted but its control record could not be committed");
    this.name = "SpawnCommitFailure";
    this.sessionId = sessionId;
    this.result = result;
    this.commitError = commitError;
    this.terminationError = terminationError;
  }
}

export class SpawnStartFailure extends Error {
  readonly sessionId: SessionId;
  readonly acceptance: "not_accepted" | "unknown";
  readonly failure: MachineError;
  readonly terminationError: unknown;

  constructor(
    sessionId: SessionId,
    acceptance: "not_accepted" | "unknown",
    failure: MachineError,
    terminationError: unknown,
  ) {
    super("Worker start did not reach a known accepted state");
    this.name = "SpawnStartFailure";
    this.sessionId = sessionId;
    this.acceptance = acceptance;
    this.failure = failure;
    this.terminationError = terminationError;
  }
}

export class SendCommitFailure extends Error {
  readonly sessionId: SessionId;
  readonly result: SendAck;
  readonly commitError: unknown;
  readonly terminationError: unknown;

  constructor(
    sessionId: SessionId,
    result: SendAck,
    commitError: unknown,
    terminationError: unknown,
  ) {
    super("Send was accepted but its control record could not be committed");
    this.name = "SendCommitFailure";
    this.sessionId = sessionId;
    this.result = result;
    this.commitError = commitError;
    this.terminationError = terminationError;
  }
}

export class SendDeliveryFailure extends Error {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly acceptance: "not_accepted" | "unknown";
  readonly failure: MachineError;
  readonly terminationError: unknown;

  constructor(
    sessionId: SessionId,
    turnId: TurnId,
    acceptance: "not_accepted" | "unknown",
    failure: MachineError,
    terminationError: unknown,
  ) {
    super("Send delivery did not produce a confirmed receipt");
    this.name = "SendDeliveryFailure";
    this.sessionId = sessionId;
    this.turnId = turnId;
    this.acceptance = acceptance;
    this.failure = failure;
    this.terminationError = terminationError;
  }
}

export class InterruptCommitFailure extends Error {
  readonly result: InterruptAck;
  readonly commitError: unknown;

  constructor(result: InterruptAck, commitError: unknown) {
    super(
      "Interrupt was accepted natively but the control record failed to commit",
    );
    this.name = "InterruptCommitFailure";
    this.result = result;
    this.commitError = commitError;
  }
}

export class InterruptRequestFailure extends Error {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly acceptance: "not_accepted" | "unknown";
  readonly failure: MachineError;

  constructor(
    sessionId: SessionId,
    turnId: TurnId,
    acceptance: "not_accepted" | "unknown",
    failure: MachineError,
  ) {
    super("Interrupt request did not receive an acceptance response");
    this.name = "InterruptRequestFailure";
    this.sessionId = sessionId;
    this.turnId = turnId;
    this.acceptance = acceptance;
    this.failure = failure;
  }
}

export class PermissionResolutionCommitFailure extends Error {
  readonly result: ResolvePermissionAck;
  readonly commitError: unknown;
  readonly verificationError: unknown;

  constructor(
    result: ResolvePermissionAck,
    commitError: unknown,
    verificationError?: unknown,
  ) {
    super(
      "Permission resolution was accepted natively but its control record failed to commit",
    );
    this.name = "PermissionResolutionCommitFailure";
    this.result = result;
    this.commitError = commitError;
    this.verificationError = verificationError;
  }
}

export class PermissionResolutionRequestFailure extends Error {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly permissionId: PermissionId;
  readonly acceptance: "not_accepted" | "unknown";
  readonly failure: MachineError;

  constructor(
    sessionId: SessionId,
    turnId: TurnId,
    permissionId: PermissionId,
    acceptance: "not_accepted" | "unknown",
    failure: MachineError,
  ) {
    super("Permission resolution did not receive native acceptance");
    this.name = "PermissionResolutionRequestFailure";
    this.sessionId = sessionId;
    this.turnId = turnId;
    this.permissionId = permissionId;
    this.acceptance = acceptance;
    this.failure = failure;
  }
}

export type SessionIdentity = {
  session(): SessionId;
};

export function createSessionMachine(options: {
  driverFactory: WorkerDriverFactory;
  identity: SessionIdentity;
  diagnostics: DiagnosticEmitter;
  onListenerError?: (error: unknown, event: DomainEvent) => void;
}): SessionMachine {
  const sessions = new Map<SessionId, SessionRecord>();
  const waiters: Array<{
    targets: readonly TurnTarget[];
    completion: WaitParams["completion"];
    resolve: (result: WaitResult) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }> = [];
  let turnSeq = 0;
  let messageSeq = 0;
  const pendingSpawns = new Map<SessionId, PendingSpawn>();
  const terminations = new Map<SessionId, PendingTermination>();
  const completedTerminations = new Map<
    SessionId,
    { readonly result: KillResult; readonly events: readonly DomainEvent[] }
  >();
  const ingressActions: IngressActionFrame[] = [];
  const uncertainDeliveries = new Set<SessionId>();
  const interruptingTurns = new Set<string>();
  const acceptedInterrupts = new Set<string>();
  // 接受响应与终态通知可能在同一轮到达；只暂存本会话事件，
  // 保证已接受 caller 事实先于该回合终态，拒绝后仍释放真实终态。
  const pendingDeliveries = new Map<SessionId, PendingDelivery>();

  let bus: EventBus;
  let driver: WorkerDriver;
  let ingestDriverEvent: (event: DomainEvent) => void = () => undefined;

  function turnTargetKey(sessionId: SessionId, turnId: TurnId): string {
    return `${sessionId}/${turnId}`;
  }

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
          ...(event.sessionLabel === undefined
            ? {}
            : { sessionLabel: event.sessionLabel }),
          spawnedAt: event.spawnedAt,
          state: "busy",
          currentTurnId: null,
          activeTurn: null,
          pendingPermissions: new Map(),
          usedPermissionIds: new Set(),
          backgroundToolCalls: new Map(),
          turns: [],
        });
        break;
      }
      case "turn.started":
        if (session !== undefined) {
          session.state = "busy";
          session.currentTurnId = event.turnId;
          if (session.activeTurn?.turnId !== event.turnId) {
            session.activeTurn = createTurnScope(
              event.turnId,
              event.origin,
              event.cause,
            );
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
        if (session?.activeTurn?.turnId === event.turnId)
          session.activeTurn.tools.set(event.toolCallId, "complete");
        if (session !== undefined)
          consumeBackgroundToolCall(
            session.backgroundToolCalls,
            event.turnId,
            event.toolCallId,
          );
        break;
      case "background.activity":
        if (session !== undefined)
          noteBackgroundToolCall(
            session.backgroundToolCalls,
            event,
            session.activeTurn,
          );
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
        interruptingTurns.delete(turnTargetKey(event.sessionId, event.turnId));
        acceptedInterrupts.delete(turnTargetKey(event.sessionId, event.turnId));
        break;
      case "session.killed":
        if (session !== undefined) {
          session.state = "killed";
          session.currentTurnId = null;
          session.activeTurn = null;
          session.pendingPermissions.clear();
          session.usedPermissionIds.clear();
          session.backgroundToolCalls.clear();
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
              ...(activeTurn.origin === undefined
                ? {}
                : { origin: activeTurn.origin }),
              ...(activeTurn.cause === undefined
                ? {}
                : { cause: activeTurn.cause }),
              messages: new Map(activeTurn.messages),
              nativeCallerCompletions: new Set(
                activeTurn.nativeCallerCompletions,
              ),
              tools: new Map(activeTurn.tools),
            },
      completedTurnIds:
        inherited === undefined
          ? new Set(session?.turns.map(({ turnId }) => turnId))
          : new Set(inherited.completedTurnIds),
      backgroundToolCalls: copyBackgroundToolCalls(source.backgroundToolCalls),
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
    const frame: IngressActionFrame = {
      accepting: true,
      projections,
      nativeEvents: [],
    };
    ingressActions.push(frame);
    let committed = false;
    let failed = false;
    let failure: unknown;
    try {
      bus.transaction(lead, () => {
        try {
          run();
        } finally {
          frame.accepting = false;
        }
      });
      committed = true;
    } catch (error) {
      failed = true;
      failure = error;
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
    // 原生事实不随本地操作记录的回滚而消失；lead 仍只在控制提交成功后发布。
    if (frame.nativeEvents.length > 0) bus.publish(frame.nativeEvents);
    if (failed) throw failure;
  }

  function projectEvent(
    projection: IngressProjection,
    event: DomainEvent,
  ): void {
    switch (event.type) {
      case "turn.started":
        projection.state = "busy";
        projection.currentTurnId = event.turnId;
        projection.activeTurn = createTurnScope(
          event.turnId,
          event.origin,
          event.cause,
        );
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
        if (projection.activeTurn?.turnId === event.turnId)
          projection.activeTurn.tools.set(event.toolCallId, "complete");
        consumeBackgroundToolCall(
          projection.backgroundToolCalls,
          event.turnId,
          event.toolCallId,
        );
        break;
      case "background.activity":
        noteBackgroundToolCall(
          projection.backgroundToolCalls,
          event,
          projection.activeTurn,
        );
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
        projection.backgroundToolCalls.clear();
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
    if (spawning?.phase === "closing") return { status: "accepted" };
    if (current === undefined && spawning === undefined)
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
      const lateBackgroundToolCompletion =
        event.type === "tool.completed" &&
        (
          current?.backgroundToolCalls.get(event.turnId) ??
          spawning?.backgroundToolCalls.get(event.turnId)
        )?.has(event.toolCallId) === true;
      if (eventTurnCompleted && !lateBackgroundToolCompletion)
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
      if (
        !lateBackgroundToolCompletion &&
        event.type === "permission.resolved" &&
        activeTurnId !== null
      ) {
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
      if (!lateBackgroundToolCompletion && activeTurnId === null) {
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
      if (!lateBackgroundToolCompletion && event.turnId !== activeTurnId)
        return {
          status: "rejected",
          rejection: {
            reason: "turn_mismatch",
            eventType: event.type,
            sessionState: sessionState as "busy" | "spawning",
            eventTurnId: event.turnId,
            activeTurnId: activeTurnId!,
          },
        };
      turnScope = lateBackgroundToolCompletion
        ? undefined
        : (current?.activeTurn ??
          (spawning?.completedTurnId === null ? spawning.turn : undefined));
      if (
        !lateBackgroundToolCompletion &&
        (turnScope === undefined || turnScope.turnId !== event.turnId)
      )
        return {
          status: "rejected",
          rejection: {
            reason: "turn_mismatch",
            eventType: event.type,
            sessionState: sessionState as "busy" | "spawning",
            eventTurnId: event.turnId,
            activeTurnId: activeTurnId!,
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
      const isNativeCallerCompletion =
        event.role === "caller" &&
        turnScope?.nativeCallerCompletions.has(event.messageId) === true;
      if (
        turnScope?.messages.get(event.messageId) === "complete" &&
        !isNativeCallerCompletion
      )
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
    const spawning = pendingSpawns.get(event.sessionId);
    const activeTurn =
      projection?.activeTurn ??
      (spawning !== undefined && spawning.phase !== "closing"
        ? spawning.turn
        : sessions.get(event.sessionId)?.activeTurn);
    if (
      event.type === "turn.completed" &&
      activeTurn?.turnId === event.turnId &&
      activeTurn.origin !== undefined
    )
      event = { ...event, origin: activeTurn.origin };
    if (event.type === "message" && event.role === "caller") {
      const turnScope =
        projection !== undefined
          ? projection.activeTurn
          : spawning !== undefined && spawning.phase !== "closing"
            ? spawning.turn
            : sessions.get(event.sessionId)?.activeTurn;
      if (turnScope?.turnId === event.turnId)
        turnScope.nativeCallerCompletions.delete(event.messageId);
    }
    if (projection !== undefined) projectEvent(projection, event);
    else {
      if (spawning !== undefined && spawning.phase !== "closing") {
        if (event.type === "text.delta")
          spawning.turn.messages.set(event.messageId, "streaming");
        else if (event.type === "message")
          spawning.turn.messages.set(event.messageId, "complete");
        else if (event.type === "tool.requested")
          spawning.turn.tools.set(event.toolCallId, "requested");
        else if (event.type === "tool.completed") {
          spawning.turn.tools.set(event.toolCallId, "complete");
          consumeBackgroundToolCall(
            spawning.backgroundToolCalls,
            event.turnId,
            event.toolCallId,
          );
        } else if (event.type === "background.activity")
          noteBackgroundToolCall(
            spawning.backgroundToolCalls,
            event,
            spawning.turn,
          );
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
    if (spawning !== undefined) {
      if (spawning.phase === "accepting") spawning.events.push(event);
      else if (spawning.phase === "committing") spawning.lateEvents.push(event);
      return;
    }
    const delivering = pendingDeliveries.get(event.sessionId);
    if (delivering === undefined) {
      const action = ingressActions.at(-1);
      if (action?.accepting === true) action.nativeEvents.push(event);
      else bus.publish(event);
    } else if (delivering.phase === "accepting") delivering.events.push(event);
    else delivering.lateEvents.push(event);
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

  function nextMessageId(): MessageId {
    messageSeq += 1;
    return v.parse(messageIdSchema, `m${messageSeq}`);
  }

  function selectCallerMessage(
    events: readonly DomainEvent[],
    fallback: Extract<DomainEvent, { type: "message" }>,
  ): {
    caller: Extract<DomainEvent, { type: "message" }>;
    remainder: DomainEvent[];
  } {
    const caller = events.find(
      (event) =>
        event.type === "message" &&
        event.role === "caller" &&
        event.messageId === fallback.messageId,
    );
    return {
      caller: caller?.type === "message" ? caller : fallback,
      remainder: events.filter(
        (event) =>
          !(
            event.type === "message" &&
            event.role === "caller" &&
            event.messageId === fallback.messageId
          ),
      ),
    };
  }

  return {
    async spawn(params, commit) {
      const parsed = v.safeParse(spawnParamsSchema, params);
      if (!parsed.success) {
        throw invalidParamsError(parsed.issues);
      }
      const spec = parsed.output;
      const sessionId = options.identity.session();
      const turnId = nextTurnId(sessionId);
      const messageId = nextMessageId();
      const cwd = spec.cwd;
      const spawnScope: PendingSpawn = {
        token: Symbol(sessionId),
        turn: createTurnScope(turnId, { kind: "caller" }),
        events: [],
        lateEvents: [],
        permissionIds: new Set(),
        pendingPermissions: new Map(),
        backgroundToolCalls: new Map(),
        completedTurnId: null,
        phase: "accepting",
      };
      pendingSpawns.set(sessionId, spawnScope);
      try {
        await driver.start({
          sessionId,
          turnId,
          messageId,
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
          ...(spec.sandbox === undefined ? {} : { sandbox: spec.sandbox }),
          ...(spec.captureHarnessStderr === undefined
            ? {}
            : { captureHarnessStderr: spec.captureHarnessStderr }),
        });
      } catch (error) {
        spawnScope.phase = "closing";
        let terminationError: unknown;
        try {
          await driver.terminate(sessionId);
          if (pendingSpawns.get(sessionId)?.token === spawnScope.token)
            pendingSpawns.delete(sessionId);
        } catch (cleanupError) {
          terminationError = cleanupError;
        }
        const knownError = v.safeParse(machineErrorSchema, error);
        const workerFailure =
          error instanceof WorkerStartFailure ? error : undefined;
        const failure = await unexpectedFailure(options.diagnostics, error, {
          sessionId,
          turnId,
          kind: "request_failure",
          operation: "spawn",
          stage: "start_session",
          reason: "upstream_error",
          message: evidence(error),
        });
        throw new SpawnStartFailure(
          sessionId,
          workerFailure?.acceptance ??
            (knownError.success ? "not_accepted" : "unknown"),
          failure,
          terminationError,
        );
      }
      const result = { sessionId, turnId, cwd };
      const callerMessage: DomainEvent = {
        type: "message",
        sessionId,
        turnId,
        messageId,
        role: "caller",
        content: spec.message,
      };
      spawnScope.turn.messages.set(messageId, "complete");
      const nativeCallerMessage = spawnScope.events.find(
        (event) =>
          event.type === "message" &&
          event.role === "caller" &&
          event.messageId === messageId,
      );
      if (nativeCallerMessage === undefined)
        spawnScope.turn.nativeCallerCompletions.add(messageId);
      const events: DomainEvent[] = [
        {
          type: "session.created",
          sessionId,
          harness: spec.harness,
          model: spec.model ?? null,
          reasoning: spec.reasoning ?? null,
          cwd,
          ...(spec.sessionLabel === undefined
            ? {}
            : { sessionLabel: spec.sessionLabel }),
          spawnedAt: new Date().toISOString(),
        },
        {
          type: "turn.started",
          sessionId,
          turnId,
          origin: { kind: "caller" },
        },
        nativeCallerMessage ?? callerMessage,
        ...spawnScope.events.filter(
          (event) =>
            !(
              event.type === "message" &&
              event.role === "caller" &&
              event.messageId === messageId
            ),
        ),
      ];
      // 固定创建提交的截点。原生在异步提交期间产生的事件只进入 lateEvents，
      // 会在创建事实提交并发布后逐批走普通记录路径。
      const initialBatch = Object.freeze([...events]);
      spawnScope.phase = "committing";
      try {
        await commit?.(result, initialBatch);
      } catch (error) {
        spawnScope.phase = "closing";
        let stopError: unknown;
        try {
          await driver.terminate(sessionId);
        } catch (terminationError) {
          stopError = terminationError;
        }
        if (
          stopError === undefined &&
          pendingSpawns.get(sessionId)?.token === spawnScope.token
        )
          pendingSpawns.delete(sessionId);
        throw new SpawnCommitFailure(sessionId, result, error, stopError);
      }
      bus.publish(initialBatch);
      const activeTurn = sessions.get(sessionId)?.activeTurn;
      if (activeTurn?.turnId === turnId) {
        for (const nativeMessageId of spawnScope.turn.nativeCallerCompletions)
          activeTurn.nativeCallerCompletions.add(nativeMessageId);
      }
      while (spawnScope.lateEvents.length > 0) {
        const batch = spawnScope.lateEvents.splice(0);
        bus.publish(batch);
      }
      spawnScope.phase = "closing";
      if (pendingSpawns.get(sessionId)?.token === spawnScope.token)
        pendingSpawns.delete(sessionId);
      return result;
    },
    async send(params, hooks) {
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
        (session.state !== "idle" ||
          pendingDeliveries.has(sessionId) ||
          uncertainDeliveries.has(sessionId))
      ) {
        throw machineError({ code: "session_busy", sessionId });
      }
      if (parsed.output.placement === "new_turn") {
        const condition = parsed.output.ifLastCompletedTurn;
        if (condition !== undefined) {
          if (condition.sessionId !== sessionId)
            throw machineError({
              code: "invalid_params",
              issues: [{ issue: "invalid_value", path: "ifLastCompletedTurn" }],
            });
          const actual = session.turns.at(-1)?.turnId;
          if (actual === undefined)
            throw machineError({
              code: "internal_error",
              cause: makeErrorCause(
                "exception",
                "An idle session has no completed turn",
              ),
            });
          if (actual !== condition.turnId)
            throw machineError({
              code: "turn_precondition_failed",
              sessionId,
              expected: condition.turnId,
              actual,
            });
        }
      }
      const messageId = nextMessageId();
      const callerMessage: Extract<DomainEvent, { type: "message" }> = {
        type: "message",
        sessionId,
        turnId:
          parsed.output.placement === "new_turn"
            ? nextTurnId(sessionId)
            : parsed.output.turnId,
        messageId,
        role: "caller",
        content: message,
      };
      if (parsed.output.placement === "new_turn") {
        const turnId = callerMessage.turnId;
        const started: DomainEvent = {
          type: "turn.started",
          sessionId,
          turnId,
          origin: { kind: "caller" },
        };
        const projection = projectSession(sessionId);
        projectEvent(projection, started);
        const delivery = createPendingDelivery(projection, true);
        pendingDeliveries.set(sessionId, delivery);
        try {
          await hooks?.beforeDispatch?.();
          const ack: SendAck = {
            sessionId,
            turnId,
            messageId,
            deliveryPoint: "new_turn",
          };
          try {
            await driver.deliver(
              sessionId,
              turnId,
              message,
              "new_turn",
              messageId,
            );
          } catch (error) {
            const acceptance =
              error instanceof WorkerDeliveryFailure
                ? error.acceptance
                : "unknown";
            const failure = await unexpectedFailure(
              options.diagnostics,
              error,
              {
                sessionId,
                turnId,
                kind: "request_failure",
                operation: "send",
                stage: "deliver",
                reason: "upstream_error",
                message: evidence(error),
              },
            );
            let terminationError: unknown;
            let terminated = false;
            if (acceptance === "unknown") {
              try {
                await driver.terminate(sessionId);
                terminated = true;
              } catch (stopError) {
                terminationError = stopError;
                uncertainDeliveries.add(sessionId);
              }
            }
            pendingDeliveries.delete(sessionId);
            delivery.settle();
            if (terminated) bus.publish({ type: "session.killed", sessionId });
            throw new SendDeliveryFailure(
              sessionId,
              turnId,
              acceptance,
              failure,
              terminationError,
            );
          }
          const selected = selectCallerMessage(delivery.events, callerMessage);
          delivery.phase = "committing";
          const batch = Object.freeze([
            started,
            selected.caller,
            ...selected.remainder,
          ]);
          try {
            await hooks?.commit?.(ack, batch);
          } catch (commitError) {
            let terminationError: unknown;
            let terminated = false;
            try {
              await driver.terminate(sessionId);
              terminated = true;
            } catch (stopError) {
              terminationError = stopError;
              uncertainDeliveries.add(sessionId);
            }
            pendingDeliveries.delete(sessionId);
            delivery.settle();
            if (terminated) bus.publish({ type: "session.killed", sessionId });
            throw new SendCommitFailure(
              sessionId,
              ack,
              commitError,
              terminationError,
            );
          }
          bus.publish(batch);
          if (selected.caller === callerMessage)
            sessions
              .get(sessionId)
              ?.activeTurn?.nativeCallerCompletions.add(messageId);
          while (delivery.lateEvents.length > 0) {
            const lateBatch = delivery.lateEvents.splice(0);
            bus.publish(lateBatch);
          }
          pendingDeliveries.delete(sessionId);
          delivery.settle();
          return ack;
        } finally {
          if (pendingDeliveries.get(sessionId) === delivery) {
            pendingDeliveries.delete(sessionId);
            delivery.settle();
          }
        }
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
      if (
        interruptingTurns.has(turnTargetKey(sessionId, turnId)) ||
        acceptedInterrupts.has(turnTargetKey(sessionId, turnId))
      )
        throw machineError({ code: "session_busy", sessionId });
      const delivery =
        pendingDeliveries.get(sessionId) ??
        createPendingDelivery(projectSession(sessionId), false);
      delivery.count += 1;
      pendingDeliveries.set(sessionId, delivery);
      try {
        await hooks?.beforeDispatch?.();
        try {
          await driver.deliver(
            sessionId,
            turnId,
            message,
            "active_turn",
            messageId,
          );
        } catch (error) {
          const known = v.safeParse(machineErrorSchema, error);
          const definitelyNotAccepted =
            (error instanceof WorkerDeliveryFailure &&
              error.acceptance === "not_accepted") ||
            (known.success &&
              [
                "turn_not_active",
                "unsupported_feature",
                "session_not_found",
                "session_killed",
                "session_terminating",
                "session_busy",
                "invalid_params",
              ].includes(known.output.code));
          const acceptance =
            error instanceof WorkerDeliveryFailure
              ? error.acceptance
              : definitelyNotAccepted
                ? "not_accepted"
                : "unknown";
          const failure = await unexpectedFailure(options.diagnostics, error, {
            sessionId,
            turnId,
            kind: "request_failure",
            operation: "send",
            stage: "steer",
            reason: "upstream_error",
            message: evidence(error),
          });
          const effect =
            error instanceof WorkerDeliveryFailure ? error.effect : undefined;
          const describedFailure: MachineError =
            effect === undefined
              ? failure
              : {
                  code: "internal_error",
                  cause:
                    failure.code === "internal_error"
                      ? failure.cause
                      : makeErrorCause(
                          "upstream",
                          "Active-turn continuation failed",
                        ),
                  ...(failure.code === "internal_error" &&
                  failure.diagnosticId !== undefined
                    ? { diagnosticId: failure.diagnosticId }
                    : {}),
                  effect,
                };
          let terminationError: unknown;
          if (acceptance === "unknown") {
            try {
              await driver.terminate(sessionId);
              bus.publish({ type: "session.killed", sessionId });
            } catch (stopError) {
              terminationError = stopError;
              uncertainDeliveries.add(sessionId);
            }
          }
          if (hooks === undefined) throw describedFailure;
          throw new SendDeliveryFailure(
            sessionId,
            turnId,
            acceptance,
            describedFailure,
            terminationError,
          );
        }
        const selected = selectCallerMessage(delivery.events, callerMessage);
        delivery.events.splice(
          0,
          delivery.events.length,
          ...selected.remainder,
        );
        const ack: SendAck = {
          sessionId,
          turnId,
          messageId,
          deliveryPoint: "active_turn",
        };
        try {
          await hooks?.commit?.(ack, [selected.caller]);
        } catch (commitError) {
          let terminationError: unknown;
          try {
            await driver.terminate(sessionId);
            bus.publish({ type: "session.killed", sessionId });
          } catch (stopError) {
            terminationError = stopError;
            uncertainDeliveries.add(sessionId);
          }
          throw new SendCommitFailure(
            sessionId,
            ack,
            commitError,
            terminationError,
          );
        }
        bus.publish(selected.caller);
        if (selected.caller === callerMessage)
          sessions
            .get(sessionId)
            ?.activeTurn?.nativeCallerCompletions.add(messageId);
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
      return {
        sessionId,
        turnId: callerMessage.turnId,
        messageId,
        deliveryPoint: "active_turn",
      };
    },
    beginAutonomousTurn(params, commit) {
      const parsed = v.safeParse(autonomousTurnParamsSchema, params);
      if (!parsed.success) throw invalidParamsError(parsed.issues);
      const { sessionId, harness, cause } = parsed.output;
      if (pendingSpawns.has(sessionId))
        throw machineError({ code: "session_busy", sessionId });
      const session = sessions.get(sessionId);
      if (session === undefined)
        throw machineError({ code: "session_not_found", sessionId });
      if (session.state === "killed")
        throw machineError({ code: "session_killed", sessionId });
      assertNotTerminating(sessionId);
      if (
        session.state !== "idle" ||
        pendingDeliveries.has(sessionId) ||
        uncertainDeliveries.has(sessionId)
      )
        throw machineError({ code: "session_busy", sessionId });
      if (session.harness !== harness)
        throw machineError({
          code: "invalid_params",
          issues: [{ issue: "invalid_value", path: "harness" }],
        });
      if (
        cause?.causedBy !== undefined &&
        cause.causedBy.turnId !== session.currentTurnId &&
        !session.turns.some((turn) => turn.turnId === cause.causedBy!.turnId)
      )
        throw machineError({
          code: "invalid_params",
          issues: [{ issue: "invalid_value", path: "cause.causedBy.turnId" }],
        });

      const turnId = nextTurnId(sessionId);
      const origin: TurnOrigin = {
        kind: "harness",
        harness,
        ...(cause?.source === undefined
          ? {}
          : { cause: { source: cause.source } }),
      };
      const event: DomainEvent = {
        type: "turn.started",
        sessionId,
        turnId,
        origin,
        ...(cause === undefined ? {} : { cause }),
      };
      const currentInfo = toInfo(session);
      if (currentInfo.state !== "idle")
        throw machineError({ code: "session_busy", sessionId });
      const projectedInfo: SessionInfo = {
        ...currentInfo,
        state: "busy",
        activeTurnId: turnId,
        activeTurnOrigin: origin,
      };
      commit(event, projectedInfo);
      bus.publish(event);
      return turnId;
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
    async interrupt(params, hooks) {
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
      const targetKey = turnTargetKey(sessionId, turnId);
      if (interruptingTurns.has(targetKey))
        throw machineError({ code: "session_busy", sessionId });
      interruptingTurns.add(targetKey);
      try {
        await pendingDeliveries.get(sessionId)?.settled;
        const afterDelivery =
          activeProjection(sessionId) ?? sessions.get(sessionId);
        if (afterDelivery?.currentTurnId !== turnId)
          throw machineError({ code: "turn_not_active", sessionId, turnId });
        await hooks?.beforeDispatch?.();
        try {
          await driver.interrupt(sessionId, turnId);
        } catch (error) {
          const known = v.safeParse(machineErrorSchema, error);
          const definitelyNotAccepted =
            (error instanceof WorkerInterruptFailure &&
              error.acceptance === "not_accepted") ||
            (known.success &&
              [
                "turn_not_active",
                "unsupported_feature",
                "session_not_found",
                "session_killed",
                "session_terminating",
                "session_busy",
                "invalid_params",
              ].includes(known.output.code));
          const acceptance =
            error instanceof WorkerInterruptFailure
              ? error.acceptance
              : definitelyNotAccepted
                ? "not_accepted"
                : "unknown";
          const failure = await unexpectedFailure(options.diagnostics, error, {
            sessionId,
            turnId,
            kind: "request_failure",
            operation: "interrupt",
            stage: "interrupt",
            reason: "upstream_error",
            message: evidence(error),
          });
          if (acceptance === "unknown") acceptedInterrupts.add(targetKey);
          if (hooks === undefined) throw failure;
          throw new InterruptRequestFailure(
            sessionId,
            turnId,
            acceptance,
            failure,
          );
        }
        if (sessions.get(sessionId)?.currentTurnId === turnId)
          acceptedInterrupts.add(targetKey);
        const result = { sessionId, turnId };
        try {
          await hooks?.commit?.(result);
        } catch (commitError) {
          throw new InterruptCommitFailure(result, commitError);
        }
        return result;
      } finally {
        interruptingTurns.delete(targetKey);
      }
    },
    async resolvePermission(params, hooks) {
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
      const result: ResolvePermissionAck = {
        sessionId,
        turnId: pending.turnId,
        permissionId,
      };
      const event = {
        type: "permission.resolved",
        sessionId,
        turnId: pending.turnId,
        permissionId,
        resolution,
      } as const;
      const phase: {
        value: "beforeDispatch" | "native" | "commit";
      } = { value: "beforeDispatch" };
      try {
        driverTransaction(
          [event],
          new Map([[sessionId, projectSession(sessionId)]]),
          () => {
            hooks?.beforeDispatch?.();
            phase.value = "native";
            driver.resolvePermission(sessionId, permissionId, resolution);
            phase.value = "commit";
            hooks?.commit?.(result, event);
          },
        );
      } catch (error) {
        if (error instanceof PermissionResolutionCommitFailure) throw error;
        if (phase.value === "commit")
          throw new PermissionResolutionCommitFailure(result, error);
        const failure = await unexpectedFailure(options.diagnostics, error, {
          sessionId,
          turnId: pending.turnId,
          kind: "authorization_failure",
          operation: "resolve_permission",
          stage: "deliver",
          reason: "upstream_rejected",
          permissionId,
        });
        if (hooks === undefined) throw failure;
        throw new PermissionResolutionRequestFailure(
          sessionId,
          turnId,
          permissionId,
          phase.value === "beforeDispatch"
            ? "not_accepted"
            : error instanceof WorkerPermissionFailure
              ? error.acceptance
              : v.safeParse(machineErrorSchema, error).success
                ? "not_accepted"
                : "unknown",
          failure,
        );
      }
      return result;
    },
    async kill(params, commit) {
      const parsed = v.safeParse(killParamsSchema, params);
      if (!parsed.success) {
        throw invalidParamsError(parsed.issues);
      }
      const id = parsed.output.sessionId;
      const session = sessions.get(id);
      if (session === undefined) {
        const result: KillResult = { sessionId: id, status: "not_found" };
        commit?.(result, []);
        return result;
      }
      if (session.state === "killed") {
        const result: KillResult = { sessionId: id, status: "killed" };
        commit?.(result, completedTerminations.get(id)?.events ?? []);
        return result;
      }
      let termination = terminations.get(id);
      if (termination === undefined) {
        let pending!: PendingTermination;
        const result = Promise.resolve().then(async () => {
          try {
            // terminate 的 resolve 是资源清理完成的承诺；成功前不得发布终态。
            await driver.terminate(id);
            uncertainDeliveries.delete(id);
            // 停止后先结算原生已接受或拒绝的消息，避免 kill 越过其事实。
            await pendingDeliveries.get(id)?.settled;
            // 停止期间自然终态可能已提交；只补仍活动的回合，且先于会话终态。
            const terminalEvents: DomainEvent[] = [];
            if (session.currentTurnId !== null) {
              terminalEvents.push({
                type: "turn.completed",
                sessionId: id,
                turnId: session.currentTurnId,
                ...(session.activeTurn?.origin === undefined
                  ? {}
                  : { origin: session.activeTurn.origin }),
                stopReason: "killed",
                finalReply: null,
              });
            }
            terminalEvents.push({ type: "session.killed", sessionId: id });
            return {
              result: { sessionId: id, status: "killed" } as const,
              events: Object.freeze(terminalEvents),
            };
          } catch (error) {
            if (terminations.get(id) === pending) terminations.delete(id);
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
        });
        pending = {
          result,
          published: false,
          requiresCommit: commit !== undefined,
          committedByCallback: false,
        };
        termination = pending;
        terminations.set(id, pending);
      }
      if (commit !== undefined) termination.requiresCommit = true;
      const closed = await termination.result;
      if (termination.published) {
        commit?.(
          closed.result,
          termination.committedByCallback ? [] : closed.events,
        );
      } else {
        if (!termination.requiresCommit || commit !== undefined) {
          commit?.(closed.result, closed.events);
          termination.committedByCallback = commit !== undefined;
          bus.transaction(closed.events, () => {});
          termination.published = true;
          completedTerminations.set(id, closed);
          if (terminations.get(id) === termination) terminations.delete(id);
        }
      }
      return closed.result;
    },
    pendingSpawnIds() {
      return [...pendingSpawns.keys()];
    },
    async terminatePendingSpawns() {
      const results = await Promise.allSettled(
        [...pendingSpawns.entries()].map(async ([sessionId, pending]) => {
          pending.phase = "closing";
          await driver.terminate(sessionId);
          if (pendingSpawns.get(sessionId)?.token === pending.token)
            pendingSpawns.delete(sessionId);
        }),
      );
      const failures = results
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result) => result.reason);
      if (failures.length > 0)
        throw new AggregateError(failures, "Pending worker cleanup failed");
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
                (filter.sessionLabel === undefined ||
                  session.sessionLabel === filter.sessionLabel) &&
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
