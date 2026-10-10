import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, access, stat } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseRetryToken } from "@reins/client";
import { decodeTurnHandle } from "@reins/protocol";
import { afterEach, expect, test } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const cliBin = join(root, "apps/cli/dist/reins.js");
const daemonBin = join(root, "packages/daemon/dist/main.js");
const fixture = join(root, "apps/cli/test/e2e/fixtures/fake-adapters.ts");
const daemons: ChildProcess[] = [];
const directories: string[] = [];
const sockets = new Set<Socket>();
const servers: ReturnType<typeof createServer>[] = [];
const sleep = async (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function stop(daemon: ChildProcess): Promise<void> {
  if (daemon.exitCode !== null || daemon.signalCode !== null) return;
  const done = new Promise<void>((resolve) =>
    daemon.once("close", () => resolve()),
  );
  daemon.kill("SIGTERM");
  await done;
}
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const daemon of daemons.splice(0)) await stop(daemon);
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function start(env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const daemon = spawn(process.execPath, [daemonBin, "--adapters", fixture], {
    env: { ...process.env, ...env },
    stdio: "ignore",
  });
  daemons.push(daemon);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(env.REINS_SOCKET!);
      return daemon;
    } catch {
      await sleep(10);
    }
  }
  throw new Error("Daemon did not open its socket");
}
async function cli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [cliBin, ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (data) => {
    stdout += String(data);
  });
  child.stderr.on("data", (data) => {
    stderr += String(data);
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

// 真 Unix 代理只丢弃已收到的 spawn ACK；上游 daemon 与 adapter 已执行，
// 不替代业务模块，也不靠超时猜测是否发生了效果。
async function dropSpawnAck(
  proxyPath: string,
  targetPath: string,
): Promise<void> {
  const server = createServer((downstream) => {
    const upstream = createConnection(targetPath);
    sockets.add(downstream);
    sockets.add(upstream);
    let requests = "",
      responses = "";
    let spawnId: string | undefined;
    downstream.on("data", (chunk) => {
      requests += String(chunk);
      let lineEnd: number;
      while ((lineEnd = requests.indexOf("\n")) !== -1) {
        const line = requests.slice(0, lineEnd);
        requests = requests.slice(lineEnd + 1);
        const request = JSON.parse(line) as {
          method: string;
          requestId: string;
        };
        if (request.method === "spawn") spawnId = request.requestId;
        upstream.write(line + "\n");
      }
    });
    upstream.on("data", (chunk) => {
      responses += String(chunk);
      let lineEnd: number;
      while ((lineEnd = responses.indexOf("\n")) !== -1) {
        const line = responses.slice(0, lineEnd);
        responses = responses.slice(lineEnd + 1);
        const response = JSON.parse(line) as {
          kind: string;
          requestId?: string;
          result?: unknown;
        };
        if (
          response.kind === "response" &&
          response.requestId === spawnId &&
          response.result !== undefined
        ) {
          downstream.destroy();
          upstream.destroy();
          return;
        }
        downstream.write(line + "\n");
      }
    });
    upstream.on("error", () => downstream.destroy());
    downstream.on("error", () => upstream.destroy());
    downstream.on("close", () => upstream.destroy());
    upstream.on("close", () => downstream.destroy());
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(proxyPath, resolve);
  });
}

test("真实 CLI 在 ACK 丢失后显式恢复原结果，正常重启后旧 token 零效果拒绝", async () => {
  const directory = await mkdtemp(
    join(
      process.platform === "linux" ? "/dev/shm" : tmpdir(),
      "reins-wrr04-command-",
    ),
  );
  directories.push(directory);
  const socket = join(directory, "daemon.sock"),
    proxy = join(directory, "proxy.sock");
  const env = {
    REINS_SOCKET: socket,
    REINS_STATE_DIR: join(directory, "state"),
    REINS_CONSUMER_CONTEXT: "command-consumer",
    REINS_IDLE_TIMEOUT_MS: "120000",
    REINS_DAEMON_BIN: daemonBin,
    REINS_ADAPTERS_MODULE: fixture,
  };
  const first = await start(env);
  await dropSpawnAck(proxy, socket);
  const lost = await cli(
    ["spawn", "fake", "sensitive original message", "--name", "recovered"],
    { ...env, REINS_SOCKET: proxy },
  );
  expect(lost.code).toBe(65);
  const unknown = JSON.parse(lost.stdout) as {
    code: string;
    retryToken: string;
  };
  expect(unknown).toMatchObject({
    code: "command_outcome_unknown",
    cause: "disconnected",
    method: "spawn",
    retryToken: expect.stringMatching(/^retry1_/),
  });
  expect(lost.stdout).not.toContain("sensitive original message");
  expect(lost.stdout).not.toContain('"commandId"');
  expect(lost.stdout).not.toContain('"daemonGeneration"');
  const projected = parseRetryToken(unknown.retryToken);
  const cwdStat = await stat(process.cwd(), { bigint: true });
  expect(projected.spawnContext).toEqual({
    cwd: process.cwd(),
    cwdIdentity: { device: String(cwdStat.dev), inode: String(cwdStat.ino) },
  });
  expect(JSON.stringify(projected)).not.toContain("sensitive original message");
  const params = JSON.stringify({
    harness: "fake",
    message: "sensitive original message",
    sessionName: "recovered",
  });
  const recovered = await cli(
    ["retry", unknown.retryToken, "--params", params],
    env,
  );
  expect(recovered.code).toBe(0);
  const session = JSON.parse(recovered.stdout) as {
    sessionId: string;
    turnHandle: string;
    cwd: string;
  };
  expect(session.cwd).toBe(process.cwd());
  expect(decodeTurnHandle(session.turnHandle)).toMatchObject({
    sessionId: session.sessionId,
  });
  expect(session.sessionId).toMatch(/^recovered@g/);
  const replay = await cli(
    ["retry", unknown.retryToken, "--params", params, "--pretty"],
    env,
  );
  expect(replay.code).toBe(0);
  expect(replay.stdout).toBe(
    `Created session ${session.sessionId}\nTurn ${session.turnHandle}\nWorking directory ${session.cwd}\n`,
  );
  const listed = await cli(["list"], env);
  expect(JSON.parse(listed.stdout)).toHaveLength(1);
  const events = await cli(
    ["attach", session.sessionId, "--exit-on", "end_turn"],
    env,
  );
  expect(events.code).toBe(0);
  const records = events.stdout
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as { params?: { type?: string; role?: string } },
    );
  expect(
    records.filter((record) => record.params?.type === "turn.started"),
  ).toHaveLength(1);
  const prettyLost = await cli(
    [
      "spawn",
      "fake",
      "private pretty message",
      "--name",
      "pretty-recovered",
      "--pretty",
    ],
    { ...env, REINS_SOCKET: proxy },
  );
  expect(prettyLost.code).toBe(65);
  expect(prettyLost.stdout).toBe("");
  expect(prettyLost.stderr).toContain(
    "Command outcome is unknown (disconnected)",
  );
  expect(prettyLost.stderr).not.toContain("private pretty message");
  const prettyToken = /retry1_[A-Za-z0-9_-]+/.exec(prettyLost.stderr)?.[0];
  expect(prettyToken).toEqual(expect.any(String));
  const prettyRecovered = await cli(
    [
      "retry",
      prettyToken!,
      "--params",
      JSON.stringify({
        harness: "fake",
        sessionName: "pretty-recovered",
        message: "private pretty message",
      }),
    ],
    env,
  );
  expect(prettyRecovered.code).toBe(0);
  await stop(first);
  const second = await start(env);
  expect(second.pid).not.toBe(first.pid);
  const stale = await cli(
    ["retry", unknown.retryToken, "--params", params],
    env,
  );
  expect(stale.code).toBe(65);
  expect(JSON.parse(stale.stdout)).toMatchObject({ code: "stale_command_id" });
  expect(JSON.parse((await cli(["list"], env)).stdout)).toEqual([]);
  await stop(second);
}, 30_000);
