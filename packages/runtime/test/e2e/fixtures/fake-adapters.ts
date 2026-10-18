import { appendFileSync } from "node:fs";

import type {
  HarnessId,
  HarnessModelCatalog,
  SessionId,
  TurnId,
  WorkerDriver,
  AdapterDriverFactory,
} from "@reins/protocol";
import { messageIdSchema } from "@reins/protocol";
import * as v from "valibot";

function modelCatalog(
  harness: HarnessId,
  modelId: string,
): HarnessModelCatalog {
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
  harness: HarnessId;
  modelId: string;
  canCaptureHarnessStderr?: boolean;
}): {
  driverFactory: AdapterDriverFactory;
  modelCatalog(): Promise<HarnessModelCatalog>;
} {
  const { harness, modelId } = options;
  const factory: AdapterDriverFactory = ({ emit, diagnostics }) => {
    let current: { sessionId: SessionId; turnId: TurnId } | null = null;
    const driver: WorkerDriver = {
      start(spec) {
        current = { sessionId: spec.sessionId, turnId: spec.turnId };
        const behavior =
          spec.captureHarnessStderr === true || !spec.message.startsWith("hold")
            ? "complete"
            : "hang";
        const observationsFile = process.env.REINS_FIXTURE_REQUESTS_FILE;
        if (observationsFile !== undefined) {
          appendFileSync(
            observationsFile,
            `${JSON.stringify({ type: "worker_started", spec })}\n`,
          );
        }
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
      },
      async deliver(_sessionId, turnId, message) {
        if (current === null) return;
        const sessionId = current.sessionId;
        const requestsFile = process.env.REINS_FIXTURE_REQUESTS_FILE;
        if (requestsFile !== undefined) {
          appendFileSync(
            requestsFile,
            `${JSON.stringify({ type: "message_delivered", sessionId, turnId, message })}\n`,
          );
        }
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
      async interrupt() {},
      resolvePermission() {},
      async terminate() {},
    };
    return driver;
  };
  return {
    driverFactory: factory,
    modelCatalog: async () => {
      const delayMs = Number(process.env.REINS_FIXTURE_MODEL_CATALOG_DELAY_MS);
      if (Number.isFinite(delayMs) && delayMs > 0) {
        const requestsFile = process.env.REINS_FIXTURE_REQUESTS_FILE;
        if (requestsFile !== undefined) {
          appendFileSync(
            requestsFile,
            `${JSON.stringify({ type: "model_catalog_started", harness })}\n`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return modelCatalog(harness, modelId);
    },
    ...(options.canCaptureHarnessStderr === true
      ? { canCaptureHarnessStderr: true }
      : {}),
  };
}

export default {
  codex: fakeAdapter({
    harness: "codex",
    modelId: "fake-model",
    canCaptureHarnessStderr: true,
  }),
  qoder: fakeAdapter({ harness: "qoder", modelId: "qoder-fixture-model" }),
};
