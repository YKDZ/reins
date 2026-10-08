import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, onTestFinished, test } from "vitest";

import { DEFAULT_BOOTSTRAP_IMAGE } from "../src/defaults.ts";
import { destroyPlatform, statusPlatform } from "../src/lifecycle.ts";
import { runRound } from "../src/round.ts";

const repository = fileURLToPath(new URL("../../../", import.meta.url));

test("正式 pnpm 输入组在 Docker 中执行完整 worker 回合并在销毁后保留产品事实", async () => {
  const root = join(repository, ".artifacts/acceptance-docker");
  const input = join(root, "input");
  const evidenceDirectory = join(root, "evidence");
  const options = {
    stateDirectory: join(root, "state"),
    bootstrapImage: DEFAULT_BOOTSTRAP_IMAGE,
    timeoutMs: 420_000,
  };
  if (existsSync(options.stateDirectory)) {
    throw new Error(
      "Recover the previous acceptance platform before starting another round.",
    );
  }
  const group = join(repository, ".artifacts/acceptance-input");
  const identity = JSON.parse(
    await readFile(join(group, "input.json"), "utf8"),
  ) as {
    pnpmVersion: string;
    files: Record<string, string>;
  };
  // 独立输入组保持原样，场景证据写入它的同级目录，不改变组内成员或锁。
  await rm(input, { recursive: true, force: true });
  await mkdir(input, { recursive: true });
  await cp(group, join(input, "group"), { recursive: true });
  onTestFinished(async () => {
    if (existsSync(options.stateDirectory)) {
      const cleanup = await destroyPlatform(options);
      expect(cleanup.disposition, JSON.stringify(cleanup)).toBe("destroyed");
    }
    await rm(input, { recursive: true, force: true });
  }, 1_800_000);

  const result = await runRound(options, {
    evidenceDirectory,
    identification: { scenario: "formal-pnpm-consumer" },
    scenarios: [
      {
        image: "node:24-bookworm",
        sourceDirectory: input,
        environment: { PNPM_VERSION: identity.pnpmVersion },
        command: [
          "sh",
          "-c",
          [
            "set -eu",
            'npm install --global "pnpm@$PNPM_VERSION"',
            'exec node group/fixtures/scripts/check-pnpm-consumer-round.ts "$PWD/group" "$PWD/group/fixtures/scripts/packed-cli-fixtures/simulated-adapter.ts" "$PWD/evidence"',
          ].join("\n"),
        ],
        timeoutMs: 900_000,
        logPaths: ["evidence"],
      },
    ],
  });
  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(result.disposition).toBe("destroyed");
  expect(result.verification).toMatchObject({
    scenarioExecution: "passed",
    scenarioCleanup: "passed",
    evidenceExport: "passed",
    platformReclaim: "passed",
  });
  const scenario = result.scenarios[0];
  expect(scenario?.exitCode).toBe(0);
  if (scenario === undefined)
    throw new Error("The consumer scenario did not run.");
  expect(scenario.resolvedImage.id).toMatch(/^sha256:/);
  const exported = join(
    evidenceDirectory,
    "rounds",
    result.roundId,
    "scenarios",
    scenario.id,
    "collected",
    "evidence",
  );
  const facts = (
    await readFile(join(exported, "pnpm-round-facts.ndjson"), "utf8")
  )
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          label: string;
          fact: Record<string, unknown>;
        },
    );
  const fact = (label: string) =>
    facts.find((entry) => entry.label === label)?.fact;
  expect(fact("worker_round")).toMatchObject({ status: "passed" });
  expect(fact("product_socket_cleanup")).toMatchObject({
    socketPresent: false,
    lockPresent: false,
  });
  expect(fact("runtime_cleanup")).toMatchObject({ removed: true });
  expect(fact("acceptance_input_identity")?.files).toEqual(identity.files);
  expect(fact("acceptance_input_reverified")?.files).toEqual(identity.files);
  expect((await statusPlatform(options)).phase).toBe("absent");
  expect(existsSync(options.stateDirectory)).toBe(false);
}, 1_800_000);
