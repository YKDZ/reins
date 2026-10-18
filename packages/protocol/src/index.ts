import * as v from "valibot";

export const harnessIdSchema = v.picklist(["codex", "qoder"]);
export type HarnessId = v.InferOutput<typeof harnessIdSchema>;

// —— 会话与状态 ——

const identifier = <T extends string>(name: T, pattern: RegExp) =>
  v.pipe(v.string(), v.regex(pattern), v.brand<string, T>(name));

const opaqueIdentity = <T extends string>(name: T) =>
  v.pipe(v.string(), v.minLength(1), v.brand<string, T>(name));

export const sessionIdSchema = identifier(
  "SessionId",
  /^session:[a-z0-9]+:[1-9][0-9]*$/u,
);
export type SessionId = v.InferOutput<typeof sessionIdSchema>;
export const turnIdSchema = opaqueIdentity("TurnId");
export type TurnId = v.InferOutput<typeof turnIdSchema>;
export const sessionHandleSchema = sessionIdSchema;
export type SessionHandle = SessionId;
export const turnTargetSchema = v.strictObject({
  sessionId: sessionIdSchema,
  turnId: turnIdSchema,
});
export type TurnTarget = v.InferOutput<typeof turnTargetSchema>;

function encodeIdentity<T>(
  prefix: string,
  schema: v.GenericSchema<unknown, T>,
  value: unknown,
): string {
  const parsed = v.parse(schema, value);
  return prefix + Buffer.from(JSON.stringify(parsed)).toString("base64url");
}

function decodeIdentity<T>(
  prefix: string,
  schema: v.GenericSchema<unknown, T>,
  value: string,
): T {
  if (!value.startsWith(prefix)) throw new Error("Invalid serialized identity");
  const encoded = value.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded))
    throw new Error("Invalid serialized identity");
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  if (Buffer.from(decoded, "utf8").toString("base64url") !== encoded)
    throw new Error("Invalid serialized identity");
  return v.parse(schema, JSON.parse(decoded));
}

export const turnHandleSchema = v.pipe(
  v.string(),
  v.check((value) => {
    try {
      decodeIdentity("turn1_", turnTargetSchema, value);
      return true;
    } catch {
      return false;
    }
  }),
  v.brand<string, "TurnHandle">("TurnHandle"),
);
export type TurnHandle = v.InferOutput<typeof turnHandleSchema>;

export function encodeTurnHandle(target: TurnTarget): TurnHandle {
  return v.parse(
    turnHandleSchema,
    encodeIdentity("turn1_", turnTargetSchema, target),
  );
}

export function decodeTurnHandle(handle: string): TurnTarget {
  return decodeIdentity("turn1_", turnTargetSchema, handle);
}
export const permissionIdSchema = opaqueIdentity("PermissionId");
export type PermissionId = v.InferOutput<typeof permissionIdSchema>;
export const permissionTargetSchema = v.strictObject({
  ...turnTargetSchema.entries,
  permissionId: permissionIdSchema,
});
export type PermissionTarget = v.InferOutput<typeof permissionTargetSchema>;
export function encodePermissionHandle(target: PermissionTarget): string {
  return encodeIdentity("permission1_", permissionTargetSchema, target);
}
export function decodePermissionHandle(handle: string): PermissionTarget {
  return decodeIdentity("permission1_", permissionTargetSchema, handle);
}
export const permissionHandleSchema = v.pipe(
  v.string(),
  v.check((value) => {
    try {
      decodePermissionHandle(value);
      return true;
    } catch {
      return false;
    }
  }),
  v.brand("PermissionHandle"),
);
export type PermissionHandle = v.InferOutput<typeof permissionHandleSchema>;
export const messageIdSchema = opaqueIdentity("MessageId");
export type MessageId = v.InferOutput<typeof messageIdSchema>;
export const toolCallIdSchema = opaqueIdentity("ToolCallId");
export type ToolCallId = v.InferOutput<typeof toolCallIdSchema>;
export const commandIdSchema = identifier(
  "CommandId",
  /^[a-z0-9]+:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
);
export type CommandId = v.InferOutput<typeof commandIdSchema>;
export const sideEffectMethodSchema = v.picklist([
  "spawn",
  "send",
  "interrupt",
  "kill",
  "resolvePermission",
]);
export type SideEffectMethod = v.InferOutput<typeof sideEffectMethodSchema>;
export function isSideEffectMethod(method: string): method is SideEffectMethod {
  return v.safeParse(sideEffectMethodSchema, method).success;
}
export const requestIdSchema = identifier("RequestId", /^[a-z0-9][a-z0-9-]*$/);
export type RequestId = v.InferOutput<typeof requestIdSchema>;

// —— 握手：协议主版本、daemon 世代与消费者绑定 ——

export const REINS_PROTOCOL_MAJOR_VERSION = 2;

// 主版本是兼容性边界；不匹配必须以 protocol_version_mismatch 类型化呈现，
// 不能被字面量 schema 伪装成参数校验失败（ADR-0033）。
export const protocolMajorVersionSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
);

export const daemonGenerationSchema = identifier(
  "DaemonGeneration",
  /^[a-z0-9]+$/,
);
export type DaemonGeneration = v.InferOutput<typeof daemonGenerationSchema>;

export const runtimeScopeIdSchema = v.pipe(
  v.string(),
  v.regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  ),
  v.brand<string, "RuntimeScopeId">("RuntimeScopeId"),
);
export type RuntimeScopeId = v.InferOutput<typeof runtimeScopeIdSchema>;
export const messageIdentitySchema = v.strictObject({
  generation: daemonGenerationSchema,
  sessionId: sessionIdSchema,
  turnId: turnIdSchema,
  messageId: messageIdSchema,
});
export type MessageIdentity = v.InferOutput<typeof messageIdentitySchema>;
export const messageKeySchema = v.pipe(
  v.string(),
  v.check((value) => {
    try {
      decodeIdentity("message1_", messageIdentitySchema, value);
      return true;
    } catch {
      return false;
    }
  }),
  v.brand("MessageKey"),
);
export type MessageKey = v.InferOutput<typeof messageKeySchema>;
export function encodeMessageKey(identity: MessageIdentity): MessageKey {
  return v.parse(
    messageKeySchema,
    encodeIdentity("message1_", messageIdentitySchema, identity),
  );
}
export function decodeMessageKey(value: string): MessageIdentity {
  return decodeIdentity("message1_", messageIdentitySchema, value);
}

export const toolIdentitySchema = v.strictObject({
  generation: daemonGenerationSchema,
  sessionId: sessionIdSchema,
  turnId: turnIdSchema,
  toolCallId: toolCallIdSchema,
});
export type ToolIdentity = v.InferOutput<typeof toolIdentitySchema>;
export const toolKeySchema = v.pipe(
  v.string(),
  v.check((value) => {
    try {
      decodeIdentity("tool1_", toolIdentitySchema, value);
      return true;
    } catch {
      return false;
    }
  }),
  v.brand("ToolKey"),
);
export type ToolKey = v.InferOutput<typeof toolKeySchema>;
export function encodeToolKey(identity: ToolIdentity): ToolKey {
  return v.parse(
    toolKeySchema,
    encodeIdentity("tool1_", toolIdentitySchema, identity),
  );
}
export function decodeToolKey(value: string): ToolIdentity {
  return decodeIdentity("tool1_", toolIdentitySchema, value);
}

// 消费者上下文是 initialize 必填的内部路由事实；
// 不作为 agent 参数、成功输出或第四类句柄（ADR-0037）。
export const consumerContextSchema = v.pipe(
  v.string(),
  v.maxLength(64),
  v.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  v.brand<string, "ConsumerContext">("ConsumerContext"),
);
export type ConsumerContext = v.InferOutput<typeof consumerContextSchema>;

export function makeDiagnosticId(
  generation: string,
  counter: string,
): DiagnosticId {
  return v.parse(diagnosticIdSchema, `diagnostic:${generation}:${counter}`);
}
export const diagnosticIdSchema = identifier(
  "DiagnosticId",
  /^diagnostic:[a-z0-9]+:[1-9a-z][0-9a-z]*$/u,
);
export type DiagnosticId = v.InferOutput<typeof diagnosticIdSchema>;

export function isDiagnosticId(value: unknown): value is DiagnosticId {
  return v.safeParse(diagnosticIdSchema, value).success;
}

export const sessionStateSchema = v.union([
  v.literal("busy"),
  v.literal("idle"),
  v.literal("killed"),
]);
export type SessionState = v.InferOutput<typeof sessionStateSchema>;

// 回合终态；wait 的超时是 wait 层结果，不是回合终态。
export const STOP_REASONS = [
  "end_turn",
  "cancelled",
  "failed",
  "killed",
] as const;
export const stopReasonSchema = v.picklist(STOP_REASONS);
export type StopReason = v.InferOutput<typeof stopReasonSchema>;

export const deliveryPointSchema = v.union([
  v.literal("active_turn"),
  v.literal("new_turn"),
]);
export type DeliveryPoint = v.InferOutput<typeof deliveryPointSchema>;

export const authorizationModeSchema = v.union([
  v.literal("interactive"),
  v.literal("allowAll"),
]);
export type AuthorizationMode = v.InferOutput<typeof authorizationModeSchema>;

// —— 权限决议与选项菜单 ——

export const permissionResolutionSchema = v.union([
  v.strictObject({
    outcome: v.literal("allow"),
    scope: v.union([v.literal("once"), v.literal("session")]),
  }),
  v.strictObject({
    outcome: v.literal("deny"),
    feedback: v.optional(v.string()),
  }),
]);
export type PermissionResolution = v.InferOutput<
  typeof permissionResolutionSchema
>;

export const permissionOptionSchema = v.union([
  v.strictObject({
    outcome: v.literal("allow"),
    scope: v.union([v.literal("once"), v.literal("session")]),
  }),
  v.strictObject({
    outcome: v.literal("deny"),
    feedback: v.boolean(),
  }),
]);
export type PermissionOption = v.InferOutput<typeof permissionOptionSchema>;

// 答案形状契约：一个决议是否落在某个选项允许的形状内。这不是决议逻辑，
// 只是核对"答卷是否在本次请求的菜单里"；allow/deny 的选择由调用方做出。
function optionAllowsResolution(
  option: PermissionOption,
  resolution: PermissionResolution,
): boolean {
  if (option.outcome === "allow" && resolution.outcome === "allow") {
    return option.scope === resolution.scope;
  }
  if (option.outcome === "deny" && resolution.outcome === "deny") {
    // feedback=true 表示该 adapter 的 deny 必须由调用方提供文本；
    // feedback=false 表示没有文本通道。控制面不合成任何文案。
    if (option.feedback) return resolution.feedback !== undefined;
    return resolution.feedback === undefined;
  }
  return false;
}

