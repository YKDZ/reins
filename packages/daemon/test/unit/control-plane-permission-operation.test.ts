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
  WorkerPermissionFailure,
  type CoreDiagnosticFact,
  type DiagnosticsResult,
  type HarnessId,
  type OperationKey,
  type OperationKeyClaims,
  type ResolvePermissionParams,
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
const consumer = v.parse(consumerContextSchema, "permission-operation-test");
const generation = v.parse(daemonGenerationSchema, "permissionoperationtest");

function operationKey(kind: "spawn" | "resolvePermission"): OperationKey {
  const claims: OperationKeyClaims = v.parse(operationKeyClaimsSchema, {
    runtimeScopeId,
    consumer,
    kind,
    generation,
    nonce: randomUUID(),
  });
  return serializeOperationKey(claims);
}

test.each([
  "registration_failed",
  "not_accepted",
  "failure_record_failed",
  "unknown",
  "commit_failed",
  "commit_succeeded_then_threw",
] as const)("授权决议 %s 保留首次原生结果且同键不重派", async (scenario) => {
  const baseStore = createInMemoryControlStore();
  const store: ControlStore = {
    ...baseStore,
    registerResolvePermission(input) {
      if (scenario === "registration_failed")
        throw new Error("permission registration write rejected");
      return baseStore.registerResolvePermission(input);
    },
    failResolvePermission(key, error) {
      if (scenario === "failure_record_failed")
        throw new Error("permission failure record write rejected");
      return baseStore.failResolvePermission(key, error);
    },
    commitResolvePermission(input) {
      if (scenario === "commit_failed")
        throw new Error("permission commit rejected");
      const committed = baseStore.commitResolvePermission(input);
      if (scenario === "commit_succeeded_then_threw")
        throw new Error("permission commit acknowledgement was lost");
      return committed;
    },
  };
  let sessionCounter = 0;
  const sessionId = v.parse(
    sessionIdSchema,
    `session:${runtimeScopeId}:${generation}:1`,
  );
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
    (id) => baseStore.getSession(id)?.consumer,
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
  let resolutionCalls = 0;
  const adapters = new Map<HarnessId, HarnessAdapter>([
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
  ]);
  const machine = createSessionMachine({
    identity: {
      session() {
        sessionCounter += 1;
        return sessionId;
      },
    },
    diagnostics: coreDiagnostics,
    driverFactory: (emit) => ({
      async start(spec) {
        emit({
          type: "permission.requested",
          sessionId: spec.sessionId,
          turnId: spec.turnId,
          permissionId: "permission-1" as never,
          kind: "tool:Bash",
          options: [{ outcome: "allow", scope: "once" }],
        });
      },
      async deliver() {},
      async interrupt() {},
      resolvePermission() {
        resolutionCalls += 1;
        if (scenario === "not_accepted" || scenario === "failure_record_failed")
          throw new WorkerPermissionFailure(
            "native rejected permission resolution",
            "not_accepted",
          );
        if (scenario === "unknown")
          throw new WorkerPermissionFailure(
            "native permission receipt was lost",
            "unknown",
          );
      },
      async terminate() {},
    }),
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
    method: "spawn" | "resolvePermission",
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
      throw new Error(`测试会话创建失败：${JSON.stringify(spawned)}`);
    const spawnResult = spawned.result as SpawnAck;
    const request: ResolvePermissionParams = {
      sessionId: spawnResult.sessionId,
      turnId: spawnResult.turnId,
      permissionId: "permission-1" as never,
      resolution: { outcome: "allow", scope: "once" },
    };
    const key = operationKey("resolvePermission");
    const resolved = await execute("resolvePermission", request, key);
    if (scenario === "registration_failed") {
      expect(resolved).toMatchObject({
        error: {
          code: "control_store_unavailable",
          stage: "register",
          acceptance: "not_dispatched",
        },
      });
      expect(
        await plane.dispatch("getOperation", { operationKey: key }, consumer),
      ).toMatchObject({ status: "unknown", operationKey: key });
      expect(
        await execute(
          "resolvePermission",
          { ...request, resolution: { outcome: "deny" } },
          key,
        ),
      ).toMatchObject({ error: { code: "operation_key_conflict" } });
      expect(resolutionCalls).toBe(0);
      return;
    } else if (scenario === "commit_succeeded_then_threw") {
      expect(resolved).toMatchObject({
        result: {
          sessionId: spawnResult.sessionId,
          turnId: spawnResult.turnId,
          permissionId: request.permissionId,
        },
      });
      expect(
        await plane.dispatch("getOperation", { operationKey: key }, consumer),
      ).toMatchObject({ status: "succeeded", operationKey: key });
      expect(
        baseStore.sessionEvents(spawnResult.sessionId).at(-1)?.event,
      ).toMatchObject({
        type: "permission.resolved",
        permissionId: request.permissionId,
      });
    } else if (scenario === "commit_failed") {
      expect(resolved).toMatchObject({
        error: {
          code: "control_store_unavailable",
          stage: "commit",
          acceptance: "accepted",
          acceptedResult: {
            sessionId: spawnResult.sessionId,
            turnId: spawnResult.turnId,
            permissionId: request.permissionId,
          },
        },
      });
      expect(
        await plane.dispatch("getOperation", { operationKey: key }, consumer),
      ).toMatchObject({
        status: "accepted_uncommitted",
        operationKey: key,
        result: {
          sessionId: spawnResult.sessionId,
          turnId: spawnResult.turnId,
          permissionId: request.permissionId,
        },
      });
    } else if (scenario === "unknown") {
      expect(resolved).toMatchObject({
        error: { code: "operation_outcome_unknown", operationKey: key },
      });
      expect(
        await plane.dispatch("getOperation", { operationKey: key }, consumer),
      ).toMatchObject({ status: "outcome_unknown", operationKey: key });
    } else if (scenario === "failure_record_failed") {
      expect(resolved).toMatchObject({
        error: {
          code: "control_store_unavailable",
          stage: "failure",
          acceptance: "not_dispatched",
        },
      });
      expect(
        await plane.dispatch("getOperation", { operationKey: key }, consumer),
      ).toMatchObject({
        status: "not_accepted_uncommitted",
        operationKey: key,
        error: { code: "internal_error" },
      });
      expect(await execute("resolvePermission", request, key)).toMatchObject({
        error: {
          code: "control_store_unavailable",
          stage: "failure",
          acceptance: "not_dispatched",
        },
      });
      expect(
        await execute(
          "resolvePermission",
          { ...request, resolution: { outcome: "deny" } },
          key,
        ),
      ).toMatchObject({ error: { code: "operation_key_conflict" } });
      expect(resolutionCalls).toBe(1);
      return;
    } else {
      expect(resolved).toMatchObject({
        error: { code: "internal_error" },
      });
      expect(
        await plane.dispatch("getOperation", { operationKey: key }, consumer),
      ).toMatchObject({ status: "failed", operationKey: key });
    }

    await execute("resolvePermission", request, key);
    expect(resolutionCalls).toBe(1);
  } finally {
    await plane.terminateLiveSessions();
    plane.close();
    store.close();
    await diagnostics.close();
  }
});
