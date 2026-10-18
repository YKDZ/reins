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
const consumer = v.parse(consumerContextSchema, "record-deletion-test");
const generation = v.parse(daemonGenerationSchema, "recorddeletiontest");

function operationKey(kind: "spawn" | "interrupt" | "kill"): OperationKey {
  const claims: OperationKeyClaims = v.parse(operationKeyClaimsSchema, {
    runtimeScopeId,
    consumer,
    kind,
    generation,
    nonce: randomUUID(),
  });
  return serializeOperationKey(claims);
}

function createFixture() {
  const baseStore = createInMemoryControlStore();
  let failInterruptRegistration = false;
  let failKillAdmission = false;
  const store: ControlStore = {
    ...baseStore,
    registerInterrupt(input) {
      if (failInterruptRegistration)
        throw new Error("interrupt registration write rejected");
      return baseStore.registerInterrupt(input);
    },
    registerKill(input) {
      if (failKillAdmission)
        throw new Error("kill registration write rejected");
      return baseStore.registerKill(input);
    },
    markKillDispatched(key) {
      if (failKillAdmission) throw new Error("kill dispatch write rejected");
      return baseStore.markKillDispatched(key);
    },
    commitKill(input) {
      if (failKillAdmission) throw new Error("kill result write rejected");
      return baseStore.commitKill(input);
    },
  };
  let sessionCounter = 0;
  let stopCount = 0;
  let interruptCount = 0;
  let assertWriterLease: () => Promise<void> = async () => {};
  let resolveLeaseEntered: (() => void) | undefined;
  const leaseEntered = new Promise<void>((resolve) => {
    resolveLeaseEntered = resolve;
  });
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
    driverFactory: () => ({
      async start() {},
      async deliver() {},
      async interrupt() {
        interruptCount += 1;
        throw new WorkerInterruptFailure(
          "native interrupt response was lost",
          "unknown",
        );
      },
      resolvePermission() {},
      async terminate() {
        stopCount += 1;
      },
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
    assertWriterLease: async () => {
      resolveLeaseEntered?.();
      await assertWriterLease();
    },
  });
  const execute = (
    method: "spawn" | "interrupt" | "kill" | "deleteRecords",
    params: unknown,
    key?: OperationKey,
  ) =>
    plane.execute(
      { method, params, ...(key === undefined ? {} : { operationKey: key }) },
      consumer,
      async () => ({
        result: await plane.dispatch(method, params, consumer, key),
      }),
    );

  return {
    baseStore,
    store,
    plane,
    execute,
    leaseEntered,
    setFailInterruptRegistration(value: boolean) {
      failInterruptRegistration = value;
    },
    setFailKillAdmission(value: boolean) {
      failKillAdmission = value;
    },
    setWriterLease(check: () => Promise<void>) {
      assertWriterLease = check;
    },
    counts() {
      return { stopCount, interruptCount };
    },
    async close() {
      await plane.terminateLiveSessions();
      plane.close();
      await diagnostics.close();
    },
  };
}

describe("记录删除与现场操作归属", () => {
  test("删除时保留入库失败的精确中断操作键", async () => {
    const fixture = createFixture();
    try {
      const spawned = await fixture.execute(
        "spawn",
        { harness: "codex", cwd: "/tmp", message: "initial" },
        operationKey("spawn"),
      );
      if (!("result" in spawned)) throw new Error("测试会话创建失败");
      const target = spawned.result as SpawnAck;
      const interruptKey = operationKey("interrupt");
      fixture.setFailInterruptRegistration(true);
      const interrupted = await fixture.execute(
        "interrupt",
        { sessionId: target.sessionId, turnId: target.turnId },
        interruptKey,
      );
      expect(interrupted).toMatchObject({
        error: {
          code: "control_store_unavailable",
          acceptance: "unknown",
        },
      });
      expect(fixture.counts().interruptCount).toBe(1);
      fixture.setFailInterruptRegistration(false);

      await fixture.execute(
        "kill",
        { sessionId: target.sessionId },
        operationKey("kill"),
      );
      expect(
        await fixture.execute("deleteRecords", { sessionId: target.sessionId }),
      ).toMatchObject({ result: { status: "deleted" } });
      expect(fixture.store.isOperationDeleted(interruptKey)).toBe(true);
      expect(
        await fixture.plane.dispatch(
          "getOperation",
          { operationKey: interruptKey },
          consumer,
        ),
      ).toMatchObject({ status: "deleted", operationKey: interruptKey });
      expect(fixture.counts()).toEqual({ stopCount: 1, interruptCount: 1 });
    } finally {
      await fixture.close();
    }
  });

  test("删除等待写入租约时也把已知接受的操作键写入防重放依据", async () => {
    const fixture = createFixture();
    try {
      const firstSpawn = await fixture.execute(
        "spawn",
        { harness: "codex", cwd: "/tmp", message: "first" },
        operationKey("spawn"),
      );
      const secondSpawn = await fixture.execute(
        "spawn",
        { harness: "codex", cwd: "/tmp", message: "second" },
        operationKey("spawn"),
      );
      if (!("result" in firstSpawn) || !("result" in secondSpawn))
        throw new Error("测试会话创建失败");
      const firstTarget = firstSpawn.result as SpawnAck;
      const secondTarget = secondSpawn.result as SpawnAck;
      await fixture.execute(
        "kill",
        { sessionId: firstTarget.sessionId },
        operationKey("kill"),
      );

      let releaseLease!: () => void;
      const leaseGate = new Promise<void>((resolve) => {
        releaseLease = resolve;
      });
      fixture.setWriterLease(() => leaseGate);
      const deletion = fixture.execute("deleteRecords", {
        sessionId: firstTarget.sessionId,
      });
      await fixture.leaseEntered;

      const duringDeleteKey = operationKey("kill");
      fixture.setFailKillAdmission(true);
      expect(
        await fixture.execute(
          "kill",
          { sessionId: firstTarget.sessionId },
          duringDeleteKey,
        ),
      ).toMatchObject({
        error: {
          code: "control_store_unavailable",
          acceptance: "accepted",
        },
      });
      fixture.setFailKillAdmission(false);
      fixture.setWriterLease(async () => {});
      releaseLease();

      expect(await deletion).toMatchObject({ result: { status: "deleted" } });
      expect(fixture.store.isOperationDeleted(duringDeleteKey)).toBe(true);
      expect(
        await fixture.plane.dispatch(
          "getOperation",
          { operationKey: duringDeleteKey },
          consumer,
        ),
      ).toMatchObject({ status: "deleted", operationKey: duringDeleteKey });
      const beforeRetry = fixture.counts();
      expect(
        await fixture.execute(
          "kill",
          { sessionId: secondTarget.sessionId },
          duringDeleteKey,
        ),
      ).toMatchObject({ error: { code: "operation_key_conflict" } });
      expect(fixture.counts()).toEqual(beforeRetry);
    } finally {
      await fixture.close();
    }
  });
});