// 把"决议 ∈ 本次请求的选项菜单"表达为 valibot schema：
// core 用它做命令入口的同步校验，adapter 用它复验兜底。
export function permissionResolutionSchemaFor(
  options: readonly PermissionOption[],
): v.GenericSchema {
  return v.pipe(
    permissionResolutionSchema,
    v.check((resolution) =>
      options.some((option) => optionAllowsResolution(option, resolution)),
    ),
  );
}

export function isPermissionResolutionAllowed(
  options: readonly PermissionOption[],
  resolution: PermissionResolution,
): boolean {
  return v.safeParse(permissionResolutionSchemaFor(options), resolution)
    .success;
}

// —— 七动作的参数与结果 ——

export const spawnParamsSchema = v.strictObject({
  sessionLabel: v.optional(v.string()),
  harness: harnessIdSchema,
  message: v.pipe(v.string(), v.minLength(1)),
  agent: v.optional(v.string()),
  model: v.optional(v.string()),
  reasoning: v.optional(v.string()),
  cwd: v.pipe(
    v.string(),
    v.startsWith("/"),
    v.check((path) => !path.includes("\0")),
  ),
  cwdIdentity: v.optional(
    v.strictObject({
      // 调用方可提供目录对象事实；仅在接受边界比对，不作运行期身份。
      device: v.pipe(v.string(), v.regex(/^[0-9]+$/u)),
      inode: v.pipe(v.string(), v.regex(/^[0-9]+$/u)),
    }),
  ),
  authorizationMode: v.optional(authorizationModeSchema),
  sandbox: v.optional(v.string()),
  captureHarnessStderr: v.optional(v.boolean()),
});
export type SpawnParams = v.InferOutput<typeof spawnParamsSchema>;
export const spawnAckSchema = v.strictObject({
  sessionId: sessionIdSchema,
  turnId: turnIdSchema,
  cwd: v.string(),
});
export type SpawnAck = v.InferOutput<typeof spawnAckSchema>;

export const sendParamsSchema = v.variant("placement", [
  v.strictObject({
    placement: v.literal("new_turn"),
    sessionId: sessionIdSchema,
    message: v.string(),
  }),
  v.strictObject({
    placement: v.literal("active_turn"),
    sessionId: sessionIdSchema,
    turnId: turnIdSchema,
    message: v.string(),
  }),
]);
export type SendParams = v.InferOutput<typeof sendParamsSchema>;

export const sendAckSchema = v.strictObject({
  sessionId: sessionIdSchema,
  turnId: turnIdSchema,
  messageId: messageIdSchema,
  deliveryPoint: deliveryPointSchema,
});
export type SendAck = v.InferOutput<typeof sendAckSchema>;

export const waitParamsSchema = v.strictObject({
  targets: v.pipe(
    v.array(turnTargetSchema),
    v.minLength(1),
    v.check(
      (targets) =>
        new Set(targets.map((target) => `${target.sessionId}/${target.turnId}`))
          .size === targets.length,
      "Duplicate turn target",
    ),
  ),
  completion: v.picklist(["any", "all"]),
  timeoutMs: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
});
export type WaitParams = v.InferOutput<typeof waitParamsSchema>;

export const harnessFailureSchema = v.strictObject({
  failureCategory: v.picklist([
    "credential_rejected",
    "quota_exhausted",
    "balance_exhausted",
    "account_unavailable",
    "rate_limited",
    "model_unavailable",
    "request_rejected",
    "provider_unavailable",
    "runtime_unavailable",
    "unclassified",
  ]),
  retryDisposition: v.picklist([
    "wait",
    "external_state_change",
    "input_change",
    "unknown",
  ]),
});
export type HarnessFailure = v.InferOutput<typeof harnessFailureSchema>;
export const UNKNOWN_HARNESS_FAILURE: HarnessFailure = {
  failureCategory: "unclassified",
  retryDisposition: "unknown",
};

const turnCompletedFields = {
  sessionId: sessionIdSchema,
  turnId: turnIdSchema,
  finalReply: v.nullable(v.string()),
  usage: v.optional(v.record(v.string(), v.unknown())),
  diagnosticId: v.optional(diagnosticIdSchema),
};
const failedTurnCompletedSchema = v.strictObject({
  ...turnCompletedFields,
  stopReason: v.literal("failed"),
  failure: harnessFailureSchema,
});
const successfulTurnCompletedSchema = v.strictObject({
  ...turnCompletedFields,
  stopReason: v.picklist(["end_turn", "cancelled", "killed"]),
});
export const turnCompletedSchema = v.variant("stopReason", [
  failedTurnCompletedSchema,
  successfulTurnCompletedSchema,
]);
export type TurnCompleted = v.InferOutput<typeof turnCompletedSchema>;

export const waitResultSchema = v.strictObject({
  status: v.picklist(["satisfied", "timeout"]),
  completed: v.array(turnCompletedSchema),
  pending: v.array(turnTargetSchema),
});
export type WaitResult = v.InferOutput<typeof waitResultSchema>;

export const interruptParamsSchema = turnTargetSchema;
export type InterruptParams = v.InferOutput<typeof interruptParamsSchema>;

export const interruptAckSchema = turnTargetSchema;
export type InterruptAck = v.InferOutput<typeof interruptAckSchema>;

export const resolvePermissionParamsSchema = v.strictObject({
  sessionId: sessionIdSchema,
  turnId: turnIdSchema,
  permissionId: permissionIdSchema,
  resolution: permissionResolutionSchema,
});
export type ResolvePermissionParams = v.InferOutput<
  typeof resolvePermissionParamsSchema
>;

export const resolvePermissionAckSchema = v.strictObject({
  sessionId: sessionIdSchema,
  turnId: turnIdSchema,
  permissionId: permissionIdSchema,
});
export type ResolvePermissionAck = v.InferOutput<
  typeof resolvePermissionAckSchema
>;

export const killParamsSchema = v.strictObject({
  sessionId: sessionIdSchema,
});
export type KillParams = v.InferOutput<typeof killParamsSchema>;

export const listFilterSchema = v.strictObject({
  sessionId: v.optional(sessionIdSchema),
  harness: v.optional(harnessIdSchema),
  state: v.optional(sessionStateSchema),
  sessionLabel: v.optional(v.string()),
  model: v.optional(v.string()),
});
export type ListFilter = v.InferOutput<typeof listFilterSchema>;

export const subscriptionTargetSchema = v.variant("scope", [
  v.strictObject({ scope: v.literal("session"), sessionId: sessionIdSchema }),
  v.strictObject({ scope: v.literal("turn"), ...turnTargetSchema.entries }),
]);
export type SubscriptionTarget = v.InferOutput<typeof subscriptionTargetSchema>;

