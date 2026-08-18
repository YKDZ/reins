import type {
  DomainEvent,
  SessionId,
  WorkerDriver,
  WorkerDriverFactory,
  WorkerSpec,
} from "@reins/protocol";

export type FakeDriverControls = {
  readonly emit: (event: DomainEvent) => void;
  readonly started: readonly WorkerSpec[];
  readonly delivered: ReadonlyArray<{
    sessionId: SessionId;
    turnId: string;
    message: string;
  }>;
  readonly interrupted: ReadonlyArray<{
    sessionId: SessionId;
    message?: string;
  }>;
  readonly terminated: readonly SessionId[];
};

export function createFakeDriver(): {
  readonly factory: WorkerDriverFactory;
  readonly controls: FakeDriverControls;
} {
  let emitRef: ((event: DomainEvent) => void) | null = null;
  const emitEvent = (event: DomainEvent) => {
    emitRef?.(event);
  };
  const started: WorkerSpec[] = [];
  const delivered: {
    sessionId: SessionId;
    turnId: string;
    message: string;
  }[] = [];
  const interrupted: { sessionId: SessionId; message?: string }[] = [];
  const terminated: SessionId[] = [];

  const factory: WorkerDriverFactory = (emit) => {
    emitRef = emit;
    const driver: WorkerDriver = {
      start(spec) {
        started.push(spec);
      },
      deliver(sessionId, turnId, message) {
        delivered.push({ sessionId, turnId, message });
      },
      interrupt(sessionId, message) {
        interrupted.push(
          message === undefined ? { sessionId } : { sessionId, message },
        );
      },
      terminate(sessionId) {
        terminated.push(sessionId);
      },
    };
    return driver;
  };

  return {
    factory,
    controls: {
      emit: (event) => emitEvent(event),
      started,
      delivered,
      interrupted,
      terminated,
    },
  };
}
