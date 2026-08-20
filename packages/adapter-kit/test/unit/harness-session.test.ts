import type {
  DiagnosticInput,
  DomainEvent,
  SessionId,
  TurnId,
} from "@reins/protocol";
import { describe, expect, test } from "vitest";

import { HarnessSession } from "#/harness-session";

const sessionId = "reviewer@g1" as SessionId;
const firstTurnId = "t1" as TurnId;
const secondTurnId = "t2" as TurnId;

function setup(cleared: string[] = []): {
  events: DomainEvent[];
  session: HarnessSession<string>;
  cleared: string[];
} {
  const events: DomainEvent[] = [];
  const session = new HarnessSession<string>({
    sessionId,
    emit: (event) => events.push(event),
    onClearPending: (attachments) => cleared.push(...attachments),
  });
  return { events, session, cleared };
}

describe("HarnessSession", () => {
  test("diagnostic 自动关联当前 session 与 turn", async () => {
    const inputs: DiagnosticInput[] = [];
    const session = new HarnessSession({
      sessionId,
      emit: () => {},
      diagnostics: async (input) => {
        inputs.push(input);
        return undefined;
      },
    });
    session.beginTurn(firstTurnId);

    await session.diagnostic({
      source: "adapter",
      harness: "qoder",
      kind: "mapping_gap",
      operation: "spawn",
      reason: "unsupported_input",
      fields: ["reasoning"],
    });

    expect(inputs).toEqual([
      {
        source: "adapter",
        harness: "qoder",
        sessionId,
        turnId: firstTurnId,
        kind: "mapping_gap",
        operation: "spawn",
        reason: "unsupported_input",
        fields: ["reasoning"],
      },
    ]);
  });

  test("diagnostic 在回合外不伪造 turn，且 sink 失败不穿透控制流", async () => {
    const inputs: DiagnosticInput[] = [];
    const session = new HarnessSession({
      sessionId,
      emit: () => {},
      diagnostics: async (input) => {
        inputs.push(input);
        throw new Error("store unavailable");
      },
    });

    await expect(
      session.diagnostic({
        source: "adapter",
        harness: "codex",
        kind: "compatibility_gap",
        operation: "receive_worker_request",
        reason: "unsupported_request",
      }),
    ).resolves.toBeUndefined();
    expect(inputs[0]).toMatchObject({ sessionId });
    expect(inputs[0]).not.toHaveProperty("turnId");
  });

  test("endTurn(end_turn) 携带 finalText 与 usage 并复位", () => {
    const { session } = setup();
    session.beginTurn(firstTurnId);
    session.setFinalText("完成");
    session.setUsage({ input_tokens: 5 });

    expect(session.endTurn("end_turn")).toEqual({
      type: "turn.completed",
      sessionId,
      turnId: firstTurnId,
      stopReason: "end_turn",
      finalReply: "完成",
      usage: { input_tokens: 5 },
    });
    expect(session.turnId).toBeNull();
    expect(session.finalText).toBeNull();
  });

  test("cancelled 终态 finalReply 为 null", () => {
    const { session } = setup();
    session.beginTurn(firstTurnId);
    expect(session.endTurn("cancelled")).toMatchObject({
      stopReason: "cancelled",
      finalReply: null,
    });
  });

  test("requestPermission 发事件并登记 pending，takePending 取走", () => {
    const { events, session } = setup();
    session.beginTurn(firstTurnId);
    const id = session.requestPermission(
      "tool:Bash",
      { command: "ls" },
      [{ outcome: "allow", scope: "once" }],
      "附件",
    );

    expect(events).toEqual([
      {
        type: "permission.requested",
        sessionId,
        turnId: firstTurnId,
        permissionId: id,
        kind: "tool:Bash",
        input: { command: "ls" },
        options: [{ outcome: "allow", scope: "once" }],
      },
    ]);
    expect(session.takePending(id)).toBe("附件");
    expect(session.takePending(id)).toBeUndefined();
  });

  test("endTurn 清空 pending 并把附件交给 onClearPending", () => {
    const { session, cleared } = setup();
    session.beginTurn(firstTurnId);
    session.requestPermission("tool:Bash", {}, [], "a");
    session.requestPermission("tool:Bash", {}, [], "b");

    session.endTurn("cancelled");
    expect(cleared).toEqual(["a", "b"]);
  });

  test("failActiveTurn 发 failed 并复位清空", () => {
    const { events, session, cleared } = setup();
    session.beginTurn(firstTurnId);
    session.requestPermission("tool:Bash", {}, [], "a");

    session.failActiveTurn();
    expect(events.at(-1)).toEqual({
      type: "turn.completed",
      sessionId,
      turnId: firstTurnId,
      stopReason: "failed",
      finalReply: null,
    });
    expect(session.turnId).toBeNull();
    expect(cleared).toEqual(["a"]);
  });

  test("setTurnId 只改回合号，不复位 finalText", () => {
    const { session } = setup();
    session.beginTurn(firstTurnId);
    session.setFinalText("保留");
    session.setTurnId(secondTurnId);
    expect(session.turnId).toBe(secondTurnId);
    expect(session.finalText).toBe("保留");
  });
});
