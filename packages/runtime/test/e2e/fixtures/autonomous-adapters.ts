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
      const activities = [
        {
          source: { kind: "fixture_job", id: "job-before-status" },
          toolCallId: v.parse(toolCallIdSchema, "job-output-before-status"),
        },
        {
          source: { kind: "fixture_job", id: "job-after-status" },
          toolCallId: v.parse(toolCallIdSchema, "job-output-after-status"),
        },
      ] as const;
      const ordinaryToolCallId = v.parse(
        toolCallIdSchema,
        "untracked-after-status",
      );
      for (const { source, toolCallId } of activities) {
        emit({
          type: "tool.requested",
          sessionId: spec.sessionId,
          turnId: spec.turnId,
          toolCallId,
          name: "start_background_job",
          input: { id: source.id },
        });
        emit({
          type: "background.activity",
          sessionId: spec.sessionId,
          source,
          status: "active",
          causedBy: { turnId: spec.turnId, toolCallId },
        });
      }
      emit({
        type: "tool.requested",
        sessionId: spec.sessionId,
        turnId: spec.turnId,
        toolCallId: ordinaryToolCallId,
        name: "ordinary_tool_without_background_source",
        input: { reason: "negative-case" },
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
        const [beforeStatus, afterStatus] = activities;
        if (beforeStatus === undefined || afterStatus === undefined)
          throw new Error("后台事实 fixture 配置不完整");
        emit({
          type: "tool.completed",
          sessionId: spec.sessionId,
          turnId: spec.turnId,
          toolCallId: beforeStatus.toolCallId,
          name: "finish_background_job",
          result: {
            content: [
              { type: "text", text: "BACKGROUND_OUTPUT_BEFORE_STATUS" },
            ],
            bytes: "AAEC",
          },
          isError: false,
        });
        emit({
          type: "tool.completed",
          sessionId: spec.sessionId,
          turnId: spec.turnId,
          toolCallId: beforeStatus.toolCallId,
          name: "finish_background_job",
          result: { content: "DUPLICATE_BACKGROUND_OUTPUT" },
          isError: false,
        });
        emit({
          type: "tool.completed",
          sessionId: spec.sessionId,
          turnId: spec.turnId,
          toolCallId: ordinaryToolCallId,
          name: "ordinary_tool_without_background_source",
          result: { content: "MUST_NOT_APPEAR_AFTER_TURN" },
          isError: false,
        });
        emit({
          type: "background.activity",
          sessionId: spec.sessionId,
          source: beforeStatus.source,
          status: "completed",
          causedBy: {
            turnId: spec.turnId,
            toolCallId: beforeStatus.toolCallId,
          },
        });
        emit({
          type: "background.activity",
          sessionId: spec.sessionId,
          source: afterStatus.source,
          status: "completed",
          causedBy: {
            turnId: spec.turnId,
            toolCallId: afterStatus.toolCallId,
          },
        });
        emit({
          type: "tool.completed",
          sessionId: spec.sessionId,
          turnId: spec.turnId,
          toolCallId: afterStatus.toolCallId,
          name: "finish_background_job",
          result: {
            content: [{ type: "text", text: "BACKGROUND_OUTPUT_AFTER_STATUS" }],
            bytes: "BAUG",
          },
          isError: false,
        });
        if (context.beginAutonomousTurn === undefined)
          throw new Error("自主回合入口未提供");
        const turnId = await context.beginAutonomousTurn({
          source: beforeStatus.source,
          causedBy: {
            turnId: spec.turnId,
            toolCallId: beforeStatus.toolCallId,
          },
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
