import * as v from "valibot";

// —— 会话与状态 ——

const identifier = <T extends string>(name: T, pattern: RegExp) =>
  v.pipe(v.string(), v.regex(pattern), v.brand<string, T>(name));

export const sessionNameSchema = v.pipe(
  v.string(),
  v.maxLength(32),
  v.regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  v.check(
    (value) =>
      !["daemon", "core", "adapter", "harness", "root"].includes(value),
  ),
  v.brand<string, "SessionName">("SessionName"),
);
export type SessionName = v.InferOutput<typeof sessionNameSchema>;

export const sessionIdSchema = v.pipe(
  v.string(),
  v.regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*@g[a-z0-9]+$/),
  v.check((value) => {
    const [name] = value.split("@", 1);
    return name !== undefined && v.safeParse(sessionNameSchema, name).success;
  }),
  v.brand<string, "SessionId">("SessionId"),
);
export type SessionId = v.InferOutput<typeof sessionIdSchema>;
export const turnIdSchema = identifier("TurnId", /^[a-z0-9][a-z0-9-]*$/);
export type TurnId = v.InferOutput<typeof turnIdSchema>;
export const permissionIdSchema = identifier(
  "PermissionId",
  /^[a-z0-9][a-z0-9-]*$/,
);
export type PermissionId = v.InferOutput<typeof permissionIdSchema>;
export const messageIdSchema = identifier("MessageId", /^[a-z0-9][a-z0-9-]*$/);
export type MessageId = v.InferOutput<typeof messageIdSchema>;
export const toolCallIdSchema = identifier(
  "ToolCallId",
  /^[a-z0-9][a-z0-9-]*$/,
);
export type ToolCallId = v.InferOutput<typeof toolCallIdSchema>;
export const requestIdSchema = identifier("RequestId", /^[a-z0-9][a-z0-9-]*$/);
export type RequestId = v.InferOutput<typeof requestIdSchema>;

const checksumAlphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
const damm36Packed =
  "AAIDAQQGBwUICgsJDA4PDRASExEUFhcVGBobGRweHx0gIiMhAgABAwYEBQcKCAkLDgwNDxIQERMWFBUXGhgZGx4cHR8iICEjAwEAAgcFBAYLCQgKDw0MDhMREBIXFRQWGxkYGh8dHB4jISAiAQMCAAUHBgQJCwoIDQ8ODBETEhAVFxYUGRsaGB0fHhwhIyIgICIjIQACAwEEBgcFCAoLCQwODw0QEhMRFBYXFRgaGxkcHh8dIiAhIwIAAQMGBAUHCggJCw4MDQ8SEBETFhQVFxoYGRseHB0fIyEgIgMBAAIHBQQGCwkICg8NDA4TERASFxUUFhsZGBofHRweISMiIAEDAgAFBwYECQsKCA0PDgwRExIQFRcWFBkbGhgdHx4cHB4fHSAiIyEAAgMBBAYHBQgKCwkMDg8NEBITERQWFxUYGhsZHhwdHyIgISMCAAEDBgQFBwoICQsODA0PEhARExYUFRcaGBkbHx0cHiMhICIDAQACBwUEBgsJCAoPDQwOExEQEhcVFBYbGRgaHR8eHCEjIiABAwIABQcGBAkLCggNDw4MERMSEBUXFhQZGxoYGBobGRweHx0gIiMhAAIDAQQGBwUICgsJDA4PDRASExEUFhcVGhgZGx4cHR8iICEjAgABAwYEBQcKCAkLDgwNDxIQERMWFBUXGxkYGh8dHB4jISAiAwEAAgcFBAYLCQgKDw0MDhMREBIXFRQWGRsaGB0fHhwhIyIgAQMCAAUHBgQJCwoIDQ8ODBETEhAVFxYUFBYXFRgaGxkcHh8dICIjIQACAwEEBgcFCAoLCQwODw0QEhMRFhQVFxoYGRseHB0fIiAhIwIAAQMGBAUHCggJCw4MDQ8SEBETFxUUFhsZGBofHRweIyEgIgMBAAIHBQQGCwkICg8NDA4TERASFRcWFBkbGhgdHx4cISMiIAEDAgAFBwYECQsKCA0PDgwRExIQEBITERQWFxUYGhsZHB4fHSAiIyEAAgMBBAYHBQgKCwkMDg8NEhARExYUFRcaGBkbHhwdHyIgISMCAAEDBgQFBwoICQsODA0PExEQEhcVFBYbGRgaHx0cHiMhICIDAQACBwUEBgsJCAoPDQwOERMSEBUXFhQZGxoYHR8eHCEjIiABAwIABQcGBAkLCggNDw4MDA4PDRASExEUFhcVGBobGRweHx0gIiMhAAIDAQQGBwUICgsJDgwNDxIQERMWFBUXGhgZGx4cHR8iICEjAgABAwYEBQcKCAkLDw0MDhMREBIXFRQWGxkYGh8dHB4jISAiAwEAAgcFBAYLCQgKDQ8ODBETEhAVFxYUGRsaGB0fHhwhIyIgAQMCAAUHBgQJCwoICAoLCQwODw0QEhMRFBYXFRgaGxkcHh8dICIjIQACAwEEBgcFCggJCw4MDQ8SEBETFhQVFxoYGRseHB0fIiAhIwIAAQMGBAUHCwkICg8NDA4TERASFxUUFhsZGBofHRweIyEgIgMBAAIHBQQGCQsKCA0PDgwRExIQFRcWFBkbGhgdHx4cISMiIAEDAgAFBwYEBAYHBQgKCwkMDg8NEBITERQWFxUYGhsZHB4fHSAiIyEAAgMBBgQFBwoICQsODA0PEhARExYUFRcaGBkbHhwdHyIgISMCAAEDBwUEBgsJCAoPDQwOExEQEhcVFBYbGRgaHx0cHiMhICIDAQACBQcGBAkLCggNDw4MERMSEBUXFhQZGxoYHR8eHCEjIiABAwIA";