export const resumePositionSchema = v.strictObject({
  target: subscriptionTargetSchema,
  daemonGeneration: daemonGenerationSchema,
  eventId: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
export type ResumePosition = v.InferOutput<typeof resumePositionSchema>;
export function encodeResumeCursor(position: ResumePosition): ResumeCursor {
  return v.parse(
    resumeCursorSchema,
    encodeIdentity("resume1_", resumePositionSchema, position),
  );
}
export function decodeResumeCursor(cursor: string): ResumePosition {
  return decodeIdentity("resume1_", resumePositionSchema, cursor);
}
export const resumeCursorSchema = v.pipe(
  v.string(),
  v.check((value) => {
    try {
      decodeResumeCursor(value);
      return true;
    } catch {
      return false;
    }
  }),
  v.brand("ResumeCursor"),
);
export type ResumeCursor = v.InferOutput<typeof resumeCursorSchema>;
export const replayPolicySchema = v.variant("mode", [
  v.strictObject({ mode: v.literal("none") }),
  v.strictObject({ mode: v.literal("available") }),
  v.strictObject({ mode: v.literal("after"), cursor: resumeCursorSchema }),
]);

export const attachParamsSchema = v.variant("scope", [
  v.strictObject({
    scope: v.literal("session"),
    sessionId: sessionIdSchema,
    replay: replayPolicySchema,
  }),
  v.strictObject({
    scope: v.literal("turn"),
    ...turnTargetSchema.entries,
    replay: replayPolicySchema,
  }),
]);
export type AttachParams = v.InferOutput<typeof attachParamsSchema>;
export const subscriptionIdSchema = identifier(
  "SubscriptionId",
  /^[a-z0-9-]+$/u,
);
export type SubscriptionId = v.InferOutput<typeof subscriptionIdSchema>;
export const eventIdSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
  v.brand("EventId"),
);
export type EventId = v.InferOutput<typeof eventIdSchema>;
export const eventWindowSchema = v.strictObject({
  truncated: v.boolean(),
  oldest: v.nullable(eventIdSchema),
  head: v.nullable(eventIdSchema),
});

export const killResultSchema = v.strictObject({
  sessionId: sessionIdSchema,
  status: v.union([v.literal("killed"), v.literal("not_found")]),
});
export type KillResult = v.InferOutput<typeof killResultSchema>;

const completedTurnSummarySchema = v.strictObject({
  turnId: turnIdSchema,
  stopReason: stopReasonSchema,
});
const sessionInfoFields = {
  sessionId: sessionIdSchema,
  sessionLabel: v.optional(v.string()),
  harness: harnessIdSchema,
  model: v.nullable(v.string()),
  reasoning: v.nullable(v.string()),
  cwd: v.string(),
  spawnedAt: v.string(),
  turns: v.number(),
  lastCompletedTurn: v.optional(completedTurnSummarySchema),
};
export const sessionInfoSchema = v.variant("state", [
  v.strictObject({
    ...sessionInfoFields,
    state: v.literal("busy"),
    activeTurnId: turnIdSchema,
  }),
  v.strictObject({
    ...sessionInfoFields,
    state: v.literal("idle"),
    lastCompletedTurn: completedTurnSummarySchema,
  }),
  v.strictObject({ ...sessionInfoFields, state: v.literal("killed") }),
]);
export type SessionInfo = v.InferOutput<typeof sessionInfoSchema>;

// —— 领域事件 ——

export const domainEventSchema = v.union([
  v.strictObject({
    type: v.literal("session.created"),
    sessionId: sessionIdSchema,
    harness: harnessIdSchema,
    model: v.nullable(v.string()),
    reasoning: v.nullable(v.string()),
    cwd: v.string(),
    sessionLabel: v.optional(v.string()),
    spawnedAt: v.string(),
  }),
  v.strictObject({
    type: v.literal("turn.started"),
    sessionId: sessionIdSchema,
    turnId: turnIdSchema,
  }),
  v.strictObject({
    type: v.literal("text.delta"),
    sessionId: sessionIdSchema,
    turnId: turnIdSchema,
    messageId: messageIdSchema,
    delta: v.string(),
  }),
  v.strictObject({
    type: v.literal("message"),
    sessionId: sessionIdSchema,
    turnId: turnIdSchema,
    messageId: messageIdSchema,
    role: v.union([v.literal("caller"), v.literal("worker")]),
    content: v.string(),
  }),
  v.strictObject({
    type: v.literal("tool.requested"),
    sessionId: sessionIdSchema,
    turnId: turnIdSchema,
    toolCallId: toolCallIdSchema,
    name: v.string(),
  }),
  v.strictObject({
    type: v.literal("tool.completed"),
    sessionId: sessionIdSchema,
    turnId: turnIdSchema,
    toolCallId: toolCallIdSchema,
    name: v.string(),
    result: v.nullable(v.string()),
    isError: v.boolean(),
  }),
  v.strictObject({
    type: v.literal("permission.requested"),
    sessionId: sessionIdSchema,
    turnId: turnIdSchema,
    permissionId: permissionIdSchema,
    kind: v.string(),
    input: v.optional(v.unknown()),
    options: v.array(permissionOptionSchema),
  }),
  v.strictObject({
    type: v.literal("permission.resolved"),
    sessionId: sessionIdSchema,
    turnId: turnIdSchema,
    permissionId: permissionIdSchema,
    resolution: permissionResolutionSchema,
  }),
  v.strictObject({
    type: v.literal("turn.completed"),
    ...failedTurnCompletedSchema.entries,
  }),
  v.strictObject({
    type: v.literal("turn.completed"),
    ...successfulTurnCompletedSchema.entries,
  }),
  v.strictObject({
    type: v.literal("session.killed"),
    sessionId: sessionIdSchema,
  }),
]);
export type DomainEvent = v.InferOutput<typeof domainEventSchema>;

const workerEventTypeSchema = v.picklist([
  "session.created",
  "turn.started",
  "text.delta",
  "message",
  "tool.requested",
  "tool.completed",
  "permission.requested",
  "permission.resolved",
  "turn.completed",
  "session.killed",
]);
const turnWorkerEventTypeSchema = v.picklist([
  "turn.started",
  "text.delta",
  "message",
  "tool.requested",
  "tool.completed",
  "permission.requested",
  "permission.resolved",
  "turn.completed",
]);
const activeTurnRejectionEntries = {
  sessionState: v.picklist(["spawning", "busy"]),
  eventTurnId: turnIdSchema,
  activeTurnId: turnIdSchema,
} as const;

function defineWorkerEventRejection<
  const TReason extends string,
  const TEntries extends v.ObjectEntries,
>(reason: TReason, entries: TEntries) {
  const rejectionEntries = { reason: v.literal(reason), ...entries } as const;
  return {
    reason,
    entries: rejectionEntries,
    rejection: v.strictObject(rejectionEntries),
  } as const;
}

function defineCompletedTurnWorkerEventRejection() {
  const reason = "event_after_turn_completed";
  const variants = [
    {
      reason: v.literal(reason),
      eventType: turnWorkerEventTypeSchema,
      sessionState: v.literal("idle"),
      eventTurnId: turnIdSchema,
    },
    {
      reason: v.literal(reason),
      eventType: turnWorkerEventTypeSchema,
      sessionState: v.literal("busy"),
      eventTurnId: turnIdSchema,
      activeTurnId: turnIdSchema,
    },
    {
      reason: v.literal(reason),
      eventType: turnWorkerEventTypeSchema,
      sessionState: v.literal("spawning"),
      eventTurnId: turnIdSchema,
      activeTurnId: turnIdSchema,
    },
  ] as const;
  return {
    reason,
    variants,
    rejection: v.variant("sessionState", [
      v.strictObject(variants[0]),
      v.strictObject(variants[1]),
      v.strictObject(variants[2]),
    ]),
  } as const;
}

type DefinitionFieldTuple<
  TKey extends PropertyKey,
  TDefinitions extends readonly [
    Record<TKey, unknown>,
    ...Record<TKey, unknown>[],
  ],
> = {
  -readonly [TIndex in keyof TDefinitions]: TDefinitions[TIndex][TKey];
};

function selectDefinitionField<
  const TKey extends PropertyKey,
  const TDefinitions extends readonly [
    Record<TKey, unknown>,
    ...Record<TKey, unknown>[],
  ],
>(definitions: TDefinitions, key: TKey) {
  return definitions.map(
    (definition) => definition[key],
  ) as DefinitionFieldTuple<TKey, TDefinitions>;
}

const workerEventRejectionDefinitions = [
  defineWorkerEventRejection("unknown_session", {
    eventType: workerEventTypeSchema,
    sessionState: v.literal("unknown"),
    eventTurnId: v.optional(turnIdSchema),
  }),
  defineWorkerEventRejection("session_killed", {
    eventType: workerEventTypeSchema,
    sessionState: v.literal("killed"),
    eventTurnId: v.optional(turnIdSchema),
  }),
  defineWorkerEventRejection("driver_event_forbidden", {
    eventType: v.picklist([
      "session.created",
      "turn.started",
      "session.killed",
    ]),
    sessionState: v.picklist(["spawning", "busy", "idle"]),
  }),
  defineWorkerEventRejection("turn_not_active", {
    eventType: turnWorkerEventTypeSchema,
    sessionState: v.literal("idle"),
    eventTurnId: turnIdSchema,
  }),
  defineWorkerEventRejection("turn_mismatch", {
    eventType: turnWorkerEventTypeSchema,
    ...activeTurnRejectionEntries,
  }),
  defineCompletedTurnWorkerEventRejection(),
  defineWorkerEventRejection("message_already_completed", {
    eventType: v.picklist(["text.delta", "message"]),
    ...activeTurnRejectionEntries,
    messageId: messageIdSchema,
  }),
  defineWorkerEventRejection("tool_already_requested", {
    eventType: v.literal("tool.requested"),
    ...activeTurnRejectionEntries,
    toolCallId: toolCallIdSchema,
  }),
  defineWorkerEventRejection("tool_already_completed", {
    eventType: v.literal("tool.completed"),
    ...activeTurnRejectionEntries,
    toolCallId: toolCallIdSchema,
  }),
  defineWorkerEventRejection("permission_id_reused", {
    eventType: v.literal("permission.requested"),
    ...activeTurnRejectionEntries,
    permissionId: permissionIdSchema,
  }),
  defineWorkerEventRejection("permission_not_pending", {
    eventType: v.literal("permission.resolved"),
    ...activeTurnRejectionEntries,
    permissionId: permissionIdSchema,
  }),
  defineWorkerEventRejection("permission_turn_mismatch", {
    eventType: v.literal("permission.resolved"),
    ...activeTurnRejectionEntries,
    permissionId: permissionIdSchema,
  }),
] as const;

export const WORKER_EVENT_REJECTION_REASONS = Object.freeze(
  selectDefinitionField(workerEventRejectionDefinitions, "reason"),
);

export const workerEventRejectionSchema = v.variant(
  "reason",
  selectDefinitionField(workerEventRejectionDefinitions, "rejection"),
);
export type WorkerEventRejection = v.InferOutput<
  typeof workerEventRejectionSchema
>;

// —— 诊断（存储 envelope 与 producer input） ——

export const DIAGNOSTIC_SOURCES = [
  "daemon",
  "core",
  "adapter",
  "harness",
] as const;
export const diagnosticSourceSchema = v.picklist(DIAGNOSTIC_SOURCES);
export type DiagnosticSource = v.InferOutput<typeof diagnosticSourceSchema>;
export const DIAGNOSTIC_SEVERITIES = [
  "debug",
  "info",
  "warning",
  "error",
] as const;
export const diagnosticSeveritySchema = v.picklist(DIAGNOSTIC_SEVERITIES);
export type DiagnosticSeverity = v.InferOutput<typeof diagnosticSeveritySchema>;
export const DIAGNOSTIC_KINDS = [
  "lifecycle",
  "mapping_gap",
  "compatibility_gap",
  "request_failure",
  "stream_failure",
  "turn_failure",
  "authorization_failure",
  "protocol_violation",
  "transport_failure",
  "storage_failure",
  "harness_stderr",
] as const;
export const diagnosticKindSchema = v.picklist(DIAGNOSTIC_KINDS);
export type DiagnosticKind = v.InferOutput<typeof diagnosticKindSchema>;
export const utcMillisecondTimestampSchema = v.pipe(
  v.string(),
  v.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  v.isoTimestamp(),
);
export const textEvidenceSchema = v.pipe(
  v.strictObject({
    text: v.pipe(v.string(), v.maxBytes(64 * 1024)),
    truncated: v.boolean(),
    originalBytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
  }),
  v.check((value) => {
    const textBytes = new TextEncoder().encode(value.text).length;
    return value.truncated
      ? value.originalBytes > textBytes
      : value.originalBytes === textBytes;
  }),
);
export type TextEvidence = v.InferOutput<typeof textEvidenceSchema>;

const harnessSchema = harnessIdSchema;
const optionalEvidenceEntries = {
  message: v.optional(textEvidenceSchema),
  stack: v.optional(textEvidenceSchema),
} as const;

function recordEnvelope<const TSeverity extends DiagnosticSeverity>(
  severity: TSeverity,
) {
  return {
    v: v.literal(1),
    diagnosticId: diagnosticIdSchema,
    recordedAt: utcMillisecondTimestampSchema,
    severity: v.literal(severity),
  } as const;
}

function withControlAssociations<const TEntries extends v.ObjectEntries>(
  entries: TEntries,
) {
  return v.union([
    v.strictObject({
      source: v.picklist(["daemon", "core"]),
      harness: v.optional(harnessSchema),
      ...entries,
    }),
    v.strictObject({
      source: v.picklist(["daemon", "core"]),
      harness: v.optional(harnessSchema),
      sessionId: sessionIdSchema,
      turnId: v.optional(turnIdSchema),
      ...entries,
    }),
    v.strictObject({
      source: v.literal("adapter"),
      harness: harnessSchema,
      ...entries,
    }),
    v.strictObject({
      source: v.literal("adapter"),
      harness: harnessSchema,
      sessionId: sessionIdSchema,
      turnId: v.optional(turnIdSchema),
      ...entries,
    }),
  ]);
}

function withSessionAssociations<const TEntries extends v.ObjectEntries>(
  entries: TEntries,
) {
  return v.union([
    v.strictObject({
      source: v.picklist(["daemon", "core"]),
      harness: v.optional(harnessSchema),
      sessionId: sessionIdSchema,
      turnId: v.optional(turnIdSchema),
      ...entries,
    }),
    v.strictObject({
      source: v.literal("adapter"),
      harness: harnessSchema,
      sessionId: sessionIdSchema,
      turnId: v.optional(turnIdSchema),
      ...entries,
    }),
  ]);
}

function withAdapterAssociations<const TEntries extends v.ObjectEntries>(
  entries: TEntries,
) {
  return v.union([
    v.strictObject({
      source: v.literal("adapter"),
      harness: harnessSchema,
      ...entries,
    }),
    v.strictObject({
      source: v.literal("adapter"),
      harness: harnessSchema,
      sessionId: sessionIdSchema,
      turnId: v.optional(turnIdSchema),
      ...entries,
    }),
  ]);
}

function withAdapterSession<const TEntries extends v.ObjectEntries>(
  entries: TEntries,
) {
  return v.strictObject({
    source: v.literal("adapter"),
    harness: harnessSchema,
    sessionId: sessionIdSchema,
    turnId: v.optional(turnIdSchema),
    ...entries,
  });
}

function withDaemonAssociations<const TEntries extends v.ObjectEntries>(
  entries: TEntries,
) {
  return v.union([
    v.strictObject({
      source: v.literal("daemon"),
      harness: v.optional(harnessSchema),
      ...entries,
    }),
    v.strictObject({
      source: v.literal("daemon"),
      harness: v.optional(harnessSchema),
      sessionId: sessionIdSchema,
      turnId: v.optional(turnIdSchema),
      ...entries,
    }),
  ]);
}

function withDaemonGlobal<const TEntries extends v.ObjectEntries>(
  entries: TEntries,
) {
  return v.strictObject({ source: v.literal("daemon"), ...entries });
}

function withCoreSession<const TEntries extends v.ObjectEntries>(
  entries: TEntries,
) {
  return v.strictObject({
    source: v.literal("core"),
    sessionId: sessionIdSchema,
    turnId: v.optional(turnIdSchema),
    ...entries,
  });
}

function defineControlDiagnostic<
  const TEntries extends v.ObjectEntries,
  const TSeverity extends DiagnosticSeverity,
>(entries: TEntries, severity: TSeverity) {
  return {
    input: withControlAssociations(entries),
    record: withControlAssociations({
      ...recordEnvelope(severity),
      ...entries,
    }),
  } as const;
}

function defineDaemonGlobalDiagnostic<
  const TEntries extends v.ObjectEntries,
  const TSeverity extends DiagnosticSeverity,
>(entries: TEntries, severity: TSeverity) {
  return {
    input: withDaemonGlobal(entries),
    record: withDaemonGlobal({ ...recordEnvelope(severity), ...entries }),
  } as const;
}

function defineCoreSessionDiagnostic<
  const TEntries extends v.ObjectEntries,
  const TSeverity extends DiagnosticSeverity,
>(entries: TEntries, severity: TSeverity) {
  return {
    input: withCoreSession(entries),
    record: withCoreSession({ ...recordEnvelope(severity), ...entries }),
  } as const;
}

function defineCoreWorkerEventDiagnosticVariant<
  const TEntries extends v.ObjectEntries,
>(definition: { entries: TEntries }) {
  const inputEntries = {
    source: v.literal("core"),
    sessionId: sessionIdSchema,
    kind: v.literal("protocol_violation"),
    operation: v.literal("validate_worker_event"),
    ...definition.entries,
  } as const;
  return {
    input: v.strictObject(inputEntries),
    record: v.strictObject({
      ...recordEnvelope("error"),
      ...inputEntries,
    }),
  } as const;
}

function defineCoreCompletedTurnWorkerEventDiagnostic(
  definition: ReturnType<typeof defineCompletedTurnWorkerEventRejection>,
) {
  const variants = [
    defineCoreWorkerEventDiagnosticVariant({
      entries: definition.variants[0],
    }),
    defineCoreWorkerEventDiagnosticVariant({
      entries: definition.variants[1],
    }),
    defineCoreWorkerEventDiagnosticVariant({
      entries: definition.variants[2],
    }),
  ] as const;
  return {
    input: v.variant("sessionState", selectDefinitionField(variants, "input")),
    record: v.variant(
      "sessionState",
      selectDefinitionField(variants, "record"),
    ),
  } as const;
}

function defineCoreWorkerEventDiagnostic() {
  const variants = [
    defineCoreWorkerEventDiagnosticVariant(workerEventRejectionDefinitions[0]),
    defineCoreWorkerEventDiagnosticVariant(workerEventRejectionDefinitions[1]),
    defineCoreWorkerEventDiagnosticVariant(workerEventRejectionDefinitions[2]),
    defineCoreWorkerEventDiagnosticVariant(workerEventRejectionDefinitions[3]),
    defineCoreWorkerEventDiagnosticVariant(workerEventRejectionDefinitions[4]),
    defineCoreCompletedTurnWorkerEventDiagnostic(
      workerEventRejectionDefinitions[5],
    ),
    defineCoreWorkerEventDiagnosticVariant(workerEventRejectionDefinitions[6]),
    defineCoreWorkerEventDiagnosticVariant(workerEventRejectionDefinitions[7]),
    defineCoreWorkerEventDiagnosticVariant(workerEventRejectionDefinitions[8]),
    defineCoreWorkerEventDiagnosticVariant(workerEventRejectionDefinitions[9]),
    defineCoreWorkerEventDiagnosticVariant(workerEventRejectionDefinitions[10]),
    defineCoreWorkerEventDiagnosticVariant(workerEventRejectionDefinitions[11]),
  ] as const;
  return {
    input: v.variant("reason", selectDefinitionField(variants, "input")),
    record: v.variant("reason", selectDefinitionField(variants, "record")),
  } as const;
}

const coreWorkerEventDiagnosticDefinition = defineCoreWorkerEventDiagnostic();
type WorkerEventProtocolViolationFact = v.InferOutput<
  typeof coreWorkerEventDiagnosticDefinition.input
>;

function defineSessionDiagnostic<
  const TEntries extends v.ObjectEntries,
  const TSeverity extends DiagnosticSeverity,
>(entries: TEntries, severity: TSeverity) {
  return {
    input: withSessionAssociations(entries),
    record: withSessionAssociations({
      ...recordEnvelope(severity),
      ...entries,
    }),
  } as const;
}

function defineAdapterDiagnostic<
  const TEntries extends v.ObjectEntries,
  const TSeverity extends DiagnosticSeverity,
>(entries: TEntries, severity: TSeverity) {
  return {
    input: withAdapterAssociations(entries),
    record: withAdapterAssociations({
      ...recordEnvelope(severity),
      ...entries,
    }),
  } as const;
}

function defineAdapterSessionDiagnostic<
  const TEntries extends v.ObjectEntries,
  const TSeverity extends DiagnosticSeverity,
>(entries: TEntries, severity: TSeverity) {
  return {
    input: withAdapterSession(entries),
    record: withAdapterSession({ ...recordEnvelope(severity), ...entries }),
  } as const;
}

function defineDaemonDiagnostic<
  const TEntries extends v.ObjectEntries,
  const TSeverity extends DiagnosticSeverity,
>(entries: TEntries, severity: TSeverity) {
  return {
    input: withDaemonAssociations(entries),
    record: withDaemonAssociations({ ...recordEnvelope(severity), ...entries }),
  } as const;
}

function defineRequestFailure<
  const TOperation extends string,
  const TStage extends string,
>(operation: TOperation, stage: TStage) {
  const common = {
    kind: v.literal("request_failure"),
    operation: v.literal(operation),
    stage: v.literal(stage),
    message: textEvidenceSchema,
    stack: v.optional(textEvidenceSchema),
  } as const;
  const upstream = defineControlDiagnostic(
    { ...common, reason: v.literal("upstream_error") },
    "error",
  );
  const timeout = defineControlDiagnostic(
    { ...common, reason: v.literal("timeout") },
    "error",
  );
  const closed = defineControlDiagnostic(
    { ...common, reason: v.literal("closed") },
    "error",
  );
  const rejected = defineControlDiagnostic(
    { ...common, reason: v.literal("rejected") },
    "error",
  );
  return {
    input: v.union([
      upstream.input,
      timeout.input,
      closed.input,
      rejected.input,
    ]),
    record: v.union([
      upstream.record,
      timeout.record,
      closed.record,
      rejected.record,
    ]),
  } as const;
}

const diagnosticDefinitions = [
  defineDaemonGlobalDiagnostic(
    {
      kind: v.literal("lifecycle"),
      operation: v.literal("daemon"),
      reason: v.literal("started"),
    },
    "info",
  ),
  defineDaemonGlobalDiagnostic(
    {
      kind: v.literal("lifecycle"),
      operation: v.literal("daemon"),
      reason: v.literal("stopped"),
    },
    "info",
  ),
  defineDaemonGlobalDiagnostic(
    {
      kind: v.literal("lifecycle"),
      operation: v.literal("daemon"),
      reason: v.literal("idle_exit"),
    },
    "info",
  ),
  defineDaemonGlobalDiagnostic(
    {
      kind: v.literal("lifecycle"),
      operation: v.literal("daemon"),
      reason: v.literal("crashed"),
      ...optionalEvidenceEntries,
    },
    "error",
  ),
  defineAdapterSessionDiagnostic(
    {
      kind: v.literal("lifecycle"),
      operation: v.literal("worker"),
      reason: v.literal("initialized"),
    },
    "info",
  ),
  defineAdapterSessionDiagnostic(
    {
      kind: v.literal("lifecycle"),
      operation: v.literal("worker"),
      reason: v.literal("closed"),
    },
    "info",
  ),
  defineAdapterSessionDiagnostic(
    {
      kind: v.literal("lifecycle"),
      operation: v.literal("worker"),
      reason: v.literal("exited_unexpectedly"),
      ...optionalEvidenceEntries,
    },
    "error",
  ),
  defineDaemonGlobalDiagnostic(
    {
      kind: v.literal("lifecycle"),
      operation: v.literal("diagnostics_store"),
      reason: v.literal("initialized"),
    },
    "info",
  ),
  defineDaemonGlobalDiagnostic(
    {
      kind: v.literal("lifecycle"),
      operation: v.literal("diagnostics_store"),
      reason: v.literal("closed"),
    },
    "info",
  ),
  defineDaemonGlobalDiagnostic(
    {
      kind: v.literal("lifecycle"),
      operation: v.literal("diagnostics_store"),
      reason: v.literal("invariant_failed"),
      ...optionalEvidenceEntries,
    },
    "error",
  ),
  defineCoreSessionDiagnostic(
    {
      kind: v.literal("lifecycle"),
      operation: v.literal("event_delivery"),
      reason: v.literal("listener_failed"),
      ...optionalEvidenceEntries,
    },
    "error",
  ),
  defineAdapterDiagnostic(
    {
      kind: v.literal("mapping_gap"),
      operation: v.literal("spawn"),
      reason: v.literal("unsupported_input"),
      fields: v.tupleWithRest(
        [v.picklist(["agent", "reasoning", "sandbox"])],
        v.picklist(["agent", "reasoning", "sandbox"]),
      ),
    },
    "warning",
  ),
  defineAdapterDiagnostic(
    {
      kind: v.literal("mapping_gap"),
      operation: v.literal("resolve_permission"),
      reason: v.literal("unsupported_input"),
      fields: v.tupleWithRest(
        [v.picklist(["feedback", "resolution"])],
        v.picklist(["feedback", "resolution"]),
      ),
    },
    "warning",
  ),
  defineAdapterDiagnostic(
    {
      kind: v.literal("compatibility_gap"),
      operation: v.literal("receive_worker_request"),
      reason: v.literal("unsupported_request"),
      message: v.optional(textEvidenceSchema),
    },
    "warning",
  ),
  defineRequestFailure("spawn", "start_session"),
  defineRequestFailure("spawn", "start_turn"),
  defineRequestFailure("send", "deliver"),
  defineRequestFailure("send", "steer"),
  defineRequestFailure("interrupt", "interrupt"),
  defineRequestFailure("kill", "terminate"),
  defineRequestFailure("resolve_permission", "resolve"),
  defineRequestFailure("model_catalog", "query"),
  defineRequestFailure("spawn", "dispatch"),
  defineRequestFailure("send", "dispatch"),
  defineRequestFailure("wait", "dispatch"),
  defineRequestFailure("interrupt", "dispatch"),
  defineRequestFailure("kill", "dispatch"),
  defineRequestFailure("list", "dispatch"),
  defineRequestFailure("attach", "dispatch"),
  defineRequestFailure("diagnostics", "dispatch"),
  defineRequestFailure("resolve_permission", "dispatch"),
  defineRequestFailure("model_catalog", "dispatch"),
  defineAdapterSessionDiagnostic(
    {
      kind: v.literal("stream_failure"),
      operation: v.literal("receive_worker_stream"),
      reason: v.literal("read_error"),
      message: textEvidenceSchema,
    },
    "error",
  ),
  defineAdapterSessionDiagnostic(
    {
      kind: v.literal("stream_failure"),
      operation: v.literal("receive_worker_stream"),
      reason: v.literal("closed_unexpectedly"),
      message: textEvidenceSchema,
    },
    "error",
  ),
  defineAdapterSessionDiagnostic(
    {
      kind: v.literal("turn_failure"),
      operation: v.literal("run_turn"),
      reason: v.literal("worker_reported_failure"),
      message: textEvidenceSchema,
    },
    "error",
  ),
  defineSessionDiagnostic(
    {
      kind: v.literal("authorization_failure"),
      operation: v.literal("resolve_permission"),
      stage: v.literal("lookup"),
      reason: v.literal("target_lost"),
      permissionId: permissionIdSchema,
    },
    "error",
  ),
  defineSessionDiagnostic(
    {
      kind: v.literal("authorization_failure"),
      operation: v.literal("resolve_permission"),
      stage: v.literal("deliver"),
      reason: v.literal("upstream_rejected"),
      permissionId: permissionIdSchema,
    },
    "error",
  ),
  defineControlDiagnostic(
    {
      kind: v.literal("protocol_violation"),
      operation: v.literal("decode_worker_message"),
      reason: v.literal("invalid_json"),
      message: v.optional(textEvidenceSchema),
    },
    "error",
  ),
  defineControlDiagnostic(
    {
      kind: v.literal("protocol_violation"),
      operation: v.literal("decode_worker_message"),
      reason: v.literal("invalid_shape"),
      message: v.optional(textEvidenceSchema),
    },
    "error",
  ),
  defineControlDiagnostic(
    {
      kind: v.literal("protocol_violation"),
      operation: v.literal("decode_worker_message"),
      reason: v.literal("unexpected_message"),
      message: v.optional(textEvidenceSchema),
    },
    "error",
  ),
  defineAdapterDiagnostic(
    {
      kind: v.literal("protocol_violation"),
      operation: v.literal("validate_worker_response"),
      reason: v.literal("invalid_shape"),
      message: v.optional(textEvidenceSchema),
    },
    "error",
  ),
  defineAdapterDiagnostic(
    {
      kind: v.literal("protocol_violation"),
      operation: v.literal("validate_worker_response"),
      reason: v.literal("unexpected_message"),
      message: v.optional(textEvidenceSchema),
    },
    "error",
  ),
  defineAdapterDiagnostic(
    {
      kind: v.literal("protocol_violation"),
      operation: v.literal("validate_worker_event"),
      reason: v.literal("invalid_shape"),
      message: v.optional(textEvidenceSchema),
    },
    "error",
  ),
  defineAdapterDiagnostic(
    {
      kind: v.literal("protocol_violation"),
      operation: v.literal("validate_worker_event"),
      reason: v.literal("unexpected_message"),
      message: v.optional(textEvidenceSchema),
    },
    "error",
  ),
  coreWorkerEventDiagnosticDefinition,
  defineControlDiagnostic(
    {
      kind: v.literal("protocol_violation"),
      operation: v.literal("validate_daemon_result"),
      reason: v.literal("invalid_shape"),
      message: v.optional(textEvidenceSchema),
    },
    "error",
  ),
  defineControlDiagnostic(
    {
      kind: v.literal("protocol_violation"),
      operation: v.literal("emit_domain_event"),
      reason: v.literal("invalid_shape"),
      message: v.optional(textEvidenceSchema),
    },
    "error",
  ),
  defineDaemonGlobalDiagnostic(
    {
      kind: v.literal("protocol_violation"),
      operation: v.literal("validate_daemon_request"),
      stage: v.literal("envelope"),
      reason: v.literal("invalid_shape"),
    },
    "error",
  ),
] as const;

function defineTransportFailure<const TEntries extends v.ObjectEntries>(
  entries: TEntries,
) {
  return {
    fact: v.strictObject(entries),
    ...defineDaemonDiagnostic(entries, "error"),
  } as const;
}

function defineTransportFailurePair<
  const TOperation extends string,
  const TReason extends string,
>(operation: TOperation, reason: TReason) {
  return defineTransportFailure({
    kind: v.literal("transport_failure"),
    operation: v.literal(operation),
    reason: v.literal(reason),
  });
}

const transportFailureDefinitions = [
  defineTransportFailure({
    kind: v.literal("transport_failure"),
    operation: v.literal("read"),
    reason: v.literal("invalid_frame"),
    inputBytes: v.pipe(
      v.number(),
      v.integer(),
      v.minValue(0),
      v.maxValue(Number.MAX_SAFE_INTEGER),
    ),
  }),
  defineTransportFailurePair("listen", "io_error"),
  defineTransportFailurePair("connect", "io_error"),
  defineTransportFailurePair("connect", "timeout"),
  defineTransportFailurePair("connection", "io_error"),
  defineTransportFailurePair("read", "io_error"),
  defineTransportFailurePair("read", "timeout"),
  defineTransportFailurePair("read", "disconnected"),
  defineTransportFailurePair("write", "io_error"),
  defineTransportFailurePair("write", "timeout"),
  defineTransportFailurePair("write", "disconnected"),
  defineTransportFailurePair("close", "io_error"),
  defineTransportFailurePair("close", "timeout"),
  defineTransportFailurePair("close", "disconnected"),
] as const;

export const transportFailureFactSchema = v.union(
  selectDefinitionField(transportFailureDefinitions, "fact"),
);
type ParsedTransportFailureFact = v.InferOutput<
  typeof transportFailureFactSchema
>;
export type TransportFailureFact =
  ParsedTransportFailureFact extends infer TFact
    ? TFact extends object
      ? Readonly<TFact>
      : never
    : never;

export function parseTransportFailureFact(
  input: unknown,
): TransportFailureFact {
  const parsed = v.safeParse(transportFailureFactSchema, input);
  if (!parsed.success) {
    throw new TypeError("Invalid transport failure fact");
  }
  return Object.freeze({ ...parsed.output });
}

function defineStorageFailure<
  const TOperation extends string,
  const TReason extends string,
>(operation: TOperation, reason: TReason) {
  return defineDaemonDiagnostic(
    {
      kind: v.literal("storage_failure"),
      operation: v.literal(operation),
      reason: v.literal(reason),
      message: textEvidenceSchema,
    },
    "error",
  );
}

const remainingDiagnosticDefinitions = [
  ...transportFailureDefinitions,
  defineStorageFailure("initialize", "unavailable"),
  defineStorageFailure("initialize", "io_error"),
  defineStorageFailure("initialize", "corrupt"),
  defineStorageFailure("initialize", "invalid_configuration"),
  defineStorageFailure("append", "unavailable"),
  defineStorageFailure("append", "io_error"),
  defineStorageFailure("query", "unavailable"),
  defineStorageFailure("query", "io_error"),
  defineStorageFailure("query", "corrupt"),
  defineStorageFailure("rotate", "unavailable"),
  defineStorageFailure("rotate", "io_error"),
  defineStorageFailure("recover", "io_error"),
  defineStorageFailure("recover", "corrupt"),
  defineDaemonDiagnostic(
    {
      kind: v.literal("storage_failure"),
      operation: v.literal("recover"),
      reason: v.literal("tail_repaired"),
      affectedBytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
    },
    "warning",
  ),
  defineStorageFailure("lock", "io_error"),
  defineStorageFailure("lock", "lock_unavailable"),
  defineStorageFailure("close", "io_error"),
  defineStorageFailure("allocate_generation", "io_error"),
  defineStorageFailure("allocate_generation", "corrupt"),
  {
    input: v.strictObject({
      source: v.literal("harness"),
      harness: harnessSchema,
      sessionId: sessionIdSchema,
      turnId: v.optional(turnIdSchema),
      kind: v.literal("harness_stderr"),
      operation: v.literal("worker_process"),
      reason: v.literal("stderr_output"),
      text: v.pipe(
        textEvidenceSchema,
        v.check(
          (value) => new TextEncoder().encode(value.text).length <= 16 * 1024,
        ),
      ),
    }),
    record: v.strictObject({
      source: v.literal("harness"),
      harness: harnessSchema,
      sessionId: sessionIdSchema,
      turnId: v.optional(turnIdSchema),
      ...recordEnvelope("info"),
      kind: v.literal("harness_stderr"),
      operation: v.literal("worker_process"),
      reason: v.literal("stderr_output"),
      text: v.pipe(
        textEvidenceSchema,
        v.check(
          (value) => new TextEncoder().encode(value.text).length <= 16 * 1024,
        ),
      ),
    }),
  },
] as const;

const allDiagnosticDefinitions = [
  ...diagnosticDefinitions,
  ...remainingDiagnosticDefinitions,
] as const;
type DiagnosticDefinition = (typeof allDiagnosticDefinitions)[number];
type DiagnosticInputSchema = DiagnosticDefinition["input"];
type DiagnosticRecordSchema = DiagnosticDefinition["record"];

type UnscopedControlAssociation =
  | {
      source: "daemon" | "core";
      harness?: string | undefined;
      sessionId?: never;
      turnId?: never;
    }
  | {
      source: "adapter";
      harness: string;
      sessionId?: never;
      turnId?: never;
    };
type ScopedControlAssociation =
  | {
      source: "daemon" | "core";
      harness?: string | undefined;
      sessionId: SessionId;
      turnId?: TurnId | undefined;
    }
  | {
      source: "adapter";
      harness: string;
      sessionId: SessionId;
      turnId?: TurnId | undefined;
    };
type ControlAssociation = UnscopedControlAssociation | ScopedControlAssociation;
type AdapterAssociation =
  | {
      source: "adapter";
      harness: string;
      sessionId?: never;
      turnId?: never;
    }
  | {
      source: "adapter";
      harness: string;
      sessionId: SessionId;
      turnId?: TurnId | undefined;
    };
type AdapterSessionAssociation = Extract<
  AdapterAssociation,
  { sessionId: SessionId }
>;
type DaemonAssociation =
  | {
      source: "daemon";
      harness?: string | undefined;
      sessionId?: never;
      turnId?: never;
    }
  | {
      source: "daemon";
      harness?: string | undefined;
      sessionId: SessionId;
      turnId?: TurnId | undefined;
    };

type LifecycleInput =
  | {
      source: "daemon";
      kind: "lifecycle";
      operation: "daemon";
      reason: "started" | "stopped" | "idle_exit";
    }
  | {
      source: "daemon";
      kind: "lifecycle";
      operation: "daemon";
      reason: "crashed";
      message?: TextEvidence | undefined;
      stack?: TextEvidence | undefined;
    }
  | {
      source: "adapter";
      harness: string;
      sessionId: SessionId;
      turnId?: TurnId | undefined;
      kind: "lifecycle";
      operation: "worker";
      reason: "initialized" | "closed";
    }
  | {
      source: "adapter";
      harness: string;
      sessionId: SessionId;
      turnId?: TurnId | undefined;
      kind: "lifecycle";
      operation: "worker";
      reason: "exited_unexpectedly";
      message?: TextEvidence | undefined;
      stack?: TextEvidence | undefined;
    }
  | {
      source: "core";
      sessionId: SessionId;
      turnId?: TurnId | undefined;
      kind: "lifecycle";
      operation: "event_delivery";
      reason: "listener_failed";
      message?: TextEvidence | undefined;
      stack?: TextEvidence | undefined;
    };
type StoreLifecycleInput =
  | {
      source: "daemon";
      kind: "lifecycle";
      operation: "diagnostics_store";
      reason: "initialized" | "closed";
    }
  | {
      source: "daemon";
      kind: "lifecycle";
      operation: "diagnostics_store";
      reason: "invariant_failed";
      message?: TextEvidence | undefined;
      stack?: TextEvidence | undefined;
    };
type MappingGapFact =
  | {
      kind: "mapping_gap";
      operation: "spawn";
      reason: "unsupported_input";
      fields: [
        "agent" | "reasoning" | "sandbox",
        ...("agent" | "reasoning" | "sandbox")[],
      ];
    }
  | {
      kind: "mapping_gap";
      operation: "resolve_permission";
      reason: "unsupported_input";
      fields: ["feedback" | "resolution", ...("feedback" | "resolution")[]];
    };
type CompatibilityGapFact = {
  kind: "compatibility_gap";
  operation: "receive_worker_request";
  reason: "unsupported_request";
  message?: TextEvidence | undefined;
};
type RequestPair =
  | { operation: "spawn"; stage: "start_session" | "start_turn" | "dispatch" }
  | { operation: "send"; stage: "deliver" | "steer" | "dispatch" }
  | { operation: "wait"; stage: "dispatch" }
  | { operation: "interrupt"; stage: "interrupt" | "dispatch" }
  | { operation: "kill"; stage: "terminate" | "dispatch" }
  | { operation: "list"; stage: "dispatch" }
  | { operation: "attach"; stage: "dispatch" }
  | { operation: "diagnostics"; stage: "dispatch" }
  | { operation: "resolve_permission"; stage: "resolve" | "dispatch" }
  | { operation: "model_catalog"; stage: "query" | "dispatch" };
type RequestFailureFact = RequestPair & {
  kind: "request_failure";
  reason: "upstream_error" | "timeout" | "closed" | "rejected";
  message: TextEvidence;
  stack?: TextEvidence | undefined;
};
type StreamFailureFact = {
  kind: "stream_failure";
  operation: "receive_worker_stream";
  reason: "read_error" | "closed_unexpectedly";
  message: TextEvidence;
};
type TurnFailureFact = {
  kind: "turn_failure";
  operation: "run_turn";
  reason: "worker_reported_failure";
  message: TextEvidence;
};
type AuthorizationFailureFact =
  | {
      kind: "authorization_failure";
      operation: "resolve_permission";
      stage: "lookup";
      reason: "target_lost";
      permissionId: PermissionId;
    }
  | {
      kind: "authorization_failure";
      operation: "resolve_permission";
      stage: "deliver";
      reason: "upstream_rejected";
      permissionId: PermissionId;
    };
type ProtocolViolationPair =
  | {
      operation: "decode_worker_message";
      reason: "invalid_json" | "invalid_shape" | "unexpected_message";
    }
  | {
      operation: "validate_daemon_result" | "emit_domain_event";
      reason: "invalid_shape";
    };
type ProtocolViolationFact = ProtocolViolationPair & {
  kind: "protocol_violation";
  message?: TextEvidence | undefined;
};
type WorkerShapeProtocolViolationFact = {
  kind: "protocol_violation";
  operation: "validate_worker_event" | "validate_worker_response";
  reason: "invalid_shape" | "unexpected_message";
  message?: TextEvidence | undefined;
};
type DaemonRequestProtocolViolationFact = {
  kind: "protocol_violation";
  operation: "validate_daemon_request";
  stage: "envelope";
  reason: "invalid_shape";
};
type StorageFailurePair =
  | {
      operation: "initialize";
      reason: "unavailable" | "io_error" | "corrupt" | "invalid_configuration";
    }
  | { operation: "append" | "rotate"; reason: "unavailable" | "io_error" }
  | { operation: "query"; reason: "unavailable" | "io_error" | "corrupt" }
  | { operation: "recover"; reason: "io_error" | "corrupt" }
  | { operation: "lock"; reason: "io_error" | "lock_unavailable" }
  | { operation: "close"; reason: "io_error" }
  | { operation: "allocate_generation"; reason: "io_error" | "corrupt" };
type StorageFailureFact = StorageFailurePair & {
  kind: "storage_failure";
  message: TextEvidence;
};
type TailRepairedFact = {
  kind: "storage_failure";
  operation: "recover";
  reason: "tail_repaired";
  affectedBytes: number;
};
type HarnessStderrFact = {
  source: "harness";
  harness: string;
  sessionId: SessionId;
  turnId?: TurnId | undefined;
  kind: "harness_stderr";
  operation: "worker_process";
  reason: "stderr_output";
  text: TextEvidence;
};

export type DiagnosticInput =
  | LifecycleInput
  | StoreLifecycleInput
  | (AdapterAssociation & MappingGapFact)
  | (AdapterAssociation & CompatibilityGapFact)
  | (ControlAssociation & RequestFailureFact)
  | (AdapterSessionAssociation & StreamFailureFact)
  | (AdapterSessionAssociation & TurnFailureFact)
  | (ScopedControlAssociation & AuthorizationFailureFact)
  | (ControlAssociation & ProtocolViolationFact)
  | (AdapterAssociation & WorkerShapeProtocolViolationFact)
  | ({ source: "daemon" } & DaemonRequestProtocolViolationFact)
  | WorkerEventProtocolViolationFact
  | (DaemonAssociation & TransportFailureFact)
  | (DaemonAssociation & (StorageFailureFact | TailRepairedFact))
  | HarnessStderrFact;

type WithoutDiagnosticAuthority<TInput> = TInput extends {
  source: DiagnosticSource;
}
  ? Omit<TInput, "source" | "harness">
  : never;
type WithoutDiagnosticSource<TInput> = TInput extends {
  source: DiagnosticSource;
}
  ? Omit<TInput, "source">
  : never;
type DiagnosticInputsForSource<TSource extends DiagnosticSource> =
  DiagnosticInput extends infer TInput
    ? TInput extends { source: infer TAllowedSource }
      ? TSource extends TAllowedSource
        ? TInput
        : never
      : never
    : never;

// Producer 只描述自己有权产生的事实；source 与 harness 由 daemon 注册表绑定。
export type AdapterDiagnosticFact = WithoutDiagnosticAuthority<
  DiagnosticInputsForSource<"adapter">
>;
export type HarnessDiagnosticFact = WithoutDiagnosticAuthority<
  DiagnosticInputsForSource<"harness">
>;
export type DriverDiagnosticFact =
  | AdapterDiagnosticFact
  | HarnessDiagnosticFact;
export type CoreDiagnosticFact = WithoutDiagnosticSource<
  DiagnosticInputsForSource<"core">
>;
export type DaemonDiagnosticFact = WithoutDiagnosticSource<
  DiagnosticInputsForSource<"daemon">
>;

type DiagnosticSeverityFor<TInput extends DiagnosticInput> = TInput extends {
  kind: "mapping_gap" | "compatibility_gap";
}
  ? "warning"
  : TInput extends { kind: "storage_failure"; reason: "tail_repaired" }
    ? "warning"
    : TInput extends { kind: "harness_stderr" }
      ? "info"
      : TInput extends {
            kind: "lifecycle";
            reason:
              | "started"
              | "stopped"
              | "idle_exit"
              | "initialized"
              | "closed";
          }
        ? "info"
        : "error";
type DiagnosticRecordEnvelope<TSeverity extends DiagnosticSeverity> = {
  v: 1;
  diagnosticId: DiagnosticId;
  recordedAt: string;
  severity: TSeverity;
};
export type DiagnosticRecord = DiagnosticInput extends infer TInput
  ? TInput extends DiagnosticInput
    ? TInput & DiagnosticRecordEnvelope<DiagnosticSeverityFor<TInput>>
    : never
  : never;

const diagnosticInputVariants = allDiagnosticDefinitions.map(
  (definition) => definition.input,
) as [DiagnosticInputSchema, ...DiagnosticInputSchema[]];
const diagnosticRecordVariants = allDiagnosticDefinitions.map(
  (definition) => definition.record,
) as [DiagnosticRecordSchema, ...DiagnosticRecordSchema[]];

export const diagnosticInputSchema: v.GenericSchema<unknown, DiagnosticInput> =
  v.union(diagnosticInputVariants);
export const diagnosticRecordSchema: v.GenericSchema<
  unknown,
  DiagnosticRecord
> = v.union(diagnosticRecordVariants);

type DiagnosticFilterFields = {
  harness?: string | undefined;
  sources?: DiagnosticSource[] | undefined;
  kinds?: DiagnosticKind[] | undefined;
  minSeverity?: DiagnosticSeverity | undefined;
  since?: string | undefined;
  until?: string | undefined;
  limit?: number | undefined;
};
export type DiagnosticsParams =
  | { diagnosticId: DiagnosticId }
  | (DiagnosticFilterFields & {
      sessionId?: SessionId | undefined;
      turnId?: undefined;
    })
  | (DiagnosticFilterFields & {
      sessionId: SessionId;
      turnId: TurnId;
    });

const diagnosticFilterEntries = {
  harness: v.optional(harnessIdSchema),
  sources: v.optional(v.array(diagnosticSourceSchema)),
  kinds: v.optional(v.array(diagnosticKindSchema)),
  minSeverity: v.optional(diagnosticSeveritySchema),
  since: v.optional(utcMillisecondTimestampSchema),
  until: v.optional(utcMillisecondTimestampSchema),
  limit: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000)),
  ),
} as const;

