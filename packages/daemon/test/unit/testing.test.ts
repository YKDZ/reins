import { randomUUID } from "node:crypto";

import {
  commandIdSchema,
  isSideEffectMethod,
  initializeResultSchema,
} from "@reins/protocol";
import { REINS_PROTOCOL_MAJOR_VERSION } from "@reins/protocol";
import type { ProtocolMessage, ProtocolResponse } from "@reins/protocol";
import type { TransportConnection } from "@reins/transport";
import * as v from "valibot";
import { expect, test } from "vitest";

import { openEphemeralDaemonForTest } from "../../src/testing.ts";

const generations = new WeakMap<TransportConnection<ProtocolMessage>, string>();

async function request(
  connection: TransportConnection<ProtocolMessage>,
  message: Extract<ProtocolMessage, { kind: "request" }>,
): Promise<ProtocolResponse> {
  return await new Promise((resolve) => {
    const unsubscribe = connection.onEvent((event) => {
      if (
        event.kind === "message" &&
        event.message.kind === "response" &&
        event.message.requestId === message.requestId
      ) {
        unsubscribe();
        if (message.method === "initialize" && "result" in event.message)
          generations.set(
            connection,
            v.parse(initializeResultSchema, event.message.result)
              .daemonGeneration,
          );
        resolve(event.message);
      }
    });
    connection.send(
      isSideEffectMethod(message.method)
        ? {
            ...message,
            commandId: v.parse(
              commandIdSchema,
              generations.get(connection) + ":" + randomUUID(),
            ),
          }
        : message,
    );
  });
}

test("ephemeral composition owns connections and closes idempotently", async () => {
  const daemon = await openEphemeralDaemonForTest({ adapters: new Map() });
  const connection = daemon.connect();

  const closing = daemon.close();
  expect(() => daemon.connect()).toThrow("Ephemeral daemon is closing");
  await expect(Promise.all([closing, daemon.close()])).resolves.toEqual([
    undefined,
    undefined,
  ]);
  expect(() => daemon.connect()).toThrow("Ephemeral daemon is closed");
  expect(() => connection.close()).not.toThrow();
});

test("failed cleanup rejects connections and retries without reopening", async () => {
  let terminateCount = 0;
  const daemon = await openEphemeralDaemonForTest({
    adapters: new Map([
      [
        "failing",
        {
          driverFactory: () => ({
            start() {},
            deliver() {},
            interrupt() {},
            resolvePermission() {},
            async terminate() {
              terminateCount += 1;
              if (terminateCount === 1) {
                throw new Error("fixture terminate failed");
              }
            },
          }),
          async capabilities() {
            return { harness: "failing", models: [] };
          },
        },
      ],
    ]),
  });
  const connection = daemon.connect();
  await expect(
    request(connection, {
      kind: "request",
      requestId: "bind" as never,
      method: "initialize",
      params: {
        protocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
        consumerContext: "test-consumer",
      },
    }),
  ).resolves.toMatchObject({ kind: "response", result: expect.any(Object) });
  await expect(
    request(connection, {
      kind: "request",
      requestId: "spawnfailure" as never,
      method: "spawn",
      params: {
        sessionName: "failure" as never,
        harness: "failing",
        message: "start",
        cwd: "/tmp",
      },
    }),
  ).resolves.toMatchObject({ kind: "response", result: expect.any(Object) });

  const failedClose = daemon.close();
  expect(daemon.close()).toBe(failedClose);
  await expect(failedClose).rejects.toThrow("Worker cleanup failed");
  expect(terminateCount).toBe(1);
  expect(() => daemon.connect()).toThrow("Ephemeral daemon cleanup failed");

  const retry = daemon.close();
  expect(retry).not.toBe(failedClose);
  await expect(retry).resolves.toBeUndefined();
  expect(terminateCount).toBe(2);
  expect(() => daemon.connect()).toThrow("Ephemeral daemon is closed");
  expect(daemon.close()).toBe(retry);
});
