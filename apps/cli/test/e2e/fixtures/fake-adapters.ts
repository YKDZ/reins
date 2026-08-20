import type {
  HarnessCapability,
  WorkerDriver,
  WorkerDriverFactory,
} from "@reins/protocol";

function capability(harness: string, modelId: string): HarnessCapability {
  return {
    harness,
    models: [
      {
        id: modelId,
        displayName: `${harness} model`,
        reasoningEfforts: ["low", "high"],
      },
    ],
  };
}

function fakeAdapter(options: {
  harness: string;
  modelId: string;
  behavior: "complete" | "hang" | "permission";
}): {
  driverFactory: WorkerDriverFactory;
  capabilities(): Promise<HarnessCapability>;
} {
  const { harness, modelId, behavior } = options;
  const factory: WorkerDriverFactory = (emit) => {
    let current: { sessionId: string; turnId: string } | null = null;
    const driver: WorkerDriver = {
      start(spec) {
        current = { sessionId: spec.sessionId, turnId: spec.turnId };
        if (behavior === "complete") {
          queueMicrotask(() => {
            emit({
              type: "message",
              sessionId: spec.sessionId,
              turnId: spec.turnId,
              messageId: "w1",
              role: "worker",
              content: "interim",
            });
            emit({
              type: "turn.completed",
              sessionId: spec.sessionId,
              turnId: spec.turnId,
              stopReason: "end_turn",
              finalReply: "ok",
            });
          });
        }
        if (behavior === "permission") {
          emit({
            type: "permission.requested",
            sessionId: spec.sessionId,
            turnId: spec.turnId,
            permissionId: "p1",
            kind: "tool:Bash",
            input: { command: "ls" },
            options: [
              { outcome: "allow", scope: "once" },
              { outcome: "deny", feedback: false },
            ],
          });
        }
      },
      deliver(_sessionId, turnId) {
        if (current === null) return;
        queueMicrotask(() => {
          emit({
            type: "turn.completed",
            sessionId: current?.sessionId ?? "",
            turnId,
            stopReason: "end_turn",
            finalReply: "ok",
          });
        });
      },
      interrupt() {},
      resolvePermission(_sessionId, _permissionId, resolution) {
        if (current === null) return;
        const { sessionId, turnId } = current;
        queueMicrotask(() => {
          emit({
            type: "turn.completed",
            sessionId,
            turnId,
            stopReason: "end_turn",
            finalReply: `resolved:${resolution.outcome}`,
          });
        });
      },
      terminate() {},
    };
    return driver;
  };
  return {
    driverFactory: factory,
    capabilities: async () => capability(harness, modelId),
  };
}

export default {
  fake: fakeAdapter({
    harness: "fake",
    modelId: "fake-model",
    behavior: "complete",
  }),
  hang: fakeAdapter({
    harness: "hang",
    modelId: "hang-model",
    behavior: "hang",
  }),
  permission: fakeAdapter({
    harness: "permission",
    modelId: "perm-model",
    behavior: "permission",
  }),
};
