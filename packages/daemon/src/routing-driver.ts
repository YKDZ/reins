import {
  isDriverFailure,
  makeErrorCause,
  type MachineError,
  type DiagnosticInput,
  type DriverDiagnosticFact,
  type SessionId,
  type TurnId,
  type WorkerDriver,
  type WorkerDriverFactory,
  type WorkerSpec,
} from "@reins/protocol";

import type { DiagnosticsRuntime } from "./diagnostics-recorder.ts";
import type { AdapterRegistry } from "./registry.ts";

// SessionMachine 只接受单一 driverFactory；路由 driver 按 harness 懒实例化
// 各家 factory，并按 sessionId→harness 表路由（ADR-0009 adapter 表落地）。
export function createRoutingDriverFactory(
  adapters: AdapterRegistry,
  diagnostics: Pick<DiagnosticsRuntime, "record" | "query">,
): WorkerDriverFactory {
  return (emit) => {
    const drivers = new Map<string, WorkerDriver>();
    const sessionHarness = new Map<SessionId, string>();
    const sessionTurn = new Map<SessionId, TurnId>();

    async function recordAdapterFact(
      harness: string,
      fact: DriverDiagnosticFact,
    ) {
      const unsafe = fact as unknown as Record<string, unknown>;
      if ("source" in unsafe || "harness" in unsafe) {
        return undefined;
      }
      const input =
        fact.kind === "harness_stderr"
          ? ({ ...fact, source: "harness", harness } as DiagnosticInput)
          : ({ ...fact, source: "adapter", harness } as DiagnosticInput);
      return await diagnostics.record(input);
    }

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

    async function verifiedDriverFailure(
      error: unknown,
      harness: string,
      sessionId: SessionId,
    ): Promise<MachineError | undefined> {
      if (!isDriverFailure(error) || error.diagnosticId === undefined) {
        return undefined;
      }
      try {
        const result = await diagnostics.query({
          diagnosticId: error.diagnosticId,
        });
        if (!("record" in result)) return undefined;
        const record = result.record;
        if (
          record.diagnosticId !== error.diagnosticId ||
          record.source !== "adapter" ||
          record.harness !== harness ||
          record.sessionId !== sessionId ||
          ("turnId" in record &&
            record.turnId !== sessionTurn.get(sessionId)) ||
          record.kind !== "request_failure" ||
          record.operation !== "kill" ||
          record.stage !== "terminate"
        ) {
          return undefined;
        }
        return {
          code: "internal_error",
          cause: makeErrorCause("upstream", error.message),
          diagnosticId: error.diagnosticId,
        };
      } catch {
        return undefined;
      }
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
          driver = adapter.driverFactory({
            emit,
            diagnostics: (input) => recordAdapterFact(spec.harness, input),
          });
          drivers.set(spec.harness, driver);
        }
        try {
          driver.start(spec);
          sessionHarness.set(spec.sessionId, spec.harness);
          sessionTurn.set(spec.sessionId, spec.turnId);
        } catch (error) {
          sessionHarness.delete(spec.sessionId);
          sessionTurn.delete(spec.sessionId);
          throw error;
        }
      },
      deliver(sessionId, turnId, message) {
        driverFor(sessionId).deliver(sessionId, turnId, message);
        sessionTurn.set(sessionId, turnId);
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
      async terminate(sessionId) {
        const harness = sessionHarness.get(sessionId);
        if (harness === undefined) {
          throw new Error(`No routing entry for session ${sessionId}`);
        }
        const driver = drivers.get(harness);
        if (driver === undefined) {
          throw new Error(`No driver for harness ${harness}`);
        }
        try {
          await driver.terminate(sessionId);
        } catch (error) {
          throw (
            (await verifiedDriverFailure(error, harness, sessionId)) ?? error
          );
        }
        sessionHarness.delete(sessionId);
        sessionTurn.delete(sessionId);
      },
    };
    return routingDriver;
  };
}
