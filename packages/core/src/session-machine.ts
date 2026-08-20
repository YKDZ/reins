import {
  spawnParamsSchema,
  type DomainEvent,
  type DiagnosticId,
  type CoreDiagnosticFact,
  type InterruptAck,
  type InterruptOutcome,
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
  type TurnCompleted,
  type WaitParams,
  type WaitResult,
  waitParamsSchema,
  type WorkerDriver,
  type WorkerDriverFactory,
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
  inbox: Array<{ messageId: MessageId; text: string }>;
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
  accepting: boolean;
};

type IngressProjection = {
  state: SessionRecord["state"];
  currentTurnId: TurnId | null;
  activeTurn: TurnScope | null;
  readonly pendingPermissions: SessionRecord["pendingPermissions"];
  readonly usedPermissionIds: Set<PermissionId>;
};

type IngressActionFrame = {
  accepting: boolean;
  readonly projections: Map<SessionId, IngressProjection>;
};

function createTurnScope(turnId: TurnId): TurnScope {
  return { turnId, messages: new Map(), tools: new Map() };
}

type WaitOutcome = {
  sessionId: SessionId;
  status: "completed" | "killed";
  turn?: TurnCompleted;
};

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
  void Promise.resolve()
    .then(async () => await diagnostics.record(input))
    .catch(() => undefined);
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

  return {
    sessionId: session.id,
    sessionName: session.sessionName,
    harness: session.harness,
    state: session.state,
    model: session.model,
    reasoning: session.reasoning,
    cwd: session.cwd,
    spawnedAt: session.spawnedAt,
    turns: session.turns.length,
    lastStopReason: lastTurn === undefined ? null : lastTurn.stopReason,
  } satisfies SessionInfo;
}

