import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { destroyPlatform } from "../src/lifecycle.ts";
import {
  acquireStateLock,
  readManifest,
  releaseStateLock,
} from "../src/manifest.ts";
import { ROUND_VERIFICATION_ITEMS, runRound } from "../src/round.ts";
import type { RoundRequest } from "../src/round.ts";
import type { ScenarioRequest } from "../src/runner.ts";
import { PlatformError } from "../src/types.ts";
import type { PlatformOptions } from "../src/types.ts";
import { BOOTSTRAP_IMAGE, fakeEngine, result } from "./fixtures.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

async function createRoot(): Promise<{
  options: PlatformOptions;
  evidenceDirectory: string;
}> {
  const base = await mkdtemp(join(tmpdir(), "reins-platform-round-"));
  directories.push(base);
  return {
    options: {
      stateDirectory: join(base, "state"),
      bootstrapImage: BOOTSTRAP_IMAGE,
      timeoutMs: 500,
    },
    evidenceDirectory: join(base, "evidence"),
  };
}

const SINGLE_SCENARIO: readonly ScenarioRequest[] = [
  { image: "alpine:3.20@sha256:keep", command: ["sh", "-c", "exit 0"] },
];

function roundRequest(
  evidenceDirectory: string,
  overrides: {
    scenarios?: readonly ScenarioRequest[];
    reuse?: boolean;
    signal?: AbortSignal;
  } = {},
): RoundRequest {
  const request: RoundRequest = {
    evidenceDirectory,
    scenarios: overrides.scenarios ?? SINGLE_SCENARIO,
  };
  if (overrides.reuse !== undefined) request.reuse = overrides.reuse;
  if (overrides.signal !== undefined) request.signal = overrides.signal;
  return request;
}

