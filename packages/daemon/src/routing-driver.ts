import type {
  MachineError,
  SessionId,
  WorkerDriver,
  WorkerDriverFactory,
  WorkerSpec,
} from "@reins/protocol";

import type { AdapterRegistry } from "./registry.ts";

function machineError(
  code: MachineError["code"],
  context?: MachineError["context"],
): MachineError {
  return context === undefined ? { code } : { code, context };
}

// SessionMachine 只接受单一 driverFactory；路由 driver 按 harness 懒实例化
// 各家 factory，并按 sessionId→harness 表路由（ADR-0009 adapter 表落地）。
export function createRoutingDriverFactory(
  adapters: AdapterRegistry,
): WorkerDriverFactory {
  return (emit) => {
    const drivers = new Map<string, WorkerDriver>();
    const sessionHarness = new Map<SessionId, string>();

    function driverFor(sessionId: SessionId): WorkerDriver | null {
      const harness = sessionHarness.get(sessionId);
      if (harness === undefined) return null;
      return drivers.get(harness) ?? null;
    }

    const routingDriver: WorkerDriver = {
      start(spec: WorkerSpec) {
        const adapter = adapters.get(spec.harness);
        if (adapter === undefined) {
          throw machineError("unknown_harness", {
            valid: { harness: [...adapters.keys()] },
          });
        }
        let driver = drivers.get(spec.harness);
        if (driver === undefined) {
          driver = adapter.driverFactory(emit);
          drivers.set(spec.harness, driver);
        }
        sessionHarness.set(spec.sessionId, spec.harness);
        driver.start(spec);
      },
      deliver(sessionId, turnId, message) {
        driverFor(sessionId)?.deliver(sessionId, turnId, message);
      },
      interrupt(sessionId) {
        driverFor(sessionId)?.interrupt(sessionId);
      },
      resolvePermission(sessionId, permissionId, resolution) {
        driverFor(sessionId)?.resolvePermission(
          sessionId,
          permissionId,
          resolution,
        );
      },
      terminate(sessionId) {
        const harness = sessionHarness.get(sessionId);
        if (harness === undefined) return;
        sessionHarness.delete(sessionId);
        drivers.get(harness)?.terminate(sessionId);
      },
    };
    return routingDriver;
  };
}
