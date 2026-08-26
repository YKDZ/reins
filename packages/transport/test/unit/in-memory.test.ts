import { describe, expect, test } from "vitest";

import {
  createInMemoryTransportPair,
  createTransportError,
  isTransportError,
  transportErrorCodeOf,
  transportFailureFactOf,
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
  test("transport error 只品牌化 protocol 接受的不可变闭合事实", () => {
    const secretSentinel = ["strict", "fact", "sentinel"].join("-");
    const invalidFacts = [
      {
        kind: "transport_failure",
        operation: "write",
        reason: "io_error",
        details: secretSentinel,
      },
      {
        kind: "invented_failure",
        operation: "write",
        reason: "io_error",
      },
      {
        kind: "transport_failure",
        operation: "write",
        reason: "io_error",
        source: "daemon",
      },
      {
        kind: "transport_failure",
        operation: "write",
        reason: "io_error",
        message: secretSentinel,
      },
      {
        kind: "transport_failure",
        operation: "write",
        reason: "io_error",
        frame: secretSentinel,
      },
      {
        kind: "transport_failure",
        operation: "invented_operation",
        reason: "io_error",
      },
      {
        kind: "transport_failure",
        operation: "write",
        reason: "invalid_frame",
        inputBytes: -1,
      },
    ];
    const rejected = invalidFacts.map((fact) => {
      try {
        createTransportError({ code: "io_error", fact } as never);
        return false;
      } catch {
        return true;
      }
    });
    expect(rejected).toEqual(invalidFacts.map(() => true));

    const mutableFact = {
      kind: "transport_failure" as const,
      operation: "write" as const,
      reason: "io_error" as const,
    };
    const error = createTransportError({ code: "io_error", fact: mutableFact });
    Object.assign(mutableFact, { operation: "read", details: secretSentinel });
    expect(() =>
      Object.assign(error, {
        fact: {
          kind: "transport_failure",
          operation: "read",
          reason: "io_error",
          message: secretSentinel,
        },
      }),
    ).toThrow();
    expect(error.fact).toEqual({
      kind: "transport_failure",
      operation: "write",
      reason: "io_error",
    });
    expect(Object.isFrozen(error.fact)).toBe(true);
    expect(transportErrorCodeOf(error)).toBe("io_error");
    expect(transportFailureFactOf(error)).toBe(error.fact);
    expect(JSON.stringify(error).includes(secretSentinel)).toBe(false);
  });

  test("transport code 与闭合事实组合全表一致", () => {
    const inputs = [
      ["invalid_frame", "read", "invalid_frame", 3],
      ["address_in_use", "listen", "io_error"],
      ["io_error", "listen", "io_error"],
      ["io_error", "connect", "io_error"],
      ["io_error", "connection", "io_error"],
      ["io_error", "read", "io_error"],
      ["io_error", "write", "io_error"],
      ["io_error", "close", "io_error"],
      ["timeout", "connect", "timeout"],
      ["timeout", "read", "timeout"],
      ["timeout", "write", "timeout"],
      ["timeout", "close", "timeout"],
      ["transport_closed", "read", "disconnected"],
      ["transport_closed", "write", "disconnected"],
      ["transport_closed", "close", "disconnected"],
    ] as const;

    const accepted = inputs.map(([code, operation, reason, inputBytes]) =>
      createTransportError({
        code,
        fact: {
          kind: "transport_failure",
          operation,
          reason,
          ...(inputBytes === undefined ? {} : { inputBytes }),
        },
      } as never),
    );
    expect(accepted.map((error) => error.code)).toEqual(
      inputs.map(([code]) => code),
    );
    expect(accepted.map((error) => error.message)).toEqual(
      inputs.map(([code]) => code),
    );
    expect(accepted.map((error) => transportFailureFactOf(error))).toEqual(
      accepted.map((error) => error.fact),
    );

    const rejected = [
      ["invalid_frame", "read", "io_error"],
      ["address_in_use", "connect", "io_error"],
      ["io_error", "read", "timeout"],
      ["timeout", "connection", "timeout"],
      ["timeout", "write", "disconnected"],
      ["transport_closed", "close", "io_error"],
    ] as const;
    expect(
      rejected.map(([code, operation, reason]) => {
        try {
          createTransportError({
            code,
            fact: { kind: "transport_failure", operation, reason },
          } as never);
          return false;
        } catch {
          return true;
        }
      }),
    ).toEqual(rejected.map(() => true));
  });

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
    expect(
      isTransportError(
        Object.assign(new Error("unsafe"), { code: "transport_closed" }),
      ),
    ).toBe(false);
    expect(() =>
      createTransportError({
        code: "invalid_frame",
        fact: {
          kind: "transport_failure",
          operation: "write",
          reason: "io_error",
        },
      } as never),
    ).toThrow("Invalid transport error fact");
  });
});