const damm36 = Uint8Array.from(Buffer.from(damm36Packed, "base64"));
function dammState(value: string): number {
  let state = 0;
  for (const character of value) {
    const digit = checksumAlphabet.indexOf(character);
    if (digit === -1) throw new Error("Invalid DiagnosticId character");
    state = damm36[state * 36 + digit]!;
  }
  return state;
}
function diagnosticChecksum(generation: string, counter: string): string {
  // prefix-free 的一元长度编码保留 generation/counter 边界；移动 `-` 时拼接数据虽不变，前缀仍会变化。
  const boundaryPrefix = "1".repeat(generation.length) + "0";
  return checksumAlphabet[dammState(boundaryPrefix + generation + counter)]!;
}
export function makeDiagnosticId(
  generation: string,
  counter: string,
): DiagnosticId {
  const component = v.pipe(v.string(), v.regex(/^[a-z0-9]+$/));
  if (
    !v.safeParse(component, generation).success ||
    !v.safeParse(component, counter).success
  )
    throw new Error("Invalid DiagnosticId component");
  return v.parse(
    diagnosticIdSchema,
    "d" + generation + "-" + counter + diagnosticChecksum(generation, counter),
  );
}
export const diagnosticIdSchema = v.pipe(
  v.string(),
  v.regex(/^d[a-z0-9]+-[a-z0-9]+$/),
  v.check((value) => {
    const match = /^d([a-z0-9]+)-([a-z0-9]+)([a-z0-9])$/.exec(value);
    return (
      match !== null && diagnosticChecksum(match[1]!, match[2]!) === match[3]
    );
  }),
  v.brand<string, "DiagnosticId">("DiagnosticId"),
);
export type DiagnosticId = v.InferOutput<typeof diagnosticIdSchema>;

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

// —— 七动作的参数与结果 ——

