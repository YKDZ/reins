import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { createRealQoderSdk } from "#/sdk-binding";

const runtimePath = fileURLToPath(
  new URL("../fixtures/model-query-runtime.ts", import.meta.url),
);
const environmentKeys = [
  "QODERCLI_PATH",
  "QODER_MODEL_QUERY_DIR",
  "QODER_MODEL_QUERY_MODE",
] as const;
const previousEnvironment = new Map<string, string | undefined>();

function configureEnvironment(directory: string, mode?: string): void {
  for (const key of environmentKeys) {
    previousEnvironment.set(key, process.env[key]);
  }
  process.env.QODERCLI_PATH = runtimePath;
  process.env.QODER_MODEL_QUERY_DIR = directory;
  if (mode === undefined) delete process.env.QODER_MODEL_QUERY_MODE;
  else process.env.QODER_MODEL_QUERY_MODE = mode;
}

afterEach(() => {
  for (const key of environmentKeys) {
    const value = previousEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previousEnvironment.clear();
});

async function readEvents(directory: string): Promise<string[] | undefined> {
  try {
    return (await readFile(join(directory, "events.jsonl"), "utf8"))
      .trim()
      .split("\n");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

async function waitForEndOfInput(directory: string): Promise<string[]> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const events = await readEvents(directory);
    if (events?.includes("stdin_eof")) return events;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for model query input to end");
}

describe("Qoder 官方模型查询生命周期", () => {
  test("live model lookup sends its control request before temporary input reaches EOF", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-qoder-models-"));
    configureEnvironment(directory);
    try {
      const models = await createRealQoderSdk().getAvailableModels({
        fetchStrategy: "live",
      });
      expect(models).toEqual([
        {
          value: "fixture-model",
          displayName: "Fixture model",
          description: "Local control fixture",
        },
      ]);

      const events = await waitForEndOfInput(directory);
      expect(events.indexOf("get_models_response")).toBeGreaterThanOrEqual(0);
      expect(events.indexOf("get_models_response")).toBeLessThan(
        events.indexOf("stdin_eof"),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 8_000);

  test("failed live model lookup closes its temporary input and propagates the error", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "reins-qoder-model-failure-"),
    );
    configureEnvironment(directory, "reject");
    try {
      await expect(
        createRealQoderSdk().getAvailableModels({ fetchStrategy: "live" }),
      ).rejects.toThrow("fixture model lookup failure");

      const events = await waitForEndOfInput(directory);
      expect(events.indexOf("get_models_response")).toBeGreaterThanOrEqual(0);
      expect(events.indexOf("get_models_response")).toBeLessThan(
        events.indexOf("stdin_eof"),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 8_000);
});
