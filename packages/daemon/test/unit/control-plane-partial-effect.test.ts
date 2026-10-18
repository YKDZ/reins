import { randomUUID } from "node:crypto";

import { createSessionMachine } from "@reins/core";
import {
  createInMemoryControlStore,
  type ControlStore,
} from "@reins/event-journal";
import {
  consumerContextSchema,
  operationKeyClaimsSchema,
  runtimeScopeIdSchema,
  serializeOperationKey,
  sessionIdSchema,
  WorkerDeliveryFailure,
  type CoreDiagnosticFact,
  type DiagnosticsResult,
  type HarnessId,
  type OperationKey,
  type OperationKeyClaims,
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

const runtimeScopeId = v.parse(
  runtimeScopeIdSchema,
  "00000000-0000-4000-8000-000000000000",
);
const consumer = v.parse(consumerContextSchema, "partial-effect-test");
const generation = v.parse(daemonGenerationSchema, "partialeffecttest");

function operationKey(kind: "spawn" | "send" | "interrupt"): OperationKey {
  const claims: OperationKeyClaims = v.parse(operationKeyClaimsSchema, {
    runtimeScopeId,
    consumer,
    kind,
    generation,
    nonce: randomUUID(),
  });
  return serializeOperationKey(claims);
}

describe("部分原生效果的 send 查询", () => {
  test("续接前阶段已取消且失败记录不可写时不伪报无效果拒绝", async () => {
    const baseStore = createInMemoryControlStore();
    const store: ControlStore = {
      ...baseStore,
      failSend() {
        throw new Error("failure record write rejected");
      },
    };
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
      (sessionId) => baseStore.getSession(sessionId)?.consumer,
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
    let deliveries = 0;
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
      driverFactory: (emit) => ({
        async start() {},
        async deliver(sessionId, turnId) {
          deliveries += 1;
          emit({
            type: "turn.completed",
            sessionId,
            turnId,
            stopReason: "cancelled",
            finalReply: null,
          });
          throw new WorkerDeliveryFailure(
            "原生已取消此前阶段，但拒绝本次续接",
            "not_accepted",
            undefined,
            { kind: "execution_phase_cancelled", sessionId, turnId },
          );
        },
        async interrupt() {},
        resolvePermission() {},
        async terminate() {},
      }),
    });
    const plane = createControlPlane({
      machine,
      adapters: new Map<HarnessId, HarnessAdapter>([
        [
          "codex",
          {
            driverFactory: () => {
              throw new Error("测试直接使用session machine driver");
            },
            async modelCatalog() {
              return { harness: "codex", models: [] };
            },
          },
        ],
      ]),
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
      if (!("result" in spawned))
        throw new Error(`创建测试会话失败：${JSON.stringify(spawned)}`);
      const spawnResult = spawned.result as SpawnAck;
      const sendKey = operationKey("send");
      const sent = await execute(
        "send",
        {
          placement: "active_turn",
          sessionId: spawnResult.sessionId,
          turnId: spawnResult.turnId,
          message: "continue",
        },
        sendKey,
      );
      expect(sent).toMatchObject({
        error: {
          code: "control_store_unavailable",
          acceptance: "not_dispatched",
          effect: {
            kind: "execution_phase_cancelled",
            sessionId: spawnResult.sessionId,
            turnId: spawnResult.turnId,
          },
        },
      });
      expect(
        await plane.dispatch(
          "getOperation",
          { operationKey: sendKey },
          consumer,
        ),
      ).toMatchObject({
        status: "partial_effect_uncommitted",
        operationKey: sendKey,
        error: {
          code: "internal_error",
          effect: {
            kind: "execution_phase_cancelled",
            sessionId: spawnResult.sessionId,
            turnId: spawnResult.turnId,
          },
        },
      });
      expect(
        await execute(
          "send",
          {
            placement: "active_turn",
            sessionId: spawnResult.sessionId,
            turnId: spawnResult.turnId,
            message: "continue",
          },
          sendKey,
        ),
      ).toMatchObject({
        error: {
          code: "control_store_unavailable",
          effect: {
            kind: "execution_phase_cancelled",
            sessionId: spawnResult.sessionId,
            turnId: spawnResult.turnId,
          },
        },
      });
      expect(deliveries).toBe(1);
      expect(
        plane.list({ sessionId: spawnResult.sessionId }, consumer)[0],
      ).toMatchObject({
        state: "idle",
        lastCompletedTurn: { stopReason: "cancelled" },
      });
    } finally {
      await plane.terminateLiveSessions();
      plane.close();
      await diagnostics.close();
    }
  });

  test("interrupt 回执与竞争中的自然终态分开且提交失败不重派", async () => {
    const baseStore = createInMemoryControlStore();
    const store: ControlStore = {
      ...baseStore,
      commitInterrupt() {
        throw new Error("interrupt commit rejected");
      },
    };
    let sessionCounter = 0;
    let terminal: (event: {
      readonly type: "turn.completed";
      readonly sessionId: SpawnAck["sessionId"];
      readonly turnId: SpawnAck["turnId"];
      readonly stopReason: "end_turn";
      readonly finalReply: string;
    }) => void = () => undefined;
    let interruptCalls = 0;
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
      (sessionId) => baseStore.getSession(sessionId)?.consumer,
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
      driverFactory: (emit) => {
        terminal = emit as typeof terminal;
        return {
          async start() {},
          async deliver() {},
          async interrupt(sessionId, turnId) {
            interruptCalls += 1;
            terminal({
              type: "turn.completed",
              sessionId,
              turnId,
              stopReason: "end_turn",
              finalReply: "natural completion",
            });
          },
          resolvePermission() {},
          async terminate() {},
        };
      },
    });
    const plane = createControlPlane({
      machine,
      adapters: new Map<HarnessId, HarnessAdapter>([
        [
          "codex",
          {
            driverFactory: () => {
              throw new Error("测试直接使用session machine driver");
            },
            async modelCatalog() {
              return { harness: "codex", models: [] };
            },
          },
        ],
      ]),
      diagnostics,
      consumerScope,
      controlStore: store,
      runtimeScopeId,
    });
    const execute = (
      method: "spawn" | "interrupt",
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
      if (!("result" in spawned))
        throw new Error(`创建测试会话失败：${JSON.stringify(spawned)}`);
      const spawnResult = spawned.result as SpawnAck;
      const interruptKey = operationKey("interrupt");
      const interruptRequest = {
        sessionId: spawnResult.sessionId,
        turnId: spawnResult.turnId,
      };
      const interrupted = await execute(
        "interrupt",
        interruptRequest,
        interruptKey,
      );
      expect(interrupted).toMatchObject({
        error: {
          code: "control_store_unavailable",
          stage: "commit",
          acceptance: "accepted",
          acceptedResult: interruptRequest,
        },
      });
      expect(
        await plane.dispatch(
          "getOperation",
          { operationKey: interruptKey },
          consumer,
        ),
      ).toMatchObject({
        status: "accepted_uncommitted",
        operationKey: interruptKey,
        result: interruptRequest,
      });
      expect(
        await execute("interrupt", interruptRequest, interruptKey),
      ).toMatchObject({
        error: {
          code: "control_store_unavailable",
          acceptance: "accepted",
          acceptedResult: interruptRequest,
        },
      });
      expect(interruptCalls).toBe(1);

      await plane.settleEvents();
      expect(
        plane.list({ sessionId: spawnResult.sessionId }, consumer)[0],
      ).toMatchObject({
        state: "idle",
        lastCompletedTurn: { stopReason: "end_turn" },
      });
      expect(
        baseStore.sessionEvents(spawnResult.sessionId).at(-1)?.event,
      ).toMatchObject({
        type: "turn.completed",
        stopReason: "end_turn",
        finalReply: "natural completion",
      });
    } finally {
      await plane.terminateLiveSessions();
      plane.close();
      await diagnostics.close();
    }
  });

  test("登记或派发标记持续写失败时仍会尝试并保留原生 interrupt 回执", async () => {
    for (const failedWrite of ["register", "mark"] as const) {
      const baseStore = createInMemoryControlStore();
      const store: ControlStore = {
        ...baseStore,
        registerInterrupt(input) {
          if (failedWrite === "register") {
            throw new Error("interrupt registration write rejected");
          }
          return baseStore.registerInterrupt(input);
        },
        markInterruptDispatched(key) {
          if (failedWrite === "mark") {
            throw new Error("interrupt dispatch mark rejected");
          }
          return baseStore.markInterruptDispatched(key);
        },
      };
      let sessionCounter = 0;
      let interruptCalls = 0;
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
        (sessionId) => baseStore.getSession(sessionId)?.consumer,
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
        driverFactory: (_emit) => ({
          async start() {},
          async deliver() {},
          async interrupt() {
            interruptCalls += 1;
          },
          resolvePermission() {},
          async terminate() {},
        }),
      });
      const plane = createControlPlane({
        machine,
        adapters: new Map<HarnessId, HarnessAdapter>([
          [
            "codex",
            {
              driverFactory: () => {
                throw new Error("测试直接使用 session machine driver");
              },
              async modelCatalog() {
                return { harness: "codex", models: [] };
              },
            },
          ],
        ]),
        diagnostics,
        consumerScope,
        controlStore: store,
        runtimeScopeId,
      });
      const execute = (
        method: "spawn" | "interrupt",
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
        if (!("result" in spawned))
          throw new Error(`创建测试会话失败：${JSON.stringify(spawned)}`);
        const interruptRequest = {
          sessionId: (spawned.result as SpawnAck).sessionId,
          turnId: (spawned.result as SpawnAck).turnId,
        };
        const key = operationKey("interrupt");

        expect(await execute("interrupt", interruptRequest, key)).toMatchObject({
          error: {
            code: "control_store_unavailable",
            stage: "commit",
            acceptance: "accepted",
            acceptedResult: interruptRequest,
          },
        });
        expect(interruptCalls).toBe(1);
        expect(
          await plane.dispatch(
            "getOperation",
            { operationKey: key },
            consumer,
          ),
        ).toMatchObject({
          status:
            failedWrite === "register"
              ? "accepted_unconfirmed"
              : "accepted_uncommitted",
          operationKey: key,
          result: interruptRequest,
        });
        expect(
          await execute("interrupt", interruptRequest, key),
        ).toMatchObject({
          error: {
            code: "control_store_unavailable",
            acceptance: "accepted",
            acceptedResult: interruptRequest,
          },
        });
        expect(interruptCalls).toBe(1);
      } finally {
        await plane.terminateLiveSessions();
        plane.close();
        await diagnostics.close();
      }
    }
  });
});
