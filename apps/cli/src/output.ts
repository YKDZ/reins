import { encodePermissionHandle, makeErrorCause } from "@reins/protocol";
import type {
  DiagnosticsResult,
  ProtocolResult,
  SendAck,
  WaitResult,
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
