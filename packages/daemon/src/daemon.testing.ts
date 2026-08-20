import type { SessionIdentity } from "@reins/core";
import type { DomainEvent, ProtocolMessage, SessionId } from "@reins/protocol";
import type { TransportServer } from "@reins/transport";

import { createDaemonInternal, type Daemon } from "./daemon.ts";
import type { DiagnosticsRuntime } from "./diagnostics-recorder.ts";
import type { AdapterRegistry } from "./registry.ts";

export function createDaemonForTest(options: {
  transport: TransportServer<ProtocolMessage>;
  adapters: AdapterRegistry;
  identity: SessionIdentity;
  diagnostics: DiagnosticsRuntime;
  idleTimeoutMs?: number;
  eventLogLimit?: number;
  beforeAttachReplay?: (sessionId: SessionId) => void;
  onEvent?: (event: DomainEvent) => void;
}): Daemon {
  const { beforeAttachReplay, onEvent, ...productionOptions } = options;
  return createDaemonInternal(productionOptions, {
    ...(beforeAttachReplay === undefined ? {} : { beforeAttachReplay }),
    ...(onEvent === undefined ? {} : { onEvent }),
  });
}
