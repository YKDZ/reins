import {
  spawnParamsSchema,
  type DomainEvent,
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
  sessionIdSchema,
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
  inbox: Array<{ messageId: MessageId; text: string }>;
  pendingPermissions: Map<
    PermissionId,
    { turnId: TurnId; options: PermissionOption[] }
  >;
  turns: TurnCompleted[];
};

type WaitOutcome = {
  sessionId: SessionId;
  status: "completed" | "killed";
  turn?: TurnCompleted;
};

function machineError(error: MachineError): MachineError {
  return error;
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
  spawn(params: SpawnParams): SessionId;
  send(params: SendParams): SendAck;
  wait(params: WaitParams): Promise<WaitResult>;
  interrupt(params: InterruptParams): InterruptAck;
  resolvePermission(params: ResolvePermissionParams): void;
  kill(params: KillParams): KillResult[];
  list(filter?: ListFilter): SessionInfo[];
  subscribe(listener: (event: DomainEvent) => void): () => void;
};

export function createSessionMachine(options: {
  driverFactory: WorkerDriverFactory;
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

  let bus: EventBus;
  let driver: WorkerDriver;

  driver = options.driverFactory((event) => bus.publish(event));

  // 事件折叠：只改状态，不做任何订阅通知；通知由总线在折叠前发出。
  const apply = (event: DomainEvent): void => {
    const session = sessions.get(event.sessionId);
    if (session !== undefined && session.state === "killed") return;
    switch (event.type) {
      case "session.created":
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
          inbox: [],
          pendingPermissions: new Map(),
          turns: [],
        });
        break;
      case "turn.started":
        if (session !== undefined) {
          session.state = "busy";
          session.currentTurnId = event.turnId;
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
          session.pendingPermissions.clear();
        }
        break;
      case "message":
      case "tool.completed":
        if (session !== undefined && session.inbox.length > 0) {
          const pending = session.inbox.splice(0);
          for (const item of pending) {
            const turnId = session.currentTurnId;
            if (turnId === null) continue;
            bus.transaction(
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
              () => {
                driver.deliver(session.id, turnId, item.text);
              },
            );
          }
        }
        break;
      case "session.killed":
        if (session !== undefined) {
          session.state = "killed";
          session.currentTurnId = null;
          session.inbox = [];
          session.pendingPermissions.clear();
        }
        break;
      case "permission.requested":
        if (session !== undefined) {
          session.pendingPermissions.set(event.permissionId, {
            turnId: event.turnId,
            options: event.options,
          });
        }
        break;
      default:
        break;
    }
    settleWaiters();
  };

  bus = createEventBus({
    apply,
    ...(options.onListenerError === undefined
      ? {}
      : { onListenerError: options.onListenerError }),
  });

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
    spawn(params) {
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
      sessionSeq += 1;
      const sessionId = v.parse(sessionIdSchema, `${spec.sessionName}@g0`);
      const turnId = nextTurnId(sessionId);
      const cwd = spec.cwd ?? process.cwd();
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
            ...(spec.sandbox === undefined ? {} : { sandbox: spec.sandbox }),
            sessionName: spec.sessionName,
          });
        },
      );
      usedSessionNames.add(spec.sessionName);
      return sessionId;
    },
    send(params) {
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
      messageSeq += 1;
      const messageId = v.parse(messageIdSchema, `m${messageSeq}`);
      if (session.state === "idle") {
        const turnId = nextTurnId(sessionId);
        bus.transaction(
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
          () => {
            driver.deliver(sessionId, turnId, message);
          },
        );
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
    interrupt(params) {
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
        if (session.state === "busy") {
          driver.interrupt(id);
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
    resolvePermission(params) {
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
      bus.transaction(
        [
          {
            type: "permission.resolved",
            sessionId,
            turnId: pending.turnId,
            permissionId,
            resolution,
          },
        ],
        () => {
          driver.resolvePermission(sessionId, permissionId, resolution);
        },
      );
      session.pendingPermissions.delete(permissionId);
    },
    kill(params) {
      const parsed = v.safeParse(killParamsSchema, params);
      if (!parsed.success) {
        throw invalidParamsError(parsed.issues);
      }
      return parsed.output.ids.map((id) => {
        const session = sessions.get(id);
        if (session === undefined) {
          return { sessionId: id, status: "not_found" };
        }
        if (session.state === "killed") {
          return { sessionId: id, status: "killed" };
        }
        bus.transaction([{ type: "session.killed", sessionId: id }], () => {
          driver.terminate(id);
        });
        return { sessionId: id, status: "killed" };
      });
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
