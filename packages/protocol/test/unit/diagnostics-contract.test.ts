import * as v from "valibot";
import { describe, expect, expectTypeOf, test } from "vitest";

import {
  modelCatalogFailureSchema,
  diagnosticInputSchema,
  diagnosticRecordSchema,
  diagnosticsParamsSchema,
  diagnosticsResultSchema,
  diagnosticIdSchema,
  errorCauseSchema,
  makeDiagnosticId,
  makeErrorCause,
  machineErrorSchema,
  messageIdSchema,
  parseTransportFailureFact,
  permissionIdSchema,
  protocolParamsSchemaFor,
  protocolResultSchemaFor,
  requestIdSchema,
  sessionIdSchema,
  sessionNameSchema,
  toolCallIdSchema,
  transportFailureFactSchema,
  turnIdSchema,
  workerEventRejectionSchema,
  type DiagnosticId,
  type DiagnosticInput,
  type DriverDiagnosticFact,
  type DiagnosticRecord,
  type DiagnosticsParams,
  type MessageId,
  type MachineError,
  type PermissionId,
  type RequestId,
  type SessionName,
  type SessionId,
  type ToolCallId,
  type TurnId,
  type WorkerEventRejection,
} from "../../src/index.ts";

const ok = (schema: v.GenericSchema, input: unknown): void =>
  expect(v.safeParse(schema, input).success).toBe(true);
const bad = (schema: v.GenericSchema, input: unknown): void =>
  expect(v.safeParse(schema, input).success).toBe(false);

const sessionId = "reviewer@g7";
const diagnosticId = makeDiagnosticId("7", "42");

