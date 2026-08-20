import type {
  MachineError,
  SessionId,
  WorkerDriver,
  WorkerDriverFactory,
  WorkerSpec,
} from "@reins/protocol";

import type { AdapterRegistry } from "./registry.ts";

// SessionMachine 只接受单一 driverFactory；路由 driver 按 harness 懒实例化
// 各家 factory，并按 sessionId→harness 表路由（ADR-0009 adapter 表落地）。
export function createRoutingDriverFactory(
  adapters: AdapterRegistry,
): WorkerDriverFactory {
  return (emit) => {
    const drivers = new Map<string, WorkerDriver>();
    const sessionHarness = new Map<SessionId, string>();

    function driverFor(sessionId: SessionId): WorkerDriver {
      const harness = sessionHarness.get(sessionId);
      if (harness === undefined) {
        throw new Error(`No routing entry for session ${sessionId}`);
      }
      const driver = drivers.get(harness);
      if (driver === undefined) {
        throw new Error(`No driver for harness ${harness}`);
      }
      return driver;
    }

    const routingDriver: WorkerDriver = {
      start(spec: WorkerSpec) {
        const adapter = adapters.get(spec.harness);
        if (adapter === undefined) {
          throw {
            code: "unknown_harness",
            harness: spec.harness,
            availableHarnesses: [...adapters.keys()],
          } satisfies MachineError;
        }
        let driver = drivers.get(spec.harness);
        if (driver === undefined) {
          driver = adapter.driverFactory(emit);
          drivers.set(spec.harness, driver);
        }
        try {
          driver.start(spec);
          sessionHarness.set(spec.sessionId, spec.harness);
        } catch (error) {
          sessionHarness.delete(spec.sessionId);
          throw error;
        }
      },
      deliver(sessionId, turnId, message) {
        driverFor(sessionId).deliver(sessionId, turnId, message);
      },
      interrupt(sessionId) {
        driverFor(sessionId).interrupt(sessionId);
      },
      resolvePermission(sessionId, permissionId, resolution) {
        driverFor(sessionId).resolvePermission(
          sessionId,
          permissionId,
          resolution,
        );
      },
      terminate(sessionId) {
        const harness = sessionHarness.get(sessionId);
        if (harness === undefined) {
          throw new Error(`No routing entry for session ${sessionId}`);
        }
        const driver = drivers.get(harness);
        if (driver === undefined) {
          throw new Error(`No driver for harness ${harness}`);
        }
        driver.terminate(sessionId);
        sessionHarness.delete(sessionId);
      },
    };
    return routingDriver;
  };
}
