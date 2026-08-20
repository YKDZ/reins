import {
  createSessionMachine,
  type DiagnosticEmitter,
  type SessionIdentity,
} from "@reins/core";
import type { ProtocolMessage } from "@reins/protocol";
import type { TransportServer } from "@reins/transport";

import type { AdapterRegistry } from "./registry.ts";
import { createRoutingDriverFactory } from "./routing-driver.ts";
import { createProtocolServer } from "./server.ts";

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
  diagnostics: DiagnosticEmitter;
  idleTimeoutMs?: number;
  eventLogLimit?: number;
}): Daemon {
  const machine = createSessionMachine({
    driverFactory: createRoutingDriverFactory(options.adapters),
    identity: options.identity,
    diagnostics: options.diagnostics,
    onListenerError(error, event) {
      console.error("daemon event subscriber error", error, event);
    },
  });
  const server = createProtocolServer({
    transport: options.transport,
    adapters: options.adapters,
    machine,
    ...(options.idleTimeoutMs === undefined
      ? {}
      : { idleTimeoutMs: options.idleTimeoutMs }),
    ...(options.eventLogLimit === undefined
      ? {}
      : { eventLogLimit: options.eventLogLimit }),
  });
  machine.subscribe((event) => {
    server.forwardEvent(event);
  });
  return {
    start: () => server.start(),
    stop: () => server.stop(),
  };
}
