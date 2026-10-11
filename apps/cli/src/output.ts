import type {
  CapabilitiesResult,
  DiagnosticsResult,
  DomainEvent,
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
} from "./grammar.ts";

export type OutputMode = "json" | "pretty";

export function printJsonLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function printError(
  error: CliError,
  mode: OutputMode,
  spec?: CommandSpec,
): void {
  const rendered = renderCliError(error, spec);
  if (mode === "json") {
    const message = jsonErrorMessage(rendered);
    printJsonLine({
      ...error,
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
  if (mode === "json") {
    printJsonLine(ack);
  } else {
    process.stdout.write(
      `Sent message ${ack.messageId} (delivery: ${ack.deliveryPoint})\n`,
    );
  }
}

export function printWaitResult(result: WaitResult, mode: OutputMode): void {
  const completed = result.completed.map(({ sessionId, turnId, ...facts }) => ({
    turnHandle: encodeTurnHandle({ sessionId, turnId }),
    ...facts,
  }));
  const pending = result.pending.map((target) => ({
    turnHandle: encodeTurnHandle(target),
  }));
  if (mode === "json") {
    printJsonLine({ status: result.status, completed, pending });
    return;
  }
  if (result.status === "timeout") {
    process.stdout.write("Timed out waiting for turn completion\n");
  }
  for (const turn of completed) {
    process.stdout.write(
      `Turn completed: ${turn.stopReason} (${turn.turnHandle})\n`,
    );
    if (turn.finalReply !== null && turn.finalReply !== undefined) {
      process.stdout.write(`${turn.finalReply}\n`);
    }
  }
  for (const target of pending) {
    process.stdout.write(`Pending: ${target.turnHandle}\n`);
  }
}

export function printInterruptResult(
  outcomes: ProtocolResult<"interrupt">,
  mode: OutputMode,
): void {
  if (mode === "json") {
    printJsonLine(outcomes);
    return;
  }
  for (const outcome of outcomes) {
    if (outcome.status === "idle") {
      process.stdout.write(`Session ${outcome.sessionId} is idle\n`);
    } else {
      process.stdout.write(
        `Interrupted ${outcome.sessionId}${outcome.turnId === undefined ? "" : ` (turn ${outcome.turnId})`}\n`,
      );
    }
  }
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
    printJsonLine(ack);
    return;
  }
  process.stdout.write(
    `Resolved permission ${ack.permissionId} on session ${ack.sessionId}\n`,
  );
}

export function printCapabilitiesResult(
  result: CapabilitiesResult,
  mode: OutputMode,
): void {
  if (mode === "json") {
    printJsonLine(result);
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
    const cause = failure.cause?.message ?? "no cause provided";
    const diagnostic =
      failure.diagnosticId === undefined
        ? ""
        : ` (diagnostic: ${failure.diagnosticId})`;
    process.stderr.write(
      `warning: capability query failed for ${failure.harness}: ${cause}${diagnostic}\n`,
    );
  }
}

export function printNotification(
  kind: "event" | "attach.ended",
  params: unknown,
  mode: OutputMode,
): void {
  if (mode === "json") {
    printJsonLine({
      kind: "notification",
      method: kind,
      params,
    });
    return;
  }
  if (kind === "attach.ended") {
    const ended = params as { sessionId: string; reason: string };
    process.stdout.write(
      `[attach ended] ${ended.sessionId}: ${ended.reason}\n`,
    );
    return;
  }
  printPrettyEvent(params as DomainEvent);
}

function printPrettyEvent(event: DomainEvent): void {
  switch (event.type) {
    case "text.delta":
      process.stdout.write(event.delta);
      break;
    case "message":
      process.stdout.write(
        `${event.role === "worker" ? "worker" : "caller"}: ${event.content}\n`,
      );
      break;
    case "tool.requested":
      process.stdout.write(
        `[tool] ${event.name} requested (${event.toolCallId})\n`,
      );
      break;
    case "tool.completed":
      process.stdout.write(
        `[tool] ${event.name} completed (${event.toolCallId})${event.isError ? " with error" : ""}\n`,
      );
      break;
    case "permission.resolved":
      process.stdout.write(
        `[permission] resolved ${event.permissionId}: ${JSON.stringify(event.resolution)}\n`,
      );
      break;
    case "turn.completed":
      process.stdout.write(
        `[turn completed] ${event.stopReason} (${event.sessionId})\n`,
      );
      if (event.usage !== undefined) {
        process.stdout.write(`usage: ${JSON.stringify(event.usage)}\n`);
      }
      break;
    case "session.created":
    case "session.killed":
    case "turn.started":
      break;
    case "permission.requested":
      break;
  }
}
