import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { createCodexDriver, createCodexTransport } from "@reins/codex";
import type { CodexChild } from "@reins/codex";
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
import { createRoutingDriverFactory } from "../../src/routing-driver.ts";

const runtimeScopeId = v.parse(
  runtimeScopeIdSchema,
  "00000000-0000-4000-8000-000000000000",
);
const consumer = v.parse(consumerContextSchema, "codex-steer-rejection-test");
const generation = v.parse(daemonGenerationSchema, "codexsteerrejectiontest");

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

test.each([
  "explicit_rejection",
  "transport_eof",
  "accepted_commit_failure",
] as const)(
  "Codex active_turn %s 保留准确接受状态与清理事实",
  async (failureMode) => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const events = new EventEmitter();
    let childClosed = false;
    const requests: Array<{ readonly id?: number; readonly method?: string }> =
      [];
    let pendingInput = "";
    const child: CodexChild = {
      stdin,
      stdout,
      on(event, listener) {
        if (event === "exit") events.on("exit", () => listener());
        else events.on("error", listener);
      },
      kill() {
        childClosed = true;
        events.emit("exit");
        stdout.end();
        return true;
      },
      treeAlive() {
        return !childClosed;
      },
    };
    stdin.on("data", (chunk: Buffer | string) => {
      pendingInput += String(chunk);
      for (;;) {
        const newline = pendingInput.indexOf("\n");
        if (newline < 0) break;
        const request = JSON.parse(pendingInput.slice(0, newline)) as {
          readonly id?: number;
          readonly method?: string;
        };
        pendingInput = pendingInput.slice(newline + 1);
        requests.push(request);
        if (request.id === undefined) continue;
        if (
          request.method === "turn/steer" &&
          failureMode === "transport_eof"
        ) {
          queueMicrotask(() => stdout.end());
          continue;
        }
        const response =
          request.method === "turn/steer" &&
          failureMode === "explicit_rejection"
            ? {
                id: request.id,
                error: { code: -32600, message: "no active turn" },
              }
            : request.method === "turn/steer"
              ? {
                  id: request.id,
                  result: { turnId: "native-turn" },
                }
              : {
                  id: request.id,
                  result:
                    request.method === "thread/start"
                      ? { thread: { id: "native-thread" } }
                      : request.method === "turn/start"
                        ? { turn: { id: "native-turn" } }
                        : {},
                };
        queueMicrotask(() => stdout.write(`${JSON.stringify(response)}\n`));
      }
    });

    const baseStore = createInMemoryControlStore();
    const store: ControlStore =
      failureMode === "accepted_commit_failure"
        ? {
            ...baseStore,
            commitSend() {
              throw new Error("injected send commit failure");
            },
          }
        : baseStore;
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
    const adapters = new Map<HarnessId, HarnessAdapter>([
      [
        "codex",
        {
          driverFactory: createCodexDriver({
            transportFactory: (options) =>
              createCodexTransport({ ...options, spawnChild: () => child }),
          }),
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

    let cleanupError: unknown;
    try {
      const spawned = await execute(
        "spawn",
        { harness: "codex", cwd: "/tmp", message: "initial" },
        operationKey("spawn"),
      );
      if (!("result" in spawned)) throw new Error("Codex 测试会话创建失败");
      const target = spawned.result as SpawnAck;
      const sendKey = operationKey("send");
      const params = {
        sessionId: target.sessionId,
        turnId: target.turnId,
        placement: "active_turn",
        message: "rejected steer",
      };
      const rejected = await execute("send", params, sendKey);
      const record = await plane.dispatch(
        "getOperation",
        { operationKey: sendKey },
        consumer,
      );
      if (failureMode === "explicit_rejection") {
        expect(rejected).toMatchObject({
          error: {
            code: "internal_error",
            cause: { message: expect.stringContaining("no active turn") },
          },
        });
        expect(record).toMatchObject({
          status: "failed",
          operationKey: sendKey,
          error: { code: "internal_error" },
        });
      } else if (failureMode === "transport_eof") {
        expect(rejected).toMatchObject({
          error: {
            code: "operation_outcome_unknown",
            cause: {
              kind: "exception",
              message: "codex app-server closed",
            },
            cleanupCause: {
              kind: "closed",
              message: expect.stringContaining(
                "Codex app-server closed before thread deletion was confirmed",
              ),
            },
          },
        });
        expect(record).toMatchObject({
          status: "outcome_unknown",
          operationKey: sendKey,
          cause: { kind: "exception", message: "codex app-server closed" },
          cleanupCause: {
            kind: "closed",
            message: expect.stringContaining(
              "Codex app-server closed before thread deletion was confirmed",
            ),
          },
        });
      } else {
        expect(rejected).toMatchObject({
          error: {
            code: "control_store_unavailable",
            stage: "commit",
            acceptance: "accepted",
            acceptedResult: {
              sessionId: target.sessionId,
              turnId: target.turnId,
              deliveryPoint: "active_turn",
            },
          },
        });
        expect(record).toMatchObject({
          status: "accepted_uncommitted",
          operationKey: sendKey,
          result: {
            sessionId: target.sessionId,
            turnId: target.turnId,
            deliveryPoint: "active_turn",
          },
        });
      }
      expect(await execute("send", params, sendKey)).toEqual(rejected);
      if (failureMode === "transport_eof") {
        const blockedNewTurn = await execute(
          "send",
          {
            sessionId: target.sessionId,
            placement: "new_turn",
            message: "must stay fenced",
          },
          operationKey("send"),
        );
        expect(blockedNewTurn).toMatchObject({
          error: { code: "session_busy" },
        });
      }
      expect(
        requests.filter((request) => request.method === "turn/steer"),
      ).toHaveLength(1);
      expect(
        requests.some((request) => request.method === "thread/delete"),
      ).toBe(failureMode === "accepted_commit_failure");
      await plane.settleEvents();
      const eventTypes = store
        .sessionEvents(target.sessionId)
        .map((entry) => entry.event.type);
      expect(childClosed).toBe(failureMode !== "explicit_rejection");
      expect(eventTypes.includes("session.killed")).toBe(
        failureMode === "accepted_commit_failure",
      );
      if (failureMode === "accepted_commit_failure")
        expect(
          store
            .sessionEvents(target.sessionId)
            .some(
              ({ event }) =>
                event.type === "message" && event.content === "rejected steer",
            ),
        ).toBe(false);
      expect(
        plane.list({ sessionId: target.sessionId }, consumer)[0],
      ).toMatchObject({
        // 这是已提交投影；EOF 结果仍未知，准入栅栏阻止新 turn。
        state:
          failureMode === "transport_eof"
            ? "idle"
            : failureMode === "accepted_commit_failure"
              ? "killed"
              : "busy",
      });
    } finally {
      try {
        await plane.terminateLiveSessions();
      } catch (error) {
        cleanupError = error;
      }
      plane.close();
      await diagnostics.close();
    }
    if (failureMode === "transport_eof")
      expect(cleanupError).toMatchObject({
        errors: [{ code: "internal_error", cause: { kind: "closed" } }],
      });
    else expect(cleanupError).toBeUndefined();
  },
);