describe("worker event rejection contract", () => {
  const rejections = [
    {
      reason: "unknown_session",
      eventType: "message",
      sessionState: "unknown",
      eventTurnId: "t1",
    },
    {
      reason: "session_killed",
      eventType: "message",
      sessionState: "killed",
      eventTurnId: "t1",
    },
    {
      reason: "driver_event_forbidden",
      eventType: "session.created",
      sessionState: "busy",
    },
    {
      reason: "turn_not_active",
      eventType: "message",
      sessionState: "idle",
      eventTurnId: "t2",
    },
    {
      reason: "turn_mismatch",
      eventType: "message",
      sessionState: "busy",
      eventTurnId: "t2",
      activeTurnId: "t1",
    },
    {
      reason: "event_after_turn_completed",
      eventType: "text.delta",
      sessionState: "idle",
      eventTurnId: "t1",
    },
    {
      reason: "message_already_completed",
      eventType: "message",
      sessionState: "busy",
      eventTurnId: "t1",
      activeTurnId: "t1",
      messageId: "m1",
    },
    {
      reason: "tool_already_requested",
      eventType: "tool.requested",
      sessionState: "busy",
      eventTurnId: "t1",
      activeTurnId: "t1",
      toolCallId: "c1",
    },
    {
      reason: "tool_already_completed",
      eventType: "tool.completed",
      sessionState: "busy",
      eventTurnId: "t1",
      activeTurnId: "t1",
      toolCallId: "c1",
    },
    {
      reason: "permission_id_reused",
      eventType: "permission.requested",
      sessionState: "busy",
      eventTurnId: "t1",
      activeTurnId: "t1",
      permissionId: "p1",
    },
    {
      reason: "permission_not_pending",
      eventType: "permission.resolved",
      sessionState: "busy",
      eventTurnId: "t1",
      activeTurnId: "t1",
      permissionId: "p1",
    },
    {
      reason: "permission_turn_mismatch",
      eventType: "permission.resolved",
      sessionState: "busy",
      eventTurnId: "t2",
      activeTurnId: "t1",
      permissionId: "p1",
    },
  ] as const;
  const requiredVariantFields = [
    "eventType",
    "eventType",
    "eventType",
    "eventTurnId",
    "activeTurnId",
    "eventTurnId",
    "messageId",
    "toolCallId",
    "toolCallId",
    "permissionId",
    "permissionId",
    "permissionId",
  ] as const;

  test("accepts every closed rejection variant and rejects unsafe fields", () => {
    for (const [index, rejection] of rejections.entries()) {
      ok(workerEventRejectionSchema, rejection);
      ok(diagnosticInputSchema, {
        source: "core",
        sessionId,
        kind: "protocol_violation",
        operation: "validate_worker_event",
        ...rejection,
      });
      bad(workerEventRejectionSchema, {
        ...rejection,
        content: "secret-content",
      });
      bad(workerEventRejectionSchema, {
        ...rejection,
        nativePayload: { secret: true },
      });
      bad(diagnosticInputSchema, {
        source: "core",
        sessionId,
        kind: "protocol_violation",
        operation: "validate_worker_event",
        ...rejection,
        content: "secret-content",
      });
      const missingField = requiredVariantFields[index];
      if (missingField === undefined)
        throw new Error("Missing rejection field fixture");
      const incomplete = { ...rejection } as Record<string, unknown>;
      delete incomplete[missingField];
      bad(workerEventRejectionSchema, incomplete);
      bad(diagnosticInputSchema, {
        source: "core",
        sessionId,
        kind: "protocol_violation",
        operation: "validate_worker_event",
        ...incomplete,
      });
    }
    bad(workerEventRejectionSchema, {
      ...rejections[0],
      reason: "unexpected_message",
    });
    bad(diagnosticInputSchema, {
      source: "core",
      sessionId,
      kind: "protocol_violation",
      operation: "validate_worker_event",
      reason: "unexpected_message",
    });
  });

  test("requires the active turn only when a completed-turn event arrives during an active turn", () => {
    const envelope = {
      source: "core",
      sessionId,
      kind: "protocol_violation",
      operation: "validate_worker_event",
    } as const;
    const busy = {
      reason: "event_after_turn_completed",
      eventType: "message",
      sessionState: "busy",
      eventTurnId: "t1",
      activeTurnId: "t2",
    } as const;
    const spawning = { ...busy, sessionState: "spawning" } as const;
    const idle = {
      reason: "event_after_turn_completed",
      eventType: "message",
      sessionState: "idle",
      eventTurnId: "t1",
    } as const;

    for (const rejection of [busy, spawning, idle]) {
      ok(workerEventRejectionSchema, rejection);
      ok(diagnosticInputSchema, { ...envelope, ...rejection });
    }
    for (const rejection of [
      { ...busy, activeTurnId: undefined },
      { ...spawning, activeTurnId: undefined },
      { ...idle, activeTurnId: "t2" },
    ]) {
      bad(workerEventRejectionSchema, rejection);
      bad(diagnosticInputSchema, { ...envelope, ...rejection });
    }
  });

  test("keeps rejection handling exhaustive", () => {
    const handleRejection = (rejection: WorkerEventRejection): string => {
      switch (rejection.reason) {
        case "unknown_session":
        case "session_killed":
        case "driver_event_forbidden":
        case "turn_not_active":
        case "turn_mismatch":
        case "event_after_turn_completed":
        case "message_already_completed":
        case "tool_already_requested":
        case "tool_already_completed":
        case "permission_id_reused":
        case "permission_not_pending":
        case "permission_turn_mismatch":
          return rejection.reason;
        default:
          return rejection satisfies never;
      }
    };
    expect(
      rejections.map((rejection) =>
        handleRejection(v.parse(workerEventRejectionSchema, rejection)),
      ),
    ).toEqual(rejections.map(({ reason }) => reason));
  });

  test("derives diagnostic input and record types from the rejection union", () => {
    type WorkerDiagnosticInput = Extract<
      DiagnosticInput,
      {
        source: "core";
        operation: "validate_worker_event";
      }
    >;
    type ExpectedInput = WorkerEventRejection & {
      source: "core";
      sessionId: SessionId;
      kind: "protocol_violation";
      operation: "validate_worker_event";
    };
    type WorkerDiagnosticRecord = Extract<
      DiagnosticRecord,
      {
        source: "core";
        operation: "validate_worker_event";
      }
    >;
    type ExpectedRecord = ExpectedInput & {
      v: 1;
      diagnosticId: DiagnosticId;
      recordedAt: string;
      severity: "error";
    };

    expectTypeOf<WorkerDiagnosticInput>().toMatchTypeOf<ExpectedInput>();
    expectTypeOf<ExpectedInput>().toMatchTypeOf<WorkerDiagnosticInput>();
    expectTypeOf<WorkerDiagnosticRecord>().toMatchTypeOf<ExpectedRecord>();
    expectTypeOf<ExpectedRecord>().toMatchTypeOf<WorkerDiagnosticRecord>();
  });
});

