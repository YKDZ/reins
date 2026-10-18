import {
  messageIdSchema,
  permissionIdSchema,
  sessionIdSchema,
  toolCallIdSchema,
  turnIdSchema,
} from "@reins/protocol";
import * as v from "valibot";

import { noopDiagnosticEmitter } from "#/diagnostic-emitter";
import type { SessionIdentity } from "#/session-machine";

// 测试夹具也经协议解析，避免用断言绕过独立 ID 的品牌和格式约束。
export const ids = {
  sessionLabel: (value: string) => value,
  session: (value: string) => v.parse(sessionIdSchema, value),
  turn: (value: string) => v.parse(turnIdSchema, value),
  message: (value: string) => v.parse(messageIdSchema, value),
  permission: (value: string) => v.parse(permissionIdSchema, value),
  toolCall: (value: string) => v.parse(toolCallIdSchema, value),
};

let sessionCounter = 0;

export const testIdentity: SessionIdentity = {
  session: () => {
    sessionCounter += 1;
    return v.parse(
      sessionIdSchema,
      `session:00000000-0000-4000-8000-000000000000:gtest:${sessionCounter}`,
    );
  },
};

export const testDiagnostics = noopDiagnosticEmitter;