export type SessionMachine = {
  spawn(params: SpawnParams): Promise<SessionId>;
  send(params: SendParams): Promise<SendAck>;
  wait(params: WaitParams): Promise<WaitResult>;
  interrupt(params: InterruptParams): Promise<InterruptAck>;
  resolvePermission(params: ResolvePermissionParams): Promise<void>;
  kill(params: KillParams): Promise<KillResult[]>;
  list(filter?: ListFilter): SessionInfo[];
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
    ids: ReadonlySet<SessionId>;
    resolve: (result: WaitResult) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }> = [];
  let sessionSeq = 0;
  let turnSeq = 0;
  let messageSeq = 0;
  const pendingSpawns = new Map<SessionId, PendingSpawn>();
  const terminations = new Map<SessionId, Promise<void>>();
  const ingressActions: IngressActionFrame[] = [];

  let bus: EventBus;
  let driver: WorkerDriver;
  let ingestDriverEvent: (event: DomainEvent) => void = () => undefined;

  driver = options.driverFactory((event) => ingestDriverEvent(event));

  function assertNotTerminating(sessionId: SessionId): void {
    if (terminations.has(sessionId)) {
      throw machineError({ code: "session_terminating", sessionId });
    }
  }

  // 事件折叠：只改状态，不做任何订阅通知；通知由总线在折叠前发出。
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
          inbox: [],
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
        if (session !== undefined && session.inbox.length > 0) {
          deliverInbox(session);
        }
        break;
      case "tool.requested":
        session?.activeTurn?.tools.set(event.toolCallId, "requested");
        break;
      case "tool.completed":
        session?.activeTurn?.tools.set(event.toolCallId, "complete");
        if (session !== undefined && session.inbox.length > 0) {
          deliverInbox(session);
        }
        break;
      case "turn.completed":
        if (session !== undefined) {
          session.turns.push({
            sessionId: event.sessionId,
            turnId: event.turnId,
            stopReason: event.stopReason,
            finalReply: event.finalReply,
            usage: event.usage,
          });
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
          session.inbox = [];
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

  function deliverInbox(session: SessionRecord): void {
    while (session.inbox.length > 0) {
      const item = session.inbox[0]!;
      const turnId = session.currentTurnId;
      if (turnId === null) break;
      try {
        driverTransaction(
          [
            {
              type: "message",
              sessionId: session.id,
              turnId,
              messageId: item.messageId,
              role: "caller",
              content: item.text,
            },
          ],
          new Map([[session.id, projectSession(session.id)]]),
          () => {
            driver.deliver(session.id, turnId, item.text);
          },
        );
        session.inbox.shift();
      } catch (error) {
        if (!v.safeParse(machineErrorSchema, error).success) {
          recordBestEffort(options.diagnostics, {
            sessionId: session.id,
            turnId,
            kind: "request_failure",
            operation: "send",
            stage: "steer",
            reason: "upstream_error",
            message: evidence(error),
          });
        }
        break;
      }
    }
  }

  function activeProjection(
    sessionId: SessionId,
  ): IngressProjection | undefined {
    for (let index = ingressActions.length - 1; index >= 0; index -= 1) {
      const frame = ingressActions[index];
      if (frame?.accepting !== true) continue;
      const projection = frame.projections.get(sessionId);
      if (projection !== undefined) return projection;
    }
    return undefined;
  }

  function projectSession(sessionId: SessionId): IngressProjection {
    const source = activeProjection(sessionId) ?? sessions.get(sessionId);
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

  function validDriverEvent(event: DomainEvent): boolean {
    const session = sessions.get(event.sessionId);
    const projected = activeProjection(event.sessionId);
    const current = projected ?? session;
    const spawning =
      current === undefined ? pendingSpawns.get(event.sessionId) : undefined;
    if (
      (current === undefined && spawning?.accepting !== true) ||
      current?.state === "killed"
    ) {
      return false;
    }
    if (event.type === "session.created" || event.type === "turn.started") {
      return false;
    }
    let turnScope: TurnScope | undefined;
    if ("turnId" in event) {
      if (
        (current !== undefined &&
          (current.state !== "busy" ||
            current.currentTurnId === null ||
            event.turnId !== current.currentTurnId)) ||
        (spawning !== undefined && event.turnId !== spawning.turn.turnId)
      ) {
        return false;
      }
      turnScope = current?.activeTurn ?? spawning?.turn;
      if (turnScope === undefined || turnScope.turnId !== event.turnId) {
        return false;
      }
    }
    if (event.type === "text.delta") {
      if (turnScope?.messages.get(event.messageId) === "complete") return false;
      turnScope?.messages.set(event.messageId, "streaming");
    }
    if (event.type === "message") {
      if (turnScope?.messages.get(event.messageId) === "complete") return false;
      turnScope?.messages.set(event.messageId, "complete");
    }
    if (event.type === "tool.requested") {
      if (turnScope?.tools.has(event.toolCallId) === true) return false;
      turnScope?.tools.set(event.toolCallId, "requested");
    }
    if (event.type === "tool.completed") {
      if (turnScope?.tools.get(event.toolCallId) === "complete") return false;
      turnScope?.tools.set(event.toolCallId, "complete");
    }
    if (event.type === "permission.requested") {
      const used = current?.usedPermissionIds ?? spawning?.permissionIds;
      if (used === undefined || used.has(event.permissionId)) return false;
      used.add(event.permissionId);
      const pendingPermissions =
        current?.pendingPermissions ?? spawning?.pendingPermissions;
      pendingPermissions?.set(event.permissionId, {
        turnId: event.turnId,
        options: event.options,
      });
      return true;
    }
    if (event.type === "permission.resolved") {
      const pendingPermissions =
        current?.pendingPermissions ?? spawning?.pendingPermissions;
      if (pendingPermissions === undefined) return false;
      const pending = pendingPermissions.get(event.permissionId);
      if (pending === undefined || pending.turnId !== event.turnId)
        return false;
      pendingPermissions.delete(event.permissionId);
      return true;
    }
    return true;
  }

  function protocolViolation(event: DomainEvent): void {
    const session = sessions.get(event.sessionId);
    const knownTurn =
      session !== undefined &&
      "turnId" in event &&
      session.currentTurnId === event.turnId
        ? event.turnId
        : undefined;
    recordBestEffort(options.diagnostics, {
      ...(session === undefined
        ? {}
        : {
            sessionId: session.id,
            ...(knownTurn === undefined ? {} : { turnId: knownTurn }),
          }),
      kind: "protocol_violation",
      operation: "validate_worker_event",
      reason: "unexpected_message",
      message: {
        text: "Worker event does not belong to the active session state",
        truncated: false,
        originalBytes: 56,
      },
    });
  }

  ingestDriverEvent = (event) => {
    if (!validDriverEvent(event)) {
      protocolViolation(event);
      return;
    }
    bus.publish(event);
  };

  function collectOutcomes(ids: ReadonlySet<SessionId>): WaitOutcome[] {
    const outcomes: WaitOutcome[] = [];
    for (const id of ids) {
      const session = sessions.get(id);
      if (session === undefined) continue;
      if (session.state === "killed") {
        outcomes.push({ sessionId: id, status: "killed" });
      } else if (session.state === "idle" && session.turns.length > 0) {
        const lastTurn = session.turns[session.turns.length - 1];
        if (lastTurn !== undefined) {
          outcomes.push({
            sessionId: id,
            status: "completed",
            turn: lastTurn,
          });
        }
      }
    }
    return outcomes;
  }

  function settleWaiters(): void {
    const resolved: Array<{
      waiter: (typeof waiters)[number];
      outcomes: WaitOutcome[];
    }> = [];
    for (const waiter of waiters) {
      const outcomes = collectOutcomes(waiter.ids);
      if (outcomes.length > 0) resolved.push({ waiter, outcomes });
    }
    for (const { waiter, outcomes } of resolved) {
      if (waiter.timer !== null) clearTimeout(waiter.timer);
      const index = waiters.indexOf(waiter);
      if (index !== -1) waiters.splice(index, 1);
      waiter.resolve({ status: "completed", results: outcomes });
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
      const cwd = spec.cwd ?? process.cwd();
      const spawnScope: PendingSpawn = {
        token: Symbol(spec.sessionName),
        turn: createTurnScope(turnId),
        permissionIds: new Set(),
        pendingPermissions: new Map(),
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
                authorizationMode: spec.authorizationMode ?? "allowAll",
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
      return sessionId;
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
      messageSeq += 1;
      const messageId = v.parse(messageIdSchema, `m${messageSeq}`);
      if (session.state === "idle") {
        const turnId = nextTurnId(sessionId);
        try {
          driverTransaction(
            [
              { type: "turn.started", sessionId, turnId },
              {
                type: "message",
                sessionId,
                turnId,
                messageId,
                role: "caller",
                content: message,
              },
            ],
            new Map([[sessionId, projectSession(sessionId)]]),
            () => {
              driver.deliver(sessionId, turnId, message);
            },
          );
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
        }
        return { sessionId, turnId, messageId, deliveryPoint: "new_turn" };
      }
      session.inbox.push({ messageId, text: message });
      if (session.currentTurnId === null) {
        throw new Error("Busy session is missing its current turn");
      }
      return {
        sessionId,
        turnId: session.currentTurnId,
        messageId,
        deliveryPoint: "boundary",
      };
    },
    async wait(params) {
      const parsed = v.safeParse(waitParamsSchema, params);
      if (!parsed.success) {
        throw invalidParamsError(parsed.issues);
      }
      const ids = new Set(parsed.output.ids);
      for (const id of ids) {
        if (!sessions.has(id)) {
          throw machineError({ code: "session_not_found", sessionId: id });
        }
      }
      const immediate = collectOutcomes(ids);
      if (immediate.length > 0) {
        return { status: "completed", results: immediate };
      }
      return await new Promise<WaitResult>((resolve) => {
        const timer =
          parsed.output.timeoutMs === undefined
            ? null
            : setTimeout(() => {
                const index = waiters.findIndex(
                  (waiter) => waiter.resolve === resolve,
                );
                if (index !== -1) waiters.splice(index, 1);
                resolve({ status: "timeout", results: [] });
              }, parsed.output.timeoutMs);
        waiters.push({ ids, resolve, timer });
      });
    },
    async interrupt(params) {
      const parsed = v.safeParse(interruptParamsSchema, params);
      if (!parsed.success) {
        throw invalidParamsError(parsed.issues);
      }
      const outcomes: InterruptOutcome[] = [];
      for (const id of parsed.output.ids) {
        const session = sessions.get(id);
        if (session === undefined) {
          throw machineError({ code: "session_not_found", sessionId: id });
        }
        if (session.state === "killed") {
          throw machineError({ code: "session_killed", sessionId: id });
        }
        assertNotTerminating(id);
        if (session.state === "busy") {
          try {
            driverTransaction([], new Map([[id, projectSession(id)]]), () => {
              driver.interrupt(id);
            });
          } catch (error) {
            throw await unexpectedFailure(options.diagnostics, error, {
              sessionId: id,
              ...(session.currentTurnId === null
                ? {}
                : { turnId: session.currentTurnId }),
              kind: "request_failure",
              operation: "interrupt",
              stage: "interrupt",
              reason: "upstream_error",
              message: evidence(error),
            });
          }
          outcomes.push({
            sessionId: id,
            status: "requested",
            ...(session.currentTurnId === null
              ? {}
              : { turnId: session.currentTurnId }),
          });
        } else {
          outcomes.push({ sessionId: id, status: "idle" });
        }
      }
      return outcomes;
    },
    async resolvePermission(params) {
      const parsed = v.safeParse(resolvePermissionParamsSchema, params);
      if (!parsed.success) {
        throw invalidParamsError(parsed.issues);
      }
      const { sessionId, permissionId, resolution } = parsed.output;
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
      const results: KillResult[] = [];
      for (const id of parsed.output.ids) {
        const session = sessions.get(id);
        if (session === undefined) {
          results.push({ sessionId: id, status: "not_found" });
          continue;
        }
        if (session.state === "killed") {
          results.push({ sessionId: id, status: "killed" });
          continue;
        }
        let termination = terminations.get(id);
        if (termination === undefined) {
          termination = (async () => {
            try {
              // terminate 的 resolve 是资源清理完成的承诺；成功前不得发布终态。
              await driver.terminate(id);
              bus.transaction(
                [{ type: "session.killed", sessionId: id }],
                () => {},
              );
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
        results.push({ sessionId: id, status: "killed" });
      }
      return results;
    },
    list(filter) {
      const matches =
        filter === undefined
          ? [...sessions.values()]
          : [...sessions.values()].filter(
              (session) =>
                (filter.harness === undefined ||
                  session.harness === filter.harness) &&
                (filter.state === undefined ||
                  session.state === filter.state) &&
                (filter.sessionName === undefined ||
                  session.sessionName === filter.sessionName) &&
                (filter.model === undefined || session.model === filter.model),
            );
      return matches
        .map(toInfo)
        .toSorted((left, right) =>
          left.sessionId.localeCompare(right.sessionId),
        );
    },
    subscribe(listener) {
      return bus.subscribe(listener);
    },
  };
}
