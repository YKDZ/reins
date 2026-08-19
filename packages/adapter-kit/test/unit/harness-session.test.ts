import type { DomainEvent } from "@reins/protocol";
import { describe, expect, test } from "vitest";

import { HarnessSession } from "#/harness-session";

function setup(cleared: string[] = []): {
  events: DomainEvent[];
  session: HarnessSession<string>;
  cleared: string[];
} {
  const events: DomainEvent[] = [];
  const session = new HarnessSession<string>({
    sessionId: "s1",
    emit: (event) => events.push(event),
    onClearPending: (attachments) => cleared.push(...attachments),
  });
  return { events, session, cleared };
}

describe("HarnessSession", () => {
  test("endTurn(end_turn) 携带 finalText 与 usage 并复位", () => {
    const { session } = setup();
    session.beginTurn("s1:t1");
    session.setFinalText("完成");
    session.setUsage({ input_tokens: 5 });

    expect(session.endTurn("end_turn")).toEqual({
      type: "turn.completed",
      sessionId: "s1",
      turnId: "s1:t1",
      stopReason: "end_turn",
      finalReply: "完成",
      usage: { input_tokens: 5 },
    });
    expect(session.turnId).toBeNull();
    expect(session.finalText).toBeNull();
  });

  test("cancelled 终态 finalReply 为 null", () => {
    const { session } = setup();
    session.beginTurn("s1:t1");
    expect(session.endTurn("cancelled")).toMatchObject({
      stopReason: "cancelled",
      finalReply: null,
    });
  });

  test("requestPermission 发事件并登记 pending，takePending 取走", () => {
    const { events, session } = setup();
    session.beginTurn("s1:t1");
    const id = session.requestPermission(
      "tool:Bash",
      { command: "ls" },
      [{ outcome: "allow", scope: "once" }],
      "附件",
    );

    expect(events).toEqual([
      {
        type: "permission.requested",
        sessionId: "s1",
        turnId: "s1:t1",
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
    session.beginTurn("s1:t1");
    session.requestPermission("tool:Bash", {}, [], "a");
    session.requestPermission("tool:Bash", {}, [], "b");

    session.endTurn("cancelled");
    expect(cleared).toEqual(["a", "b"]);
  });

  test("failActiveTurn 发 failed 并复位清空", () => {
    const { events, session, cleared } = setup();
    session.beginTurn("s1:t1");
    session.requestPermission("tool:Bash", {}, [], "a");

    session.failActiveTurn();
    expect(events.at(-1)).toEqual({
      type: "turn.completed",
      sessionId: "s1",
      turnId: "s1:t1",
      stopReason: "failed",
      finalReply: null,
    });
    expect(session.turnId).toBeNull();
    expect(cleared).toEqual(["a"]);
  });

  test("setTurnId 只改回合号，不复位 finalText", () => {
    const { session } = setup();
    session.beginTurn("s1:t1");
    session.setFinalText("保留");
    session.setTurnId("s1:t2");
    expect(session.turnId).toBe("s1:t2");
    expect(session.finalText).toBe("保留");
  });
});
