import { describe, expect, test } from "vitest";

import { createCodexCapabilities } from "#/capabilities";

import { createFakeTransport } from "../helpers/fake-transport.ts";

describe("codex capabilities", () => {
  test("model/list 实时查询并映射为能力矩阵", async () => {
    const { transport, controls } = createFakeTransport();
    controls.setResponse("model/list", {
      data: [
        {
          id: "internal-spark-uuid",
          model: "gpt-5.3-codex-spark",
          displayName: "GPT-5.3 Codex Spark",
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Low" },
            { reasoningEffort: "high", description: "High" },
          ],
        },
        {
          id: "internal-hidden-uuid",
          model: "hidden-model",
          displayName: "Hidden",
          hidden: true,
          supportedReasoningEfforts: [],
        },
      ],
      nextCursor: null,
    });

    const capability = await createCodexCapabilities({
      transportFactory: () => transport,
    })();

    expect(controls.requests().map((entry) => entry.method)).toEqual([
      "initialize",
      "model/list",
    ]);
    expect(controls.closed()).toBe(true);
    expect(capability).toEqual({
      harness: "codex",
      models: [
        {
          id: "gpt-5.3-codex-spark",
          displayName: "GPT-5.3 Codex Spark",
          reasoningEfforts: ["low", "high"],
        },
      ],
    });
  });

  test("model/list 失败时错误上抛，由 daemon 归入失败面", async () => {
    const { transport, controls } = createFakeTransport();
    const failingTransport = {
      ...transport,
      request: async () => {
        throw new Error("app-server 不可用");
      },
    };
    await expect(
      createCodexCapabilities({ transportFactory: () => failingTransport })(),
    ).rejects.toThrow("app-server 不可用");
    expect(controls.closed()).toBe(true);
  });
});
