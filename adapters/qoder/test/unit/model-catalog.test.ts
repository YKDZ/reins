import { describe, expect, test } from "vitest";

import { createQoderModelCatalog } from "#/model-catalog";

import { createFakeSdk } from "../helpers/fake-sdk.ts";

describe("Qoder 模型目录", () => {
  test("实时查询并映射为模型目录", async () => {
    const { sdk, controls } = createFakeSdk();
    controls.setAvailableModels([
      {
        value: "qwen3.7-flash",
        displayName: "Qwen3.7 Flash",
        description: "低成本快速模型",
        efforts: ["low", "high"],
        isEnabled: true,
      },
      {
        value: "qwen3.7-max",
        displayName: "Qwen3.7 Max",
        description: "旗舰模型",
        isEnabled: true,
      },
      {
        value: "qwen-disabled",
        displayName: "Disabled",
        description: "已禁用",
        efforts: ["low"],
        isEnabled: false,
      },
    ]);

    const modelCatalog = await createQoderModelCatalog(sdk)();

    expect(controls.modelsCalls()).toBe(1);
    expect(modelCatalog).toEqual({
      harness: "qoder",
      models: [
        {
          id: "qwen3.7-flash",
          displayName: "Qwen3.7 Flash",
          reasoningEfforts: ["low", "high"],
        },
        {
          id: "qwen3.7-max",
          displayName: "Qwen3.7 Max",
          reasoningEfforts: [],
        },
      ],
    });
  });

  test("SDK 查询失败时错误上抛，由 daemon 归入失败面", async () => {
    const { sdk, controls } = createFakeSdk();
    controls.setAvailableModels([]);
    const failingSdk = {
      ...sdk,
      getAvailableModels: async () => {
        throw new Error("cli 未登录");
      },
    };
    await expect(createQoderModelCatalog(failingSdk)()).rejects.toThrow(
      "cli 未登录",
    );
  });
});
