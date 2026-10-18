import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import type { AdapterDriverFactory, WorkerSpec } from "@reins/protocol";

const driverFactory: AdapterDriverFactory = ({ emit }) => {
  let child: ChildProcessWithoutNullStreams;
  let current: Pick<WorkerSpec, "sessionId" | "turnId">;
  return {
    async start(spec) {
      current = { sessionId: spec.sessionId, turnId: spec.turnId };
      child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./cwd-worker.ts", import.meta.url))],
        { cwd: spec.cwd },
      );
      void (async () => {
        for await (const reply of createInterface({ input: child.stdout })) {
          emit({
            type: "turn.completed",
            ...current,
            stopReason: "end_turn",
            finalReply: reply,
          });
        }
      })();
      child.stdin.write(`${JSON.stringify({ message: spec.message })}\n`);
    },
    async deliver(sessionId, turnId, message) {
      current = { sessionId, turnId };
      child.stdin.write(`${JSON.stringify({ message })}\n`);
    },
    async interrupt() {},
    resolvePermission() {},
    async terminate() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        child.once("close", () => resolve());
        child.kill("SIGTERM");
      });
    },
  };
};

export default {
  codex: {
    driverFactory,
    modelCatalog: async () => ({ harness: "codex", models: [] }),
  },
};
