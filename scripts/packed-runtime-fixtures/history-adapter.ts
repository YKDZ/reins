// 通过正式 adapter 接口生成用于验证全量分页回放的长消息历史。
import { access } from "node:fs/promises";

import type { HarnessAdapter } from "@reins/daemon";
import type {
  DomainEvent,
  HarnessModelCatalog,
  MessageId,
  WorkerDriver,
} from "@reins/protocol";

const simulatedModelCatalog: HarnessModelCatalog = {
  harness: "qoder",
  models: [
    {
      id: "simulated-model",
      displayName: "Simulated model",
      reasoningEfforts: ["low", "high"],
    },
  ],
};

type HistoryRequest = {
  readonly gate: string;
  readonly messages: number;
  readonly reply: string;
};

async function waitForGate(path: string): Promise<void> {
  while (
    !(await access(path).then(
      () => true,
      () => false,
    ))
  )
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
}

function readHistoryRequest(message: string): HistoryRequest {
  const value: unknown = JSON.parse(message);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("历史事件场景输入格式错误");
  const request = value as Record<string, unknown>;
  if (
    typeof request.gate !== "string" ||
    typeof request.messages !== "number" ||
    typeof request.reply !== "string"
  )
    throw new Error("历史事件场景缺少所需输入");
  return {
    gate: request.gate,
    messages: request.messages,
    reply: request.reply,
  };
}

const simulatedDriverFactory: HarnessAdapter["driverFactory"] = ({ emit }) => {
  const driver: WorkerDriver = {
    async start(spec) {
      const request = readHistoryRequest(spec.message);
      void (async () => {
        await waitForGate(request.gate);
        for (let index = 0; index < request.messages; index += 1) {
          emit({
            type: "message",
            sessionId: spec.sessionId,
            turnId: spec.turnId,
            messageId: `history-${index}` as MessageId,
            role: "worker",
            content: `message ${index}`,
          });
        }
        const completed: DomainEvent = {
          type: "turn.completed",
          sessionId: spec.sessionId,
          turnId: spec.turnId,
          stopReason: "end_turn",
          finalReply: request.reply,
        };
        emit(completed);
      })();
    },
    async deliver() {
      throw new Error("历史事件场景不支持追加消息");
    },
    async interrupt() {
      throw new Error("历史事件场景不支持中断");
    },
    resolvePermission() {
      throw new Error("历史事件场景不支持授权");
    },
    async terminate() {},
  };
  return driver;
};

const simulatedRegistryModule = {
  qoder: {
    driverFactory: simulatedDriverFactory,
    async modelCatalog(): Promise<HarnessModelCatalog> {
      return simulatedModelCatalog;
    },
  } satisfies HarnessAdapter,
} satisfies Record<string, HarnessAdapter>;

export default simulatedRegistryModule;
