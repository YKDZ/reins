import { randomUUID } from "node:crypto";

import {
  operationKeyClaimsSchema,
  isSideEffectMethod,
  initializeResultSchema,
  serializeOperationKey,
} from "@reins/protocol";
import { REINS_PROTOCOL_MAJOR_VERSION } from "@reins/protocol";
import type { ProtocolMessage, ProtocolResponse } from "@reins/protocol";
import type { TransportConnection } from "@reins/transport";
import * as v from "valibot";
import { expect, test } from "vitest";

import { openEphemeralDaemonForTest } from "../../src/testing.ts";

const generations = new WeakMap<
  TransportConnection<ProtocolMessage>,
  { generation: string; consumerContext: string; runtimeScopeId: string }
>();

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
          if (
            message.method === "initialize" &&
            typeof message.params === "object" &&
            message.params !== null
          ) {
            const initialized = v.parse(
              initializeResultSchema,
              event.message.result,
            );
            generations.set(connection, {
              generation: initialized.daemonGeneration,
              consumerContext: String(
                (message.params as { consumerContext?: unknown })
                  .consumerContext,
              ),
              runtimeScopeId: initialized.runtimeScopeId,
            });
          }
        resolve(event.message);
      }
    });
    const context = generations.get(connection);
    connection.send(
      isSideEffectMethod(message.method)
        ? {
            ...message,
            operationKey: serializeOperationKey(
              v.parse(operationKeyClaimsSchema, {
                runtimeScopeId: context?.runtimeScopeId,
                consumer: context?.consumerContext,
                kind: message.method,
                generation: context?.generation,
                nonce: randomUUID(),
              }),
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
        "codex",
        {
          driverFactory: () => ({
            async start() {},
            async deliver() {},
            async interrupt() {},
            resolvePermission() {},
            async terminate() {
              terminateCount += 1;
              if (terminateCount === 1) {
                throw new Error("fixture terminate failed");
              }
            },
          }),
          async modelCatalog() {
            return { harness: "codex", models: [] };
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
        runtimeScopeId: daemon.runtimeScopeId,
      },
    }),
  ).resolves.toMatchObject({ kind: "response", result: expect.any(Object) });
  await expect(
    request(connection, {
      kind: "request",
      requestId: "spawnfailure" as never,
      method: "spawn",
      params: {
        sessionLabel: "failure" as never,
        harness: "codex",
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
