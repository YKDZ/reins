import { appendFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

import type {
  AdapterDriverFactory,
  HarnessModelCatalog,
  SessionId,
  TurnId,
  WorkerDriver,
} from "@reins/protocol";
import { toolCallIdSchema } from "@reins/protocol";
import * as v from "valibot";

const driverFactory: AdapterDriverFactory = (context) => {
  const { emit } = context;
  let current: { sessionId: SessionId; turnId: TurnId } | undefined;
  let active = false;
  const interruptedTurns = new Set<TurnId>();

  const driver: WorkerDriver = {
    async start(spec) {
      current = { sessionId: spec.sessionId, turnId: spec.turnId };
      active = true;
      const input = JSON.parse(spec.message) as {
        wakeGate: string;
        turnGate: string;
        startedFile: string;
      };
      const source = { kind: "fixture_job", id: "job-1" };
      const toolCallId = v.parse(toolCallIdSchema, "job-creator");
      emit({
        type: "tool.requested",
        sessionId: spec.sessionId,
        turnId: spec.turnId,
        toolCallId,
        name: "start_background_job",
        input: { id: source.id },
      });
      emit({
        type: "tool.completed",
        sessionId: spec.sessionId,
        turnId: spec.turnId,
        toolCallId,
        name: "start_background_job",
        result: { id: source.id },
        isError: false,
      });
      emit({
        type: "background.activity",
        sessionId: spec.sessionId,
        source,
        status: "active",
        causedBy: { turnId: spec.turnId, toolCallId },
      });
      emit({
        type: "turn.completed",
        sessionId: spec.sessionId,
        turnId: spec.turnId,
        stopReason: "end_turn",
        finalReply: "background started",
      });
      const requestsFile = process.env.REINS_FIXTURE_REQUESTS_FILE;
      if (requestsFile !== undefined)
        appendFileSync(
          requestsFile,
          `${JSON.stringify({ type: "autonomous_fixture_started" })}\n`,
        );

      void (async () => {
        while (active) {
          try {
            await readFile(input.wakeGate, "utf8");
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
        if (!active) return;
        emit({
          type: "background.activity",
          sessionId: spec.sessionId,
          source,
          status: "completed",
          causedBy: { turnId: spec.turnId, toolCallId },
        });
        if (context.beginAutonomousTurn === undefined)
          throw new Error("自主回合入口未提供");
        const turnId = context.beginAutonomousTurn({
          source,
          causedBy: { turnId: spec.turnId, toolCallId },
        });
        current = { sessionId: spec.sessionId, turnId };
        await writeFile(input.startedFile, turnId);
        while (active && !interruptedTurns.has(turnId)) {
          try {
            await readFile(input.turnGate, "utf8");
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
        if (!active || interruptedTurns.has(turnId)) return;
        emit({
          type: "turn.completed",
          sessionId: spec.sessionId,
          turnId,
          stopReason: "end_turn",
          finalReply: "autonomous complete",
        });
      })();
    },
    async deliver(sessionId, turnId) {
      emit({
        type: "turn.completed",
        sessionId,
        turnId,
        stopReason: "end_turn",
        finalReply: "caller complete",
      });
    },
    async interrupt(sessionId, turnId) {
      if (
        current === undefined ||
        current.sessionId !== sessionId ||
        current.turnId !== turnId
      )
        return;
      interruptedTurns.add(turnId);
      emit({
        type: "turn.completed",
        sessionId,
        turnId,
        stopReason: "cancelled",
        finalReply: null,
      });
    },
    resolvePermission() {},
    async terminate() {
      active = false;
    },
  };
  return driver;
};

const modelCatalog = async (): Promise<HarnessModelCatalog> => ({
  harness: "codex",
  models: [],
});

export default { codex: { driverFactory, modelCatalog } };