export const spawnParamsSchema = v.strictObject({
  sessionName: sessionNameSchema,
  harness: v.pipe(v.string(), v.minLength(1)),
  message: v.pipe(v.string(), v.minLength(1)),
  agent: v.optional(v.string()),
  model: v.optional(v.string()),
  reasoning: v.optional(v.string()),
  cwd: v.optional(v.string()),
  authorizationMode: v.optional(authorizationModeSchema),
  sandbox: v.optional(v.string()),
  captureHarnessStderr: v.optional(v.boolean()),
  meta: v.optional(v.record(v.string(), v.unknown())),
});
export type SpawnParams = v.InferOutput<typeof spawnParamsSchema>;

export const sendParamsSchema = v.strictObject({
  sessionId: sessionIdSchema,
  message: v.string(),
});
export type SendParams = v.InferOutput<typeof sendParamsSchema>;

export const sendAckSchema = v.strictObject({
  sessionId: sessionIdSchema,
  turnId: turnIdSchema,
  messageId: messageIdSchema,
  deliveryPoint: deliveryPointSchema,
});
export type SendAck = v.InferOutput<typeof sendAckSchema>;

export const waitParamsSchema = v.strictObject({
  ids: v.array(sessionIdSchema),
  timeoutMs: v.optional(v.number()),
});
export type WaitParams = v.InferOutput<typeof waitParamsSchema>;

export const turnCompletedSchema = v.strictObject({
  sessionId: sessionIdSchema,
  turnId: turnIdSchema,
  stopReason: stopReasonSchema,
  finalReply: v.nullable(v.string()),
  usage: v.optional(v.record(v.string(), v.unknown())),
});
export type TurnCompleted = v.InferOutput<typeof turnCompletedSchema>;

export const waitResultSchema = v.strictObject({
  status: v.union([v.literal("completed"), v.literal("timeout")]),
  results: v.array(
    v.strictObject({
      sessionId: sessionIdSchema,
      status: v.union([v.literal("completed"), v.literal("killed")]),
      turn: v.optional(turnCompletedSchema),
    }),
  ),
});
export type WaitResult = v.InferOutput<typeof waitResultSchema>;

export const interruptParamsSchema = v.strictObject({
  ids: v.array(sessionIdSchema),
});
export type InterruptParams = v.InferOutput<typeof interruptParamsSchema>;

export const interruptOutcomeSchema = v.strictObject({
  sessionId: sessionIdSchema,
  status: v.union([v.literal("requested"), v.literal("idle")]),
  turnId: v.optional(turnIdSchema),
});
export type InterruptOutcome = v.InferOutput<typeof interruptOutcomeSchema>;
export type InterruptAck = readonly InterruptOutcome[];

export const resolvePermissionParamsSchema = v.strictObject({
  sessionId: sessionIdSchema,
  permissionId: permissionIdSchema,
  resolution: permissionResolutionSchema,
});
export type ResolvePermissionParams = v.InferOutput<
  typeof resolvePermissionParamsSchema
>;

export const killParamsSchema = v.strictObject({
  ids: v.array(sessionIdSchema),
});
export type KillParams = v.InferOutput<typeof killParamsSchema>;

export const listFilterSchema = v.strictObject({
  harness: v.optional(v.string()),
  state: v.optional(sessionStateSchema),
  sessionName: v.optional(sessionNameSchema),
  model: v.optional(v.string()),
});
export type ListFilter = v.InferOutput<typeof listFilterSchema>;

export const attachParamsSchema = v.strictObject({
  sessionId: sessionIdSchema,
  replay: v.optional(v.number()),
  exitOn: v.optional(v.array(stopReasonSchema)),
});
export type AttachParams = v.InferOutput<typeof attachParamsSchema>;

export const killResultSchema = v.strictObject({
  sessionId: sessionIdSchema,
  status: v.union([v.literal("killed"), v.literal("not_found")]),
});
export type KillResult = v.InferOutput<typeof killResultSchema>;

