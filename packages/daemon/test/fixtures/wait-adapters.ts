import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import type { AdapterDriverFactory, StopReason, TurnId } from "@reins/protocol";

const driverFactory: AdapterDriverFactory = ({emit}) => {
  let child: ChildProcessWithoutNullStreams;
  let sessionId: Parameters<ReturnType<AdapterDriverFactory>["deliver"]>[0];
  return {
    start(spec) {
      sessionId = spec.sessionId;
      child = spawn(process.execPath, [fileURLToPath(new URL("./wait-worker.ts", import.meta.url))], {cwd: spec.cwd});
      void (async () => {
        for await (const line of createInterface({input: child.stdout})) {
          const reply = JSON.parse(line) as {turnId: TurnId; stopReason: StopReason; finalReply: string};
          emit({type: "turn.completed", sessionId, ...reply});
        }
      })();
      child.stdin.write(JSON.stringify({turnId: spec.turnId, message: spec.message}) + "\n");
    },
    async deliver(_sessionId, turnId, message) {
      child.stdin.write(JSON.stringify({turnId, message}) + "\n");
    },
    interrupt() {},
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
export default {codex: {driverFactory, capabilities: async () => ({harness: "codex", models: []})}};
