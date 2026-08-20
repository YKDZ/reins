import { appendFileSync } from "node:fs";

import type {
  HarnessCapability,
  SessionId,
  TurnId,
  WorkerDriver,
  AdapterDriverFactory,
} from "@reins/protocol";
import { messageIdSchema, permissionIdSchema } from "@reins/protocol";
import * as v from "valibot";

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
  behavior: "complete" | "hang" | "permission" | "failed" | "cancelled";
  canCaptureHarnessStderr?: boolean;
}): {
  driverFactory: AdapterDriverFactory;
  capabilities(): Promise<HarnessCapability>;
} {
  const { harness, modelId, behavior } = options;
  const factory: AdapterDriverFactory = ({ emit, diagnostics }) => {
    let current: { sessionId: SessionId; turnId: TurnId } | null = null;
    const resolvedPermissions = new Set<string>();
    let expectedPermissionCount = 1;
    const driver: WorkerDriver = {
      start(spec) {
        current = { sessionId: spec.sessionId, turnId: spec.turnId };
        if (behavior === "complete") {
          if (spec.captureHarnessStderr === true) {
            for (const originalBytes of [20_000, 20_001, 20_002]) {
              void diagnostics({
                sessionId: spec.sessionId,
                turnId: spec.turnId,
                kind: "harness_stderr",
                operation: "worker_process",
                reason: "stderr_output",
                text: {
                  text: "é".repeat(8_192),
                  truncated: true,
                  originalBytes,
                },
              });
            }
          }
          queueMicrotask(() => {
            emit({
              type: "message",
              sessionId: spec.sessionId,
              turnId: spec.turnId,
              messageId: v.parse(messageIdSchema, "w1"),
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
          const permissionIds =
            spec.message === "queue" ? (["p1", "p2"] as const) : ["p1"];
          expectedPermissionCount = permissionIds.length;
          for (const permissionId of permissionIds) {
            emit({
              type: "permission.requested",
              sessionId: spec.sessionId,
              turnId: spec.turnId,
              permissionId: v.parse(permissionIdSchema, permissionId),
              kind: "tool:Bash",
              input: { command: permissionId },
              options: [
                { outcome: "allow", scope: "once" },
                { outcome: "deny", feedback: false },
              ],
            });
          }
        }
        if (behavior === "failed" || behavior === "cancelled") {
          queueMicrotask(() => {
            emit({
              type: "turn.completed",
              sessionId: spec.sessionId,
              turnId: spec.turnId,
              stopReason: behavior === "failed" ? "failed" : "cancelled",
              finalReply: null,
            });
          });
        }
      },
      deliver(_sessionId, turnId) {
        if (current === null) return;
        const sessionId = current.sessionId;
        queueMicrotask(() => {
          emit({
            type: "turn.completed",
            sessionId,
            turnId,
            stopReason: "end_turn",
            finalReply: "ok",
          });
        });
      },
      interrupt() {},
      resolvePermission(_sessionId, permissionId, resolution) {
        if (current === null) return;
        const requestsFile = process.env.REINS_FIXTURE_REQUESTS_FILE;
        if (requestsFile !== undefined) {
          appendFileSync(requestsFile, `${permissionId}\n`);
        }
        resolvedPermissions.add(permissionId);
        if (resolvedPermissions.size < expectedPermissionCount) return;
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
      async terminate() {},
    };
    return driver;
  };
  return {
    driverFactory: factory,
    capabilities: async () => capability(harness, modelId),
    ...(options.canCaptureHarnessStderr === true
      ? { canCaptureHarnessStderr: true }
      : {}),
  };
}

export default {
  fake: fakeAdapter({
    harness: "fake",
    modelId: "fake-model",
    behavior: "complete",
  }),
  capture: fakeAdapter({
    harness: "capture",
    modelId: "capture-model",
    behavior: "complete",
    canCaptureHarnessStderr: true,
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
  failed: fakeAdapter({
    harness: "failed",
    modelId: "failed-model",
    behavior: "failed",
  }),
  cancelled: fakeAdapter({
    harness: "cancelled",
    modelId: "cancelled-model",
    behavior: "cancelled",
  }),
};
