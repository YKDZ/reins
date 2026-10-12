import { encodePermissionHandle, makeErrorCause } from "@reins/protocol";
import type {
  CapabilitiesResult,
  DiagnosticsResult,
  KillResult,
  ProtocolResult,
  SessionInfo,
  SendAck,
  WaitResult,
  SpawnAck,
} from "@reins/protocol";
import { encodeTurnHandle } from "@reins/protocol";

import { fullUsageFor, type CommandSpec } from "./command-spec.ts";
import type { CliError } from "./errors.ts";
import {
  isUsageClassError,
  jsonErrorMessage,
  renderCliError,
  transportErrorMessage,
} from "./grammar.ts";
import { harnessFailureMessage } from "./harness-failure.ts";

export type OutputMode = "json" | "pretty";

export function printJsonLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function printResult(value: unknown, mode: OutputMode): void {
  process.stdout.write(
    `${JSON.stringify(value, null, mode === "pretty" ? 2 : undefined)}\n`,
  );
}

export function printError(
  error: CliError,
  mode: OutputMode,
  spec?: CommandSpec,
): void {
  const rendered = renderCliError(error, spec);
  if (mode === "json") {
    const message = jsonErrorMessage(rendered);
    const projected = jsonErrorProjection(error);
    printJsonLine({
      ...projected,
      message:
        "diagnosticId" in error && error.diagnosticId !== undefined
          ? `${message}. reins diagnostics --id ${error.diagnosticId}`
          : message,
      ...(isUsageClassError(error)
        ? { usage: `reins ${fullUsageFor(spec)}` }
        : {}),
    });
    return;
  }
  for (const item of rendered.items) {
    process.stderr.write(`error: ${item.message}\n`);
    if (item.suggestion !== undefined) {
      process.stderr.write(`suggestion: ${item.suggestion}\n`);
    }
  }
  if ("diagnosticId" in error && error.diagnosticId !== undefined) {
    process.stderr.write(`diagnostic: ${error.diagnosticId}\n`);
    process.stderr.write(
      `suggestion: reins diagnostics --id ${error.diagnosticId}\n`,
    );
  }
  if (isUsageClassError(error)) {
    process.stderr.write(`usage: reins ${fullUsageFor(spec)}\n`);
  }
}

function jsonErrorProjection(error: CliError): object {
  if ("permissionId" in error) {
    return { code: error.code, sessionId: error.sessionId };
  }
  if (error.code === "daemon_start_failed" && "transportCode" in error) {
    return {
      code: error.code,
      cause: makeErrorCause("io", transportErrorMessage(error.transportCode)),
    };
  }
  return error;
}

export function printSpawnResult(result: SpawnAck, mode: OutputMode): void {
  const turnHandle = encodeTurnHandle({
    sessionId: result.sessionId,
    turnId: result.turnId,
  });
  if (mode === "json") {
    printJsonLine({ sessionId: result.sessionId, turnHandle, cwd: result.cwd });
  } else {
    process.stdout.write(
      `Created session ${result.sessionId}\nTurn ${turnHandle}\nWorking directory ${result.cwd}\n`,
    );
  }
}

