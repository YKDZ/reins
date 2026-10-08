import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, onTestFinished, test } from "vitest";

import { DEFAULT_BOOTSTRAP_IMAGE } from "../src/defaults.ts";
import { executeDocker } from "../src/docker.ts";
import { destroyPlatform, statusPlatform } from "../src/lifecycle.ts";
import { runRound } from "../src/round.ts";
import type { DockerExecutor } from "../src/types.ts";

const repository = fileURLToPath(new URL("../../../", import.meta.url));

test("真实部分创建遇归属冲突时保留外来资源与失败事实，解除冲突后可重试销毁", async () => {
  const root = join(repository, ".artifacts/recovery-docker");
  const evidenceDirectory = join(root, "evidence");
  const options = {
    stateDirectory: join(root, "state"),
    bootstrapImage: DEFAULT_BOOTSTRAP_IMAGE,
    timeoutMs: 180_000,
  };
  if (existsSync(options.stateDirectory)) {
    throw new Error("Recover the previous fault-injection platform first.");
  }
  await mkdir(evidenceDirectory, { recursive: true });
  let foreignNetwork: string | undefined;
  let createdVolume: string | undefined;
  onTestFinished(async () => {
    if (foreignNetwork !== undefined) {
      const removed = await executeDocker(options, [
        "network",
        "rm",
        foreignNetwork,
      ]);
      expect(removed.exitCode, removed.stderr).toBe(0);
    }
    if (existsSync(options.stateDirectory)) {
      const cleanup = await destroyPlatform(options);
      expect(cleanup.disposition, JSON.stringify(cleanup)).toBe("destroyed");
    }
  });
  // 仅在 Docker 边界注入真实归属冲突；所有生产命令及失败响应均来自实际 daemon。
  const execute: DockerExecutor = async (config, args, execution) => {
    const result = await executeDocker(config, args, execution);
    if (
      createdVolume === undefined &&
      args[0] === "volume" &&
      args[1] === "create" &&
      result.exitCode === 0
    ) {
      createdVolume = result.stdout.trim();
      const manifest = JSON.parse(
        await readFile(join(options.stateDirectory, "platform.json"), "utf8"),
      ) as {
        names: { networkName: string };
      };
      foreignNetwork = manifest.names.networkName;
      const injected = await executeDocker(options, [
        "network",
        "create",
        "--label",
        "reins-test-owner=caller",
        foreignNetwork,
      ]);
      expect(injected.exitCode, injected.stderr).toBe(0);
      await writeFile(
        join(evidenceDirectory, "injection.json"),
        JSON.stringify({ createdVolume, foreignNetwork, injected }, null, 2),
      );
    }
    return result;
  };
  const first = await runRound(
    options,
    {
      evidenceDirectory,
      scenarios: [{ image: "alpine:3.20", command: ["true"] }],
    },
    { execute },
  );
  expect(createdVolume).toBeTruthy();
  expect(first.disposition, JSON.stringify(first)).toBe("recovery_required");
  expect(first.exitCode).toBe(1);
  expect(first.scenarios[0]?.phase).toBe("not_run");
  expect(first.reclamation.failures.join("\n")).toContain("ownership");
  expect(existsSync(options.stateDirectory)).toBe(true);
  const network = foreignNetwork;
  if (network === undefined)
    throw new Error("The real conflict was not injected.");
  const preserved = await executeDocker(options, [
    "network",
    "inspect",
    "--format",
    '{{index .Labels "reins-test-owner"}}',
    network,
  ]);
  expect(preserved.exitCode, preserved.stderr).toBe(0);
  expect(preserved.stdout.trim()).toBe("caller");
  const reclamationPath = join(
    evidenceDirectory,
    "rounds",
    first.roundId,
    "reclamation.jsonl",
  );
  const failedRecord = await readFile(reclamationPath, "utf8");
  expect(failedRecord).toContain("ownership");
  const removed = await executeDocker(options, ["network", "rm", network]);
  expect(removed.exitCode, removed.stderr).toBe(0);
  foreignNetwork = undefined;
  const retry = await destroyPlatform(options);
  expect(retry.disposition, JSON.stringify(retry)).toBe("destroyed");
  expect((await statusPlatform(options)).phase).toBe("absent");
  expect(await readFile(reclamationPath, "utf8")).toContain(
    failedRecord.trim(),
  );
  const volume = await executeDocker(options, [
    "volume",
    "inspect",
    createdVolume!,
  ]);
  expect(volume.exitCode).toBe(1);
  expect(volume.stderr).toContain("no such volume");
}, 600_000);
