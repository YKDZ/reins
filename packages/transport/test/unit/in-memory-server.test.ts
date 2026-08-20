import { describe, expect, test } from "vitest";

import {
  createInMemoryTransportServer,
  type TransportConnection,
} from "../../src/index.ts";

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe("in-memory 传输服务器", () => {
  test("connect 建立的连接可达服务器订阅者", async () => {
    const server = createInMemoryTransportServer<string>();
    await server.listen();
    const accepted: TransportConnection<string>[] = [];
    server.onConnection((connection) => {
      accepted.push(connection);
    });

    const client = server.connect();
    await flush();
    expect(accepted).toHaveLength(1);

    const received: string[] = [];
    accepted[0]?.onEvent((event) => {
      if (event.kind === "message") received.push(event.message);
    });
    client.send("hello");
    await flush();
    expect(received).toEqual(["hello"]);
  });

  test("未 listen 时 connect 的连接不派发", async () => {
    const server = createInMemoryTransportServer<string>();
    const accepted: TransportConnection<string>[] = [];
    server.onConnection((connection) => {
      accepted.push(connection);
    });
    server.connect();
    await flush();
    expect(accepted).toEqual([]);
  });

  test("close 后不再接受新连接", async () => {
    const server = createInMemoryTransportServer<string>();
    await server.listen();
    await server.close();
    const accepted: TransportConnection<string>[] = [];
    server.onConnection((connection) => {
      accepted.push(connection);
    });
    server.connect();
    await flush();
    expect(accepted).toEqual([]);
  });

  test("服务器端 close 通知客户端连接关闭", async () => {
    const server = createInMemoryTransportServer<string>();
    await server.listen();
    server.onConnection((connection) => {
      connection.close();
    });
    const client = server.connect();
    const events: string[] = [];
    client.onEvent((event) => {
      events.push(event.kind);
    });
    await flush();
    expect(events).toEqual(["closed"]);
  });
});
