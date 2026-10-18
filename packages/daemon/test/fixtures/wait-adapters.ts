import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import type { AdapterDriverFactory, StopReason, TurnId } from "@reins/protocol";

const driverFactory: AdapterDriverFactory = ({ emit }) => {
  let child: ChildProcessWithoutNullStreams;
  let sessionId: Parameters<ReturnType<AdapterDriverFactory>["deliver"]>[0];
  const accepted = new Map<TurnId, () => void>();
  return {
    start(spec) {
      sessionId = spec.sessionId;
      child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./wait-worker.ts", import.meta.url))],
        { cwd: spec.cwd },
      );
      void (async () => {
        for await (const line of createInterface({ input: child.stdout })) {
          const reply = JSON.parse(line) as
            | { kind: "accepted"; turnId: TurnId }
            | {
                kind: "completed";
                turnId: TurnId;
                stopReason: StopReason;
                finalReply: string;
              };
          if (reply.kind === "accepted") {
            accepted.get(reply.turnId)?.();
            accepted.delete(reply.turnId);
          } else
            emit({
              type: "turn.completed",
              sessionId,
              turnId: reply.turnId,
              ...(reply.stopReason === "failed"
                ? {
                    stopReason: reply.stopReason,
                    failure: {
                      failureCategory: "unclassified" as const,
                      retryDisposition: "unknown" as const,
                    },
                  }
                : { stopReason: reply.stopReason }),
              finalReply: reply.finalReply,
            });
        }
      })();
      child.stdin.write(
        JSON.stringify({ turnId: spec.turnId, message: spec.message }) + "\n",
      );
    },
    async deliver(_sessionId, turnId, message) {
      await new Promise<void>((resolve) => {
        accepted.set(turnId, resolve);
        child.stdin.write(JSON.stringify({ turnId, message }) + "\n");
      });
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
