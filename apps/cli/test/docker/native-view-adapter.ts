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
  const accepted = new Map<
    TurnId,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  return {
    start(spec) {
      child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./native-view-worker.ts", import.meta.url))],
        { cwd: spec.cwd },
      );
      child.once("close", () => {
        for (const pending of accepted.values())
          pending.reject(
            new Error("Fixture worker stopped before native acceptance"),
          );
        accepted.clear();
      });
      void (async () => {
        for await (const line of createInterface({ input: child.stdout })) {
          const reply = JSON.parse(line) as
            | { kind: "accepted"; turnId: TurnId }
            | { kind: "event"; event: DomainEvent };
          if (reply.kind === "accepted") {
            accepted.get(reply.turnId)?.resolve();
            accepted.delete(reply.turnId);
          } else emit(reply.event);
        }
      })();
      child.stdin.write(JSON.stringify(spec) + "\n");
    },
    async deliver(sessionId, turnId, message) {
      await new Promise<void>((resolve, reject) => {
        accepted.set(turnId, { resolve, reject });
        child.stdin.write(
          JSON.stringify({ sessionId, turnId, message }) + "\n",
        );
      });
    },
    async interrupt() {},
    resolvePermission(_sessionId, _permissionId, resolution) {
      child.stdin.write(
        JSON.stringify({ kind: "resolution", resolution }) + "\n",
      );
    },
    async terminate() {
      if (child.exitCode !== null || child.signalCode !== null) return;
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