export const diagnosticsParamsSchema: v.GenericSchema<
  unknown,
  DiagnosticsParams
> = v.pipe(
  v.union([
    v.strictObject({ diagnosticId: diagnosticIdSchema }),
    v.strictObject({
      sessionId: v.optional(sessionIdSchema),
      turnId: v.optional(v.never()),
      ...diagnosticFilterEntries,
    }),
    v.strictObject({
      sessionId: sessionIdSchema,
      turnId: turnIdSchema,
      ...diagnosticFilterEntries,
    }),
  ]),
  v.check(
    (query) =>
      !("since" in query) ||
      !("until" in query) ||
      query.since === undefined ||
      query.until === undefined ||
      Date.parse(query.since) <= Date.parse(query.until),
  ),
);
export const diagnosticsResultSchema = v.union([
  v.strictObject({ record: diagnosticRecordSchema }),
  v.strictObject({
    records: v.array(diagnosticRecordSchema),
    truncated: v.boolean(),
  }),
]);
export type DiagnosticsResult = v.InferOutput<typeof diagnosticsResultSchema>;

// —— 错误码与机器错误（程序化契约；用户文案由调用方映射） ——

export const errorCodeSchema = v.union([
  v.literal("session_busy"),
  v.literal("turn_not_active"),
  v.literal("session_not_found"),
  v.literal("session_killed"),
  v.literal("session_terminating"),
  v.literal("daemon_shutting_down"),
  v.literal("workspace_detaching"),
  v.literal("native_view_lost"),
  v.literal("invalid_params"),
  v.literal("permission_not_pending"),
  v.literal("permission_resolution_mismatch"),
  v.literal("unknown_harness"),
  v.literal("method_not_found"),
  v.literal("protocol_error"),
  v.literal("model_catalog_query_failed"),
  v.literal("internal_error"),
  v.literal("unsupported_feature"),
  v.literal("diagnostic_not_found"),
  v.literal("diagnostics_unavailable"),
  v.literal("diagnostics_store_corrupt"),
  v.literal("protocol_version_mismatch"),
  v.literal("runtime_scope_mismatch"),
  v.literal("consumer_context_required"),
  v.literal("command_id_conflict"),
  v.literal("stale_command_id"),
  v.literal("daemon_timeout"),
  v.literal("invalid_daemon_response"),
  v.literal("daemon_start_failed"),
  v.literal("daemon_disconnected"),
  v.literal("event_cursor_expired"),
]);
export type ErrorCode = v.InferOutput<typeof errorCodeSchema>;

