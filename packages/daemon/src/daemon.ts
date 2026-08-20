import { createSessionMachine, type SessionIdentity } from "@reins/core";
import {
  type DomainEvent,
  type ProtocolMessage,
  type SessionId,
} from "@reins/protocol";
import type { TransportServer } from "@reins/transport";

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
  diagnostics: { close(): Promise<void> },
): Promise<void> {
  try {
    await daemon.start();
  } finally {
    try {
      await daemon.stop();
    } finally {
      await diagnostics.close();
    }
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
    onEvent?: (event: DomainEvent) => void;
  },
): Daemon {
  const machine = createSessionMachine({
    driverFactory: createRoutingDriverFactory(options.adapters),
    identity: options.identity,
    diagnostics: options.diagnostics,
  });
  const server = createProtocolServerInternal(
    {
      transport: options.transport,
      adapters: options.adapters,
      machine,
      diagnostics: options.diagnostics,
      ...(options.idleTimeoutMs === undefined
        ? {}
        : { idleTimeoutMs: options.idleTimeoutMs }),
      ...(options.eventLogLimit === undefined
        ? {}
        : { eventLogLimit: options.eventLogLimit }),
    },
    testing.beforeAttachReplay === undefined
      ? {}
      : { beforeAttachReplay: testing.beforeAttachReplay },
  );
  machine.subscribe((event) => {
    server.forwardEvent(event);
  });
  if (testing.onEvent !== undefined) {
    machine.subscribe(testing.onEvent);
  }
  return {
    start: () => server.start(),
    stop: () => server.stop(),
  };
}
