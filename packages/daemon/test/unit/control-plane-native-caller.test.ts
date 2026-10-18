import { randomUUID } from "node:crypto";

import { createAsyncQueue } from "@reins/adapter-kit";
import {
  createCodexDriver,
  type CodexTransport,
  type InboundMessage,
} from "@reins/codex";
import { createSessionMachine } from "@reins/core";
import { createInMemoryControlStore } from "@reins/event-journal";
import {
  consumerContextSchema,
  operationKeyClaimsSchema,
  runtimeScopeIdSchema,
  serializeOperationKey,
  sessionIdSchema,
  type CoreDiagnosticFact,
  type DiagnosticsResult,
  type HarnessId,
  type OperationKey,
  type OperationKeyClaims,
  type SendAck,
  type SpawnAck,
} from "@reins/protocol";
import * as v from "valibot";
import { describe, expect, test } from "vitest";

import { createConsumerScope } from "../../src/consumer-scope.ts";
import { createControlPlane } from "../../src/control-plane.ts";
import { orderDiagnosticsAcceptance } from "../../src/diagnostics-acceptance.ts";
import type { DiagnosticsRuntime } from "../../src/diagnostics-recorder.ts";
import { daemonGenerationSchema } from "../../src/generation.ts";
import type { HarnessAdapter } from "../../src/registry.ts";
import { createRoutingDriverFactory } from "../../src/routing-driver.ts";

const runtimeScopeId = v.parse(
  runtimeScopeIdSchema,
  "00000000-0000-4000-8000-000000000000",
);
const consumer = v.parse(consumerContextSchema, "native-caller-test");
const generation = v.parse(daemonGenerationSchema, "nativecallertest");

function operationKey(kind: "spawn" | "send"): OperationKey {
  const claims: OperationKeyClaims = v.parse(operationKeyClaimsSchema, {
    runtimeScopeId,
    consumer,
    kind,
    generation,
    nonce: randomUUID(),
  });
  return serializeOperationKey(claims);
}

