import type {
  DomainEvent,
  SessionId,
  WorkerDriver,
  WorkerDriverFactory,
} from "@reins/protocol";

export type FakeDriverControls = {
  readonly emit: (event: DomainEvent) => void;
  readonly delivered: ReadonlyArray<{ sessionId: SessionId; message: string }>;
  readonly interrupted: ReadonlyArray<{
    sessionId: SessionId;
    message?: string;
  }>;
  readonly terminated: readonly SessionId[];
  setInterruptFinalReply(value: string | null): void;
};

export function createFakeDriver(): {
  readonly factory: WorkerDriverFactory;
  readonly controls: FakeDriverControls;
} {
  let emitRef: ((event: DomainEvent) => void) | null = null;
  const emitEvent = (event: DomainEvent) => {
    emitRef?.(event);
  };
  const delivered: { sessionId: SessionId; message: string }[] = [];
  const interrupted: { sessionId: SessionId; message?: string }[] = [];
  const terminated: SessionId[] = [];
  let interruptFinalReply: string | null = null;

  const factory: WorkerDriverFactory = (emit) => {
    emitRef = emit;
    const driver: WorkerDriver = {
      start(spec) {
        emitEvent({
          type: "session.created",
          sessionId: spec.sessionId,
          harness: spec.harness,
          model: spec.model ?? null,
          reasoning: spec.reasoning ?? null,
          cwd: spec.cwd,
          label: spec.label ?? null,
          spawnedAt: spec.spawnedAt,
        });
        emitEvent({
          type: "turn.started",
          sessionId: spec.sessionId,
          turnId: `${spec.sessionId}:t1`,
        });
      },
      deliver(sessionId, message) {
        delivered.push({ sessionId, message });
      },
      interrupt(sessionId, message) {
        interrupted.push(
          message === undefined ? { sessionId } : { sessionId, message },
        );
        emitEvent({
          type: "turn.completed",
          sessionId,
          turnId: `${sessionId}:t1`,
          stopReason: "cancelled",
          finalReply: interruptFinalReply,
          usage: {},
        });
      },
      terminate(sessionId) {
        terminated.push(sessionId);
        emitEvent({ type: "session.killed", sessionId });
      },
    };
    return driver;
  };

  return {
    factory,
    controls: {
      emit: (event) => emitEvent(event),
      delivered,
      interrupted,
      terminated,
      setInterruptFinalReply: (value) => {
        interruptFinalReply = value;
      },
    },
  };
}
