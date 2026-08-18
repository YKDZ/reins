import {
  spawnParamsSchema,
  type DomainEvent,
  type InterruptParams,
  interruptParamsSchema,
  type KillParams,
  type KillResult,
  killParamsSchema,
  type ListFilter,
  type MachineError,
  type SendAck,
  type SendParams,
  sendParamsSchema,
  type SessionId,
  type SessionInfo,
  type SpawnParams,
  type TurnCompleted,
  type WaitParams,
  type WaitResult,
  waitParamsSchema,
  type WorkerDriverFactory,
} from "@reins/protocol";
import * as v from "valibot";

type SessionRecord = {
  readonly id: SessionId;
  readonly harness: string;
  readonly model: string | null;
  readonly reasoning: string | null;
  readonly cwd: string;
  readonly label: string | null;
  readonly spawnedAt: string;
  state: "busy" | "idle" | "killed";
  currentTurnId: string | null;
  inbox: Array<{ messageId: string; text: string }>;
  turns: TurnCompleted[];
};

type WaitOutcome = {
  sessionId: SessionId;
  status: "completed" | "killed";
  turn?: TurnCompleted;
};

function machineError(
  code: MachineError["code"],
  context?: MachineError["context"],
): MachineError {
  return context === undefined ? { code } : { code, context };
}

function toInfo(session: SessionRecord): SessionInfo {
  const lastTurn = session.turns[session.turns.length - 1];

  return {
    sessionId: session.id,
    harness: session.harness,
    state: session.state,
    model: session.model,
    reasoning: session.reasoning,
    cwd: session.cwd,
    label: session.label,
    spawnedAt: session.spawnedAt,
    turns: session.turns.length,
    lastStopReason: lastTurn === undefined ? null : lastTurn.stopReason,
  } satisfies SessionInfo;
}

export type SessionMachine = {
  spawn(params: SpawnParams): SessionId;
  send(params: SendParams): SendAck;
  wait(params: WaitParams): Promise<WaitResult>;
  interrupt(params: InterruptParams): TurnCompleted[];
  kill(params: KillParams): KillResult[];
  list(filter?: ListFilter): SessionInfo[];
  subscribe(listener: (event: DomainEvent) => void): () => void;
};

