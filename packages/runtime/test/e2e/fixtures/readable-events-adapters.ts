import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import type {
  AdapterDriverFactory,
  DomainEvent,
  TurnId,
} from "@reins/protocol";

const driverFactory: AdapterDriverFactory = ({ emit }) => {
  let child: ChildProcessWithoutNullStreams;
  let sessionId: Parameters<ReturnType<AdapterDriverFactory>["deliver"]>[0];
  const accepted = new Map<TurnId, () => void>();
  return {
    start(spec) {
      sessionId = spec.sessionId;
      child = spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL("./readable-events-worker.ts", import.meta.url),
          ),
        ],
        { cwd: spec.cwd },
      );
      void (async () => {
        for await (const line of createInterface({ input: child.stdout })) {
          const reply = JSON.parse(line) as
            | { kind: "accepted"; turnId: TurnId }
            | { kind: "event"; event: DomainEvent };
          if (reply.kind === "accepted") {
            accepted.get(reply.turnId)?.();
            accepted.delete(reply.turnId);
          } else emit(reply.event);
        }
      })();
      child.stdin.write(
        JSON.stringify({
          sessionId,
          turnId: spec.turnId,
          message: spec.message,
        }) + "\n",
      );
    },
    async deliver(_sessionId, turnId, message) {
      await new Promise<void>((resolve) => {
        accepted.set(turnId, resolve);
        child.stdin.write(
          JSON.stringify({ sessionId, turnId, message }) + "\n",
        );
      });
    },
    async interrupt() {},
    resolvePermission(_sessionId, permissionId, resolution) {
      child.stdin.write(
        JSON.stringify({ kind: "permission", permissionId, resolution }) + "\n",
      );
    },
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