describe("typed identifiers", () => {
  test("DiagnosticId check character detects every one-character edit and adjacent transposition", () => {
    const vector = "d1-098";
    ok(diagnosticIdSchema, vector);
    bad(diagnosticIdSchema, "d1-908");
    bad(diagnosticIdSchema, "d1-102");
    bad(diagnosticIdSchema, "d11-02");
    ok(diagnosticIdSchema, "d1-101");
    bad(diagnosticIdSchema, "d11-01");

    const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
    for (let index = 0; index < vector.length; index += 1) {
      if (vector[index] === "-") continue;
      for (const replacement of alphabet) {
        if (replacement === vector[index]) continue;
        bad(
          diagnosticIdSchema,
          `${vector.slice(0, index)}${replacement}${vector.slice(index + 1)}`,
        );
      }
    }

    const exhaustive = makeDiagnosticId("1", alphabet);
    for (let index = 1; index < exhaustive.length - 1; index += 1) {
      if (exhaustive[index] === exhaustive[index + 1]) continue;
      const swapped =
        exhaustive.slice(0, index) +
        exhaustive[index + 1] +
        exhaustive[index] +
        exhaustive.slice(index + 2);
      bad(diagnosticIdSchema, swapped);
    }

    for (const character of alphabet) {
      const moveRight = makeDiagnosticId("1", `${character}0`);
      const separator = moveRight.indexOf("-");
      bad(
        diagnosticIdSchema,
        moveRight.slice(0, separator) +
          character +
          "-" +
          moveRight.slice(separator + 2),
      );

      const moveLeft = makeDiagnosticId(`1${character}`, "0");
      const leftSeparator = moveLeft.indexOf("-");
      bad(
        diagnosticIdSchema,
        moveLeft.slice(0, leftSeparator - 1) +
          "-" +
          character +
          moveLeft.slice(leftSeparator + 1),
      );
    }

    for (let length = 1; length <= 72; length += 1) {
      const generated = makeDiagnosticId("a".repeat(length), "b0");
      const separator = generated.indexOf("-");
      bad(
        diagnosticIdSchema,
        generated.slice(0, separator) + "b-" + generated.slice(separator + 2),
      );
    }
  });

  test("validates owned ID formats and rejects cross-brand assignment", () => {
    ok(sessionNameSchema, "code-reviewer");
    bad(sessionNameSchema, "Core");
    bad(sessionNameSchema, "daemon");
    ok(sessionIdSchema, sessionId);
    bad(sessionIdSchema, "s1");
    bad(sessionIdSchema, "daemon@g1");
    ok(diagnosticIdSchema, diagnosticId);
    bad(diagnosticIdSchema, `${diagnosticId.slice(0, -1)}z`);

    const sessionName: SessionName = v.parse(sessionNameSchema, "reviewer");
    const sid: SessionId = v.parse(sessionIdSchema, sessionId);
    const tid: TurnId = v.parse(turnIdSchema, "t1");
    const pid: PermissionId = v.parse(permissionIdSchema, "p1");
    const mid: MessageId = v.parse(messageIdSchema, "m1");
    const cid: ToolCallId = v.parse(toolCallIdSchema, "c1");
    const rid: RequestId = v.parse(requestIdSchema, "r1");
    const did = diagnosticId;
    // @ts-expect-error independently branded IDs are not interchangeable.
    const wrongSession: SessionId = tid;
    // @ts-expect-error independently branded IDs are not interchangeable.
    const wrongDiagnostic: DiagnosticId = mid;
    // @ts-expect-error SessionName is not an addressable SessionId.
    const nameAsSession: SessionId = sessionName;
    // @ts-expect-error PermissionId is not a TurnId.
    const permissionAsTurn: TurnId = pid;
    // @ts-expect-error ToolCallId is not a MessageId.
    const toolAsMessage: MessageId = cid;
    // @ts-expect-error connection-scoped RequestId is not a DiagnosticId.
    const requestAsDiagnostic: DiagnosticId = rid;
    void [
      sid,
      did,
      wrongSession,
      wrongDiagnostic,
      nameAsSession,
      permissionAsTurn,
      toolAsMessage,
      requestAsDiagnostic,
    ];
  });

  test("every owned identifier schema rejects malformed and foreign formats", () => {
    const cases: Array<[v.GenericSchema, string, string]> = [
      [sessionNameSchema, "reviewer", "Reviewer"],
      [sessionIdSchema, "reviewer@g7", "reviewer"],
      [turnIdSchema, "t1", "T1"],
      [permissionIdSchema, "p1", "p/1"],
      [messageIdSchema, "m1", "m_1"],
      [toolCallIdSchema, "c1", "c.1"],
      [requestIdSchema, "r1", "r 1"],
      [diagnosticIdSchema, diagnosticId, "d7-42x"],
    ];
    for (const [schema, valid, invalid] of cases) {
      ok(schema, valid);
      bad(schema, invalid);
    }
  });
});