export const errorCauseSchema = v.strictObject({
  kind: v.picklist(["exception", "upstream", "io", "timeout", "closed"]),
  message: v.pipe(v.string(), v.maxBytes(4 * 1024)),
});
export type ErrorCause = v.InferOutput<typeof errorCauseSchema>;

// 统一在协议生产边界按 UTF-8 字节数截断，避免各调用方各自截断并切断多字节字符。
export function makeErrorCause(
  kind: ErrorCause["kind"],
  message: string,
): ErrorCause {
  let bytes = 0;
  let truncated = "";
  for (const character of message) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > 4 * 1024) break;
    truncated += character;
    bytes += characterBytes;
  }
  return v.parse(errorCauseSchema, { kind, message: truncated });
}

export function makeTextEvidence(message: string): TextEvidence {
  const originalBytes = Buffer.byteLength(message, "utf8");
  let bytes = 0;
  let text = "";
  for (const character of message) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > 64 * 1024) break;
    text += character;
    bytes += characterBytes;
  }
  return v.parse(textEvidenceSchema, {
    text,
    truncated: bytes < originalBytes,
    originalBytes,
  });
}
export const invalidParamIssueSchema = v.union([
  v.strictObject({
    issue: v.literal("missing_required"),
    path: v.string(),
  }),
  v.strictObject({
    issue: v.literal("invalid_type"),
    path: v.string(),
    expected: v.picklist(["string", "number", "boolean", "array", "object"]),
  }),
  v.strictObject({
    issue: v.literal("invalid_value"),
    path: v.string(),
  }),
  v.strictObject({
    issue: v.literal("invalid_combination"),
    paths: v.tupleWithRest([v.string()], v.string()),
  }),
]);
export type InvalidParamIssue = v.InferOutput<typeof invalidParamIssueSchema>;

