import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, onTestFinished, test } from "vitest";

import { DEFAULT_BOOTSTRAP_IMAGE } from "../src/defaults.ts";
import { executeDocker } from "../src/docker.ts";
import { destroyPlatform, statusPlatform } from "../src/lifecycle.ts";
import { runRound } from "../src/round.ts";
import type { DockerExecutor } from "../src/types.ts";

const repository = fileURLToPath(new URL("../../../", import.meta.url));

test("完整销毁后同一状态路径重建不同实例，旧镜像、卷与工作区均不存在", async () => {
  const root = join(repository, ".artifacts/recovery-docker");
  const evidenceDirectory = join(root, "evidence", "rebuild");
  const options = {
    stateDirectory: join(root, "rebuild-state"),
    bootstrapImage: DEFAULT_BOOTSTRAP_IMAGE,
    timeoutMs: 420_000,
  };
  if (existsSync(options.stateDirectory)) {
    throw new Error("Recover the previous rebuild platform first.");
  }
  await mkdir(evidenceDirectory, { recursive: true });
  onTestFinished(async () => {
    if (!existsSync(options.stateDirectory)) return;
    const cleanup = await destroyPlatform(options);
    expect(cleanup.disposition, JSON.stringify(cleanup)).toBe("destroyed");
  }, 1_800_000);

  const first = await runRound(options, {
    reuse: true,
    evidenceDirectory,
    scenarios: [{ image: "alpine:3.20", command: ["true"] }],
  });
  expect(first, JSON.stringify(first)).toMatchObject({
    exitCode: 0,
    disposition: "retained",
    verification: { scenarioExecution: "passed", scenarioCleanup: "passed" },
  });
  const oldContainer = (await statusPlatform(options)).manifest!.names
    .containerName;
  const oldScenario = first.scenarios[0]!;
  const oldImage = oldScenario.resolvedImage.id;
  expect(oldImage).toBeTruthy();
  const oldDigest = oldScenario.resolvedImage.digests[0];
  expect(oldDigest).toBeTruthy();
  const oldVolume = "rebuild-cache";
  const oldWorkspace = oldScenario.workspacePath;
  const oldFacts = [];
  // 显式制造跨轮允许保留的缓存及旧工作区标记，先证实它们真实存在，再销毁。
  for (const args of [
    ["exec", oldContainer, "docker", "tag", oldImage!, "rebuild-cache:local"],
    ["exec", oldContainer, "docker", "volume", "create", oldVolume],
    [
      "exec",
      oldContainer,
      "sh",
      "-c",
      'mkdir -p "$1"; printf old > "$1/rebuild-canary"',
      "rebuild-marker",
      oldWorkspace,
    ],
    ["exec", oldContainer, "docker", "image", "inspect", oldImage!],
    ["exec", oldContainer, "docker", "volume", "inspect", oldVolume],
    ["exec", oldContainer, "test", "-f", `${oldWorkspace}/rebuild-canary`],
  ]) {
    const result = await executeDocker(options, args);
    oldFacts.push({ args, result });
    expect(result.exitCode, result.stderr).toBe(0);
  }
  await writeFile(
    join(evidenceDirectory, "before-destroy.json"),
    JSON.stringify(oldFacts, null, 2),
  );
  const destroyed = await destroyPlatform(options);
  expect(destroyed, JSON.stringify(destroyed)).toMatchObject({
    disposition: "destroyed",
    failures: [],
  });
  expect((await statusPlatform(options)).phase).toBe("absent");
  expect(existsSync(options.stateDirectory)).toBe(false);

  let observed = false;
  const execute: DockerExecutor = async (config, args, execution) => {
    // 只在真实场景容器启动的 Docker 边界观察，不规定此前调用数量或次序。
    if (
      !observed &&
      args[0] === "exec" &&
      args.includes("docker") &&
      args.includes("run")
    ) {
      observed = true;
      const container = args[1]!;
      const queries = [
        ["exec", container, "docker", "image", "ls", "--all", "--quiet"],
        ["exec", container, "docker", "volume", "ls", "--quiet"],
        ["exec", container, "docker", "image", "inspect", oldImage!],
        ["exec", container, "docker", "image", "inspect", oldDigest!],
        ["exec", container, "test", "!", "-e", oldWorkspace],
      ];
      const facts = [];
      for (const query of queries)
        facts.push({ args: query, result: await executeDocker(config, query) });
      await writeFile(
        join(evidenceDirectory, "rebuilt-before-scenario.json"),
        JSON.stringify(facts, null, 2),
      );
      expect(facts[0]!.result.exitCode).toBe(0);
      expect(facts[0]!.result.stdout.trim()).toBe("");
      expect(facts[1]!.result.exitCode).toBe(0);
      expect(facts[1]!.result.stdout.trim()).toBe("");
      for (const fact of facts.slice(2, 4)) {
        expect(fact.result.exitCode).toBe(1);
        expect(fact.result.stderr).toContain("No such image");
      }
      expect(facts[4]!.result.exitCode).toBe(0);
    }
    return executeDocker(config, args, execution);
  };
  const rebuilt = await runRound(
    options,
    {
      evidenceDirectory,
      scenarios: [{ image: "alpine:3.20", command: ["true"] }],
    },
    { execute },
  );
  expect(observed).toBe(true);
  expect(rebuilt, JSON.stringify(rebuilt)).toMatchObject({
    exitCode: 0,
    disposition: "destroyed",
    verification: {
      scenarioExecution: "passed",
      scenarioCleanup: "passed",
      evidenceExport: "passed",
      platformReclaim: "passed",
    },
  });
  expect(rebuilt.platformId).not.toBe(first.platformId);
  expect(rebuilt.platform.innerEngineId).not.toBe(first.platform.innerEngineId);
  expect(rebuilt.reclamation.failures).toEqual([]);
  expect((await statusPlatform(options)).phase).toBe("absent");
  expect(existsSync(options.stateDirectory)).toBe(false);
}, 1_800_000);
