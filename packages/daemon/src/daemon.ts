import { createSessionMachine, type SessionIdentity } from "@reins/core";
import {
  type DiagnosticId,
  type DiagnosticInput,
  type CoreDiagnosticFact,
  type DomainEvent,
  type ProtocolMessage,
  type SessionId,
} from "@reins/protocol";
import type { TransportServer } from "@reins/transport";

import { createConsumerScope } from "./consumer-scope.ts";
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
    idleTimeoutMs?: number;
    eventLogLimit?: number;
  },
  testing: {
    beforeAttachReplay?: (sessionId: SessionId) => void;
    onDiagnosticsQueryAccepted?: () => void;
    onEvent?: (event: DomainEvent) => void;
  },
): Daemon {
  const consumerScope = createConsumerScope();
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
  const server = createProtocolServerInternal(
    {
      transport: options.transport,
      adapters: options.adapters,
      machine,
      diagnostics,
      consumerScope,
      ...(options.idleTimeoutMs === undefined
        ? {}
        : { idleTimeoutMs: options.idleTimeoutMs }),
      ...(options.eventLogLimit === undefined
        ? {}
        : { eventLogLimit: options.eventLogLimit }),
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
  machine.subscribe((event) => {
    server.forwardEvent(event);
  });
  if (testing.onEvent !== undefined) {
    machine.subscribe(testing.onEvent);
  }
  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopPromise !== undefined) return stopPromise;
    server.quiesce();
    const attempt = (async () => {
      const liveSessionIds = machine
        .list()
        .filter((session) => session.state !== "killed")
        .map((session) => session.sessionId);
      const results = await Promise.allSettled(
        liveSessionIds.map(async (sessionId) => {
          await machine.kill({ sessionId: sessionId });
        }),
      );
      const failures = results
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result) => result.reason);
      if (failures.length > 0) {
        throw new AggregateError(failures, "Worker cleanup failed");
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
