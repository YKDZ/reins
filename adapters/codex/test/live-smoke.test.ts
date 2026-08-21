import type {
  DriverDiagnosticFact,
  DomainEvent,
  SessionId,
  SessionName,
  TurnId,
} from "@reins/protocol";
import { describe, expect, test } from "vitest";

import { createCodexDriver } from "#/codex-driver";
import { createCodexTransport } from "#/transport";

const live = process.env.REINS_LIVE_SMOKE === "1" ? describe : describe.skip;

live("codex live smoke", () => {
  test("短任务产出流式输出、工具事件与回合终态", async () => {
    const model = process.env.REINS_LIVE_SMOKE_MODEL ?? "gpt-5.3-codex-spark";
    const reasoning = process.env.REINS_LIVE_SMOKE_REASONING ?? "xhigh";
    type TurnCompletedEvent = Extract<DomainEvent, { type: "turn.completed" }>;
    let resolveTurn: ((event: TurnCompletedEvent) => void) | null = null;
    const turnDone = new Promise<TurnCompletedEvent>((resolve) => {
      resolveTurn = resolve;
    });
    const events: DomainEvent[] = [];
    const diagnostics: DriverDiagnosticFact[] = [];
    const factory = createCodexDriver({
      transportFactory: () => createCodexTransport({}),
    });
    const driver = factory({
      emit: (event) => {
        events.push(event);
        if (event.type === "permission.requested") {
          driver.resolvePermission(event.sessionId, event.permissionId, {
            outcome: "allow",
            scope: "once",
          });
        }
        if (event.type === "turn.completed" && resolveTurn !== null) {
          resolveTurn(event);
        }
      },
      diagnostics: async (input) => {
        diagnostics.push(input);
        return undefined;
      },
    });

    driver.start({
      sessionId: "smoke@g1" as SessionId,
      turnId: "t1" as TurnId,
      sessionName: "smoke" as SessionName,
      harness: "codex",
      message: "用一条 shell 命令列出当前目录的内容",
      cwd: process.cwd(),
      model,
      reasoning,
      authorizationMode: "interactive",
    });

    const completed = await turnDone;
    if (completed.stopReason === "failed") {
      expect(diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "turn_failure",
            message: expect.objectContaining({ text: expect.any(String) }),
          }),
        ]),
      );
    }
    expect(completed.stopReason).toBe("end_turn");
    expect(events.some((event) => event.type === "text.delta")).toBe(true);
    expect(events.some((event) => event.type === "tool.requested")).toBe(true);
    expect(
      events.some((event) => event.type === "tool.completed" && !event.isError),
    ).toBe(true);
    expect(
      diagnostics.some((input) => input.kind === "protocol_violation"),
    ).toBe(false);
    await driver.terminate("smoke@g1" as SessionId);
  }, 180_000);
});