type UnexpectedErrorCode =
  | "model_catalog_query_failed"
  | "internal_error"
  | "diagnostics_store_corrupt";
const unexpectedError = <const TCode extends UnexpectedErrorCode>(
  code: TCode,
) =>
  v.strictObject({
    code: v.literal(code),
    cause: v.optional(errorCauseSchema),
    diagnosticId: v.optional(diagnosticIdSchema),
  });
export const nativeViewLossSchema = v.variant("reason", [
  v.strictObject({
    reason: v.literal("moved"),
    currentRoot: v.string(),
  }),
  v.strictObject({ reason: v.literal("replaced") }),
  v.strictObject({ reason: v.literal("removed") }),
  v.strictObject({ reason: v.literal("split") }),
  v.strictObject({ reason: v.literal("unreachable") }),
]);
export type NativeViewLoss = v.InferOutput<typeof nativeViewLossSchema>;
export const machineErrorSchema = v.union([
  v.strictObject({
    code: v.literal("native_view_lost"),
    detail: v.optional(v.string()),
    nativeView: nativeViewLossSchema,
  }),
  v.strictObject({
    code: v.literal("session_busy"),
    sessionId: sessionIdSchema,
  }),
  v.strictObject({
    code: v.literal("turn_not_active"),
    ...turnTargetSchema.entries,
  }),
  v.strictObject({ code: v.literal("command_id_conflict") }),
  v.strictObject({ code: v.literal("stale_command_id") }),
  v.strictObject({
    code: v.literal("session_not_found"),
    sessionId: sessionIdSchema,
  }),
  v.strictObject({
    code: v.literal("session_killed"),
    sessionId: sessionIdSchema,
  }),
  v.strictObject({
    code: v.literal("session_terminating"),
    sessionId: sessionIdSchema,
  }),
  v.strictObject({ code: v.literal("daemon_shutting_down") }),
  v.strictObject({ code: v.literal("workspace_detaching") }),
  v.strictObject({
    code: v.literal("permission_not_pending"),
    sessionId: sessionIdSchema,
    permissionId: permissionIdSchema,
  }),
  v.strictObject({
    code: v.literal("permission_resolution_mismatch"),
    sessionId: sessionIdSchema,
    permissionId: permissionIdSchema,
  }),
  v.strictObject({
    code: v.literal("diagnostic_not_found"),
    diagnosticId: diagnosticIdSchema,
  }),
  v.strictObject({
    code: v.literal("unknown_harness"),
    harness: harnessIdSchema,
    availableHarnesses: v.array(harnessIdSchema),
  }),
  v.strictObject({
    code: v.literal("method_not_found"),
    method: v.pipe(v.string(), v.minLength(1)),
  }),
  v.strictObject({
    code: v.literal("invalid_params"),
    issues: v.tupleWithRest([invalidParamIssueSchema], invalidParamIssueSchema),
  }),
  v.strictObject({ code: v.literal("protocol_error") }),
  v.strictObject({
    code: v.literal("protocol_version_mismatch"),
    requestedProtocolMajorVersion: v.pipe(v.number(), v.integer()),
    supportedProtocolMajorVersion: v.pipe(v.number(), v.integer()),
  }),
  v.strictObject({
    code: v.literal("runtime_scope_mismatch"),
    requestedRuntimeScopeId: runtimeScopeIdSchema,
    actualRuntimeScopeId: runtimeScopeIdSchema,
  }),
  v.strictObject({ code: v.literal("consumer_context_required") }),
  v.strictObject({
    code: v.literal("unsupported_feature"),
    feature: v.pipe(v.string(), v.minLength(1)),
  }),
  v.strictObject({ code: v.literal("daemon_timeout") }),
  v.strictObject({ code: v.literal("invalid_daemon_response") }),
  v.strictObject({
    code: v.literal("daemon_start_failed"),
    cause: errorCauseSchema,
  }),
  v.strictObject({
    code: v.literal("daemon_disconnected"),
    resumeCursor: v.optional(resumeCursorSchema),
  }),
  v.strictObject({
    code: v.literal("event_cursor_expired"),
    oldest: v.nullable(eventIdSchema),
    head: v.nullable(eventIdSchema),
  }),
  v.strictObject({ code: v.literal("diagnostics_unavailable") }),
  unexpectedError("model_catalog_query_failed"),
  unexpectedError("internal_error"),
  unexpectedError("diagnostics_store_corrupt"),
]);
export type MachineError = v.InferOutput<typeof machineErrorSchema>;