describe("strict diagnostic protocol", () => {
  test("transport fact 使用 source-free strict schema 并返回冻结副本", () => {
    const secretSentinel = ["protocol", "fact", "sentinel"].join("-");
    const mutable = {
      kind: "transport_failure" as const,
      operation: "write" as const,
      reason: "io_error" as const,
    };
    const fact = parseTransportFailureFact(mutable);
    Object.assign(mutable, { operation: "read", message: secretSentinel });
    expect(fact).toEqual({
      kind: "transport_failure",
      operation: "write",
      reason: "io_error",
    });
    expect(Object.isFrozen(fact)).toBe(true);

    for (const candidate of [
      { ...fact, source: "daemon" },
      { ...fact, message: secretSentinel },
      { ...fact, frame: secretSentinel },
      { ...fact, operation: "invented" },
      {
        kind: "transport_failure",
        operation: "write",
        reason: "invalid_frame",
        inputBytes: 1,
      },
      {
        kind: "transport_failure",
        operation: "read",
        reason: "invalid_frame",
        inputBytes: Number.MAX_SAFE_INTEGER + 1,
      },
    ]) {
      bad(transportFailureFactSchema, candidate);
    }
  });

  test("adapter driver facts cannot express source or harness authority", () => {
    const fact = {
      kind: "mapping_gap",
      operation: "spawn",
      reason: "unsupported_input",
      fields: ["reasoning"],
    } satisfies DriverDiagnosticFact;
    expect(fact.kind).toBe("mapping_gap");
    const forged = {
      // @ts-expect-error daemon source is owned outside the adapter seam.
      source: "daemon",
      kind: "mapping_gap",
      operation: "spawn",
      reason: "unsupported_input",
      fields: ["reasoning"],
    } satisfies DriverDiagnosticFact;
    expect(forged.source).toBe("daemon");
  });

  const input = {
    source: "adapter",
    harness: "codex",
    sessionId,
    kind: "stream_failure",
    operation: "receive_worker_stream",
    reason: "closed_unexpectedly",
    message: { text: "closed", truncated: false, originalBytes: 6 },
  } as const;
  const record = {
    ...input,
    v: 1,
    diagnosticId,
    recordedAt: "2026-08-20T00:00:00.000Z",
    severity: "error",
  } as const;

  test("records and inputs are closed discriminated unions with authority severity", () => {
    ok(diagnosticInputSchema, input);
    ok(diagnosticRecordSchema, record);
    bad(diagnosticRecordSchema, { ...record, severity: "warning" });
    bad(diagnosticRecordSchema, { ...record, sdkEvent: "thread/error" });
    bad(diagnosticInputSchema, { ...input, payload: { arbitrary: true } });
    bad(diagnosticInputSchema, { ...input, kind: "thinking" });
    bad(diagnosticRecordSchema, { ...record, v: 2 });
    bad(diagnosticRecordSchema, {
      ...record,
      recordedAt: "2026-08-20T00:00:00Z",
    });
    bad(diagnosticInputSchema, {
      ...input,
      message: { text: "closed", truncated: false, originalBytes: 7 },
    });
    const { sessionId: ignoredSessionId, ...unscoped } = input;
    void ignoredSessionId;
    bad(diagnosticInputSchema, { ...unscoped, turnId: "t1" });
    const {
      harness: ignoredHarness,
      sessionId: ignoredHarnessSessionId,
      ...withoutHarness
    } = input;
    void [ignoredHarness, ignoredHarnessSessionId];
    bad(diagnosticInputSchema, {
      ...withoutHarness,
      source: "harness",
      kind: "harness_stderr",
      operation: "worker_process",
      reason: "stderr_output",
      text: { text: "stderr", truncated: false, originalBytes: 6 },
    });
  });

  test("request failures only accept declared operation and stage pairs", () => {
    const invalidPair = {
      source: "core",
      kind: "request_failure",
      operation: "model_catalog",
      stage: "start_session",
      reason: "upstream_error",
      message: { text: "failed", truncated: false, originalBytes: 6 },
    } as const;

    bad(diagnosticInputSchema, invalidPair);
    // @ts-expect-error invalid operation/stage pairs are absent from the union.
    const invalidTypedPair: DiagnosticInput = invalidPair;
    void invalidTypedPair;
  });

  test("every diagnostic kind accepts its catalog and rejects invalid pairings", () => {
    const evidence = { text: "failed", truncated: false, originalBytes: 6 };
    const valid = [
      {
        source: "daemon",
        kind: "lifecycle",
        operation: "daemon",
        reason: "started",
      },
      {
        source: "adapter",
        harness: "codex",
        sessionId,
        kind: "mapping_gap",
        operation: "spawn",
        reason: "unsupported_input",
        fields: ["agent"],
      },
      {
        source: "adapter",
        harness: "codex",
        kind: "compatibility_gap",
        operation: "receive_worker_request",
        reason: "unsupported_request",
      },
      {
        source: "core",
        sessionId,
        kind: "request_failure",
        operation: "send",
        stage: "deliver",
        reason: "upstream_error",
        message: evidence,
      },
      {
        source: "adapter",
        harness: "codex",
        sessionId,
        kind: "stream_failure",
        operation: "receive_worker_stream",
        reason: "read_error",
        message: evidence,
      },
      {
        source: "adapter",
        harness: "codex",
        sessionId,
        kind: "turn_failure",
        operation: "run_turn",
        reason: "worker_reported_failure",
        message: evidence,
      },
      {
        source: "core",
        sessionId,
        kind: "authorization_failure",
        operation: "resolve_permission",
        stage: "lookup",
        reason: "target_lost",
        permissionId: "p1",
      },
      {
        source: "adapter",
        harness: "codex",
        kind: "protocol_violation",
        operation: "decode_worker_message",
        reason: "invalid_json",
      },
      {
        source: "daemon",
        kind: "transport_failure",
        operation: "listen",
        reason: "io_error",
      },
      {
        source: "daemon",
        kind: "transport_failure",
        operation: "read",
        reason: "invalid_frame",
        inputBytes: 123,
      },
      {
        source: "daemon",
        kind: "protocol_violation",
        operation: "validate_daemon_request",
        stage: "envelope",
        reason: "invalid_shape",
      },
      {
        source: "daemon",
        kind: "storage_failure",
        operation: "recover",
        reason: "tail_repaired",
        affectedBytes: 7,
      },
      {
        source: "harness",
        harness: "codex",
        sessionId,
        kind: "harness_stderr",
        operation: "worker_process",
        reason: "stderr_output",
        text: evidence,
      },
    ];
    for (const candidate of valid) ok(diagnosticInputSchema, candidate);

    const invalid = [
      {
        source: "daemon",
        kind: "lifecycle",
        operation: "daemon",
        reason: "initialized",
      },
      {
        source: "adapter",
        harness: "codex",
        kind: "mapping_gap",
        operation: "spawn",
        reason: "unsupported_input",
        fields: ["feedback"],
      },
      {
        source: "core",
        kind: "request_failure",
        operation: "spawn",
        stage: "deliver",
        reason: "upstream_error",
        message: evidence,
      },
      {
        source: "daemon",
        kind: "transport_failure",
        operation: "read",
        reason: "invalid_frame",
        inputBytes: -1,
      },
      {
        source: "daemon",
        kind: "transport_failure",
        operation: "read",
        reason: "invalid_frame",
        inputBytes: 1.5,
      },
      {
        source: "core",
        sessionId,
        kind: "authorization_failure",
        operation: "resolve_permission",
        stage: "lookup",
        reason: "upstream_rejected",
        permissionId: "p1",
      },
      {
        source: "daemon",
        kind: "protocol_violation",
        operation: "validate_daemon_result",
        reason: "invalid_json",
      },
      {
        source: "daemon",
        kind: "transport_failure",
        operation: "listen",
        reason: "disconnected",
        message: evidence,
      },
      {
        source: "daemon",
        kind: "transport_failure",
        operation: "read",
        reason: "invalid_frame",
        inputBytes: 123,
        message: evidence,
      },
      {
        source: "daemon",
        kind: "protocol_violation",
        operation: "validate_daemon_request",
        stage: "envelope",
        reason: "invalid_shape",
        details: { raw: "not allowed" },
      },
      {
        source: "daemon",
        kind: "storage_failure",
        operation: "append",
        reason: "tail_repaired",
        affectedBytes: 7,
      },
    ];
    for (const candidate of invalid) bad(diagnosticInputSchema, candidate);
  });

  test("diagnostic types exclude invalid associations and severity", () => {
    const typedSessionId = v.parse(sessionIdSchema, sessionId);
    const typedTurnId = v.parse(turnIdSchema, "t1");
    const typedPermissionId = v.parse(permissionIdSchema, "p1");
    const evidence = { text: "failed", truncated: false, originalBytes: 6 };
    const acceptInput = (_input: DiagnosticInput): void => {};
    const acceptRecord = (_record: DiagnosticRecord): void => {};

    // @ts-expect-error a turn filter is never meaningful without its SessionId.
    const turnWithoutSession: DiagnosticsParams = { turnId: typedTurnId };
    void turnWithoutSession;

    // A concrete v1 lifecycle record retains its authoritative literal severity.
    acceptRecord({
      source: "daemon",
      kind: "lifecycle",
      operation: "daemon",
      reason: "started",
      v: 1,
      diagnosticId,
      recordedAt: "2026-08-20T00:00:00.000Z",
      severity: "info",
    });

    // @ts-expect-error daemon lifecycle facts can only be recorded by daemon.
    acceptInput({
      source: "adapter",
      harness: "codex",
      kind: "lifecycle",
      operation: "daemon",
      reason: "started",
    });
    // @ts-expect-error worker lifecycle facts require adapter, harness and SessionId.
    acceptInput({
      source: "daemon",
      kind: "lifecycle",
      operation: "worker",
      reason: "started",
    });
    acceptInput({
      source: "daemon",
      kind: "lifecycle",
      operation: "daemon",
      reason: "started",
      // @ts-expect-error normal lifecycle facts do not carry failure evidence.
      message: evidence,
    });
    // @ts-expect-error listener failures are core session-scoped facts.
    acceptInput({
      source: "adapter",
      harness: "codex",
      sessionId: typedSessionId,
      kind: "lifecycle",
      operation: "event_delivery",
      reason: "listener_failed",
    });

    // @ts-expect-error turn-scoped diagnostics always carry their SessionId.
    acceptInput({
      source: "core",
      turnId: typedTurnId,
      kind: "protocol_violation",
      operation: "emit_domain_event",
      reason: "invalid_shape",
    });
    // @ts-expect-error adapter diagnostics always identify their harness.
    acceptInput({
      source: "adapter",
      kind: "compatibility_gap",
      operation: "receive_worker_request",
      reason: "unsupported_request",
    });
    // @ts-expect-error PermissionId is interpreted with its parent SessionId.
    acceptInput({
      source: "core",
      kind: "authorization_failure",
      operation: "resolve_permission",
      stage: "lookup",
      reason: "target_lost",
      permissionId: typedPermissionId,
    });
    // @ts-expect-error stream failures have authoritative error severity.
    acceptRecord({
      source: "adapter",
      harness: "codex",
      sessionId: typedSessionId,
      kind: "stream_failure",
      operation: "receive_worker_stream",
      reason: "read_error",
      message: evidence,
      v: 1,
      diagnosticId,
      recordedAt: "2026-08-20T00:00:00.000Z",
      severity: "warning",
    });
    acceptInput({
      source: "daemon",
      kind: "transport_failure",
      operation: "read",
      reason: "invalid_frame",
      inputBytes: 8,
      // @ts-expect-error transport failures never carry raw text evidence.
      message: evidence,
    });
  });

  test("the complete diagnostic catalog validates inputs and authoritative records", () => {
    const evidence = { text: "failed", truncated: false, originalBytes: 6 };
    const catalog: Array<{
      input: Record<string, unknown>;
      severity: "info" | "warning" | "error";
    }> = [];
    const add = (
      input: Record<string, unknown>,
      severity: "info" | "warning" | "error",
    ): void => {
      catalog.push({ input, severity });
    };

    for (const [operation, reason, severity] of [
      ["daemon", "started", "info"],
      ["daemon", "stopped", "info"],
      ["daemon", "idle_exit", "info"],
      ["daemon", "crashed", "error"],
      ["worker", "initialized", "info"],
      ["worker", "closed", "info"],
      ["worker", "exited_unexpectedly", "error"],
      ["diagnostics_store", "initialized", "info"],
      ["diagnostics_store", "closed", "info"],
      ["diagnostics_store", "invariant_failed", "error"],
      ["event_delivery", "listener_failed", "error"],
    ] as const) {
      add(
        {
          source:
            operation === "worker"
              ? "adapter"
              : operation === "event_delivery"
                ? "core"
                : "daemon",
          ...(operation === "worker"
            ? { harness: "codex", sessionId }
            : operation === "event_delivery"
              ? { sessionId }
              : {}),
          kind: "lifecycle",
          operation,
          reason,
          ...(severity === "error"
            ? { message: evidence, stack: evidence }
            : {}),
        },
        severity,
      );
    }

    const invalidLifecycle = [
      {
        source: "adapter",
        harness: "codex",
        kind: "lifecycle",
        operation: "daemon",
        reason: "started",
      },
      {
        source: "daemon",
        kind: "lifecycle",
        operation: "worker",
        reason: "started",
      },
      {
        source: "daemon",
        kind: "lifecycle",
        operation: "daemon",
        reason: "stopped",
        message: evidence,
      },
      {
        source: "adapter",
        harness: "codex",
        sessionId,
        kind: "lifecycle",
        operation: "worker",
        reason: "started",
        stack: evidence,
      },
      {
        source: "adapter",
        harness: "codex",
        sessionId,
        kind: "lifecycle",
        operation: "worker",
        reason: "stopped",
        message: evidence,
      },
      {
        source: "daemon",
        kind: "lifecycle",
        operation: "diagnostics_store",
        reason: "initialized",
        message: evidence,
      },
      {
        source: "daemon",
        kind: "lifecycle",
        operation: "diagnostics_store",
        reason: "closing",
        stack: evidence,
      },
      {
        source: "adapter",
        harness: "codex",
        sessionId,
        kind: "lifecycle",
        operation: "event_delivery",
        reason: "listener_failed",
      },
      {
        source: "core",
        kind: "lifecycle",
        operation: "event_delivery",
        reason: "listener_failed",
      },
    ];
    for (const candidate of invalidLifecycle) {
      bad(diagnosticInputSchema, candidate);
    }
    add(
      {
        source: "adapter",
        harness: "codex",
        kind: "mapping_gap",
        operation: "spawn",
        reason: "unsupported_input",
        fields: ["agent"],
      },
      "warning",
    );
    add(
      {
        source: "adapter",
        harness: "codex",
        kind: "mapping_gap",
        operation: "resolve_permission",
        reason: "unsupported_input",
        fields: ["feedback"],
      },
      "warning",
    );
    add(
      {
        source: "adapter",
        harness: "codex",
        kind: "compatibility_gap",
        operation: "receive_worker_request",
        reason: "unsupported_request",
      },
      "warning",
    );

    const requestPairs = [
      ["spawn", "start_session"],
      ["spawn", "start_turn"],
      ["spawn", "dispatch"],
      ["send", "deliver"],
      ["send", "steer"],
      ["send", "dispatch"],
      ["wait", "dispatch"],
      ["interrupt", "interrupt"],
      ["interrupt", "dispatch"],
      ["kill", "terminate"],
      ["kill", "dispatch"],
      ["list", "dispatch"],
      ["attach", "dispatch"],
      ["diagnostics", "dispatch"],
      ["resolve_permission", "resolve"],
      ["resolve_permission", "dispatch"],
      ["model_catalog", "query"],
      ["model_catalog", "dispatch"],
    ] as const;
    for (const [operation, stage] of requestPairs) {
      for (const reason of [
        "upstream_error",
        "timeout",
        "closed",
        "rejected",
      ] as const) {
        add(
          {
            source: "core",
            sessionId,
            kind: "request_failure",
            operation,
            stage,
            reason,
            message: evidence,
          },
          "error",
        );
      }
    }
    for (const reason of ["read_error", "closed_unexpectedly"] as const) {
      add(
        {
          source: "adapter",
          harness: "codex",
          sessionId,
          kind: "stream_failure",
          operation: "receive_worker_stream",
          reason,
          message: evidence,
        },
        "error",
      );
    }
    add(
      {
        source: "adapter",
        harness: "codex",
        sessionId,
        kind: "turn_failure",
        operation: "run_turn",
        reason: "worker_reported_failure",
        message: evidence,
      },
      "error",
    );
    for (const [stage, reason] of [
      ["lookup", "target_lost"],
      ["deliver", "upstream_rejected"],
    ] as const) {
      add(
        {
          source: "core",
          sessionId,
          kind: "authorization_failure",
          operation: "resolve_permission",
          stage,
          reason,
          permissionId: "p1",
        },
        "error",
      );
    }

    const protocolPairs = [
      ["decode_worker_message", "invalid_json"],
      ["decode_worker_message", "invalid_shape"],
      ["decode_worker_message", "unexpected_message"],
      ["validate_daemon_result", "invalid_shape"],
      ["emit_domain_event", "invalid_shape"],
    ] as const;
    for (const [operation, reason] of protocolPairs) {
      add(
        {
          source: "core",
          sessionId,
          kind: "protocol_violation",
          operation,
          reason,
        },
        "error",
      );
    }
    add(
      {
        source: "daemon",
        kind: "protocol_violation",
        operation: "validate_daemon_request",
        stage: "envelope",
        reason: "invalid_shape",
      },
      "error",
    );
    for (const operation of [
      "validate_worker_response",
      "validate_worker_event",
    ] as const)
      for (const reason of ["invalid_shape", "unexpected_message"] as const) {
        add(
          {
            source: "adapter",
            harness: "codex",
            sessionId,
            kind: "protocol_violation",
            operation,
            reason,
          },
          "error",
        );
      }

    const transportPairs = [
      ["listen", "io_error"],
      ["connect", "io_error"],
      ["connect", "timeout"],
      ["connection", "io_error"],
      ["read", "io_error"],
      ["read", "timeout"],
      ["read", "disconnected"],
      ["write", "io_error"],
      ["write", "timeout"],
      ["write", "disconnected"],
      ["close", "io_error"],
      ["close", "timeout"],
      ["close", "disconnected"],
    ] as const;
    for (const [operation, reason] of transportPairs) {
      add(
        {
          source: "daemon",
          kind: "transport_failure",
          operation,
          reason,
        },
        "error",
      );
    }
    add(
      {
        source: "daemon",
        kind: "transport_failure",
        operation: "read",
        reason: "invalid_frame",
        inputBytes: 123,
      },
      "error",
    );

    const storagePairs = [
      ["initialize", "unavailable"],
      ["initialize", "io_error"],
      ["initialize", "corrupt"],
      ["initialize", "invalid_configuration"],
      ["append", "unavailable"],
      ["append", "io_error"],
      ["query", "unavailable"],
      ["query", "io_error"],
      ["query", "corrupt"],
      ["rotate", "unavailable"],
      ["rotate", "io_error"],
      ["recover", "io_error"],
      ["recover", "corrupt"],
      ["lock", "io_error"],
      ["lock", "lock_unavailable"],
      ["close", "io_error"],
      ["allocate_generation", "io_error"],
      ["allocate_generation", "corrupt"],
    ] as const;
    for (const [operation, reason] of storagePairs) {
      add(
        {
          source: "daemon",
          kind: "storage_failure",
          operation,
          reason,
          message: evidence,
        },
        "error",
      );
    }
    add(
      {
        source: "daemon",
        kind: "storage_failure",
        operation: "recover",
        reason: "tail_repaired",
        affectedBytes: 7,
      },
      "warning",
    );
    add(
      {
        source: "harness",
        harness: "codex",
        sessionId,
        kind: "harness_stderr",
        operation: "worker_process",
        reason: "stderr_output",
        text: evidence,
      },
      "info",
    );

    for (const { input, severity } of catalog) {
      ok(diagnosticInputSchema, input);
      ok(diagnosticRecordSchema, {
        ...input,
        v: 1,
        diagnosticId,
        recordedAt: "2026-08-20T00:00:00.000Z",
        severity,
      });
      bad(diagnosticInputSchema, { ...input, sdkField: "not allowed" });
      bad(diagnosticRecordSchema, {
        ...input,
        v: 1,
        diagnosticId,
        recordedAt: "2026-08-20T00:00:00.000Z",
        severity: severity === "error" ? "info" : "error",
      });
    }
  });

  test("diagnostics query distinguishes exact ID and filters", () => {
    ok(diagnosticsParamsSchema, { diagnosticId });
    ok(diagnosticsParamsSchema, { sessionId, turnId: "t1", limit: 100 });
    ok(diagnosticsParamsSchema, {});
    bad(diagnosticsParamsSchema, { diagnosticId, sessionId });
    bad(diagnosticsParamsSchema, { turnId: "t1" });
    bad(diagnosticsParamsSchema, { limit: 0 });
    bad(diagnosticsParamsSchema, { limit: 1001 });
    bad(diagnosticsParamsSchema, { limit: 1.5 });
    bad(diagnosticsParamsSchema, { since: "2026-08-20T00:00:00Z" });
    bad(diagnosticsParamsSchema, {
      since: "2026-02-30T00:00:00.000Z",
      until: "2026-03-01T00:00:00.000Z",
    });
    bad(diagnosticsParamsSchema, {
      since: "2026-08-21T00:00:00.000Z",
      until: "2026-08-20T00:00:00.000Z",
    });
    ok(protocolParamsSchemaFor("diagnostics"), { diagnosticId });
    ok(protocolResultSchemaFor("diagnostics"), { record });
    ok(protocolResultSchemaFor("diagnostics"), {
      records: [record],
      truncated: false,
    });
    bad(diagnosticsResultSchema, { record, records: [], truncated: false });
  });
});