export const sessionInfoSchema = v.strictObject({
  sessionId: sessionIdSchema,
  sessionName: sessionNameSchema,
  harness: v.string(),
  state: sessionStateSchema,
  model: v.nullable(v.string()),
  reasoning: v.nullable(v.string()),
  cwd: v.string(),
  spawnedAt: v.string(),
  turns: v.number(),
  lastStopReason: v.nullable(stopReasonSchema),
});
export type SessionInfo = v.InferOutput<typeof sessionInfoSchema>;

// —— 领域事件 ——

export const domainEventSchema = v.union([
  v.strictObject({
    type: v.literal("session.created"),
    sessionId: sessionIdSchema,
    harness: v.string(),
    model: v.nullable(v.string()),
    reasoning: v.nullable(v.string()),
    cwd: v.string(),
    sessionName: sessionNameSchema,
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
    sessionId: sessionIdSchema,
    turnId: turnIdSchema,
    stopReason: stopReasonSchema,
    finalReply: v.nullable(v.string()),
    usage: v.optional(v.record(v.string(), v.unknown())),
  }),
  v.strictObject({
    type: v.literal("session.killed"),
    sessionId: sessionIdSchema,
  }),
]);
export type DomainEvent = v.InferOutput<typeof domainEventSchema>;

// —— 诊断（存储 envelope 与 producer input） ——

export const diagnosticSourceSchema = v.picklist([
  "daemon",
  "core",
  "adapter",
  "harness",
]);
export type DiagnosticSource = v.InferOutput<typeof diagnosticSourceSchema>;
export const diagnosticSeveritySchema = v.picklist([
  "debug",
  "info",
  "warning",
  "error",
]);
export type DiagnosticSeverity = v.InferOutput<typeof diagnosticSeveritySchema>;
export const diagnosticKindSchema = v.picklist([
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
]);
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

