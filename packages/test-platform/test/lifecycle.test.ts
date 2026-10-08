import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  destroyPlatform,
  preparePlatform,
  statusPlatform,
} from "../src/lifecycle.ts";
import { OWNER_LABEL, plannedNames, readManifest } from "../src/manifest.ts";
import type { PlatformManifest } from "../src/manifest.ts";
import { PlatformError } from "../src/types.ts";
import type { DockerExecutor, PlatformOptions } from "../src/types.ts";
import { BOOTSTRAP_IMAGE, fakeEngine } from "./fixtures.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

async function createOptions(): Promise<PlatformOptions> {
  const base = await mkdtemp(join(tmpdir(), "reins-platform-lifecycle-"));
  directories.push(base);
  return {
    stateDirectory: join(base, "state"),
    bootstrapImage: BOOTSTRAP_IMAGE,
    timeoutMs: 200,
  };
}

async function createEvidenceDirectory(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "reins-platform-evidence-"));
  directories.push(base);
  return join(base, "evidence");
}

async function prepare(
  options: PlatformOptions,
  execute: DockerExecutor,
): Promise<PlatformManifest> {
  return await preparePlatform(options, await createEvidenceDirectory(), {
    execute,
  });
}

describe("平台生命周期", () => {
  test("准备只按固定摘要创建独占资源，内层引擎只用 Unix 套接字", async () => {
    const options = await createOptions();
    const docker = fakeEngine();
    const manifest = await prepare(options, docker.execute);
    expect(manifest.phase).toBe("running");
    expect(manifest.names).toEqual(plannedNames(manifest.id));
    expect(manifest.outerEngineId).toBe("outer-engine-id");
    expect(manifest.innerEngineId).toBe("inner-engine-id");
    expect(manifest.innerDefaults.networks).toEqual(["bridge", "host", "none"]);

    const run = docker.calls.find((args) => args[0] === "run");
    expect(run).toBeDefined();
    expect(run).toContain("--privileged");
    expect(run).toContain(
      `type=volume,source=${manifest.names.dataVolumeName},target=/var/lib/docker`,
    );
    expect(run).toContain(
      `type=volume,source=${manifest.names.workspaceVolumeName},target=/platform`,
    );
    expect(run!.slice(-3)).toEqual([
      "dockerd",
      "--host=unix:///var/run/docker.sock",
      "--feature=containerd-snapshotter=false",
    ]);
    expect(
      docker.calls.some((args) =>
        args.some((arg) => String(arg).includes("tcp://")),
      ),
    ).toBe(false);
  });

  test("清单在任何资源变更之前落盘，中断后仍能恢复", async () => {
    const options = await createOptions();
    const docker = fakeEngine();
    docker.setFailure((args) => args[0] === "network" && args[1] === "create");
    await expect(prepare(options, docker.execute)).rejects.toBeInstanceOf(
      PlatformError,
    );
    const manifest = await readManifest(options);
    expect(manifest).not.toBeNull();
    expect(manifest!.phase).toBe("recovery_required");
    expect(manifest!.ids.container).toBeNull();
    expect(manifest!.ids.dataVolume).not.toBeNull();
    expect(docker.outer.size).toBe(2);

    docker.setFailure(undefined);
    const result = await destroyPlatform(options, { execute: docker.execute });
    expect(result.disposition).toBe("destroyed");
    expect(docker.outer.size).toBe(0);
    expect(await readManifest(options)).toBeNull();
  });

  test("销毁前导出证据，成功后删除本平台状态目录但保留兄弟内容", async () => {
    const base = await createOptions();
    const options = {
      ...base,
      stateDirectory: join(base.stateDirectory, "artifacts", "platform"),
    };
    const evidence = await createEvidenceDirectory();
    const docker = fakeEngine();
    const manifest = await preparePlatform(options, evidence, {
      execute: docker.execute,
    });
    await writeFile(join(base.stateDirectory, "sibling"), "keep");
    const result = await destroyPlatform(options, { execute: docker.execute });
    expect(result.disposition).toBe("destroyed");
    expect(result.evidence.exported).toBe(true);
    const roundDirectory = join(evidence, "rounds");
    const exported = await readFile(
      join(roundDirectory, await firstDirectory(roundDirectory), "round.json"),
      "utf8",
    );
    expect(JSON.parse(exported)).toMatchObject({
      kind: "test-platform-evidence",
      platform: { id: manifest.id, phase: "destroying" },
    });
    await expect(
      readFile(join(base.stateDirectory, "sibling"), "utf8"),
    ).resolves.toBe("keep");
  });

  test("已有镜像既不拉取也不删除，新摘要镜像用非强制删除", async () => {
    const existingOptions = await createOptions();
    const existing = fakeEngine({ imageExisted: true });
    await prepare(existingOptions, existing.execute);
    await destroyPlatform(existingOptions, { execute: existing.execute });
    expect(
      existing.calls.some(
        (args) =>
          args[0] === "image" && (args[1] === "pull" || args[1] === "rm"),
      ),
    ).toBe(false);
    expect(existing.images.size).toBe(1);

    const acquiredOptions = await createOptions();
    const acquired = fakeEngine();
    await prepare(acquiredOptions, acquired.execute);
    await destroyPlatform(acquiredOptions, { execute: acquired.execute });
    expect(
      acquired.calls.filter(
        (args) => args[0] === "image" && args[1] === "pull",
      ),
    ).toHaveLength(1);
    expect(
      acquired.calls.find((args) => args[0] === "image" && args[1] === "rm"),
    ).toEqual(["image", "rm", BOOTSTRAP_IMAGE]);
    expect(acquired.images.size).toBe(0);
  });

  test("新摘要镜像删除失败时保留清单并报告恢复", async () => {
    const options = await createOptions();
    const docker = fakeEngine();
    await prepare(options, docker.execute);
    docker.setFailure((args) => args[0] === "image" && args[1] === "rm");
    const result = await destroyPlatform(options, { execute: docker.execute });
    expect(result.disposition).toBe("recovery_required");
    expect(result.facts.find((fact) => fact.kind === "image")?.outcome).toBe(
      "failed",
    );
    expect(await readManifest(options)).not.toBeNull();
  });

  test("内层失联时状态区分内外层，销毁仍从外层完成", async () => {
    const options = await createOptions();
    const docker = fakeEngine();
    await prepare(options, docker.execute);
    docker.innerDown = true;
    expect(
      await statusPlatform(options, { execute: docker.execute }),
    ).toMatchObject({
      phase: "running",
      outer: "running",
      inner: "unreachable",
    });
    const result = await destroyPlatform(options, { execute: docker.execute });
    expect(result.disposition).toBe("destroyed");
    expect(docker.outer.size).toBe(0);
  });

  test("外层失联时不把资源记为消失，也不删除本地清单", async () => {
    const options = await createOptions();
    const docker = fakeEngine();
    await prepare(options, docker.execute);
    docker.outerDown = true;
    const status = await statusPlatform(options, { execute: docker.execute });
    expect(status.outer).toBe("unreachable");
    expect(status.detail).toBe("The host Docker engine is not reachable.");
    const result = await destroyPlatform(options, { execute: docker.execute });
    expect(result.disposition).toBe("recovery_required");
    expect(result.failures.length).toBeGreaterThan(0);
    expect((await readManifest(options))!.phase).toBe("recovery_required");
  });

  test("归属标签不匹配时拒绝接管该资源并保留清单", async () => {
    const options = await createOptions();
    const docker = fakeEngine();
    const manifest = await prepare(options, docker.execute);
    docker.outer.set(`volume:${manifest.names.workspaceVolumeName}`, {
      id: `volume-${manifest.names.workspaceVolumeName}`,
      labels: { [OWNER_LABEL]: "another-platform" },
      running: false,
    });
    const result = await destroyPlatform(options, { execute: docker.execute });
    expect(result.disposition).toBe("recovery_required");
    expect(
      result.facts.some(
        (fact) =>
          fact.outcome === "failed" &&
          fact.detail?.includes("ownership label does not match"),
      ),
    ).toBe(true);
    expect(
      docker.calls.some(
        (args) =>
          args[0] === "volume" &&
          args.at(-1) === manifest.names.workspaceVolumeName &&
          args[1] === "rm",
      ),
    ).toBe(false);
    expect(
      docker.outer.has(`volume:${manifest.names.workspaceVolumeName}`),
    ).toBe(true);
    expect(await readManifest(options)).not.toBeNull();
  });

  test("记录身份与检查到的身份不符时拒绝删除该资源", async () => {
    const options = await createOptions();
    const docker = fakeEngine();
    const manifest = await prepare(options, docker.execute);
    docker.outer.set(`network:${manifest.names.networkName}`, {
      id: "network-replaced",
      labels: { [OWNER_LABEL]: manifest.id },
      running: false,
    });
    const result = await destroyPlatform(options, { execute: docker.execute });
    expect(
      result.facts.some(
        (fact) =>
          fact.kind === "network" &&
          fact.outcome === "failed" &&
          fact.detail?.includes("recorded id"),
      ),
    ).toBe(true);
  });

  test("回收失败保留清单，重试允许资源已经消失", async () => {
    const options = await createOptions();
    const docker = fakeEngine();
    const manifest = await prepare(options, docker.execute);
    docker.setFailure(
      (args) =>
        args[1] === "rm" && args.at(-1) === manifest.names.dataVolumeName,
    );
    const first = await destroyPlatform(options, { execute: docker.execute });
    expect(first.disposition).toBe("recovery_required");
    expect(await readManifest(options)).not.toBeNull();
    docker.setFailure(undefined);
    const second = await destroyPlatform(options, { execute: docker.execute });
    expect(second.disposition).toBe("destroyed");
    expect(
      second.facts.filter(
        (fact) => fact.kind === "volume" && fact.outcome === "absent",
      ),
    ).toHaveLength(1);
  });

  test("状态目录被占用时拒绝写入，销毁也不触碰其中文件", async () => {
    const options = await createOptions();
    const docker = fakeEngine();
    await mkdir(options.stateDirectory, { recursive: true });
    const path = join(options.stateDirectory, "owned-by-caller");
    await writeFile(path, "keep");
    const rejection = await preparePlatform(
      options,
      await createEvidenceDirectory(),
      { execute: docker.execute },
    ).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(PlatformError);
    expect((rejection as PlatformError).code).toBe("occupiedStateDirectory");
    const before = docker.calls.length;
    const result = await destroyPlatform(options, { execute: docker.execute });
    expect(result.disposition).toBe("absent");
    expect(docker.calls.slice(before)).toEqual([]);
    await expect(readFile(path, "utf8")).resolves.toBe("keep");
  });

  test("连接换到别的引擎时报告身份不一致", async () => {
    const options = await createOptions();
    const docker = fakeEngine();
    await prepare(options, docker.execute);
    const status = await statusPlatform(options, {
      execute: fakeEngine({ outerEngineId: "other-engine" }).execute,
    });
    expect(status.engineIdentityMatches).toBe(false);
    expect(status.detail).toContain("other-engine");
  });

  test("销毁重复执行保持幂等", async () => {
    const options = await createOptions();
    const docker = fakeEngine();
    await prepare(options, docker.execute);
    expect(
      (await destroyPlatform(options, { execute: docker.execute })).disposition,
    ).toBe("destroyed");
    const again = await destroyPlatform(options, { execute: docker.execute });
    expect(again.disposition).toBe("absent");
    expect(again.platformId).toBeNull();
  });

  test("切换宿主引擎后销毁保留恢复清单且不修改新引擎", async () => {
    const options = await createOptions();
    const original = fakeEngine();
    await prepare(options, original.execute);
    const other = fakeEngine({ outerEngineId: "other-engine" });
    const result = await destroyPlatform(options, { execute: other.execute });
    expect(result.disposition).toBe("recovery_required");
    expect(result.failures.join(" ")).toContain("other-engine");
    expect(await readManifest(options)).not.toBeNull();
    expect(other.calls.some((args) => args.includes("rm"))).toBe(false);
    expect(original.outer.size).toBe(4);
  });

  test("daemon 日志复制失败保留原始日志和恢复清单", async () => {
    const options = await createOptions();
    const evidence = await createEvidenceDirectory();
    const docker = fakeEngine();
    const manifest = await preparePlatform(options, evidence, {
      execute: docker.execute,
    });
    const blocked = join(
      evidence,
      "rounds",
      `platform-${manifest.id}`,
      "dockerd-stdout.log",
    );
    await mkdir(blocked, { recursive: true });
    const result = await destroyPlatform(options, { execute: docker.execute });
    expect(result.evidence.exported).toBe(false);
    expect(result.evidence.failures.join(" ")).toContain("stdout.log");
    expect(result.disposition).toBe("recovery_required");
    expect(await readManifest(options)).not.toBeNull();
    await expect(
      readFile(join(options.stateDirectory, "dockerd", "stdout.log"), "utf8"),
    ).resolves.toBeDefined();
    await rm(blocked, { recursive: true });
    const retry = await destroyPlatform(options, { execute: docker.execute });
    expect(retry.disposition).toBe("destroyed");
    expect(
      retry.evidence.files.find(
        (file) => file.label === "inner-dockerd-stdout.log",
      )?.status,
    ).toBe("copied");
    await expect(readFile(blocked, "utf8")).resolves.toBeDefined();
  });

  test("摘要引用已消失但新增镜像内容仍在时重试仍报告失败", async () => {
    const options = await createOptions();
    const docker = fakeEngine();
    const manifest = await prepare(options, docker.execute);
    const id = manifest.imageAcquisition.acquiredId!;
    docker.images.set(id, id);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await destroyPlatform(options, {
        execute: docker.execute,
      });
      expect(result.disposition).toBe("recovery_required");
      expect(result.facts.find((fact) => fact.kind === "image")?.outcome).toBe(
        "failed",
      );
      expect(await readManifest(options)).not.toBeNull();
    }
    docker.images.delete(id);
    expect(
      (await destroyPlatform(options, { execute: docker.execute })).disposition,
    ).toBe("destroyed");
  });
});

async function firstDirectory(directory: string): Promise<string> {
  const [name] = await readdir(directory);
  if (name === undefined)
    throw new Error(`No round exported into ${directory}.`);
  return name;
}
