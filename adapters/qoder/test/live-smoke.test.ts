import type {
  DomainEvent,
  SessionId,
  SessionName,
  TurnId,
} from "@reins/protocol";
import { describe, expect, test } from "vitest";

import { createQoderDriver } from "#/qoder-driver";
import { createRealQoderSdk } from "#/sdk-binding";

// 真实 qodercli + 本机登录态才运行（ADR-0011）；CI 默认跳过。
const live = process.env.REINS_LIVE_SMOKE === "1" ? describe : describe.skip;

live("qoder live smoke", () => {
  test("短任务产出流式输出、工具事件与回合终态", async () => {
    type TurnCompletedEvent = Extract<DomainEvent, { type: "turn.completed" }>;
    let resolveTurn: ((event: TurnCompletedEvent) => void) | null = null;
    const turnDone = new Promise<TurnCompletedEvent>((resolve) => {
      resolveTurn = resolve;
    });
    const events: DomainEvent[] = [];
    const factory = createQoderDriver({ sdk: createRealQoderSdk() });
    const driver = factory((event) => {
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
    });

    driver.start({
      sessionId: "smoke@g1" as SessionId,
      turnId: "t1" as TurnId,
      sessionName: "smoke" as SessionName,
      harness: "qoder",
      message: "用一条 shell 命令列出当前目录的内容",
      cwd: process.cwd(),
      model: "qwen3.7-flash",
      authorizationMode: "interactive",
    });

    const completed = await turnDone;
    expect(completed.stopReason).toBe("end_turn");
    expect(events.some((event) => event.type === "text.delta")).toBe(true);
    expect(events.some((event) => event.type === "tool.completed")).toBe(true);
    driver.terminate("smoke@g1" as SessionId);
  }, 120_000);
});
