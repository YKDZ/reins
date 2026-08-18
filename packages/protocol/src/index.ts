import * as v from "valibot";

// —— 会话与状态 ——

export const sessionIdSchema = v.pipe(v.string(), v.minLength(1));
export type SessionId = v.InferOutput<typeof sessionIdSchema>;

export const sessionStateSchema = v.union([
  v.literal("busy"),
  v.literal("idle"),
  v.literal("killed"),
]);
export type SessionState = v.InferOutput<typeof sessionStateSchema>;

// 回合终态；wait 的超时是 wait 层结果，不是回合终态。
export const stopReasonSchema = v.union([
  v.literal("end_turn"),
  v.literal("cancelled"),
  v.literal("failed"),
  v.literal("killed"),
]);
export type StopReason = v.InferOutput<typeof stopReasonSchema>;

export const deliveryPointSchema = v.union([
  v.literal("boundary"),
  v.literal("new_turn"),
]);
export type DeliveryPoint = v.InferOutput<typeof deliveryPointSchema>;

// —— 七动作的参数与结果 ——

export const spawnParamsSchema = v.object({
  harness: v.string(),
  message: v.string(),
  agent: v.optional(v.string()),
  model: v.optional(v.string()),
  reasoning: v.optional(v.string()),
  cwd: v.optional(v.string()),
  permissionMode: v.optional(v.string()),
  sandbox: v.optional(v.string()),
  label: v.optional(v.string()),
  meta: v.optional(v.record(v.string(), v.unknown())),
});
export type SpawnParams = v.InferOutput<typeof spawnParamsSchema>;

export const sendParamsSchema = v.object({
  sessionId: sessionIdSchema,
  message: v.string(),
  meta: v.optional(v.record(v.string(), v.unknown())),
});
export type SendParams = v.InferOutput<typeof sendParamsSchema>;

export const sendAckSchema = v.object({
  messageId: v.string(),
  deliveryPoint: deliveryPointSchema,
});
export type SendAck = v.InferOutput<typeof sendAckSchema>;

export const waitParamsSchema = v.object({
  ids: v.array(sessionIdSchema),
  timeoutMs: v.optional(v.number()),
});
export type WaitParams = v.InferOutput<typeof waitParamsSchema>;

export const turnCompletedSchema = v.object({
  sessionId: sessionIdSchema,
  turnId: v.string(),
  stopReason: stopReasonSchema,
  finalReply: v.nullable(v.string()),
  usage: v.optional(v.record(v.string(), v.unknown())),
});
export type TurnCompleted = v.InferOutput<typeof turnCompletedSchema>;

export const waitResultSchema = v.object({
  status: v.union([v.literal("completed"), v.literal("timeout")]),
  results: v.array(turnCompletedSchema),
});
export type WaitResult = v.InferOutput<typeof waitResultSchema>;

export const interruptParamsSchema = v.object({
  ids: v.array(sessionIdSchema),
  message: v.optional(v.string()),
});
export type InterruptParams = v.InferOutput<typeof interruptParamsSchema>;

export const killParamsSchema = v.object({
  ids: v.array(sessionIdSchema),
});
export type KillParams = v.InferOutput<typeof killParamsSchema>;

export const listFilterSchema = v.object({
  harness: v.optional(v.string()),
  state: v.optional(sessionStateSchema),
  label: v.optional(v.string()),
  model: v.optional(v.string()),
});
export type ListFilter = v.InferOutput<typeof listFilterSchema>;

export const attachParamsSchema = v.object({
  sessionId: sessionIdSchema,
  replay: v.optional(v.number()),
  exitOn: v.optional(v.array(stopReasonSchema)),
});
export type AttachParams = v.InferOutput<typeof attachParamsSchema>;

// —— 领域事件 ——

export const domainEventSchema = v.union([
  v.object({
    type: v.literal("session.created"),
    sessionId: sessionIdSchema,
    harness: v.string(),
    model: v.nullable(v.string()),
    reasoning: v.nullable(v.string()),
    cwd: v.string(),
    label: v.nullable(v.string()),
    spawnedAt: v.string(),
  }),
  v.object({
    type: v.literal("turn.started"),
    sessionId: sessionIdSchema,
    turnId: v.string(),
  }),
  v.object({
    type: v.literal("text.delta"),
    sessionId: sessionIdSchema,
    turnId: v.string(),
    messageId: v.string(),
    delta: v.string(),
  }),
  v.object({
    type: v.literal("message"),
    sessionId: sessionIdSchema,
    turnId: v.string(),
    messageId: v.string(),
    role: v.union([v.literal("user"), v.literal("agent")]),
    content: v.string(),
  }),
  v.object({
    type: v.literal("tool.started"),
    sessionId: sessionIdSchema,
    turnId: v.string(),
    toolCallId: v.string(),
    name: v.string(),
  }),
  v.object({
    type: v.literal("tool.completed"),
    sessionId: sessionIdSchema,
    turnId: v.string(),
    toolCallId: v.string(),
    name: v.string(),
    result: v.nullable(v.string()),
  }),
  v.object({
    type: v.literal("permission.requested"),
    sessionId: sessionIdSchema,
    turnId: v.string(),
    permissionId: v.string(),
    kind: v.string(),
  }),
  v.object({
    type: v.literal("permission.resolved"),
    sessionId: sessionIdSchema,
    turnId: v.string(),
    permissionId: v.string(),
    decision: v.union([v.literal("allow"), v.literal("deny")]),
  }),
  v.object({
    type: v.literal("turn.completed"),
    sessionId: sessionIdSchema,
    turnId: v.string(),
    stopReason: stopReasonSchema,
    finalReply: v.nullable(v.string()),
    usage: v.optional(v.record(v.string(), v.unknown())),
  }),
  v.object({
    type: v.literal("session.killed"),
    sessionId: sessionIdSchema,
  }),
]);
export type DomainEvent = v.InferOutput<typeof domainEventSchema>;

// adapter 能力声明仅作诊断信息，不构成降级许可。
export const adapterCapabilitiesSchema = v.object({
  canSendMidTurn: v.boolean(),
  canInterrupt: v.boolean(),
  canResume: v.boolean(),
  isDurable: v.boolean(),
});
export type AdapterCapabilities = v.InferOutput<
  typeof adapterCapabilitiesSchema
>;
