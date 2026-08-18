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
  harness: v.pipe(v.string(), v.minLength(1)),
  message: v.pipe(v.string(), v.minLength(1)),
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
  results: v.array(
    v.object({
      sessionId: sessionIdSchema,
      status: v.union([v.literal("completed"), v.literal("killed")]),
      turn: v.optional(turnCompletedSchema),
    }),
  ),
});
export type WaitResult = v.InferOutput<typeof waitResultSchema>;

export const interruptParamsSchema = v.object({
  ids: v.array(sessionIdSchema),
  message: v.optional(v.string()),
});
export type InterruptParams = v.InferOutput<typeof interruptParamsSchema>;

export const interruptOutcomeSchema = v.object({
  sessionId: sessionIdSchema,
  status: v.union([v.literal("requested"), v.literal("idle")]),
});
export type InterruptOutcome = v.InferOutput<typeof interruptOutcomeSchema>;
export type InterruptAck = readonly InterruptOutcome[];

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

export const killResultSchema = v.object({
  sessionId: sessionIdSchema,
  status: v.union([v.literal("killed"), v.literal("not_found")]),
});
export type KillResult = v.InferOutput<typeof killResultSchema>;

export const sessionInfoSchema = v.object({
  sessionId: sessionIdSchema,
  harness: v.string(),
  state: sessionStateSchema,
  model: v.nullable(v.string()),
  reasoning: v.nullable(v.string()),
  cwd: v.string(),
  label: v.nullable(v.string()),
  spawnedAt: v.string(),
  turns: v.number(),
  lastStopReason: v.nullable(stopReasonSchema),
});
export type SessionInfo = v.InferOutput<typeof sessionInfoSchema>;

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
    role: v.union([v.literal("driver"), v.literal("worker")]),
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

// —— 错误码与机器错误（程序化契约；可读文案由 CLI / MCP 映射） ——

export const errorCodeSchema = v.union([
  v.literal("session_not_found"),
  v.literal("session_killed"),
  v.literal("invalid_params"),
]);
export type ErrorCode = v.InferOutput<typeof errorCodeSchema>;

export const machineErrorSchema = v.object({
  code: errorCodeSchema,
  context: v.optional(v.record(v.string(), v.unknown())),
});
export type MachineError = v.InferOutput<typeof machineErrorSchema>;

// —— worker driver 契约（缝 B：adapter 实现，core 调用） ——

export type WorkerSpec = {
  readonly sessionId: SessionId;
  readonly turnId: string;
  readonly harness: string;
  readonly message: string;
  readonly agent?: string;
  readonly model?: string;
  readonly reasoning?: string;
  readonly cwd: string;
  readonly permissionMode?: string;
  readonly sandbox?: string;
  readonly label?: string;
};

export interface WorkerDriver {
  // 启动 worker 进程/会话；worker 内容事件通过 emit 回调流入 core。
  start(spec: WorkerSpec): void;
  // 把消息交给 worker；turnId 标识它所属的回合。
  deliver(sessionId: SessionId, turnId: string, message: string): void;
  // 向 worker 发出停止当前回合的指令；worker 随后以 turn.completed(cancelled) 事件确认。
  interrupt(sessionId: SessionId, message?: string): void;
  // 终止 worker 进程；会话的 session.killed 事件由 core 发出。
  terminate(sessionId: SessionId): void;
}

export type WorkerDriverFactory = (
  emit: (event: DomainEvent) => void,
) => WorkerDriver;
