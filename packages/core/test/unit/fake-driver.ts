import type {
  DomainEvent,
  PermissionId,
  PermissionResolution,
  SessionId,
  TurnId,
  WorkerDriver,
  WorkerDriverFactory,
  WorkerSpec,
} from "@reins/protocol";

export type FakeDriverControls = {
  readonly emit: (event: DomainEvent) => void;
  readonly started: readonly WorkerSpec[];
  readonly delivered: ReadonlyArray<{
    sessionId: SessionId;
    turnId: TurnId;
    message: string;
  }>;
  readonly interrupted: ReadonlyArray<{ sessionId: SessionId }>;
  readonly terminated: readonly SessionId[];
  readonly resolved: ReadonlyArray<{
    sessionId: SessionId;
    permissionId: PermissionId;
    resolution: PermissionResolution;
  }>;
};

export function createFakeDriver(options?: {
  start?: (spec: WorkerSpec) => void;
  deliver?: (sessionId: SessionId, turnId: TurnId, message: string) => void;
  resolvePermission?: (
    sessionId: SessionId,
    permissionId: PermissionId,
    resolution: PermissionResolution,
  ) => void;
  terminate?: (sessionId: SessionId) => void;
}): {
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
    turnId: TurnId;
    message: string;
  }[] = [];
  const interrupted: { sessionId: SessionId }[] = [];
  const terminated: SessionId[] = [];
  const resolved: {
    sessionId: SessionId;
    permissionId: PermissionId;
    resolution: PermissionResolution;
  }[] = [];

  const factory: WorkerDriverFactory = (emit) => {
    emitRef = emit;
    const driver: WorkerDriver = {
      start(spec) {
        if (options?.start === undefined) {
          started.push(spec);
        } else {
          options.start(spec);
        }
      },
      deliver(sessionId, turnId, message) {
        if (options?.deliver === undefined) {
          delivered.push({ sessionId, turnId, message });
        } else {
          options.deliver(sessionId, turnId, message);
        }
      },
      interrupt(sessionId) {
        interrupted.push({ sessionId });
      },
      resolvePermission(sessionId, permissionId, resolution) {
        if (options?.resolvePermission === undefined) {
          resolved.push({ sessionId, permissionId, resolution });
        } else {
          options.resolvePermission(sessionId, permissionId, resolution);
        }
      },
      terminate(sessionId) {
        if (options?.terminate === undefined) {
          terminated.push(sessionId);
        } else {
          options.terminate(sessionId);
        }
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
      resolved,
    },
  };
}
