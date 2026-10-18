import type { SessionIdentity } from "@reins/core";
import {
  runtimeScopeIdSchema,
  type DomainEvent,
  type ProtocolMessage,
  type RuntimeScopeId,
  type SessionId,
} from "@reins/protocol";
import type { TransportServer } from "@reins/transport";
import * as v from "valibot";

import { createDaemonInternal, type Daemon } from "./daemon.ts";
import type { DiagnosticsRuntime } from "./diagnostics-recorder.ts";
import type { AdapterRegistry } from "./registry.ts";

export function createDaemonForTest(options: {
  transport: TransportServer<ProtocolMessage>;
  adapters: AdapterRegistry;
  identity: SessionIdentity;
  diagnostics: DiagnosticsRuntime;
  runtimeScopeId?: RuntimeScopeId;
  idleTimeoutMs?: number;
  eventLogLimit?: number;
  beforeAttachReplay?: (sessionId: SessionId) => void;
  onDiagnosticsQueryAccepted?: () => void;
  onEvent?: (event: DomainEvent) => void;
  assertWriterLease?: () => Promise<void>;
}): Daemon {
  const {
    beforeAttachReplay,
    onDiagnosticsQueryAccepted,
    onEvent,
    assertWriterLease,
    runtimeScopeId,
    ...productionOptions
  } = options;
  return createDaemonInternal(
    {
      ...productionOptions,
      runtimeScopeId:
        runtimeScopeId ??
        v.parse(runtimeScopeIdSchema, "00000000-0000-4000-8000-000000000000"),
    },
    {
      ...(beforeAttachReplay === undefined ? {} : { beforeAttachReplay }),
      ...(onDiagnosticsQueryAccepted === undefined
        ? {}
        : { onDiagnosticsQueryAccepted }),
      ...(onEvent === undefined ? {} : { onEvent }),
    },
    assertWriterLease,
  );
}
