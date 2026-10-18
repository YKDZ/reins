#!/usr/bin/env node

import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

let eventPosition = 0;
function encodeMessage(value) {
  if (
    value.kind === "notification" &&
    value.method === "event" &&
    value.params.sessionId !== undefined
  )
    value = {
      ...value,
      params: {
        subscriptionId: "subscription-fixture",
        eventId: ++eventPosition,
        event: value.params,
      },
    };
  if (
    value.kind === "response" &&
    value.result?.sessionId !== undefined &&
    value.result.replayed !== undefined
  )
    value = {
      ...value,
      result: {
        ...value.result,
        subscriptionId: "subscription-fixture",
        target: {
          scope: "turn",
          sessionId: "session:00000000-0000-4000-8000-000000000000:prompt:1",
          turnId: "t1",
        },
        window: { oldest: null, head: null, truncated: false },
      },
    };
  return JSON.stringify(value);
}
const mode = process.env.REINS_FIXTURE_DAEMON_MODE ?? "invalid-envelope";
const socketPath = process.env.REINS_SOCKET;
const pidFile = process.env.REINS_FIXTURE_PID_FILE;
const exitFile = process.env.REINS_FIXTURE_EXIT_FILE;
const requestsFile = process.env.REINS_FIXTURE_REQUESTS_FILE;

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

if (mode === "startup-failure") {
  const fd = Number(process.env.REINS_STARTUP_FD ?? "3");
  const startupFailure = {
    v: 1,
    cause: {
      kind: "upstream",
      message: "é".repeat(3_000),
    },
  };
  writeFileSync(fd, `${encodeMessage(startupFailure)}\n`);
  process.exit(23);
}

if (mode === "startup-transport-lookalike") {
  const fd = Number(process.env.REINS_STARTUP_FD ?? "3");
  writeFileSync(
    fd,
    `${encodeMessage({
      v: 1,
      cause: { kind: "io", message: "transport:address_in_use" },
    })}\n`,
  );
  process.exit(23);
}

if (mode === "startup-transport-address-in-use") {
  const fd = Number(process.env.REINS_STARTUP_FD ?? "3");
  writeFileSync(
    fd,
    `${encodeMessage({
      v: 1,
      transport: { code: "address_in_use" },
    })}\n`,
  );
  process.exit(23);
}

if (mode === "startup-signal") {
  process.kill(process.pid, "SIGTERM");
}

if (mode === "startup-report-drain") {
  const fd = Number(process.env.REINS_STARTUP_FD ?? "3");
  writeFileSync(
    fd,
    `${encodeMessage({
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
    `${encodeMessage({
      v: 1,
      cause: { kind: "upstream", message: "late complete startup report" },
    })}\n`,
  );
  process.exit(25);
}

if (mode === "startup-never-listens") {
  await new Promise((resolve) => setInterval(resolve, 60_000));
}

if (socketPath === undefined) throw new Error("REINS_SOCKET is required");

if (mode === "cold-launch-barrier") {
  // 保证两个程序化入口都完成首次无 socket 探测后，唯一 launcher 才开始监听。
  await new Promise((resolve) => setTimeout(resolve, 300));
  let served = 0;
  const sockets = new Set();
  const barrierServer = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk;
      for (;;) {
        const newline = input.indexOf("\n");
        if (newline === -1) break;
        const request = JSON.parse(input.slice(0, newline));
        input = input.slice(newline + 1);
        if (request.method === "initialize") {
          socket.write(
            `${encodeMessage({
              kind: "response",
              requestId: request.requestId,
              result: {
                protocolMajorVersion: 1,
                daemonGeneration: "gfixture",
                runtimeScopeId: request.params.runtimeScopeId,
              },
            })}\n`,
          );
          continue;
        }
        socket.write(
          `${encodeMessage({
            kind: "response",
            requestId: request.requestId,
            result: { catalogs: [], failures: [] },
          })}\n`,
        );
        served += 1;
        if (served === 2) {
          setTimeout(() => {
            for (const peer of sockets) peer.end();
            barrierServer.close(() => process.exit(0));
          }, 20);
        }
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });
  barrierServer.listen(socketPath);
  await new Promise(() => {});
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
      // 消费者绑定握手是连接建立的一部分；timeout 验证其传输预算，
      // 其余 mode 的反例作用在领域请求上，不为 wait 设置隐式期限。
      if (mode === "timeout") continue;
      if (request.method === "initialize") {
        if (mode === "initialize-close") {
          socket.end();
          continue;
        }
        socket.write(
          `${encodeMessage({
            kind: "response",
            requestId: request.requestId,
            result: {
              protocolMajorVersion: 1,
              daemonGeneration: "gfixture",
              runtimeScopeId: request.params.runtimeScopeId,
            },
          })}\n`,
        );
        continue;
      }
      if (mode === "invalid-envelope") {
        socket.write(
          `${encodeMessage({ kind: "response", requestId: request.requestId })}\n`,
        );
      } else if (mode === "invalid-error") {
        socket.write(
          `${encodeMessage({
            kind: "response",
            requestId: request.requestId,
            error: { code: "session_not_found" },
          })}\n`,
        );
      } else if (mode === "invalid-notification") {
        socket.write(
          `${encodeMessage({
            kind: "notification",
            method: "event",
            params: { type: "sdk.raw" },
          })}\n`,
        );
      } else if (mode === "invalid-result") {
        socket.write(
          `${encodeMessage({
            kind: "response",
            requestId: request.requestId,
            result: {},
          })}\n`,
        );
      } else if (mode === "prompt-disconnect" && request.method === "attach") {
        for (const permissionId of ["p1", "p2"]) {
          socket.write(
            `${encodeMessage({
              kind: "notification",
              method: "event",
              params: {
                type: "permission.requested",
                sessionId:
                  "session:00000000-0000-4000-8000-000000000000:prompt:1",
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
          `${encodeMessage({
            kind: "response",
            requestId: request.requestId,
            result: {
              sessionId:
                "session:00000000-0000-4000-8000-000000000000:prompt:1",
              replayed: 1,
            },
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