export function printDiagnosticsResult(
  result: DiagnosticsResult,
  mode: OutputMode,
): void {
  if (mode === "json") {
    printJsonLine(result);
    return;
  }
  if ("record" in result) {
    process.stdout.write(`${JSON.stringify(result.record, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(result.records, null, 2)}\n`);
  process.stdout.write(`truncated: ${result.truncated}\n`);
}

export function printSendAck(ack: SendAck, mode: OutputMode): void {
  const turnHandle = encodeTurnHandle({
    sessionId: ack.sessionId,
    turnId: ack.turnId,
  });
  if (mode === "json") printJsonLine({ sessionId: ack.sessionId, turnHandle });
  else process.stdout.write(`Sent message to ${turnHandle}\n`);
}

export function printWaitResult(
  result: WaitResult & {
    publications?: import("@reins/workspace-protocol").Publication[];
    publicationError?: import("@reins/workspace-protocol").WorkspaceError;
  },
  mode: OutputMode,
): void {
  const completed = result.completed.map(({ sessionId, turnId, ...facts }) => ({
    turnHandle: encodeTurnHandle({ sessionId, turnId }),
    ...facts,
    ...(facts.stopReason === "failed"
      ? { message: harnessFailureMessage(facts.failure, facts.diagnosticId) }
      : {}),
  }));
  const pending = result.pending.map((target) => ({
    turnHandle: encodeTurnHandle(target),
  }));
  if (mode === "json") {
    printJsonLine({
      status: result.status,
      completed,
      pending,
      ...(result.publications === undefined
        ? {}
        : { publications: result.publications }),
      ...(result.publicationError === undefined
        ? {}
        : { publicationError: result.publicationError }),
    });
    return;
  }
  if (result.status === "timeout") {
    process.stdout.write("Timed out waiting for turn completion\n");
  }
  for (const turn of completed) {
    process.stdout.write(
      `Turn completed: ${turn.stopReason} (${turn.turnHandle})\n`,
    );
    if (turn.stopReason === "failed")
      process.stdout.write(
        `${harnessFailureMessage(turn.failure, turn.diagnosticId)}\n`,
      );
    if (turn.finalReply !== null && turn.finalReply !== undefined) {
      process.stdout.write(`${turn.finalReply}\n`);
    }
  }
  for (const publication of result.publications ?? [])
    process.stdout.write(
      `[publication ready] ${publication.publicationId} ${publication.source.path} (${publication.bytes} bytes)\n`,
    );
  if (result.publicationError)
    process.stdout.write(
      `[publication discovery failed] ${result.publicationError.code}\n`,
    );
  for (const target of pending) {
    process.stdout.write(`Pending: ${target.turnHandle}\n`);
  }
}

export function printInterruptResult(
  result: ProtocolResult<"interrupt">,
  mode: OutputMode,
): void {
  const turnHandle = encodeTurnHandle(result);
  if (mode === "json") {
    printJsonLine({ sessionId: result.sessionId, turnHandle });
    return;
  }
  process.stdout.write(`Stop request accepted: ${turnHandle}\n`);
}

export function printKillResult(result: KillResult, mode: OutputMode): void {
  if (mode === "json") {
    printJsonLine(result);
    return;
  }
  if (result.status === "killed") {
    process.stdout.write(`Killed ${result.sessionId}\n`);
  } else {
    process.stdout.write(`Session ${result.sessionId} not found\n`);
  }
}

export function printListResult(
  sessions: SessionInfo[],
  mode: OutputMode,
): void {
  const projected = sessions.map((session) => {
    const { lastCompletedTurn, ...rest } = session;
    const { activeTurnId: _activeTurnId, ...common } = rest as typeof rest & {
      activeTurnId?: string;
    };
    return {
      ...common,
      ...(session.state === "busy"
        ? {
            activeTurnHandle: encodeTurnHandle({
              sessionId: session.sessionId,
              turnId: session.activeTurnId,
            }),
          }
        : {}),
      ...(lastCompletedTurn === undefined
        ? {}
        : {
            lastCompletedTurn: {
              turnHandle: encodeTurnHandle({
                sessionId: session.sessionId,
                turnId: lastCompletedTurn.turnId,
              }),
              stopReason: lastCompletedTurn.stopReason,
            },
          }),
    };
  });
  if (mode === "json") {
    printJsonLine(projected);
    return;
  }
  if (sessions.length === 0) {
    process.stdout.write("No sessions found\n");
    return;
  }
  for (const session of projected) {
    process.stdout.write(
      `${session.sessionId}\t${session.harness}\t${session.state}\t${session.model ?? "-"}\t${session.turns}\t${session.lastCompletedTurn?.stopReason ?? "-"}\t${session.cwd}\t${session.activeTurnHandle ?? "-"}\t${session.lastCompletedTurn?.turnHandle ?? "-"}\n`,
    );
  }
}

export function printResolvePermissionAck(
  ack: ProtocolResult<"resolvePermission">,
  mode: OutputMode,
): void {
  if (mode === "json") {
    printJsonLine({
      permissionHandle: encodePermissionHandle({
        sessionId: ack.sessionId,
        turnId: ack.turnId,
        permissionId: ack.permissionId,
      }),
      status: "resolved",
    });
    return;
  }
  process.stdout.write("Permission resolved\n");
}

export function printCapabilitiesResult(
  result: CapabilitiesResult,
  mode: OutputMode,
): void {
  if (mode === "json") {
    printJsonLine({
      ...result,
      failures: result.failures.map((failure) => ({
        ...failure,
        message: harnessFailureMessage(failure.failure, failure.diagnosticId),
      })),
    });
    return;
  }
  for (const capability of result.capabilities) {
    process.stdout.write(`${capability.harness}\n`);
    for (const model of capability.models) {
      const efforts =
        model.reasoningEfforts.length === 0
          ? "(no reasoning efforts)"
          : model.reasoningEfforts.join(", ");
      process.stdout.write(
        `  ${model.id} (${model.displayName}): ${efforts}\n`,
      );
    }
  }
  for (const failure of result.failures) {
    process.stderr.write(
      `warning: capability query failed for ${failure.harness}: ${harnessFailureMessage(failure.failure, failure.diagnosticId)}\n`,
    );
  }
}

export function printAgentEvent(
  event: import("@reins/client").AgentEvent,
  mode: OutputMode,
): void {
  if (mode === "json") {
    printJsonLine(
      event.type === "turn.completed" && event.stopReason === "failed"
        ? {
            ...event,
            message: harnessFailureMessage(event.failure, event.diagnosticId),
          }
        : event,
    );
    return;
  }
  if (event.type === "publication.ready") {
    const publication = event.publication;
    process.stdout.write(
      `[publication ready] ${publication.publicationId} ${publication.source.path} (${publication.bytes} bytes)\n`,
    );
  } else if (event.type === "text") {
    if (event.start && event.complete) process.stdout.write(event.role + ": ");
    process.stdout.write(event.content);
    if (event.complete && !event.content.endsWith("\n"))
      process.stdout.write("\n");
  } else if (
    event.type === "tool.requested" ||
    event.type === "tool.completed"
  ) {
    process.stdout.write(
      `[tool] ${event.name} ${event.type === "tool.requested" ? "requested" : "completed"}\n`,
    );
  } else if (event.type === "permission.resolved")
    process.stdout.write(`[permission] resolved ${event.permissionHandle}\n`);
  else if (event.type === "turn.completed") {
    process.stdout.write(`[turn completed] ${event.stopReason}\n`);
    if (event.stopReason === "failed")
      process.stdout.write(
        `${harnessFailureMessage(event.failure, event.diagnosticId)}\n`,
      );
    if (event.usage !== undefined)
      process.stdout.write(`usage: ${JSON.stringify(event.usage)}\n`);
  }
}