const harnessSchema = v.pipe(v.string(), v.minLength(1));
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
      reason: v.literal("started"),
    },
    "info",
  ),
  defineAdapterSessionDiagnostic(
    {
      kind: v.literal("lifecycle"),
      operation: v.literal("worker"),
      reason: v.literal("stopped"),
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
  defineRequestFailure("capabilities", "query"),
  defineRequestFailure("spawn", "dispatch"),
  defineRequestFailure("send", "dispatch"),
  defineRequestFailure("wait", "dispatch"),
  defineRequestFailure("interrupt", "dispatch"),
  defineRequestFailure("kill", "dispatch"),
  defineRequestFailure("list", "dispatch"),
  defineRequestFailure("attach", "dispatch"),
  defineRequestFailure("diagnostics", "dispatch"),
  defineRequestFailure("resolve_permission", "dispatch"),
  defineRequestFailure("capabilities", "dispatch"),
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
  defineControlDiagnostic(
    {
      kind: v.literal("protocol_violation"),
      operation: v.literal("validate_worker_response"),
      reason: v.literal("invalid_shape"),
      message: v.optional(textEvidenceSchema),
    },
    "error",
  ),
  defineControlDiagnostic(
    {
      kind: v.literal("protocol_violation"),
      operation: v.literal("validate_worker_response"),
      reason: v.literal("unexpected_message"),
      message: v.optional(textEvidenceSchema),
    },
    "error",
  ),
  defineControlDiagnostic(
    {
      kind: v.literal("protocol_violation"),
      operation: v.literal("validate_worker_event"),
      reason: v.literal("invalid_shape"),
      message: v.optional(textEvidenceSchema),
    },
    "error",
  ),
  defineControlDiagnostic(
    {
      kind: v.literal("protocol_violation"),
      operation: v.literal("validate_worker_event"),
      reason: v.literal("unexpected_message"),
      message: v.optional(textEvidenceSchema),
    },
    "error",
  ),
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
] as const;

function defineTransportFailure<
  const TOperation extends string,
  const TReason extends string,
>(operation: TOperation, reason: TReason) {
  return defineDaemonDiagnostic(
    {
      kind: v.literal("transport_failure"),
      operation: v.literal(operation),
      reason: v.literal(reason),
      message: textEvidenceSchema,
    },
    "error",
  );
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
  defineTransportFailure("listen", "io_error"),
  defineTransportFailure("connect", "io_error"),
  defineTransportFailure("connect", "timeout"),
  defineTransportFailure("read", "io_error"),
  defineTransportFailure("read", "timeout"),
  defineTransportFailure("read", "disconnected"),
  defineTransportFailure("write", "io_error"),
  defineTransportFailure("write", "timeout"),
  defineTransportFailure("write", "disconnected"),
  defineTransportFailure("close", "io_error"),
  defineTransportFailure("close", "timeout"),
  defineTransportFailure("close", "disconnected"),
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
      reason: "started" | "stopped";
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
  | { operation: "capabilities"; stage: "query" | "dispatch" };
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
      operation: "validate_worker_response" | "validate_worker_event";
      reason: "invalid_shape" | "unexpected_message";
    }
  | {
      operation: "validate_daemon_result" | "emit_domain_event";
      reason: "invalid_shape";
    };
type ProtocolViolationFact = ProtocolViolationPair & {
  kind: "protocol_violation";
  message?: TextEvidence | undefined;
};
type TransportFailurePair =
  | { operation: "listen"; reason: "io_error" }
  | { operation: "connect"; reason: "io_error" | "timeout" }
  | {
      operation: "read" | "write" | "close";
      reason: "io_error" | "timeout" | "disconnected";
    };
type TransportFailureFact = TransportFailurePair & {
  kind: "transport_failure";
  message: TextEvidence;
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
  | (DaemonAssociation & TransportFailureFact)
  | (DaemonAssociation & (StorageFailureFact | TailRepairedFact))
  | HarnessStderrFact;

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
  harness: v.optional(v.pipe(v.string(), v.minLength(1))),
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
  v.literal("permission_not_pending"),
  v.literal("permission_resolution_mismatch"),
  v.literal("unknown_harness"),
  v.literal("method_not_found"),
  v.literal("protocol_error"),
  v.literal("capability_query_failed"),
  v.literal("internal_error"),
  v.literal("unsupported_feature"),
  v.literal("diagnostic_not_found"),
  v.literal("diagnostics_unavailable"),
  v.literal("diagnostics_store_corrupt"),
  v.literal("session_name_conflict"),
  v.literal("daemon_timeout"),
  v.literal("invalid_daemon_response"),
  v.literal("daemon_start_failed"),
  v.literal("daemon_disconnected"),
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
  | "capability_query_failed"
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
export const machineErrorSchema = v.union([
  v.strictObject({
    code: v.literal("session_not_found"),
    sessionId: sessionIdSchema,
  }),
  v.strictObject({
    code: v.literal("session_killed"),
    sessionId: sessionIdSchema,
  }),
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
    code: v.literal("session_name_conflict"),
    sessionName: sessionNameSchema,
  }),
  v.strictObject({
    code: v.literal("unknown_harness"),
    harness: v.pipe(v.string(), v.minLength(1)),
    availableHarnesses: v.array(v.pipe(v.string(), v.minLength(1))),
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
    code: v.literal("unsupported_feature"),
    feature: v.pipe(v.string(), v.minLength(1)),
  }),
  v.strictObject({ code: v.literal("daemon_timeout") }),
  v.strictObject({ code: v.literal("invalid_daemon_response") }),
  v.strictObject({
    code: v.literal("daemon_start_failed"),
    cause: errorCauseSchema,
  }),
  v.strictObject({ code: v.literal("daemon_disconnected") }),
  v.strictObject({ code: v.literal("diagnostics_unavailable") }),
  unexpectedError("capability_query_failed"),
  unexpectedError("internal_error"),
  unexpectedError("diagnostics_store_corrupt"),
]);
export type MachineError = v.InferOutput<typeof machineErrorSchema>;

// —— worker driver 契约（缝 B：adapter 实现，core 调用） ——

export type WorkerSpec = {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly harness: string;
  readonly message: string;
  readonly agent?: string;
  readonly model?: string;
  readonly reasoning?: string;
  readonly cwd: string;
  readonly authorizationMode: AuthorizationMode;
  readonly sandbox?: string;
  readonly captureHarnessStderr?: boolean;
  readonly sessionName: SessionName;
};

