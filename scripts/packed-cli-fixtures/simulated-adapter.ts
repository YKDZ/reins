// 场景作者创作的可控 adapter：受 daemon 注册表与 protocol driver 正式类型约束，
// 执行一次完整的 worker/session 回合。唯一替换点仍是现有注册表接缝
// （daemon 的 REINS_ADAPTERS_MODULE / --adapters 加载），不新增产品 hook。
// 本模块只模拟厂商响应内容：不接触任何厂商 SDK 或真实协议，其通过不证明
// 具体 harness、SDK、协议或真实服务可用。
// 全部类型输入均为 type-only import：Node 24 类型擦除后运行期不解析 workspace 包，
// 因此该文件可作为验收输入组成员被独立复制执行。
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { HarnessAdapter } from "@reins/daemon";
import type {
  AdapterDriverFactory,
  DomainEvent,
  HarnessCapability,
  SessionId,
  TurnId,
  WorkerDriver,
  WorkerSpec,
} from "@reins/protocol";

// 能力目录由场景作者明确创作：模型与推理档位是本场景显式可给的选项。
const simulatedCapability: HarnessCapability = {
  harness: "simulated",
  models: [
    {
      id: "simulated-model",
      displayName: "Simulated model",
      reasoningEfforts: ["low", "high"],
    },
  ],
};

// worker 文本由场景作者创作；控制面不得补值或改写。
const simulatedFinalReply = "simulated reply";

// 观察记录是可选接缝：调用方给出路径时，adapter 把自己实际收到的输入原样落盘，
// 让「未提供的字段保持省略」成为可读证据，而不是由控制面或测试设施推断。
const observationLog = process.env.REINS_SIMULATED_OBSERVATION_LOG;

function prepareObservationLog(): string | undefined {
  if (observationLog === undefined || observationLog === "") return undefined;
  mkdirSync(dirname(observationLog), { recursive: true });
  return observationLog;
}

const observationPath = prepareObservationLog();

function record(observation: Record<string, unknown>): void {
  if (observationPath === undefined) return;
  appendFileSync(observationPath, `${JSON.stringify(observation)}\n`, "utf8");
}

// 回合结束事件保持正式 DomainEvent 形状：turnId 只来自 core 交下来的本次回合。
function completedTurn(sessionId: SessionId, turnId: TurnId): DomainEvent {
  return {
    type: "turn.completed",
    sessionId,
    turnId,
    stopReason: "end_turn",
    finalReply: simulatedFinalReply,
  };
}

const simulatedDriverFactory: AdapterDriverFactory = ({ emit }) => {
  function complete(sessionId: SessionId, turnId: TurnId): void {
    queueMicrotask(() => {
      emit(completedTurn(sessionId, turnId));
    });
  }

  const driver: WorkerDriver = {
    start(spec: WorkerSpec) {
      // 原样记录收到的 spec：JSON 保留可选键的缺失，不用空字符串替代省略。
      record({ operation: "start", spec });
      complete(spec.sessionId, spec.turnId);
    },
    async deliver(sessionId, turnId, message) {
      record({ operation: "deliver", sessionId, turnId, message });
      complete(sessionId, turnId);
    },
    async interrupt(sessionId) {
      throw new Error(
        `interrupt is not part of the simulated round: ${sessionId}`,
      );
    },
    resolvePermission(sessionId, permissionId) {
      throw new Error(
        `permissions are not part of the simulated round: ${sessionId} ${permissionId}`,
      );
    },
    async terminate(sessionId) {
      record({ operation: "terminate", sessionId });
    },
  };
  return driver;
};

// satisfies 把注册表条目钉在 daemon 的正式条目类型上：形状漂移在 typecheck 失败。
const simulatedRegistryModule = {
  simulated: {
    driverFactory: simulatedDriverFactory,
    async capabilities(): Promise<HarnessCapability> {
      return simulatedCapability;
    },
  } satisfies HarnessAdapter,
} satisfies Record<string, HarnessAdapter>;

export default simulatedRegistryModule;