// —— worker driver 契约（缝 B：adapter 实现，core 调用） ——

// adapter 可携带已接受诊断的候选引用；daemon 必须查询并核对归属后才信任。
export class DriverFailure extends Error {
  readonly diagnosticId: DiagnosticId | undefined;

  constructor(message: string, diagnosticId?: DiagnosticId) {
    super(message);
    this.diagnosticId = diagnosticId;
  }
}

export function isDriverFailure(error: unknown): error is DriverFailure {
  return (
    error instanceof DriverFailure &&
    (error.diagnosticId === undefined || isDiagnosticId(error.diagnosticId))
  );
}

export type WorkerSpec = {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly harness: HarnessId;
  readonly message: string;
  readonly agent?: string;
  readonly model?: string;
  readonly reasoning?: string;
  readonly cwd: string;
  readonly authorizationMode?: AuthorizationMode;
  readonly sandbox?: string;
  readonly captureHarnessStderr?: boolean;
};

export interface WorkerDriver {
  // 启动 worker 进程/会话；worker 内容事件通过 emit 回调流入 core。
  start(spec: WorkerSpec): void;
  // 把消息交给 worker；turnId 标识它所属的回合。
  deliver(
    sessionId: SessionId,
    turnId: TurnId,
    message: string,
    placement: SendParams["placement"],
  ): Promise<void>;
  // 向 worker 发出停止当前回合的指令；worker 随后以 turn.completed(cancelled) 事件确认。
  interrupt(sessionId: SessionId, turnId: TurnId): Promise<void>;
  // 把控制面的授权决议交还 adapter，翻译为 harness 原生回答。
  resolvePermission(
    sessionId: SessionId,
    permissionId: PermissionId,
    resolution: PermissionResolution,
  ): void;
  // 终止 worker 进程；会话的 session.killed 事件由 core 发出。
  // 只有底层 worker 及其进程树已经终止后才 resolve；失败必须 reject。
  terminate(sessionId: SessionId): Promise<void>;
}

