import { mkdtemp, rm } from "node:fs/promises";
import { access } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  createUnixSocketClient,
  createUnixSocketServer,
  isTransportError,
  type TransportConnection,
} from "../../src/index.ts";

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
    await expect(second.listen()).rejects.toMatchObject({
      code: "address_in_use",
    });
  });
});
