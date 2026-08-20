#!/usr/bin/env node

import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

const mode = process.env.REINS_FIXTURE_DAEMON_MODE ?? "invalid-envelope";
const socketPath = process.env.REINS_SOCKET;
const pidFile = process.env.REINS_FIXTURE_PID_FILE;
const exitFile = process.env.REINS_FIXTURE_EXIT_FILE;
const requestsFile = process.env.REINS_FIXTURE_REQUESTS_FILE;

if (pidFile !== undefined) writeFileSync(pidFile, String(process.pid));
process.on("exit", () => {
  if (exitFile !== undefined) writeFileSync(exitFile, "exited\n");
});

if (mode === "startup-failure") {
  const fd = Number(process.env.REINS_STARTUP_FD ?? "3");
  const startupFailure = {
    v: 1,
    cause: {
      kind: "upstream",
      message: "é".repeat(3_000),
    },
  };
  writeFileSync(fd, `${JSON.stringify(startupFailure)}\n`);
  process.exit(23);
}

if (mode === "startup-signal") {
  process.kill(process.pid, "SIGTERM");
}

if (mode === "startup-report-drain") {
  const fd = Number(process.env.REINS_STARTUP_FD ?? "3");
  writeFileSync(
    fd,
    `${JSON.stringify({
      v: 1,
      cause: {
        kind: "upstream",
        message: `report-before-exit:${"界".repeat(2_000)}`,
      },
    })}\n`,
  );
  process.exit(24);
}

if (mode === "startup-report-late") {
  const fd = Number(process.env.REINS_STARTUP_FD ?? "3");
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  writeFileSync(
    fd,
    `${JSON.stringify({
      v: 1,
      cause: { kind: "upstream", message: "late complete startup report" },
    })}\n`,
  );
  process.exit(25);
}

if (socketPath === undefined) throw new Error("REINS_SOCKET is required");

if (mode === "append-failure") {
  const { createDaemonForTest } =
    await import("../../../../../packages/daemon/dist/daemon.testing.js");
  const { openDiagnosticsRuntimeForTest } =
    await import("../../../../../packages/daemon/dist/diagnostics-recorder.testing.js");
  const { createUnixSocketServer } =
    await import("../../../../../packages/transport/dist/index.js");
  const store = {
    async append() {
      throw new Error("injected append failure");
    },
    async query() {
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
          deliver() {},
          interrupt() {},
          resolvePermission() {},
          terminate() {},
        }),
      },
    ],
  ]);
  const daemon = createDaemonForTest({
    transport: createUnixSocketServer({ path: socketPath }),
    adapters,
    identity: { session: (name) => `${name}@g1` },
    diagnostics,
    idleTimeoutMs: 100,
  });
  await daemon.start();
  await diagnostics.close();
  process.exit(0);
}

const server = createServer((socket) => {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const request = JSON.parse(line);
      if (requestsFile !== undefined) {
        appendFileSync(requestsFile, `${request.method}\n`);
      }
      if (mode === "timeout") continue;
      if (mode === "invalid-envelope" || mode === "attach-invalid-envelope") {
        socket.write(
          `${JSON.stringify({ kind: "response", requestId: request.requestId })}\n`,
        );
      } else if (mode === "invalid-error" || mode === "attach-invalid-error") {
        socket.write(
          `${JSON.stringify({
            kind: "response",
            requestId: request.requestId,
            error: { code: "session_not_found" },
          })}\n`,
        );
      } else if (
        mode === "invalid-notification" ||
        mode === "attach-invalid-notification"
      ) {
        socket.write(
          `${JSON.stringify({
            kind: "notification",
            method: "event",
            params: { type: "sdk.raw" },
          })}\n`,
        );
      } else if (
        mode === "invalid-result" ||
        mode === "attach-invalid-result"
      ) {
        socket.write(
          `${JSON.stringify({
            kind: "response",
            requestId: request.requestId,
            result: {},
          })}\n`,
        );
      } else if (
        mode === "attach-invalid-after-response" &&
        request.method === "attach"
      ) {
        socket.write(
          `${JSON.stringify({
            kind: "response",
            requestId: request.requestId,
            result: { sessionId: "prompt@g1", replayed: 0 },
          })}\n`,
        );
        socket.write(
          `${JSON.stringify({
            kind: "notification",
            method: "event",
            params: { type: "sdk.raw" },
          })}\n`,
        );
      } else if (mode === "prompt-disconnect" && request.method === "attach") {
        for (const permissionId of ["p1", "p2"]) {
          socket.write(
            `${JSON.stringify({
              kind: "notification",
              method: "event",
              params: {
                type: "permission.requested",
                sessionId: "prompt@g1",
                turnId: "t1",
                permissionId,
                kind: "tool:Bash",
                options: [
                  { outcome: "allow", scope: "once" },
                  { outcome: "deny", feedback: false },
                ],
              },
            })}\n`,
          );
        }
        socket.write(
          `${JSON.stringify({
            kind: "response",
            requestId: request.requestId,
            result: { sessionId: "prompt@g1", replayed: 1 },
          })}\n`,
        );
        setTimeout(() => socket.end(), 100);
      }
    }
  });
  socket.on("close", () => {
    server.close();
  });
});

server.listen(socketPath);