describe("Codex结构化caller提交", () => {
  test("turn/start响应前到达的原生正文按原结构与接受结果一起提交", async () => {
    const store = createInMemoryControlStore();
    let sessionCounter = 0;
    const diagnosticsRuntime: DiagnosticsRuntime = {
      generation,
      sessionId() {
        sessionCounter += 1;
        return v.parse(
          sessionIdSchema,
          `session:${runtimeScopeId}:${generation}:${sessionCounter}`,
        );
      },
      async record() {
        return undefined;
      },
      async query(): Promise<DiagnosticsResult> {
        return { records: [], truncated: false };
      },
      health() {
        return { status: "healthy", repairs: [] } as const;
      },
      async close() {},
    };
    const consumerScope = createConsumerScope(
      (sessionId) => store.getSession(sessionId)?.consumer,
    );
    const diagnostics = orderDiagnosticsAcceptance(
      diagnosticsRuntime,
      consumerScope,
    );
    const coreDiagnostics = {
      async record(fact: CoreDiagnosticFact) {
        return await diagnostics.record({ ...fact, source: "core" });
      },
    };

    const inbound = createAsyncQueue<InboundMessage>();
    let turnStartCount = 0;
    let turnSteerCount = 0;
    let signalSecondTurnStart!: () => void;
    const secondTurnStart = new Promise<void>((resolve) => {
      signalSecondTurnStart = resolve;
    });
    let acceptSecondTurnStart!: () => void;
    const transport: CodexTransport = {
      start() {},
      isClosed: () => false,
      request(method, _params) {
        if (method === "turn/steer") {
          turnSteerCount += 1;
          return Promise.resolve({ turnId: "native-turn-2" } as never);
        }
        if (method === "turn/start") {
          turnStartCount += 1;
          if (turnStartCount === 2) {
            signalSecondTurnStart();
            return new Promise((resolve) => {
              acceptSecondTurnStart = () =>
                resolve({ turn: { id: "native-turn-2" } } as never);
            });
          }
          return Promise.resolve({ turn: { id: "native-turn-1" } } as never);
        }
        if (method === "thread/start")
          return Promise.resolve({ thread: { id: "native-thread" } } as never);
        return Promise.resolve({} as never);
      },
      notify() {},
      respond() {},
      respondError() {},
      messages: inbound,
      async close() {
        inbound.end();
      },
    };
    const adapter: HarnessAdapter = {
      driverFactory: createCodexDriver({ transportFactory: () => transport }),
      async modelCatalog() {
        return { harness: "codex", models: [] };
      },
    };
    const adapters = new Map<HarnessId, HarnessAdapter>([["codex", adapter]]);
    const machine = createSessionMachine({
      identity: {
        session() {
          sessionCounter += 1;
          return v.parse(
            sessionIdSchema,
            `session:${runtimeScopeId}:${generation}:${sessionCounter}`,
          );
        },
      },
      diagnostics: coreDiagnostics,
      driverFactory: createRoutingDriverFactory(adapters, diagnostics),
    });
    const plane = createControlPlane({
      machine,
      adapters,
      diagnostics,
      consumerScope,
      controlStore: store,
      runtimeScopeId,
    });
    const execute = (
      method: "spawn" | "send",
      params: unknown,
      key: OperationKey,
    ) =>
      plane.execute(
        { method, params, operationKey: key },
        consumer,
        async () => ({
          result: await plane.dispatch(method, params, consumer, key),
        }),
      );

    try {
      const spawned = await execute(
        "spawn",
        { harness: "codex", cwd: "/tmp", message: "initial" },
        operationKey("spawn"),
      );
      if (!("result" in spawned)) throw new Error("Codex spawn failed");
      const spawnResult = spawned.result as SpawnAck;

      inbound.push({
        kind: "notification",
        method: "turn/completed",
        params: {
          turn: { id: "native-turn-1", status: "completed", error: null },
        },
      });
      await plane.settleEvents();

      const message = "continue with the same caller";
      const sendKey = operationKey("send");
      const sending = execute(
        "send",
        { placement: "new_turn", sessionId: spawnResult.sessionId, message },
        sendKey,
      );
      await secondTurnStart;
      inbound.push({
        kind: "notification",
        method: "item/completed",
        params: {
          turnId: "native-turn-2",
          item: {
            type: "userMessage",
            id: "native-caller-2",
            clientId: null,
            content: [
              { type: "text", text: message, text_elements: [] },
              { type: "image", url: "https://example.invalid/native.png" },
            ],
          },
        },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      acceptSecondTurnStart();

      const sent = await sending;
      expect(sent).toMatchObject({ result: { deliveryPoint: "new_turn" } });
      await plane.settleEvents();
      const operation = await plane.dispatch(
        "getOperation",
        { operationKey: sendKey },
        consumer,
      );
      expect(operation).toMatchObject({
        status: "succeeded",
        operationKey: sendKey,
      });
      const result = (operation as { result: SendAck }).result;
      const caller = store
        .sessionEvents(spawnResult.sessionId)
        .map(({ event }) => event)
        .find(
          (event) =>
            event.type === "message" &&
            event.role === "caller" &&
            event.messageId === result.messageId,
        );
      expect(caller).toEqual({
        type: "message",
        sessionId: spawnResult.sessionId,
        turnId: result.turnId,
        messageId: result.messageId,
        role: "caller",
        content: [
          { type: "text", text: message },
          {
            type: "image",
            source: "url",
            url: "https://example.invalid/native.png",
          },
        ],
      });
      expect(
        plane.list({ sessionId: spawnResult.sessionId }, consumer)[0],
      ).toMatchObject({ state: "busy", activeTurnId: result.turnId });

      const newTurnParams = {
        placement: "new_turn" as const,
        sessionId: spawnResult.sessionId,
        message,
      };
      expect(await execute("send", newTurnParams, sendKey)).toEqual(sent);
      const changedPlacement = await execute(
        "send",
        {
          placement: "active_turn",
          sessionId: spawnResult.sessionId,
          turnId: result.turnId,
          message: "changed request",
        },
        sendKey,
      );
      expect(changedPlacement).toEqual({
        error: { code: "operation_key_conflict" },
      });
      expect(turnSteerCount).toBe(0);
      expect(
        await plane.dispatch(
          "getOperation",
          { operationKey: sendKey },
          consumer,
        ),
      ).toMatchObject({ status: "succeeded", result });

      const freshActiveTurn = await execute(
        "send",
        {
          placement: "active_turn",
          sessionId: spawnResult.sessionId,
          turnId: result.turnId,
          message: "fresh active turn request",
        },
        operationKey("send"),
      );
      expect(freshActiveTurn).toMatchObject({
        result: { deliveryPoint: "active_turn" },
      });
      expect(turnSteerCount).toBe(1);
    } finally {
      await plane.terminateLiveSessions();
      plane.close();
      await diagnostics.close();
    }
  });
});