describe("轮次生命周期", () => {
  test("非法场景参数在任何平台资源创建前拒绝", async () => {
    const root = await createRoot();
    const docker = fakeEngine();
    await expect(
      runRound(
        root.options,
        roundRequest(root.evidenceDirectory, {
          scenarios: [
            { image: "alpine:3.20", command: ["true"], workdir: "relative" },
          ],
        }),
        { execute: docker.execute },
      ),
    ).rejects.toMatchObject({ code: "invalidOptions" });
    expect(docker.outer.size).toBe(0);
    expect(docker.calls).toHaveLength(0);
  });

  test("场景日志复制失败单独报告留证失败，保留命令成功事实", async () => {
    const root = await createRoot();
    const docker = fakeEngine();
    docker.setFailure((args) => args[0] === "cp");
    const outcome = await runRound(
      root.options,
      roundRequest(root.evidenceDirectory, {
        scenarios: [
          {
            image: "alpine:3.20",
            command: ["true"],
            logPaths: ["product.log"],
          },
        ],
      }),
      { execute: docker.execute },
    );
    expect(outcome.scenarios[0]?.exitCode).toBe(0);
    expect(outcome.verification.scenarioExecution).toBe("passed");
    expect(outcome.verification.evidenceExport).toBe("failed");
    expect(outcome.exitCode).toBe(1);
    expect(outcome.evidence.failures.join(" ")).toContain("product.log");
  });

  test("场景准备失败的完整 stderr 在销毁后仍可读取", async () => {
    const root = await createRoot();
    const docker = fakeEngine();
    const diagnostic = "workspace preparation failed\n".repeat(1000);
    const outcome = await runRound(
      root.options,
      roundRequest(root.evidenceDirectory),
      {
        execute: async (options, args, commandOptions) => {
          if (args[0] === "exec" && args[2] === "mkdir") {
            const directory = commandOptions?.outputDirectory;
            if (directory === undefined)
              throw new Error("Missing diagnostic destination.");
            await mkdir(directory, { recursive: true });
            await writeFile(join(directory, "stdout.log"), "");
            await writeFile(join(directory, "stderr.log"), diagnostic);
            return result("", 1, diagnostic);
          }
          return docker.execute(options, args, commandOptions);
        },
      },
    );
    expect(outcome.disposition).toBe("destroyed");
    expect(outcome.exitCode).toBe(1);
    const preparation = outcome.evidence.files.find((file) =>
      file.label.endsWith("preparation-1"),
    );
    expect(preparation?.status).toBe("copied");
    await expect(
      readFile(join(preparation!.path, "stderr.log"), "utf8"),
    ).resolves.toBe(diagnostic);
  });

  test("准备失败仍导出失败轮次并回收已创建资源", async () => {
    const root = await createRoot();
    const docker = fakeEngine();
    docker.setFailure((args) => args[0] === "network" && args[1] === "create");
    const result = await runRound(
      root.options,
      roundRequest(root.evidenceDirectory),
      { execute: docker.execute },
    );
    expect(result.exitCode).toBe(1);
    expect(result.scenarios[0]?.phase).toBe("not_run");
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.evidence.exported).toBe(true);
    expect(result.disposition).toBe("destroyed");
    expect(docker.outer.size).toBe(0);
    expect(docker.scenarioRuns()).toHaveLength(0);
  });

  test("默认销毁一轮：执行、留证、回收，并报告全部必需项通过", async () => {
    const root = await createRoot();
    const docker = fakeEngine();
    const result = await runRound(
      root.options,
      roundRequest(root.evidenceDirectory),
      { execute: docker.execute },
    );

    expect(result.exitCode).toBe(0);
    expect(result.disposition).toBe("destroyed");
    expect(result.reuse).toBe(false);
    expect(result.cancelled).toBeNull();
    expect(result.timedOut).toBe(false);
    for (const item of ROUND_VERIFICATION_ITEMS) {
      expect(result.verification[item]).toBe("passed");
    }
    expect(result.notApplicable).toEqual({});
    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0]?.phase).toBe("completed");
    expect(result.scenarios[0]?.exitCode).toBe(0);
    expect(result.evidence.exported).toBe(true);
    expect(
      result.reclamation.facts.some((fact) => fact.kind === "container"),
    ).toBe(true);
    await expect(stat(root.options.stateDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(docker.outer.size).toBe(0);
    const round = JSON.parse(
      await readFile(
        result.evidence.files.find((file) => file.label === "round-facts")!
          .path,
        "utf8",
      ),
    ) as { round: { scenarios: unknown[] } };
    expect(round.round.scenarios).toHaveLength(1);
  });

  test("被测命令退出码 7 保留在记录里，平台只选择失败类别", async () => {
    const root = await createRoot();
    const docker = fakeEngine({
      runOutcomes: [{ exitCode: 7, stderr: "candidate failed" }],
    });
    const result = await runRound(
      root.options,
      roundRequest(root.evidenceDirectory),
      { execute: docker.execute },
    );
    expect(result.exitCode).toBe(1);
    expect(result.scenarios[0]?.exitCode).toBe(7);
    expect(result.verification.scenarioExecution).toBe("failed");
    expect(result.disposition).toBe("destroyed");
  });

  test("场景超时报告 124 并且仍然完整回收", async () => {
    const root = await createRoot();
    const docker = fakeEngine({
      runOutcomes: [{ exitCode: null, timedOut: true }],
    });
    const result = await runRound(
      root.options,
      roundRequest(root.evidenceDirectory),
      { execute: docker.execute },
    );
    expect(result.exitCode).toBe(124);
    expect(result.timedOut).toBe(true);
    expect(result.scenarios[0]?.timedOut).toBe(true);
    expect(result.disposition).toBe("destroyed");
  });

  test.each([
    { reason: "SIGINT" as const, exitCode: 130 },
    { reason: "SIGTERM" as const, exitCode: 143 },
  ])(
    "取消信号 $reason 映射到退出码 $exitCode",
    async ({ reason, exitCode }) => {
      const root = await createRoot();
      const docker = fakeEngine();
      const controller = new AbortController();
      controller.abort(reason);
      const result = await runRound(
        root.options,
        roundRequest(root.evidenceDirectory, { signal: controller.signal }),
        { execute: docker.execute },
      );
      expect(result.cancelled).toBe(reason);
      expect(result.exitCode).toBe(exitCode);
      expect(result.scenarios[0]?.phase).toBe("not_run");
      expect(result.disposition).toBe("destroyed");
    },
  );

  test("显式复用保留健康平台，并把平台回收标为不适用", async () => {
    const root = await createRoot();
    const docker = fakeEngine();
    const first = await runRound(
      root.options,
      roundRequest(root.evidenceDirectory, { reuse: true }),
      { execute: docker.execute },
    );
    expect(first.disposition).toBe("retained");
    expect(first.exitCode).toBe(0);
    expect(first.verification.platformReclaim).toBe("not_run");
    expect(first.notApplicable.platformReclaim).toContain("retained");
    const manifest = await readManifest(root.options);
    expect(manifest?.phase).toBe("retained");
    expect(docker.outer.size).toBe(4);

    const second = await runRound(
      root.options,
      roundRequest(root.evidenceDirectory, { reuse: true }),
      { execute: docker.execute },
    );
    expect(second.platformId).toBe(first.platformId);
    expect(second.roundId).not.toBe(first.roundId);
    expect(second.scenarios[0]?.id).not.toBe(first.scenarios[0]?.id);
    expect(docker.scenarioRuns()).toHaveLength(2);
    expect(second.disposition).toBe("retained");
    expect(second.exitCode).toBe(0);

    const reclaim = await destroyPlatform(root.options, {
      execute: docker.execute,
    });
    expect(reclaim.disposition).toBe("destroyed");
    expect(docker.outer.size).toBe(0);
  });

  test("复用多个场景共享同一内层引擎并逐个回收子资源", async () => {
    const root = await createRoot();
    const docker = fakeEngine({
      runOutcomes: [
        {
          containers: [{ id: "sha256:child-a", name: "child-a" }],
          networks: ["net-a"],
          volumes: ["vol-a"],
        },
        {
          containers: [{ id: "sha256:child-b", name: "child-b" }],
          volumes: ["vol-b"],
        },
      ],
    });
    const result = await runRound(
      root.options,
      roundRequest(root.evidenceDirectory, {
        reuse: true,
        scenarios: [
          { image: "alpine:3.20@sha256:keep", command: ["first"] },
          { image: "alpine:3.20@sha256:keep", command: ["second"] },
        ],
      }),
      { execute: docker.execute },
    );
    expect(result.exitCode).toBe(0);
    expect(result.scenarios).toHaveLength(2);
    expect(innerNames(docker)).toEqual({
      containers: [],
      networks: ["bridge", "host", "none"],
      volumes: [],
    });
    expect(
      docker.calls.filter(
        (args) =>
          args[2] === "docker" && args[3] === "network" && args[4] === "rm",
      ),
    ).toEqual([
      ["exec", expect.any(String), "docker", "network", "rm", "net-a"],
    ]);
    for (const name of ["child-a", "child-b"]) {
      expect(
        docker.calls.some(
          (args) => args[2] === "docker" && args.at(-1) === name,
        ),
      ).toBe(true);
    }
    expect(result.platform.innerEngineId).toBe("inner-engine-id");
  });

  test("场景未收敛时停止后续场景并销毁平台", async () => {
    const root = await createRoot();
    const docker = fakeEngine({
      runOutcomes: [{ volumes: ["vol-stuck"] }, { exitCode: 0 }],
    });
    docker.undeletable.push("vol-stuck");
    const result = await runRound(
      root.options,
      roundRequest(root.evidenceDirectory, {
        reuse: true,
        scenarios: [
          { image: "alpine:3.20@sha256:keep", command: ["first"] },
          { image: "alpine:3.20@sha256:keep", command: ["second"] },
        ],
      }),
      { execute: docker.execute },
    );
    expect(result.scenarios[0]?.verification.scenarioCleanup).toBe("failed");
    expect(result.scenarios[1]?.phase).toBe("not_run");
    expect(result.verification.scenarioCleanup).toBe("failed");
    expect(result.disposition).toBe("destroyed");
    expect(result.exitCode).toBe(1);
    expect(result.failures.join(" ")).toContain("vol-stuck");
    expect(docker.outer.size).toBe(0);
  });

  test("内层引擎失联时停止后续场景并从外层完整回收", async () => {
    const root = await createRoot();
    const docker = fakeEngine();
    docker.setFailure((args) => args[2] === "mkdir");
    const result = await runRound(
      root.options,
      roundRequest(root.evidenceDirectory, {
        scenarios: [
          { image: "alpine:3.20@sha256:keep", command: ["first"] },
          { image: "alpine:3.20@sha256:keep", command: ["second"] },
        ],
      }),
      { execute: docker.execute },
    );
    // 失联的场景仍完成清理并如实落盘，后续场景不得在失效引擎上启动。
    expect(result.disposition).toBe("destroyed");
    expect(result.exitCode).toBe(1);
    expect(result.scenarios[0]?.phase).toBe("incomplete");
    // 业务命令从未在内层执行过，因此场景项是未运行而不是通过，轮次项只能是不完整。
    expect(result.scenarios[0]?.verification.scenarioExecution).toBe("not_run");
    expect(result.verification.scenarioExecution).toBe("incomplete");
    expect(result.scenarios[1]?.phase).toBe("not_run");
    expect(docker.scenarioRuns()).toEqual([]);
    expect(result.failures.join(" ")).toContain("engine is unavailable");
    expect(docker.outer.size).toBe(0);
  });

  test("状态目录已有平台但未请求复用时拒绝执行，且不改动现有清单", async () => {
    const root = await createRoot();
    const docker = fakeEngine();
    const first = await runRound(
      root.options,
      roundRequest(root.evidenceDirectory, { reuse: true }),
      { execute: docker.execute },
    );
    const before = await readManifest(root.options);
    const rejection = await runRound(
      root.options,
      roundRequest(root.evidenceDirectory),
      { execute: docker.execute },
    ).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(PlatformError);
    expect((rejection as PlatformError).code).toBe("reuseRejected");
    expect(first.disposition).toBe("retained");
    const after = await readManifest(root.options);
    expect(after?.updatedAt).toBe(before?.updatedAt);
    expect(after?.round?.id).toBe(before?.round?.id);
  });

  test("证据目标与状态目录重叠时在创建任何资源之前拒绝", async () => {
    const root = await createRoot();
    const docker = fakeEngine();
    const rejection = await runRound(
      root.options,
      roundRequest(join(root.options.stateDirectory, "evidence")),
      { execute: docker.execute },
    ).catch((error: unknown) => error);
    expect((rejection as PlatformError).code).toBe("targetUnusable");
    expect(docker.calls).toEqual([]);
    await expect(stat(root.options.stateDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("同一状态目录的并发轮次被独占锁拒绝", async () => {
    const root = await createRoot();
    const docker = fakeEngine();
    await mkdir(root.options.stateDirectory, { recursive: true });
    const held = await acquireStateLock(root.options, "run");
    try {
      const rejection = await runRound(
        root.options,
        roundRequest(root.evidenceDirectory),
        { execute: docker.execute },
      ).catch((error: unknown) => error);
      expect((rejection as PlatformError).code).toBe("busy");
      expect(docker.calls).toEqual([]);
    } finally {
      await releaseStateLock(root.options, held);
    }
  });

  test("持有者已消失时过期锁被接管", async () => {
    const root = await createRoot();
    const docker = fakeEngine();
    await mkdir(root.options.stateDirectory, { recursive: true });
    await writeFile(
      join(root.options.stateDirectory, "platform.lock"),
      JSON.stringify({
        pid: 2_147_483_647,
        startTime: "1",
        purpose: "run",
        takenAt: new Date().toISOString(),
      }),
      "utf8",
    );
    const result = await runRound(
      root.options,
      roundRequest(root.evidenceDirectory),
      { execute: docker.execute },
    );
    expect(result.disposition).toBe("destroyed");
  });

  test("空场景列表被类型化拒绝", async () => {
    const root = await createRoot();
    const docker = fakeEngine();
    await expect(
      runRound(
        root.options,
        roundRequest(root.evidenceDirectory, { scenarios: [] }),
        { execute: docker.execute },
      ),
    ).rejects.toThrow("at least one scenario");
    expect(docker.calls).toEqual([]);
  });
});

function innerNames(engine: ReturnType<typeof fakeEngine>) {
  return {
    containers: engine.inner.containers.map((item) => item.name),
    networks: engine.inner.networks,
    volumes: engine.inner.volumes,
  };
}
