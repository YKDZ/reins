import { access, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

import { UNKNOWN_HARNESS_FAILURE } from "@reins/protocol";

const decisions = new Map<string, (resolution: unknown) => void>();
const output = (value: unknown): void => {
  process.stdout.write(JSON.stringify(value) + "\n");
};
async function run(input: {
  sessionId: string;
  turnId: string;
  message: string;
}): Promise<void> {
  const { sessionId, turnId } = input;
  const task = JSON.parse(input.message) as {
    gate: string;
    completionGate?: string;
    reply: string;
    callerMessage?: string;
    permission?: boolean;
    messages?: number;
    deltas?: number;
    replacement?: { draft: string; corrected: string };
    resolutionFile?: string;
    stopReason?: string;
  };
  output({ kind: "accepted", turnId });
  while (
    !(await access(task.gate).then(
      () => true,
      () => false,
    ))
  )
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  const emit = (event: object): void =>
    output({ kind: "event", event: { sessionId, turnId, ...event } });
  if (task.callerMessage !== undefined)
    emit({
      type: "message",
      messageId: "caller-message",
      role: "caller",
      content: task.callerMessage,
    });
  for (let index = 0; index < (task.deltas ?? 0); index += 1)
    emit({ type: "text.delta", messageId: "unclosed", delta: "x" });
  for (let index = 0; index < (task.messages ?? 0); index += 1)
    emit({
      type: "message",
      messageId: "history-" + index,
      role: "worker",
      content: "message " + index,
    });
  if (task.replacement !== undefined) {
    emit({
      type: "text.delta",
      messageId: "reply",
      delta: task.replacement.draft,
    });
    emit({
      type: "message",
      messageId: "reply",
      role: "worker",
      content: task.replacement.corrected,
    });
  } else {
    emit({ type: "text.delta", messageId: "reply", delta: "hello " });
    emit({ type: "text.delta", messageId: "reply", delta: "world" });
    emit({
      type: "message",
      messageId: "reply",
      role: "worker",
      content: "hello world",
      nativeTruncated: true,
    });
  }
  emit({
    type: "tool.requested",
    toolCallId: "read-1",
    name: "read-file",
    input: { path: "report.json", options: { raw: true } },
  });
  emit({
    type: "tool.completed",
    toolCallId: "read-1",
    name: "native-result-name",
    result: { content: "file contents", metadata: { bytes: 13 } },
    isError: false,
  });
  if (task.permission) {
    const resolution = new Promise<unknown>((resolve) =>
      decisions.set("approval", resolve),
    );
    emit({
      type: "permission.requested",
      permissionId: "approval",
      kind: "write",
      input: { path: "caller.txt" },
      options: [
        { outcome: "allow", scope: "once" },
        { outcome: "deny", feedback: true },
      ],
    });
    const decision = await resolution;
    if (task.resolutionFile !== undefined)
      await writeFile(task.resolutionFile, JSON.stringify(decision));
  }
  while (
    task.completionGate !== undefined &&
    !(await access(task.completionGate).then(
      () => true,
      () => false,
    ))
  )
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  emit({
    type: "turn.completed",
    stopReason: task.stopReason ?? "end_turn",
    ...(task.stopReason === "failed"
      ? { failure: UNKNOWN_HARNESS_FAILURE }
      : {}),
    finalReply: task.reply,
  });
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const input = JSON.parse(line);
  if (input.kind === "permission") {
    decisions.get(input.permissionId)?.(input.resolution);
    decisions.delete(input.permissionId);
  } else
    void run(input).catch((error) => {
      process.stderr.write(String(error) + "\n");
      process.exitCode = 1;
    });
});