export interface WorkerDriver {
  // 启动 worker 进程/会话；worker 内容事件通过 emit 回调流入 core。
  start(spec: WorkerSpec): void;
  // 把消息交给 worker；turnId 标识它所属的回合。
  deliver(sessionId: SessionId, turnId: TurnId, message: string): void;
  // 向 worker 发出停止当前回合的指令；worker 随后以 turn.completed(cancelled) 事件确认。
  interrupt(sessionId: SessionId): void;
  // 把控制面的授权决议交还 adapter，翻译为 harness 原生回答。
  resolvePermission(
    sessionId: SessionId,
    permissionId: PermissionId,
    resolution: PermissionResolution,
  ): void;
  // 终止 worker 进程；会话的 session.killed 事件由 core 发出。
  terminate(sessionId: SessionId): void;
}

export type WorkerDriverFactory = (
  emit: (event: DomainEvent) => void,
) => WorkerDriver;

// —— capabilities 能力矩阵（实时查询；default 字段不进矩阵，最小干扰原则） ——

export const capabilityModelSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  displayName: v.pipe(v.string(), v.minLength(1)),
  reasoningEfforts: v.array(v.pipe(v.string(), v.minLength(1))),
});
export type CapabilityModel = v.InferOutput<typeof capabilityModelSchema>;

export const harnessCapabilitySchema = v.strictObject({
  harness: v.pipe(v.string(), v.minLength(1)),
  models: v.array(capabilityModelSchema),
});
export type HarnessCapability = v.InferOutput<typeof harnessCapabilitySchema>;

export const capabilityFailureSchema = v.strictObject({
  harness: v.pipe(v.string(), v.minLength(1)),
  code: v.literal("capability_query_failed"),
  cause: v.optional(errorCauseSchema),
  diagnosticId: v.optional(diagnosticIdSchema),
});
export type CapabilityFailure = v.InferOutput<typeof capabilityFailureSchema>;

export const capabilitiesResultSchema = v.strictObject({
  capabilities: v.array(harnessCapabilitySchema),
  failures: v.array(capabilityFailureSchema),
});
export type CapabilitiesResult = v.InferOutput<typeof capabilitiesResultSchema>;

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
  v.literal("capabilities"),
  v.literal("diagnostics"),
]);
export type ProtocolMethod = v.InferOutput<typeof protocolMethodSchema>;

export const protocolRequestSchema = v.strictObject({
  kind: v.literal("request"),
  requestId: requestIdSchema,
  method: protocolMethodSchema,
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
  reason: v.union([stopReasonSchema, v.literal("session_killed")]),
});
export type AttachEnded = v.InferOutput<typeof attachEndedSchema>;

export const protocolEventNotificationSchema = v.strictObject({
  kind: v.literal("notification"),
  method: v.literal("event"),
  params: domainEventSchema,
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

export const protocolMessageSchema = v.union([
  protocolRequestSchema,
  protocolResponseSchema,
  protocolNotificationSchema,
]);
export type ProtocolMessage = v.InferOutput<typeof protocolMessageSchema>;

export const initializeParamsSchema = v.strictObject({});
export const initializeResultSchema = v.strictObject({});

export const attachResultSchema = v.strictObject({
  sessionId: sessionIdSchema,
  replayed: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
export type AttachResult = v.InferOutput<typeof attachResultSchema>;

export const interruptAckSchema = v.array(interruptOutcomeSchema);

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
  capabilities: v.strictObject({}),
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
  spawn: v.strictObject({ sessionId: sessionIdSchema }),
  send: sendAckSchema,
  wait: waitResultSchema,
  interrupt: interruptAckSchema,
  kill: v.array(killResultSchema),
  list: v.array(sessionInfoSchema),
  attach: attachResultSchema,
  resolvePermission: v.strictObject({}),
  capabilities: capabilitiesResultSchema,
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
