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
  WorkerInterruptFailure,
  type CoreDiagnosticFact,
  type DiagnosticsResult,
  type HarnessId,
  type OperationKey,
  type OperationKeyClaims,
  type SpawnAck,
} from "@reins/protocol";
import * as v from "valibot";
import { expect, test } from "vitest";

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
const consumer = v.parse(consumerContextSchema, "interrupt-identity-test");
const generation = v.parse(daemonGenerationSchema, "interruptidentitytest");

function operationKey(kind: "spawn" | "interrupt"): OperationKey {
  const claims: OperationKeyClaims = v.parse(operationKeyClaimsSchema, {
    runtimeScopeId,
    consumer,
    kind,
    generation,
    nonce: randomUUID(),
  });
  return serializeOperationKey(claims);
}

type Scenario =
  | "failed"
  | "unknown"
  | "accepted_uncommitted"
  | "register_failed";

test.each<Scenario>([
  "failed",
  "unknown",
  "accepted_uncommitted",
  "register_failed",
])("interrupt 重用同一操作键时仍绑定首次完整目标：%s", async (scenario) => {
  const baseStore = createInMemoryControlStore();
  let activeScenario = scenario;
  const store: ControlStore = {
    ...baseStore,
    registerInterrupt(input) {
      if (activeScenario === "register_failed")
        throw new Error("interrupt registration write rejected");
      return baseStore.registerInterrupt(input);
    },
    commitInterrupt(input) {
      if (activeScenario === "accepted_uncommitted")
        throw new Error("interrupt commit rejected");
      return baseStore.commitInterrupt(input);
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
  const interruptTargets: Array<{
    sessionId: SpawnAck["sessionId"];
    turnId: SpawnAck["turnId"];
  }> = [];
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
    driverFactory: () => ({
      async start() {},
      async deliver() {},
      async interrupt(sessionId, turnId) {
        interruptTargets.push({ sessionId, turnId });
        if (activeScenario === "failed")
          throw new WorkerInterruptFailure(
            "native explicitly rejected interrupt",
            "not_accepted",
          );
        if (activeScenario === "unknown")
          throw new WorkerInterruptFailure(
            "native interrupt receipt was lost",
            "unknown",
          );
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
    const firstSpawn = await execute(
      "spawn",
      { harness: "codex", cwd: "/tmp", message: "first" },
      operationKey("spawn"),
    );
    const secondSpawn = await execute(
      "spawn",
      { harness: "codex", cwd: "/tmp", message: "second" },
      operationKey("spawn"),
    );
    if (!("result" in firstSpawn) || !("result" in secondSpawn))
      throw new Error("测试会话创建失败");
    const firstTarget = firstSpawn.result as SpawnAck;
    const secondTarget = secondSpawn.result as SpawnAck;
    const key = operationKey("interrupt");
    const firstRequest = {
      sessionId: firstTarget.sessionId,
      turnId: firstTarget.turnId,
    };
    const changedRequest = {
      sessionId: secondTarget.sessionId,
      turnId: secondTarget.turnId,
    };

    const first = await execute("interrupt", firstRequest, key);
    expect(interruptTargets).toEqual([firstRequest]);
    const sameRequestRetry = await execute("interrupt", firstRequest, key);
    expect(sameRequestRetry).toEqual(first);
    const changedTargetRetry = await execute("interrupt", changedRequest, key);
    expect(changedTargetRetry).toEqual({
      error: { code: "operation_key_conflict" },
    });
    expect(interruptTargets).toEqual([firstRequest]);
    expect(
      await plane.dispatch("getOperation", { operationKey: key }, consumer),
    ).toMatchObject({ operationKey: key });
  } finally {
    await plane.terminateLiveSessions();
    plane.close();
    await diagnostics.close();
  }
});