describe("machine errors", () => {
  test("makeErrorCause truncates at a UTF-8 character boundary", () => {
    const ascii = makeErrorCause("exception", "a".repeat(4097));
    expect(Buffer.byteLength(ascii.message, "utf8")).toBe(4096);
    expect(ascii.message).toBe("a".repeat(4096));
    ok(errorCauseSchema, ascii);

    const multibyte = makeErrorCause(
      "upstream",
      "a".repeat(4094) + "€" + "trailing",
    );
    expect(Buffer.byteLength(multibyte.message, "utf8")).toBe(4094);
    expect(multibyte.message).toBe("a".repeat(4094));
    ok(errorCauseSchema, multibyte);
  });

  test("every code is strict and expected errors cannot carry cause", () => {
    ok(machineErrorSchema, { code: "session_not_found", sessionId });
    ok(machineErrorSchema, { code: "diagnostic_not_found", diagnosticId });
    ok(machineErrorSchema, {
      code: "internal_error",
      cause: { kind: "exception", message: "upstream" },
      diagnosticId,
    });
    bad(machineErrorSchema, { code: "session_not_found" });
    bad(machineErrorSchema, {
      code: "session_not_found",
      sessionId,
      cause: { kind: "exception", message: "x" },
    });
    bad(machineErrorSchema, { code: "internal_error", context: {} });
    bad(machineErrorSchema, {
      code: "internal_error",
      cause: { kind: "exception", message: "x".repeat(4097) },
    });
  });

  test("every error code has one strict recoverable shape", () => {
    const errors = [
      { code: "session_not_found", sessionId },
      { code: "session_killed", sessionId },
      {
        code: "invalid_params",
        issues: [{ issue: "invalid_value", path: "message" }],
      },
      { code: "permission_not_pending", sessionId, permissionId: "p1" },
      {
        code: "permission_resolution_mismatch",
        sessionId,
        permissionId: "p1",
      },
      { code: "unknown_harness", harness: "qoder", availableHarnesses: [] },
      { code: "method_not_found", method: "missing" },
      { code: "protocol_error" },
      {
        code: "model_catalog_query_failed",
        cause: { kind: "upstream", message: "failed" },
        diagnosticId,
      },
      {
        code: "internal_error",
        cause: { kind: "exception", message: "failed" },
        diagnosticId,
      },
      { code: "unsupported_feature", feature: "harness_stderr" },
      { code: "diagnostic_not_found", diagnosticId },
      { code: "diagnostics_unavailable" },
      {
        code: "diagnostics_store_corrupt",
        cause: { kind: "io", message: "corrupt" },
      },
      { code: "session_name_conflict", sessionName: "reviewer" },
      { code: "daemon_timeout" },
      { code: "invalid_daemon_response" },
      {
        code: "daemon_start_failed",
        cause: { kind: "timeout", message: "failed" },
      },
      { code: "daemon_disconnected" },
    ];
    for (const error of errors) {
      ok(machineErrorSchema, error);
      bad(machineErrorSchema, { ...error, unexpectedField: true });
    }
    bad(machineErrorSchema, { code: "unknown_error" });

    bad(machineErrorSchema, { code: "invalid_params", issues: [] });
    bad(machineErrorSchema, {
      code: "invalid_params",
      issues: [{ path: "message", reason: "free text" }],
    });
    bad(machineErrorSchema, {
      code: "protocol_error",
      diagnosticId,
    });
  });

  test("expected errors cannot acquire unexpected fields at compile time", () => {
    const typedSessionId = v.parse(sessionIdSchema, sessionId);
    const expected: MachineError = {
      code: "session_not_found",
      sessionId: typedSessionId,
    };
    const expectedWithCause: MachineError = {
      ...expected,
      // @ts-expect-error expected errors never carry cause.
      cause: { kind: "upstream", message: "failed" },
    };
    const expectedWithDiagnostic: MachineError = {
      ...expected,
      // @ts-expect-error expected errors never carry a diagnostic reference.
      diagnosticId,
    };
    const invalidParamsWithoutIssues: MachineError = {
      code: "invalid_params",
      // @ts-expect-error invalid_params always carries at least one issue.
      issues: [],
    };
    void [
      expected,
      expectedWithCause,
      expectedWithDiagnostic,
      invalidParamsWithoutIssues,
    ];
  });

  test("modelCatalog failures carry typed harness failure and optional accepted evidence", () => {
    ok(modelCatalogFailureSchema, {
      harness: "codex",
      code: "model_catalog_query_failed",
      failure: { failureCategory: "unclassified", retryDisposition: "unknown" },
      diagnosticId,
    });
    bad(modelCatalogFailureSchema, {
      harness: "codex",
      code: "session_not_found",
    });
    bad(modelCatalogFailureSchema, {
      harness: "codex",
      code: "model_catalog_query_failed",
      message: "legacy free text",
    });
  });
});
