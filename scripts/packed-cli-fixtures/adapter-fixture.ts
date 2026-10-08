// 受正式接口类型约束的 adapter 注册表素材（仅测试设施使用，不进入产品运行依赖）。
// 替换点只有现有注册表接缝（daemon 的 REINS_ADAPTERS_MODULE / --adapters 加载）。
// 本切片只提供注册表能力目录素材：完整 worker 回合归 S2b2，driverFactory 被调用
// 即失败，绝不编造 worker 提示词、模型或推理输入。
import type { HarnessAdapter } from "@reins/daemon";
import type { AdapterDriverFactory, HarnessCapability } from "@reins/protocol";

// 场景作者明确创作的能力目录；displayName 等运行时文本保持英文。
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

const fixtureDriverFactory: AdapterDriverFactory = () => {
  throw new Error("worker rounds are not part of this scenario");
};

// satisfies 把素材钉在 daemon 注册表的正式条目类型上：形状漂移在 typecheck 失败。
const registryAdapterModule = {
  fixture: {
    driverFactory: fixtureDriverFactory,
    async capabilities(): Promise<HarnessCapability> {
      return fixtureCapabilities;
    },
  } satisfies HarnessAdapter,
} satisfies Record<string, HarnessAdapter>;

export default registryAdapterModule;
