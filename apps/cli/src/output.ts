import { encodePermissionHandle, makeErrorCause } from "@reins/protocol";
import type { DiagnosticsResult, ProtocolResult } from "@reins/protocol";

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
