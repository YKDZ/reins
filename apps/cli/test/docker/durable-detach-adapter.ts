import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import type {
  AdapterDriverFactory,
  DomainEvent,
  TurnId,
} from "@reins/protocol";

const driverFactory: AdapterDriverFactory = ({ emit }) => {
  let child: ChildProcessWithoutNullStreams;
  let terminationFailure: string | undefined;
  const accepted = new Map<TurnId, () => void>();
  return {
    start(spec) {
      const task = JSON.parse(spec.message) as {
        path?: string;
        failTerminate?: boolean;
      };
      if (task.failTerminate)
        terminationFailure = join(spec.cwd, "provider-fail");
      child = spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL(
              task.path === undefined
                ? "./native-view-worker.ts"
                : "./workspace-reading-worker.ts",
              import.meta.url,
            ),
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
      child.stdin.write(JSON.stringify(spec) + "\n");
    },
    async deliver(sessionId, turnId, message) {
      await new Promise<void>((resolve) => {
        accepted.set(turnId, resolve);
        child.stdin.write(
          JSON.stringify({ sessionId, turnId, message }) + "\n",
        );
      });
    },
    async interrupt() {},
    resolvePermission() {},
    async terminate() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (terminationFailure !== undefined) {
        await writeFile(terminationFailure, "Native termination rejected");
        throw new Error("Fixture native termination rejected");
      }
      await new Promise<void>((resolve) => {
        child.once("close", resolve);
        child.kill("SIGTERM");
      });
    },
  };
};
export default new Map(
  ["codex", "qoder"].map((harness) => [
    harness,
    { driverFactory, capabilities: async () => ({ harness, models: [] }) },
  ]),
);