export type WorkerDriverFactory = (
  emit: (event: DomainEvent) => void,
) => WorkerDriver;

// adapter 构造只在 daemon 路由层发生；上下文只含控制面的领域事件与类型化诊断。
export type AdapterDriverFactory = (context: {
  emit: (event: DomainEvent) => void;
  diagnostics: (
    input: DriverDiagnosticFact,
  ) => Promise<DiagnosticId | undefined>;
}) => WorkerDriver;

// —— 模型目录（实时查询；default 字段不进目录） ——

export const modelCatalogEntrySchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  displayName: v.pipe(v.string(), v.minLength(1)),
  reasoningEfforts: v.array(v.pipe(v.string(), v.minLength(1))),
});
export type ModelCatalogEntry = v.InferOutput<typeof modelCatalogEntrySchema>;

export const harnessModelCatalogSchema = v.strictObject({
  harness: harnessIdSchema,
  models: v.array(modelCatalogEntrySchema),
});
export type HarnessModelCatalog = v.InferOutput<
  typeof harnessModelCatalogSchema
>;

export const modelCatalogFailureSchema = v.strictObject({
  harness: harnessIdSchema,
  code: v.literal("model_catalog_query_failed"),
  failure: harnessFailureSchema,
  diagnosticId: v.optional(diagnosticIdSchema),
});
export type ModelCatalogFailure = v.InferOutput<
  typeof modelCatalogFailureSchema
>;

export const modelCatalogResultSchema = v.strictObject({
  catalogs: v.array(harnessModelCatalogSchema),
  failures: v.array(modelCatalogFailureSchema),
});
export type ModelCatalogResult = v.InferOutput<typeof modelCatalogResultSchema>;

// —— 内部协议 envelope（typed-union，双端 valibot 校验） ——

export const protocolMethodSchema = v.union([
  v.literal("initialize"),
  v.literal("spawn"),
  v.literal("send"),
  v.literal("wait"),
  v.literal("interrupt"),
  v.literal("kill"),
  v.literal("list"),
  v.literal("attach"),
  v.literal("resolvePermission"),
  v.literal("modelCatalog"),
  v.literal("diagnostics"),
]);
export type ProtocolMethod = v.InferOutput<typeof protocolMethodSchema>;

export const protocolRequestSchema = v.strictObject({
  kind: v.literal("request"),
  requestId: requestIdSchema,
  method: protocolMethodSchema,
  commandId: v.optional(commandIdSchema),
  params: v.unknown(),
});
export type ProtocolRequest = v.InferOutput<typeof protocolRequestSchema>;

export const protocolResponseSchema = v.union([
  v.strictObject({
    kind: v.literal("response"),
    requestId: requestIdSchema,
    result: v.unknown(),
  }),
  v.strictObject({
    kind: v.literal("response"),
    requestId: requestIdSchema,
    error: machineErrorSchema,
  }),
]);
export type ProtocolResponse = v.InferOutput<typeof protocolResponseSchema>;

export const attachEndedSchema = v.strictObject({
  sessionId: sessionIdSchema,
  subscriptionId: subscriptionIdSchema,
  target: subscriptionTargetSchema,
  lastEventId: v.nullable(eventIdSchema),
  reason: v.union([
    stopReasonSchema,
    v.literal("session_killed"),
    v.literal("closed"),
  ]),
});
export type AttachEnded = v.InferOutput<typeof attachEndedSchema>;

export const protocolEventNotificationSchema = v.strictObject({
  kind: v.literal("notification"),
  method: v.literal("event"),
  params: v.strictObject({
    subscriptionId: subscriptionIdSchema,
    eventId: eventIdSchema,
    event: domainEventSchema,
  }),
});
export type ProtocolEventNotification = v.InferOutput<
  typeof protocolEventNotificationSchema
>;

export const protocolAttachEndedNotificationSchema = v.strictObject({
  kind: v.literal("notification"),
  method: v.literal("attach.ended"),
  params: attachEndedSchema,
});
export type ProtocolAttachEndedNotification = v.InferOutput<
  typeof protocolAttachEndedNotificationSchema
>;

export const protocolNotificationSchema = v.union([
  protocolEventNotificationSchema,
  protocolAttachEndedNotificationSchema,
]);
export type ProtocolNotification = v.InferOutput<
  typeof protocolNotificationSchema
>;

export const subscriptionCloseSchema = v.strictObject({
  kind: v.literal("control"),
  method: v.literal("subscription.close"),
  subscriptionId: subscriptionIdSchema,
});

export const protocolMessageSchema = v.union([
  subscriptionCloseSchema,
  protocolRequestSchema,
  protocolResponseSchema,
  protocolNotificationSchema,
]);
export type ProtocolMessage = v.InferOutput<typeof protocolMessageSchema>;

export const initializeParamsSchema = v.strictObject({
  protocolMajorVersion: protocolMajorVersionSchema,
  consumerContext: consumerContextSchema,
  runtimeScopeId: v.optional(runtimeScopeIdSchema),
});
export type InitializeParams = v.InferOutput<typeof initializeParamsSchema>;

export const initializeResultSchema = v.strictObject({
  protocolMajorVersion: protocolMajorVersionSchema,
  daemonGeneration: daemonGenerationSchema,
  runtimeScopeId: runtimeScopeIdSchema,
});
export type InitializeResult = v.InferOutput<typeof initializeResultSchema>;

export const attachResultSchema = v.strictObject({
  sessionId: sessionIdSchema,
  subscriptionId: subscriptionIdSchema,
  target: subscriptionTargetSchema,
  window: eventWindowSchema,
  replayed: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
export type AttachResult = v.InferOutput<typeof attachResultSchema>;

// 每个方法的参数 / 结果 schema 由方法名静态确定，双端共用同一契约。
const protocolParamsSchemas = {
  initialize: initializeParamsSchema,
  spawn: spawnParamsSchema,
  send: sendParamsSchema,
  wait: waitParamsSchema,
  interrupt: interruptParamsSchema,
  kill: killParamsSchema,
  list: listFilterSchema,
  attach: attachParamsSchema,
  resolvePermission: resolvePermissionParamsSchema,
  modelCatalog: v.strictObject({}),
  diagnostics: diagnosticsParamsSchema,
} as const satisfies Record<ProtocolMethod, v.GenericSchema>;

export type ProtocolParams<M extends ProtocolMethod> = v.InferOutput<
  (typeof protocolParamsSchemas)[M]
>;

export function protocolParamsSchemaFor<M extends ProtocolMethod>(
  method: M,
): (typeof protocolParamsSchemas)[M] {
  return protocolParamsSchemas[method];
}

const protocolResultSchemas = {
  initialize: initializeResultSchema,
  spawn: spawnAckSchema,
  send: sendAckSchema,
  wait: waitResultSchema,
  interrupt: interruptAckSchema,
  kill: killResultSchema,
  list: v.array(sessionInfoSchema),
  attach: attachResultSchema,
  resolvePermission: resolvePermissionAckSchema,
  modelCatalog: modelCatalogResultSchema,
  diagnostics: diagnosticsResultSchema,
} as const satisfies Record<ProtocolMethod, v.GenericSchema>;

export type ProtocolResult<M extends ProtocolMethod> = v.InferOutput<
  (typeof protocolResultSchemas)[M]
>;

export function protocolResultSchemaFor<M extends ProtocolMethod>(
  method: M,
): (typeof protocolResultSchemas)[M] {
  return protocolResultSchemas[method];
}