export function createSessionMachine(options: {
  driverFactory: WorkerDriverFactory;
}): SessionMachine {
  const sessions = new Map<SessionId, SessionRecord>();
  const subscribers = new Set<(event: DomainEvent) => void>();
  const waiters: Array<{
    ids: ReadonlySet<SessionId>;
    resolve: (result: WaitResult) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }> = [];
  const queue: DomainEvent[] = [];
  let draining = false;
  let sessionSeq = 0;
  let messageSeq = 0;

  function enqueue(event: DomainEvent): void {
    queue.push(event);
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const next = queue[0];
        queue.shift();
        if (next !== undefined) processEvent(next);
      }
    } finally {
      draining = false;
    }
  }

  const driver = options.driverFactory(enqueue);

  function emitDriverMessage(
    session: SessionRecord,
    messageId: string,
    text: string,
  ): void {
    // driver 侧消息由机器自己发出；依赖 driver 在开启新回合时同步发出 turn.started。
    if (session.currentTurnId === null) return;
    enqueue({
      type: "message",
      sessionId: session.id,
      turnId: session.currentTurnId,
      messageId,
      role: "driver",
      content: text,
    });
  }

  function processEvent(event: DomainEvent): void {
    for (const listener of subscribers) listener(event);
    const session = sessions.get(event.sessionId);
    switch (event.type) {
      case "session.created":
        sessions.set(event.sessionId, {
          id: event.sessionId,
          harness: event.harness,
          model: event.model,
          reasoning: event.reasoning,
          cwd: event.cwd,
          label: event.label,
          spawnedAt: event.spawnedAt,
          state: "busy",
          currentTurnId: null,
          inbox: [],
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
        }
        break;
      case "message":
      case "tool.completed":
        if (session !== undefined && session.inbox.length > 0) {
          const pending = session.inbox.splice(0);
          for (const item of pending) {
            driver.deliver(event.sessionId, item.text);
            emitDriverMessage(session, item.messageId, item.text);
          }
        }
        break;
      case "session.killed":
        if (session !== undefined) {
          session.state = "killed";
          session.currentTurnId = null;
          session.inbox = [];
        }
        break;
      default:
        break;
    }
    settleWaiters();
  }

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

  return {
    spawn(params) {
      const parsed = v.safeParse(spawnParamsSchema, params);
      if (!parsed.success) {
        throw machineError("invalid_params", {
          issues: parsed.issues.map((issue) => issue.message),
        });
      }
      const spec = parsed.output;
      sessionSeq += 1;
      const sessionId: SessionId = `s${sessionSeq}`;
      driver.start({
        sessionId,
        harness: spec.harness,
        message: spec.message,
        cwd: spec.cwd ?? process.cwd(),
        spawnedAt: new Date().toISOString(),
        ...(spec.agent === undefined ? {} : { agent: spec.agent }),
        ...(spec.model === undefined ? {} : { model: spec.model }),
        ...(spec.reasoning === undefined ? {} : { reasoning: spec.reasoning }),
        ...(spec.permissionMode === undefined
          ? {}
          : { permissionMode: spec.permissionMode }),
        ...(spec.sandbox === undefined ? {} : { sandbox: spec.sandbox }),
        ...(spec.label === undefined ? {} : { label: spec.label }),
      });
      return sessionId;
    },
    send(params) {
      const parsed = v.safeParse(sendParamsSchema, params);
      if (!parsed.success) {
        throw machineError("invalid_params", {
          issues: parsed.issues.map((issue) => issue.message),
        });
      }
      const { sessionId, message } = parsed.output;
      const session = sessions.get(sessionId);
      if (session === undefined) {
        throw machineError("session_not_found", { sessionId });
      }
      if (session.state === "killed") {
        throw machineError("session_killed", { sessionId });
      }
      messageSeq += 1;
      const messageId = `m${messageSeq}`;
      if (session.state === "idle") {
        driver.deliver(sessionId, message);
        emitDriverMessage(session, messageId, message);
        return { messageId, deliveryPoint: "new_turn" };
      }
      session.inbox.push({ messageId, text: message });
      return { messageId, deliveryPoint: "boundary" };
    },
    async wait(params) {
      const parsed = v.safeParse(waitParamsSchema, params);
      if (!parsed.success) {
        throw machineError("invalid_params", {
          issues: parsed.issues.map((issue) => issue.message),
        });
      }
      const ids = new Set(parsed.output.ids);
      for (const id of ids) {
        if (!sessions.has(id)) {
          throw machineError("session_not_found", { sessionId: id });
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
        throw machineError("invalid_params", {
          issues: parsed.issues.map((issue) => issue.message),
        });
      }
      const results: TurnCompleted[] = [];
      for (const id of parsed.output.ids) {
        const session = sessions.get(id);
        if (session === undefined) {
          throw machineError("session_not_found", { sessionId: id });
        }
        if (session.state === "killed") {
          throw machineError("session_killed", { sessionId: id });
        }
        if (session.state === "busy") {
          driver.interrupt(id, parsed.output.message);
          const lastTurn = session.turns[session.turns.length - 1];
          if (lastTurn !== undefined) results.push(lastTurn);
        }
      }
      return results;
    },
    kill(params) {
      const parsed = v.safeParse(killParamsSchema, params);
      if (!parsed.success) {
        throw machineError("invalid_params", {
          issues: parsed.issues.map((issue) => issue.message),
        });
      }
      return parsed.output.ids.map((id) => {
        const session = sessions.get(id);
        if (session === undefined) {
          return { sessionId: id, status: "not_found" };
        }
        if (session.state === "killed") {
          return { sessionId: id, status: "killed" };
        }
        driver.terminate(id);
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
                (filter.label === undefined ||
                  session.label === filter.label) &&
                (filter.model === undefined || session.model === filter.model),
            );
      return matches
        .map(toInfo)
        .toSorted((left, right) =>
          left.sessionId.localeCompare(right.sessionId),
        );
    },
    subscribe(listener) {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
  };
}
