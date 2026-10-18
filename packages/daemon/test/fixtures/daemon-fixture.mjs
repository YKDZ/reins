#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
const mode = process.env.REINS_FIXTURE_DAEMON_MODE ?? "invalid-envelope";
const socketPath = process.env.REINS_SOCKET;
const pidFile = process.env.REINS_FIXTURE_PID_FILE;
const exitFile = process.env.REINS_FIXTURE_EXIT_FILE;

if (pidFile !== undefined) {
  if (mode === "cold-launch-barrier") {
    appendFileSync(pidFile, `${process.pid}\n`);
  } else {
    writeFileSync(pidFile, String(process.pid));
  }
}
process.on("exit", () => {
  if (exitFile !== undefined) writeFileSync(exitFile, "exited\n");
});

if (mode === "append-failure") {
  const { createDaemonForTest } = await import("../../dist/daemon.testing.js");
  const { openDiagnosticsRuntimeForTest } =
    await import("../../dist/diagnostics-recorder.testing.js");
  const { createUnixSocketServer } = await import("@reins/transport");
  const accepted = [];
  const store = {
    async append(record) {
      if (accepted.length === 0) {
        accepted.push(record);
        return;
      }
      throw new Error("injected append failure");
    },
    async query(params) {
      if ("diagnosticId" in params) {
        const record = accepted.find(
          (candidate) => candidate.diagnosticId === params.diagnosticId,
        );
        if (record !== undefined) return { record };
      }
      return { records: [], truncated: false };
    },
    health() {
      return { status: "healthy", repairs: [] };
    },
    async close() {},
  };
  const diagnostics = await openDiagnosticsRuntimeForTest({
    async resolveState() {
      return {
        directory: "/fixture",
        diagnosticsDirectory: "/fixture/diagnostics",
        durable: false,
        retention: { maxAgeMs: 1, maxBytes: 1 },
      };
    },
    async openStore() {
      return store;
    },
    async allocateGeneration() {
      return "1";
    },
  });
  const adapters = new Map([
    [
      "explode",
      {
        capabilities: async () => ({
          harness: "explode",
          models: [
            {
              id: "explode-model",
              displayName: "explode model",
              reasoningEfforts: [],
            },
          ],
        }),
        driverFactory: () => ({
          start() {
            throw new Error("worker start exploded");
          },
          async deliver() {},
          interrupt() {},
          resolvePermission() {},
          terminate() {},
        }),
      },
    ],
  ]);
  let sessionCounter = 0;
  const daemon = createDaemonForTest({
    transport: createUnixSocketServer({ path: socketPath }),
    adapters,
    identity: { session: () => `session:daemon-fixture:${++sessionCounter}` },
    diagnostics,
    idleTimeoutMs: 100,
  });
  await daemon.start();
  await diagnostics.close();
  process.exit(0);
}
