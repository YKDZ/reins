import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { connect, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  createUnixSocketClient,
  createUnixSocketServer,
  isTransportError,
  type TransportConnection,
} from "../../src/index.ts";
import { wrapUnixSocket } from "../../src/unix-socket.ts";

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("等待条件超时");
    }
    await flush();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("Unix socket 传输", () => {
  const dirs: string[] = [];
  const servers: Array<ReturnType<typeof createUnixSocketServer>> = [];
  const clients: TransportConnection[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.close();
    }
    for (const server of servers.splice(0)) {
      await server.close();
    }
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("客户端与服务端双向收发", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-transport-"));
    dirs.push(dir);
    const socketPath = join(dir, "reins.sock");

    const server = createUnixSocketServer({ path: socketPath });
    servers.push(server);
    await server.listen();

    const accepted: TransportConnection[] = [];
    server.onConnection((connection) => {
      accepted.push(connection);
    });

    const client = await createUnixSocketClient(socketPath);
    clients.push(client);
    await waitFor(() => accepted.length > 0);

    const toClient: unknown[] = [];
    client.onEvent((event) => {
      if (event.kind === "message") toClient.push(event.message);
    });
    const toServer: unknown[] = [];
    accepted[0]?.onEvent((event) => {
      if (event.kind === "message") toServer.push(event.message);
    });

    client.send({ ping: 1 });
    await waitFor(() => toServer.length > 0);
    expect(toServer).toEqual([{ ping: 1 }]);

    accepted[0]?.send({ pong: 2 });
    await waitFor(() => toClient.length > 0);
    expect(toClient).toEqual([{ pong: 2 }]);
  });

  test("非法 JSON 帧以 invalid_frame 传输错误暴露", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-transport-"));
    dirs.push(dir);
    const socketPath = join(dir, "reins.sock");

    const server = createUnixSocketServer({ path: socketPath });
    servers.push(server);
    await server.listen();

    const accepted: TransportConnection[] = [];
    server.onConnection((connection) => {
      accepted.push(connection);
    });
    const client = await createUnixSocketClient(socketPath);
    clients.push(client);
    await waitFor(() => accepted.length > 0);

    const raw = connect(socketPath);
    await waitFor(() => accepted.length > 1);
    const errors: unknown[] = [];
    accepted[1]?.onEvent((event) => {
      if (event.kind === "error") errors.push(event.error);
    });
    raw.write("not json\n");
    raw.end();
    await waitFor(() => errors.length > 0);
    expect(isTransportError(errors[0])).toBe(true);
    expect((errors[0] as Error & { code?: string }).code).toBe("invalid_frame");
  });

  test("非法 UTF-8 以排除 LF 的原始 frame bytes 计数", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-transport-"));
    dirs.push(dir);
    const socketPath = join(dir, "reins.sock");

    const server = createUnixSocketServer({ path: socketPath });
    servers.push(server);
    await server.listen();
    const accepted: TransportConnection[] = [];
    server.onConnection((connection) => {
      accepted.push(connection);
    });

    const raw = connect(socketPath);
    await waitFor(() => accepted.length > 0);
    const errors: unknown[] = [];
    accepted[0]?.onEvent((event) => {
      if (event.kind === "error") errors.push(event.error);
    });
    raw.end(Buffer.from([0x80, 0x0a]));
    await waitFor(() => errors.length > 0);

    const error = errors[0];
    if (!isTransportError(error)) throw new Error("Expected transport error");
    expect(error.fact).toEqual({
      kind: "transport_failure",
      operation: "read",
      reason: "invalid_frame",
      inputBytes: 1,
    });
  });

  test("server.close 移除 socket 文件并通知连接关闭", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-transport-"));
    dirs.push(dir);
    const socketPath = join(dir, "reins.sock");

    const server = createUnixSocketServer({ path: socketPath });
    await server.listen();
    expect(await exists(socketPath)).toBe(true);

    const accepted: TransportConnection[] = [];
    server.onConnection((connection) => {
      accepted.push(connection);
    });
    const client = await createUnixSocketClient(socketPath);
    clients.push(client);
    await waitFor(() => accepted.length > 0);

    const clientEvents: string[] = [];
    client.onEvent((event) => {
      clientEvents.push(event.kind);
    });
    await server.close();

    expect(await exists(socketPath)).toBe(false);
    await flush();
    expect(clientEvents).toContain("closed");
  });

  test("同一路径已有服务时 listen 以协议错误拒绝", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-transport-"));
    dirs.push(dir);
    const socketPath = join(dir, "reins.sock");

    const first = createUnixSocketServer({ path: socketPath });
    servers.push(first);
    await first.listen();

    const second = createUnixSocketServer({ path: socketPath });
    const failure: unknown = await second
      .listen()
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "address_in_use",
      message: "address_in_use",
      fact: {
        kind: "transport_failure",
        operation: "listen",
        reason: "io_error",
      },
    });
    expect(JSON.stringify(failure).includes(socketPath)).toBe(false);
  });

  test("重启监听器时移除没有活动服务的遗留 socket", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-transport-stale-"));
    dirs.push(dir);
    const socketPath = join(dir, "reins.sock");
    const child = spawn(
      process.execPath,
      [
        "-e",
        "require('node:net').createServer().listen(process.argv[1])",
        socketPath,
      ],
      { stdio: "ignore" },
    );
    const deadline = Date.now() + 2_000;
    while (!(await exists(socketPath))) {
      if (Date.now() >= deadline) throw new Error("socket 子进程未启动");
      if (child.exitCode !== null)
        throw new Error(`socket 子进程提前退出: ${child.exitCode}`);
      await flush();
    }
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => resolve());
      child.kill("SIGKILL");
    });
    expect(await exists(socketPath)).toBe(true);

    const server = createUnixSocketServer({ path: socketPath });
    servers.push(server);
    await server.listen();
    expect(await exists(socketPath)).toBe(true);
  });

  test("并发 listen 复用同一 Unix socket 监听", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-transport-listen-race-"));
    dirs.push(dir);
    const socketPath = join(dir, "reins.sock");
    const server = createUnixSocketServer({ path: socketPath });
    servers.push(server);

    await Promise.all([server.listen(), server.listen()]);
    const client = await createUnixSocketClient(socketPath);
    clients.push(client);
    expect(await exists(socketPath)).toBe(true);
  });

  test("普通 listen I/O 失败在 socket adapter 原点归一化为安全事实", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-transport-"));
    dirs.push(dir);
    const server = createUnixSocketServer({
      path: join(dir, "missing", "reins.sock"),
    });
    servers.push(server);

    const failure: unknown = await server
      .listen()
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "io_error",
      message: "io_error",
      fact: {
        kind: "transport_failure",
        operation: "listen",
        reason: "io_error",
      },
    });
    expect(JSON.stringify(failure).includes(dir)).toBe(false);
  });

  test("connect I/O 失败不暴露 socket 原始错误", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-transport-"));
    dirs.push(dir);

    const failure: unknown = await createUnixSocketClient(
      join(dir, "missing.sock"),
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "io_error",
      message: "io_error",
      fact: {
        kind: "transport_failure",
        operation: "connect",
        reason: "io_error",
      },
    });
    expect(JSON.stringify(failure).includes(dir)).toBe(false);
  });

  test("peer destroy 与多次 write 只产生一个真实 provenance failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-transport-"));
    dirs.push(dir);
    const socketPath = join(dir, "reins.sock");
    const rawServer = createNetServer((socket) => {
      socket.once("data", () => socket.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      rawServer.once("error", reject);
      rawServer.listen(socketPath, resolve);
    });

    try {
      const client = await createUnixSocketClient(socketPath);
      clients.push(client);
      const observations: Array<
        { kind: "error"; operation: string } | { kind: "closed" }
      > = [];
      client.onEvent((event) => {
        if (event.kind === "error") {
          observations.push({
            kind: "error",
            operation: event.error.fact.operation,
          });
        }
        if (event.kind === "closed") observations.push({ kind: "closed" });
      });
      const body = "x".repeat(2 * 1024 * 1024);
      for (let index = 0; index < 16; index += 1) {
        client.send({ body, index });
      }
      await waitFor(() =>
        observations.some((event) => event.kind === "closed"),
      );

      const failures = observations.filter(
        (event): event is { kind: "error"; operation: string } =>
          event.kind === "error",
      );
      expect(failures).toHaveLength(1);
      expect(["connection", "write"]).toContain(failures[0]?.operation);
      expect(failures.some((failure) => failure.operation === "read")).toBe(
        false,
      );
      expect(observations.map((event) => event.kind)).toEqual([
        "error",
        "closed",
      ]);
    } finally {
      await new Promise<void>((resolve) => rawServer.close(() => resolve()));
    }
  });

  test("idle established socket error 产生 connection failure 后关闭", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-transport-"));
    dirs.push(dir);
    const socketPath = join(dir, "reins.sock");
    const rawServer = createNetServer(() => {});
    await new Promise<void>((resolve, reject) => {
      rawServer.once("error", reject);
      rawServer.listen(socketPath, resolve);
    });
    const raw = connect(socketPath);
    await new Promise<void>((resolve, reject) => {
      raw.once("connect", resolve);
      raw.once("error", reject);
    });
    const connection = wrapUnixSocket(raw);
    const events: Array<{ kind: string; operation?: string }> = [];
    const serializedFailures: string[] = [];
    connection.onEvent((event) => {
      if (event.kind === "error") {
        serializedFailures.push(JSON.stringify(event.error));
      }
      events.push(
        event.kind === "error"
          ? { kind: "error", operation: event.error.fact.operation }
          : { kind: event.kind },
      );
    });

    try {
      const secretSentinel = ["idle", "socket", "sentinel"].join("-");
      raw.destroy(new Error(secretSentinel));
      await waitFor(() => events.some((event) => event.kind === "closed"));
      expect(events).toEqual([
        { kind: "error", operation: "connection" },
        { kind: "closed" },
      ]);
      expect(
        serializedFailures.some((failure) => failure.includes(secretSentinel)),
      ).toBe(false);
    } finally {
      raw.destroy();
      await new Promise<void>((resolve) => rawServer.close(() => resolve()));
    }
  });
});
