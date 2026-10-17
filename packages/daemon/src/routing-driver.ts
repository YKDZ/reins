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

// SessionMachine 只接受单一 driverFactory；每个会话独立实例化所选
// harness 的 driver，并按 sessionId 路由，避免单会话 adapter 状态串用。
export function createRoutingDriverFactory(
  adapters: AdapterRegistry,
  diagnostics: Pick<DiagnosticsRuntime, "record" | "query">,
): WorkerDriverFactory {
  return (emit) => {
    const drivers = new Map<SessionId, WorkerDriver>();
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
      const driver = drivers.get(sessionId);
      if (driver === undefined) {
        throw new Error(`No routing entry for session ${sessionId}`);
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
        const driver = adapter.driverFactory({
          emit,
          diagnostics: (input) => recordAdapterFact(spec.harness, input),
        });
        try {
          driver.start(spec);
          drivers.set(spec.sessionId, driver);
          sessionHarness.set(spec.sessionId, spec.harness);
          sessionTurn.set(spec.sessionId, spec.turnId);
        } catch (error) {
          drivers.delete(spec.sessionId);
          sessionHarness.delete(spec.sessionId);
          sessionTurn.delete(spec.sessionId);
          throw error;
        }
      },
      async deliver(sessionId, turnId, message, placement) {
        const driver = driverFor(sessionId);
        await driver.deliver(sessionId, turnId, message, placement);
        if (drivers.get(sessionId) === driver)
          sessionTurn.set(sessionId, turnId);
      },
      async interrupt(sessionId, turnId) {
        await driverFor(sessionId).interrupt(sessionId, turnId);
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
        const driver = driverFor(sessionId);
        try {
          await driver.terminate(sessionId);
        } catch (error) {
          throw (
            (await verifiedDriverFailure(error, harness, sessionId)) ?? error
          );
        }
        sessionHarness.delete(sessionId);
        sessionTurn.delete(sessionId);
        drivers.delete(sessionId);
      },
    };
    return routingDriver;
  };
}
