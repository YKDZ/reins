import {
  messageIdSchema,
  permissionIdSchema,
  sessionIdSchema,
  sessionNameSchema,
  toolCallIdSchema,
  turnIdSchema,
} from "@reins/protocol";
import * as v from "valibot";

// 测试夹具也经协议解析，避免用断言绕过独立 ID 的品牌和格式约束。
export const ids = {
  sessionName: (value: string) => v.parse(sessionNameSchema, value),
  session: (value: string) => v.parse(sessionIdSchema, value),
  turn: (value: string) => v.parse(turnIdSchema, value),
  message: (value: string) => v.parse(messageIdSchema, value),
  permission: (value: string) => v.parse(permissionIdSchema, value),
  toolCall: (value: string) => v.parse(toolCallIdSchema, value),
};
