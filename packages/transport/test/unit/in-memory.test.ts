import { describe, expect, test } from "vitest";

import {
  createInMemoryTransportPair,
  isTransportError,
  type TransportConnection,
  type TransportEvent,
} from "../../src/index.ts";

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

function collect(connection: TransportConnection): {
  events: TransportEvent[];
  unsubscribe: () => void;
} {
  const events: TransportEvent[] = [];
  const unsubscribe = connection.onEvent((event) => {
    events.push(event);
  });
  return { events, unsubscribe };
}

describe("in-memory 传输对", () => {
  test("send 后另一端异步收到消息", async () => {
    const { client, server } = createInMemoryTransportPair();
    const received = collect(server);
    client.send({ hello: "world" });
    expect(received.events).toEqual([]);
    await flush();
    expect(received.events).toEqual([
      { kind: "message", message: { hello: "world" } },
    ]);
  });

  test("双向可达", async () => {
    const { client, server } = createInMemoryTransportPair();
    const fromClient = collect(server);
    const fromServer = collect(client);
    client.send("c1");
    server.send("s1");
    await flush();
    expect(fromClient.events[0]).toEqual({ kind: "message", message: "c1" });
    expect(fromServer.events[0]).toEqual({ kind: "message", message: "s1" });
  });

  test("退订后不再收到消息", async () => {
    const { client, server } = createInMemoryTransportPair();
    const received = collect(server);
    received.unsubscribe();
    client.send("x");
    await flush();
    expect(received.events).toEqual([]);
  });

  test("close 后另一端收到 closed 事件", async () => {
    const { client, server } = createInMemoryTransportPair();
    const received = collect(server);
    client.close();
    await flush();
    expect(received.events).toEqual([{ kind: "closed" }]);
  });

  test("close 后再 send 抛出带 transport_closed 码的错误", async () => {
    const { client } = createInMemoryTransportPair();
    client.close();
    expect(() => client.send("x")).toThrowError(
      expect.objectContaining({ code: "transport_closed" }),
    );
  });

  test("关闭的端点再次 close 是幂等的", async () => {
    const { client, server } = createInMemoryTransportPair();
    client.close();
    client.close();
    expect(() => client.close()).not.toThrow();
    const received = collect(server);
    expect(received.events).toEqual([]);
    await flush();
    expect(received.events).toEqual([{ kind: "closed" }]);
  });

  test("发送非法帧语义不适用于内存传输（消息透传）", async () => {
    const { client, server } = createInMemoryTransportPair();
    const received = collect(server);
    client.send(42);
    await flush();
    expect(received.events[0]).toEqual({ kind: "message", message: 42 });
    expect(isTransportError(undefined)).toBe(false);
  });
});
