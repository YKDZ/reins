// 真实 worker 素材只通过 daemon 已有的 REINS_ADAPTERS_MODULE 注册表接缝装载。
// 类型输入会由 Node 24 擦除，独立 consumer 运行时不解析工作区包。
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { HarnessAdapter } from "@reins/daemon";
import type {
  AdapterDriverFactory,
  HarnessCapability,
  SessionId,
  WorkerDriver,
} from "@reins/protocol";

type WorkerState = {
  readonly child: ChildProcess;
  readonly closed: Promise<void>;
};

const fixtureCapabilities: HarnessCapability = {
  harness: "fixture",
  models: [
    {
      id: "fixture-model",
      displayName: "Fixture model",
      reasoningEfforts: ["low", "high"],
    },
  ],
};
const observationPath = process.env.REINS_PACKED_FIXTURE_OBSERVATIONS;
const activityPath = process.env.REINS_PACKED_FIXTURE_ACTIVITY;
const capabilityModePath = process.env.REINS_PACKED_FIXTURE_CAPABILITY_MODE;
const terminateGatePath = process.env.REINS_PACKED_FIXTURE_TERMINATE_GATE;
const workerPath = fileURLToPath(
  new URL("./adapter-worker.ts", import.meta.url),
);

function record(value: Record<string, unknown>): void {
  if (observationPath === undefined || observationPath === "") return;
  mkdirSync(dirname(observationPath), { recursive: true });
  appendFileSync(observationPath, `${JSON.stringify(value)}\n`, "utf8");
}

function currentCapabilities(): HarnessCapability {
  if (
    capabilityModePath !== undefined &&
    capabilityModePath !== "" &&
    readFileSync(capabilityModePath, "utf8") === "without-model"
  )
    return { harness: "fixture", models: [] };
  return fixtureCapabilities;
}

const fixtureDriverFactory: AdapterDriverFactory = () => {
  const workers = new Map<SessionId, WorkerState>();
  const terminationAttempts = new Map<SessionId, number>();

  const driver: WorkerDriver = {
    start(spec) {
      const child = spawn(
        process.execPath,
        [workerPath, "worker", activityPath ?? ""],
        {
          detached: true,
          cwd: spec.cwd,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      );
      let closeResolve!: () => void;
      const closed = new Promise<void>((resolve) => {
        closeResolve = resolve;
      });
      child.once("close", () => {
        workers.delete(spec.sessionId);
        closeResolve();
      });
      child.on("message", (message: unknown) => {
        if (
          typeof message !== "object" ||
          message === null ||
          !("descendantPid" in message) ||
          typeof message.descendantPid !== "number" ||
          !("workerCwd" in message) ||
          typeof message.workerCwd !== "string"
        )
          return;
        record({
          type: "worker_ready",
          sessionId: spec.sessionId,
          workerPid: child.pid,
          descendantPid: message.descendantPid,
          workerCwd: message.workerCwd,
        });
      });
      child.once("error", (error) => {
        record({
          type: "worker_start_failed",
          sessionId: spec.sessionId,
          message: error.message,
        });
      });
      workers.set(spec.sessionId, { child, closed });
      record({
        type: "worker_started",
        workerPid: child.pid,
        spec,
      });
    },
    async deliver(_sessionId, _turnId, _message) {
      throw new Error("Message delivery is outside this fixture");
    },
    async interrupt(_sessionId, _turnId) {
      throw new Error("Interrupt is outside this fixture");
    },
    resolvePermission(_sessionId, _permissionId, _resolution) {
      throw new Error("Permissions are outside this fixture");
    },
    async terminate(sessionId) {
      const worker = workers.get(sessionId);
      if (worker === undefined) return;
      const attempt = (terminationAttempts.get(sessionId) ?? 0) + 1;
      terminationAttempts.set(sessionId, attempt);
      record({ type: "terminate_called", sessionId, attempt });
      if (
        attempt === 1 &&
        process.env.REINS_PACKED_FIXTURE_FAIL_FIRST_TERMINATE === "1"
      ) {
        record({ type: "terminate_rejected", sessionId, attempt });
        throw new Error("Fixture intentionally rejects its first cleanup call");
      }
      if (terminateGatePath !== undefined && !existsSync(terminateGatePath)) {
        record({ type: "terminate_waiting", sessionId, attempt });
        await new Promise<void>((resolve) => {
          const checkGate = (): void => {
            if (existsSync(terminateGatePath)) {
              resolve();
              return;
            }
            setTimeout(checkGate, 10);
          };
          checkGate();
        });
        record({ type: "terminate_gate_released", sessionId, attempt });
      }
      if (worker.child.pid !== undefined) {
        try {
          process.kill(-worker.child.pid, "SIGTERM");
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            error.code !== "ESRCH"
          )
            throw error;
        }
      }
      await worker.closed;
      record({ type: "terminate_finished", sessionId, attempt });
    },
  };
  return driver;
};

const registryAdapterModule = {
  fixture: {
    driverFactory: fixtureDriverFactory,
    async capabilities(): Promise<HarnessCapability> {
      const capabilities = currentCapabilities();
      record({
        type: "capabilities_queried",
        harness: capabilities.harness,
        modelIds: capabilities.models.map(({ id }) => id),
      });
      return capabilities;
    },
  } satisfies HarnessAdapter,
} satisfies Record<string, HarnessAdapter>;

export default registryAdapterModule;
