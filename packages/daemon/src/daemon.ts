import { createSessionMachine, type SessionIdentity } from "@reins/core";
import {
  createInMemoryControlStore,
  type ControlStore,
} from "@reins/event-journal";
import {
  type DiagnosticId,
  type DiagnosticInput,
  type CoreDiagnosticFact,
  type DomainEvent,
  type ProtocolMessage,
  type RuntimeScopeId,
  type SessionId,
} from "@reins/protocol";
import type { TransportServer } from "@reins/transport";

import { createConsumerScope } from "./consumer-scope.ts";
import { createControlPlane } from "./control-plane.ts";
import { orderDiagnosticsAcceptance } from "./diagnostics-acceptance.ts";
import type { DiagnosticsRuntime } from "./diagnostics-recorder.ts";
import type { AdapterRegistry } from "./registry.ts";
import { createRoutingDriverFactory } from "./routing-driver.ts";
import { createProtocolServerInternal } from "./server.ts";

export type Daemon = {
  start(): Promise<void>;
  stop(): Promise<void>;
};

export async function runDaemonLifecycle(
  daemon: Daemon,
  diagnostics: {
    record(input: DiagnosticInput): Promise<DiagnosticId | undefined>;
    close(): Promise<void>;
  },
): Promise<void> {
  try {
    const initialized = await diagnostics.record({
      source: "daemon",
      kind: "lifecycle",
      operation: "diagnostics_store",
      reason: "initialized",
    });
    if (initialized === undefined) {
      throw new Error("Diagnostics store lifecycle was not accepted");
    }
    await daemon.start();
  } finally {
    await daemon.stop();
    await diagnostics.close();
  }
}

export function createDaemon(options: {
  transport: TransportServer<ProtocolMessage>;
  adapters: AdapterRegistry;
  identity: SessionIdentity;
  diagnostics: DiagnosticsRuntime;
  runtimeScopeId: RuntimeScopeId;
  controlStore?: ControlStore;
  idleTimeoutMs?: number;
  eventLogLimit?: number;
}): Daemon {
  return createDaemonInternal(options, {});
}

export function createDaemonInternal(
  options: {
    transport: TransportServer<ProtocolMessage>;
    adapters: AdapterRegistry;
    identity: SessionIdentity;
    diagnostics: DiagnosticsRuntime;
    runtimeScopeId: RuntimeScopeId;
    controlStore?: ControlStore;
    idleTimeoutMs?: number;
    eventLogLimit?: number;
  },
  testing: {
    beforeAttachReplay?: (sessionId: SessionId) => void;
    onDiagnosticsQueryAccepted?: () => void;
    onEvent?: (event: DomainEvent) => void;
  },
  assertWriterLease?: () => Promise<void>,
): Daemon {
  const controlStore = options.controlStore ?? createInMemoryControlStore();
  const consumerScope = createConsumerScope(
    (sessionId) => controlStore.getSession(sessionId)?.consumer,
  );
  const diagnostics = orderDiagnosticsAcceptance(
    options.diagnostics,
    consumerScope,
  );
  const coreDiagnostics = {
    async record(fact: CoreDiagnosticFact) {
      const unsafe = fact as unknown as Record<string, unknown>;
      if ("source" in unsafe) return undefined;
      return await diagnostics.record({
        ...fact,
        source: "core",
      });
    },
  };
  const machine = createSessionMachine({
    driverFactory: createRoutingDriverFactory(options.adapters, diagnostics),
    identity: options.identity,
    diagnostics: coreDiagnostics,
  });
  const control = createControlPlane({
    machine,
    adapters: options.adapters,
    diagnostics,
    consumerScope,
    controlStore,
    runtimeScopeId: options.runtimeScopeId,
    ...(assertWriterLease === undefined ? {} : { assertWriterLease }),
    ...(options.eventLogLimit === undefined
      ? {}
      : { eventLogLimit: options.eventLogLimit }),
  });
  const server = createProtocolServerInternal(
    {
      transport: options.transport,
      control,
      diagnostics,
      consumerScope,
      runtimeScopeId: options.runtimeScopeId,
      ...(options.idleTimeoutMs === undefined
        ? {}
        : { idleTimeoutMs: options.idleTimeoutMs }),
    },
    {
      ...(testing.beforeAttachReplay === undefined
        ? {}
        : { beforeAttachReplay: testing.beforeAttachReplay }),
      ...(testing.onDiagnosticsQueryAccepted === undefined
        ? {}
        : {
            onDiagnosticsQueryAccepted: testing.onDiagnosticsQueryAccepted,
          }),
    },
  );
  if (testing.onEvent !== undefined) {
    machine.subscribe(testing.onEvent);
  }
  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopPromise !== undefined) return stopPromise;
    server.quiesce();
    const attempt = (async () => {
      try {
        await control.terminateLiveSessions();
      } catch (error) {
        if (control.liveSessionIds().length > 0) throw error;
        try {
          await server.stop();
        } catch (shutdownError) {
          throw new AggregateError(
            [error, shutdownError],
            "daemon 停止未完全成功",
          );
        }
        throw error;
      }
      await server.stop();
    })();
    stopPromise = attempt;
    void attempt.catch(() => {
      if (stopPromise === attempt) stopPromise = undefined;
    });
    return attempt;
  };
  return {
    start: () => server.start(),
    stop,
  };
}
