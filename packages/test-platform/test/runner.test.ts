import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  OWNER_LABEL,
  createManifest,
  readManifest,
  writeManifest,
} from "../src/manifest.ts";
import type { PlatformManifest } from "../src/manifest.ts";
import {
  SCENARIO_LABEL,
  executeScenario,
  planScenario,
  scenarioBoundaryClean,
  validateScenario,
} from "../src/runner.ts";
import type { ScenarioRequest } from "../src/runner.ts";
import { PlatformError } from "../src/types.ts";
import type {
  CommandResult,
  DockerCommandOptions,
  DockerExecutor,
  PlatformOptions,
} from "../src/types.ts";
import { BOOTSTRAP_IMAGE, result, settleWithFakeClock } from "./fixtures.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

const isRun = (args: readonly string[]): boolean =>
  args[2] === "sh" && (args[4] ?? "").includes('exec "$@"');

const isStop = (args: readonly string[]): boolean =>
  args[2] === "sh" && (args[4] ?? "").includes("matches_run()");

interface Call {
  args: readonly string[];
  options: DockerCommandOptions;
}

interface EnvironmentUpload {
  contents: string;
  mode: number;
  path: string;
}

async function fixture(): Promise<{
  options: PlatformOptions;
  manifest: PlatformManifest;
}> {
  const base = await mkdtemp(join(tmpdir(), "reins-platform-runner-"));
  directories.push(base);
  const options: PlatformOptions = {
    stateDirectory: join(base, "state"),
    bootstrapImage: BOOTSTRAP_IMAGE,
    timeoutMs: 500,
  };
  await mkdir(options.stateDirectory, { recursive: true });
  const manifest = createManifest(options, join(base, "evidence"));
  manifest.ids.container = `container-${manifest.names.containerName}`;
  manifest.innerDefaults = { networks: ["bridge", "host", "none"] };
  await writeManifest(options, manifest);
  return { options, manifest };
}

/** 记录全部 Docker 调用；未接管的调用一律成功且内层资源列表为空。 */
function recorder(
  respond: (
    args: readonly string[],
  ) => CommandResult | Promise<CommandResult> | undefined = () => undefined,
): { calls: Call[]; uploads: EnvironmentUpload[]; execute: DockerExecutor } {
  const calls: Call[] = [];
  const uploads: EnvironmentUpload[] = [];
  const execute: DockerExecutor = async (
    _options,
    args,
    commandOptions = {},
  ) => {
    calls.push({ args: [...args], options: commandOptions });
    if (args[0] === "cp" && args[1]?.endsWith("environment.env")) {
      uploads.push({
        contents: await readFile(args[1]!, "utf8"),
        mode: (await stat(args[1]!)).mode & 0o777,
        path: args[1]!,
      });
      return result();
    }
    if (args[2] === "docker" && args[3] === "image") {
      return result(
        JSON.stringify([{ Id: "sha256:inner-image", RepoDigests: [] }]),
      );
    }
    return (await respond(args)) ?? result();
  };
  return { calls, uploads, execute };
}

function runCall(calls: Call[]): Call {
  const call = calls.find(({ args }) => isRun(args));
  if (call === undefined)
    throw new Error("Scenario run command was not called.");
  return call;
}

function rejection(request: ScenarioRequest): PlatformError {
  try {
    validateScenario(request);
  } catch (error) {
    if (error instanceof PlatformError) return error;
    throw error;
  }
  throw new Error("Expected the request to be rejected.");
}

/**
 * 内层 daemon 模型。清单里给的是不透明标识，被测代码只按与基线的差集回收；强制删除不存在的
 * 目标时与本机 Docker 29.8.2 CLI 一致地把 NotFound 吞掉并成功返回，所以删除的退出码不能证明
 * 目标存在过或创建请求已提交。被中断执行的主容器在第 `landingAfter` 次清单之后才提交，用来
 * 复现实测到的迟到落地；`--volumes` 删除容器时同时带走它拥有的匿名卷。
 */
function innerEngine(
  settings: {
    /** 场景命令运行出来的子资源：运行之前不存在，因此落在本轮基线之外。 */
    containers?: string[];
    networks?: string[];
    volumes?: string[];
    /** 匿名卷归属：卷名 -> 拥有它的容器。 */
    volumeOwners?: Record<string, string>;
    /** 删除请求始终失败的资源，用来制造不收敛。 */
    undeletable?: string[];
    /** 被中断执行的主容器在第几次清单之后落地；Infinity 表示创建请求始终不提交。 */
    landingAfter?: number;
    /** 与迟到主容器一起落地的匿名卷。 */
    landingVolume?: string;
    /** 第一次差集清单里出现、但来自更早请求的资源。 */
    strayVolume?: string;
  } = {},
): {
  execute: DockerExecutor;
  landed(): boolean;
  remaining(): { containers: string[]; networks: string[]; volumes: string[] };
} {
  const alive: Record<"container" | "network" | "volume", string[]> = {
    container: [],
    network: [],
    volume: [],
  };
  const owners: Record<string, string> = { ...settings.volumeOwners };
  let mainName = "";
  let inFlight = false;
  let landed = false;
  let listings = 0;
  let strayInjected = false;
  const execute: DockerExecutor = async (_options, args) => {
    if (isRun(args)) {
      mainName = args[5]!;
      if (settings.landingAfter === undefined) {
        alive.container.push(mainName, ...(settings.containers ?? []));
        alive.network.push(...(settings.networks ?? []));
        alive.volume.push(...(settings.volumes ?? []));
        return result();
      }
      // 客户端被超时杀掉时创建请求仍在 daemon 中飞行：此刻清单上还看不到主容器。
      inFlight = true;
      return result("", null, "", true);
    }
    const kind = args[2] === "docker" ? args[3] : undefined;
    if (kind === "ps") {
      // 只有相对基线的差集清单推进落地计数；主容器观察用的按名查询不算一次差集清单。
      const counting = args.includes("--quiet");
      if (counting) listings += 1;
      if (
        counting &&
        inFlight &&
        settings.strayVolume !== undefined &&
        !strayInjected
      ) {
        // 更早请求留下的资源：它出现在本轮基线之外，却与这次创建的飞行中主容器无关。
        strayInjected = true;
        alive.volume.push(settings.strayVolume);
      }
      if (
        inFlight &&
        settings.landingAfter !== undefined &&
        listings >= settings.landingAfter
      ) {
        inFlight = false;
        landed = true;
        alive.container.push(mainName, ...(settings.containers ?? []));
        alive.network.push(...(settings.networks ?? []));
        alive.volume.push(...(settings.volumes ?? []));
        if (settings.landingVolume !== undefined) {
          owners[settings.landingVolume] = mainName;
          alive.volume.push(settings.landingVolume);
        }
      }
      return result(alive.container.join("\n"));
    }
    if (kind === "network" && args[4] === "ls") {
      return result(alive.network.join("\n"));
    }
    if (kind === "volume" && args[4] === "ls") {
      return result(alive.volume.join("\n"));
    }
    if (kind === "image") {
      return result(
        JSON.stringify([{ Id: "sha256:inner-image", RepoDigests: [] }]),
      );
    }
    const target = args.at(-1)!;
    if (target === "environment.env" || target.startsWith("/platform/runs")) {
      return result();
    }
    if (kind !== "rm" && args[4] !== "rm") return result();
    const type = (kind === "rm" ? "container" : kind!) as
      | "container"
      | "network"
      | "volume";
    if ((settings.undeletable ?? []).includes(target)) {
      return result("", 1, `remove ${target}: device is busy`);
    }
    const index = alive[type].indexOf(target);
    if (index < 0) {
      // 强制删除把缺失目标当作成功；非强制的网络与卷删除仍如实报错。
      if (type === "container") return result();
      return result(
        "",
        1,
        `Error response from daemon: get ${target}: no such ${type}`,
      );
    }
    alive[type].splice(index, 1);
    if (type === "container" && args.includes("--volumes")) {
      for (const [volume, owner] of Object.entries(owners)) {
        if (owner !== target) continue;
        alive.volume = alive.volume.filter((name) => name !== volume);
      }
    }
    return result(target);
  };
  return {
    execute,
    landed: () => landed,
    remaining: () => ({
      containers: [...alive.container],
      networks: [...alive.network],
      volumes: [...alive.volume],
    }),
  };
}

describe("场景执行", () => {
  test.each([
    {
      request: { image: "", command: ["true"] },
      message: "nonempty container image",
    },
    {
      request: { image: " -leading", command: ["true"] },
      message: "nonempty container image",
    },
    {
      request: { image: "two words", command: ["true"] },
      message: "nonempty container image",
    },
    {
      request: { image: "img@sha256:keep", command: [] },
      message: "unchanged arguments",
    },
    {
      request: { image: "img@sha256:keep", command: [""] },
      message: "unchanged arguments",
    },
    {
      request: { image: "img@sha256:keep", command: ["a\0b"] },
      message: "NUL",
    },
    {
      request: { image: "img@sha256:keep", command: ["true"], timeoutMs: 1.5 },
      message: "positive integer",
    },
    {
      request: { image: "img@sha256:keep", command: ["true"], timeoutMs: 0 },
      message: "positive integer",
    },
    {
      request: {
        image: "img@sha256:keep",
        command: ["true"],
        workdir: "relative",
      },
      message: "absolute path",
    },
    {
      request: {
        image: "img@sha256:keep",
        command: ["true"],
        environment: { "9BAD": "v" },
      },
      message: "valid identifiers",
    },
    {
      request: {
        image: "img@sha256:keep",
        command: ["true"],
        environment: { KEY: "two\nlines" },
      },
      message: "CR, LF, or NUL",
    },
    {
      request: {
        image: "img@sha256:keep",
        command: ["true"],
        logPaths: ["/absolute.log"],
      },
      message: "workspace-relative",
    },
    {
      request: {
        image: "img@sha256:keep",
        command: ["true"],
        logPaths: ["../escape.log"],
      },
      message: "workspace-relative",
    },
  ])("以 invalidOptions 拒绝非法输入：%j", ({ request, message }) => {
    const error = rejection(request as ScenarioRequest);
    expect(error.code).toBe("invalidOptions");
    expect(error.message).toContain(message);
  });

  test("计划只记录调用方给出的信息并预留全部验证项", async () => {
    const { options } = await fixture();
    const record = planScenario(options, {
      image: "explicit@sha256:keep",
      command: ["pnpm", "test"],
      environment: { TOKEN: "value" },
      identification: { candidate: "abc123" },
      verificationItems: ["assertion"],
    });
    expect(record).toMatchObject({
      phase: "planned",
      requestedImage: "explicit@sha256:keep",
      resolvedImage: { id: null, digests: [] },
      workspacePath: `/platform/runs/${record.id}/workspace`,
      environmentNames: ["TOKEN"],
      identification: { candidate: "abc123" },
      localDirectory: join(options.stateDirectory, "runs", record.id),
      collectedLogs: [],
      baseline: { containers: [], networks: [], volumes: [] },
    });
    expect(record.verification).toEqual({
      scenarioExecution: "not_run",
      scenarioCleanup: "not_run",
      assertion: "not_run",
    });
    expect(JSON.stringify(record)).not.toContain("value");
  });

  test("内层 run 参数只由调用方输入组合而成", async () => {
    const { options, manifest } = await fixture();
    const docker = recorder();
    const sourceDirectory = join(options.stateDirectory, "..", "source");
    await mkdir(sourceDirectory, { recursive: true });
    const request: ScenarioRequest = {
      image: "explicit@sha256:keep",
      command: [
        "harness",
        "--prompt",
        "keep $VALUE and `literal`",
        "",
        "--help",
      ],
      sourceDirectory,
      environment: { API_KEY: "secret with spaces = and #", EMPTY: "" },
      timeoutMs: 5_432,
    };
    const record = planScenario(options, request);
    const executed = await executeScenario(options, manifest, request, record, {
      execute: docker.execute,
    });

    const call = runCall(docker.calls);
    expect(call.args.slice(0, 5)).toEqual([
      "exec",
      manifest.names.containerName,
      "sh",
      "-c",
      expect.stringContaining('exec "$@"'),
    ]);
    expect(call.args.slice(5, 8)).toEqual([
      `reins-test-scene-${record.id}`,
      `/platform/runs/${record.id}/client.pid`,
      `/platform/runs/${record.id}/cancel`,
    ]);
    const run = call.args.slice(call.args.indexOf("docker"));
    expect(run.slice(0, 6)).toEqual([
      "docker",
      "run",
      "--name",
      `reins-test-scene-${record.id}`,
      "--label",
      `${OWNER_LABEL}=${manifest.id}`,
    ]);
    expect(run).toContainEqual(`${SCENARIO_LABEL}=${record.id}`);
    expect(run).toContainEqual(
      `type=bind,src=${record.workspacePath},dst=${record.workspacePath}`,
    );
    expect(run.filter((argument) => argument === "--mount")).toHaveLength(1);
    expect(run[run.indexOf("--workdir") + 1]).toBe(record.workspacePath);
    expect(run[run.indexOf("--env-file") + 1]).toBe(
      `/platform/runs/${record.id}/environment.env`,
    );
    expect(run.slice(-request.command.length - 1)).toEqual([
      "explicit@sha256:keep",
      ...request.command,
    ]);
    expect(run).not.toContain("/var/run/docker.sock");
    expect(call.options).toMatchObject({ timeoutMs: 5_432 });
    expect(
      docker.calls.some(
        ({ args }) =>
          args[0] === "cp" &&
          args[1] === `${sourceDirectory}/.` &&
          args[2] ===
            `${manifest.names.containerName}:${record.workspacePath}/`,
      ),
    ).toBe(true);
    expect(executed).toMatchObject({
      phase: "completed",
      exitCode: 0,
      environmentNames: ["API_KEY", "EMPTY"],
      resolvedImage: { id: "sha256:inner-image", digests: [] },
      verification: { scenarioExecution: "passed", scenarioCleanup: "passed" },
    });
    expect(executed.baseline).toEqual({
      containers: [],
      networks: [],
      volumes: [],
    });
    expect(executed.cleanupErrors).toEqual([]);
  });

  test("凭据文件以 0600 上传给平台容器、不出现在 run 参数中并在清理时删除", async () => {
    const { options, manifest } = await fixture();
    const docker = recorder();
    const request: ScenarioRequest = {
      image: "explicit@sha256:keep",
      command: ["true"],
      environment: { API_KEY: "super-secret", EMPTY: "" },
    };
    const record = planScenario(options, request);
    await executeScenario(options, manifest, request, record, {
      execute: docker.execute,
    });
    expect(docker.uploads).toHaveLength(1);
    expect(docker.uploads[0]).toMatchObject({
      contents: "API_KEY=super-secret\nEMPTY=\n",
      mode: 0o600,
    });
    expect(docker.uploads[0]!.path).toBe(
      join(record.localDirectory, "environment.env"),
    );
    expect(
      JSON.stringify(docker.calls.map(({ args }) => [...args])).includes(
        "super-secret",
      ),
    ).toBe(false);
    await expect(stat(docker.uploads[0]!.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("显式 workdir 与 docker 访问都按调用方要求传递", async () => {
    const { options, manifest } = await fixture();
    const docker = recorder();
    const request: ScenarioRequest = {
      image: "explicit@sha256:keep",
      command: ["true"],
      workdir: "/platform/custom",
      dockerAccess: true,
    };
    const record = planScenario(options, request);
    await executeScenario(options, manifest, request, record, {
      execute: docker.execute,
    });
    const run = runCall(docker.calls).args;
    expect(run[run.indexOf("--workdir") + 1]).toBe("/platform/custom");
    expect(run).not.toContain("--env-file");
    expect(run).toContainEqual(
      "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock",
    );
    expect(run.filter((argument) => argument === "--mount")).toHaveLength(2);
  });

  test("被测命令的非零退出原样记录且不重跑", async () => {
    const { options, manifest } = await fixture();
    const engine = innerEngine({});
    const calls: Call[] = [];
    const execute: DockerExecutor = async (
      callOptions,
      args,
      commandOptions,
    ) => {
      calls.push({ args: [...args], options: commandOptions ?? {} });
      if (isRun(args)) return result("", 7, "harness failed\n");
      return engine.execute(callOptions, args, commandOptions);
    };
    const request: ScenarioRequest = {
      image: "explicit@sha256:keep",
      command: ["harness"],
    };
    const record = planScenario(options, request);
    const executed = await executeScenario(options, manifest, request, record, {
      execute,
    });
    expect(executed).toMatchObject({
      exitCode: 7,
      timedOut: false,
      cancelled: false,
      phase: "completed",
    });
    expect(executed.verification.scenarioExecution).toBe("failed");
    expect(executed.verification.scenarioCleanup).toBe("passed");
    expect(calls.filter(({ args }) => isRun(args))).toHaveLength(1);
  });

  test("日志采集区分复制、缺失与失败", async () => {
    const { options, manifest } = await fixture();
    const docker = recorder((args) => {
      if (args[0] !== "cp") return undefined;
      const source = args[1] ?? "";
      if (source.endsWith("unit.log")) return result();
      if (source.endsWith("absent.log")) {
        return result(
          "",
          1,
          "Error response from daemon: Could not find the file",
        );
      }
      return result("", 1, "docker cp failed: daemon error");
    });
    const request: ScenarioRequest = {
      image: "explicit@sha256:keep",
      command: ["true"],
      logPaths: ["logs/unit.log", "absent.log", "broken.log"],
    };
    const record = planScenario(options, request);
    const executed = await executeScenario(options, manifest, request, record, {
      execute: docker.execute,
    });
    expect(executed.collectedLogs).toEqual([
      { path: "logs/unit.log", status: "copied", detail: null },
      {
        path: "absent.log",
        status: "missing",
        detail: expect.stringContaining("Could not find the file"),
      },
      {
        path: "broken.log",
        status: "failed",
        detail: expect.stringContaining("daemon error"),
      },
    ]);
  });

  test("新增的子容器、自定义网络与卷相对基线被回收并复核", async () => {
    const { options, manifest } = await fixture();
    const engine = innerEngine({
      containers: ["child-a"],
      networks: ["net-a"],
      volumes: ["vol-a"],
    });
    const request: ScenarioRequest = {
      image: "explicit@sha256:keep",
      command: ["true"],
    };
    const record = planScenario(options, request);
    const executed = await executeScenario(options, manifest, request, record, {
      execute: engine.execute,
    });
    expect(executed).toMatchObject({
      phase: "completed",
      cleanupErrors: [],
      verification: { scenarioCleanup: "passed" },
    });
    expect(executed.baseline).toEqual({
      containers: [],
      networks: [],
      volumes: [],
    });
    expect(engine.remaining()).toEqual({
      containers: [],
      networks: [],
      volumes: [],
    });
  });

  test("被中断执行迟到的主容器被真正回收，判定不采信强制删除的成功返回", async () => {
    const { options, manifest } = await fixture();
    // 客户端被超时杀掉的时刻，创建请求仍在内层 daemon 中飞行：按名称或按 id 的强制删除都
    // 会把 NotFound 吞成成功返回，第三次清单才连同它的匿名卷一起看到主容器落地。
    const engine = innerEngine({
      landingAfter: 3,
      landingVolume: "late-anon-volume",
    });
    const request: ScenarioRequest = {
      image: "explicit@sha256:keep",
      command: ["sleep"],
      timeoutMs: 50,
    };
    const record = planScenario(options, request);
    const executed = await settleWithFakeClock(() =>
      executeScenario(options, manifest, request, record, {
        execute: engine.execute,
      }),
    );
    expect(executed).toMatchObject({
      timedOut: true,
      cleanupErrors: [],
      verification: {
        scenarioExecution: "failed",
        scenarioCleanup: "passed",
      },
    });
    expect(engine.landed()).toBe(true);
    expect(engine.remaining()).toEqual({
      containers: [],
      networks: [],
      volumes: [],
    });
  });

  test("被中断执行始终没被观察到落地时报告无法确认，不把空清单当健康回收", async () => {
    const { options, manifest } = await fixture();
    // 创建请求可能一直不在清单上出现：强制删除对缺席目标同样返回成功，而空清单只描述被观察
    // 的这段时间，没有任何时长能证明 daemon 的创建请求已经结束，所以本轮必须记为未确认。
    const engine = innerEngine({ landingAfter: Number.POSITIVE_INFINITY });
    const request: ScenarioRequest = {
      image: "explicit@sha256:keep",
      command: ["sleep"],
      timeoutMs: 50,
    };
    const record = planScenario(options, request);
    const executed = await settleWithFakeClock(() =>
      executeScenario(options, manifest, request, record, {
        execute: engine.execute,
      }),
    );
    expect(executed).toMatchObject({
      timedOut: true,
      phase: "incomplete",
      verification: { scenarioCleanup: "failed" },
    });
    expect(executed.cleanupErrors.join("\n")).toContain(
      `Could not confirm that scenario ${record.id} reclaimed its inner resources`,
    );
    expect(engine.landed()).toBe(false);
  });

  test("更早请求留下的资源被收回，但不代替对主容器自身的观察", async () => {
    const { options, manifest } = await fixture();
    // 三类资源是三次并行查询，组合结果不是同一 daemon 时刻的快照：清单里出现本轮基线之外的
    // 卷只证明那个卷在，不证明这次被中断的创建已经提交，因此仍须报告无法确认。
    const engine = innerEngine({
      landingAfter: Number.POSITIVE_INFINITY,
      strayVolume: "earlier-request-volume",
    });
    const request: ScenarioRequest = {
      image: "explicit@sha256:keep",
      command: ["sleep"],
      timeoutMs: 50,
    };
    const record = planScenario(options, request);
    const executed = await settleWithFakeClock(() =>
      executeScenario(options, manifest, request, record, {
        execute: engine.execute,
      }),
    );
    expect(executed.verification.scenarioCleanup).toBe("failed");
    expect(executed.cleanupErrors.join("\n")).toContain(
      `Could not confirm that scenario ${record.id} reclaimed its inner resources`,
    );
    expect(engine.landed()).toBe(false);
    expect(engine.remaining().volumes).not.toContain("earlier-request-volume");
  });

  test("被中断执行在窗口尽头仍留有收不掉的资源时报告未清理", async () => {
    const { options, manifest } = await fixture();
    const engine = innerEngine({
      containers: ["child-a"],
      undeletable: ["child-a"],
      landingAfter: 2,
    });
    const request: ScenarioRequest = {
      image: "explicit@sha256:keep",
      command: ["sleep"],
      timeoutMs: 50,
    };
    const record = planScenario(options, request);
    const executed = await settleWithFakeClock(() =>
      executeScenario(options, manifest, request, record, {
        execute: engine.execute,
      }),
    );
    expect(executed.verification.scenarioCleanup).toBe("failed");
    expect(executed.phase).toBe("incomplete");
    expect(executed.cleanupErrors.join("\n")).toContain(
      "still has uncleaned inner resources: container child-a",
    );
    expect(engine.remaining().containers).toContain("child-a");
  });

  test("容器删除顺带带走、再删时已不存在的卷记为消失而不是清理失败", async () => {
    const { options, manifest } = await fixture();
    const engine = innerEngine({
      containers: ["child-a"],
      volumes: ["anon-volume-a"],
      volumeOwners: { "anon-volume-a": "child-a" },
    });
    const request: ScenarioRequest = {
      image: "explicit@sha256:keep",
      command: ["true"],
    };
    const record = planScenario(options, request);
    const executed = await executeScenario(options, manifest, request, record, {
      execute: engine.execute,
    });
    expect(executed).toMatchObject({
      cleanupErrors: [],
      verification: { scenarioCleanup: "passed" },
    });
    expect(engine.remaining()).toEqual({
      containers: [],
      networks: [],
      volumes: [],
    });
  });

  test("收敛后仍残留的子资源报告为清理失败而不是被吞掉", async () => {
    const { options, manifest } = await fixture();
    const engine = innerEngine({
      containers: ["child-a"],
      undeletable: ["child-a"],
    });
    const request: ScenarioRequest = {
      image: "explicit@sha256:keep",
      command: ["true"],
    };
    const record = planScenario(options, request);
    const executed = await executeScenario(options, manifest, request, record, {
      execute: engine.execute,
    });
    expect(executed.verification.scenarioCleanup).toBe("failed");
    expect(executed.phase).toBe("incomplete");
    expect(executed.cleanupErrors.join("\n")).toContain(
      "Could not remove scenario container child-a",
    );
    expect(executed.cleanupErrors.join("\n")).toContain(
      `still has uncleaned inner resources: container child-a`,
    );
    expect(engine.remaining().containers).toContain("child-a");
  });

  test("取消只停止业务执行，清理命令不继承已取消的 signal", async () => {
    const { options, manifest } = await fixture();
    const docker = recorder();
    const controller = new AbortController();
    const request: ScenarioRequest = {
      image: "explicit@sha256:keep",
      command: ["long-operation"],
    };
    const record = planScenario(options, request);
    controller.abort();
    const executed = await executeScenario(options, manifest, request, record, {
      execute: docker.execute,
      signal: controller.signal,
    });
    expect(executed).toMatchObject({
      phase: "incomplete",
      cancelled: true,
      exitCode: null,
    });
    expect(executed.verification.scenarioExecution).toBe("incomplete");
    expect(executed.verification.scenarioCleanup).toBe("passed");
    expect(docker.calls.filter(({ args }) => isRun(args))).toEqual([]);
    const cleanup = docker.calls.find(({ args }) => isStop(args));
    expect(cleanup?.options).toEqual({ timeoutMs: 15_000 });
    expect(
      docker.calls.filter(({ options: call }) => call.signal !== undefined),
    ).toEqual([]);
    expect(
      docker.calls.filter(({ args }) => args[2] === "rm" && args[3] === "-rf"),
    ).toHaveLength(1);
  });

  test("准备阶段失败时记录真实原因并仍然执行清理", async () => {
    const { options, manifest } = await fixture();
    const engine = innerEngine({});
    const docker = recorder((args) =>
      args[2] === "mkdir"
        ? result("", 42, "mkdir: cannot create directory: permission denied")
        : engine.execute(options, args),
    );
    const request: ScenarioRequest = {
      image: "explicit@sha256:keep",
      command: ["true"],
    };
    const record = planScenario(options, request);
    await expect(
      executeScenario(options, manifest, request, record, {
        execute: docker.execute,
      }),
    ).rejects.toThrow("Could not prepare the workspace");
    expect(record.error).toContain("prepare the workspace (exit 42)");
    expect(record.error).toContain(
      join(record.localDirectory, "preparation-1"),
    );
    expect(record.verification.scenarioExecution).toBe("not_run");
    expect(record.phase).toBe("incomplete");
    expect(
      docker.calls.filter(({ args }) => args[2] === "rm" && args[3] === "-rf"),
    ).toHaveLength(1);
  });

  test("缺失的来源目录在发起任何 Docker 调用之前被拒绝", async () => {
    const { options, manifest } = await fixture();
    const docker = recorder();
    const request: ScenarioRequest = {
      image: "explicit@sha256:keep",
      command: ["true"],
      sourceDirectory: join(options.stateDirectory, "absent"),
    };
    const record = planScenario(options, request);
    const error = await executeScenario(options, manifest, request, record, {
      execute: docker.execute,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlatformError);
    expect((error as PlatformError).code).toBe("invalidOptions");
    expect(record.phase).toBe("incomplete");
    expect(docker.calls).toEqual([]);
  });

  test("场景阶段在对应 Docker 调用之前先写入清单", async () => {
    const { options, manifest } = await fixture();
    const engine = innerEngine({});
    const record = planScenario(options, {
      image: "explicit@sha256:keep",
      command: ["true"],
    });
    manifest.round = {
      id: randomUUID(),
      startedAt: manifest.createdAt,
      finishedAt: null,
      reuse: false,
      evidenceDirectory: manifest.evidence.directory!,
      identification: {},
      scenarios: [record],
    };
    await writeManifest(options, manifest);
    const phases: string[] = [];
    const execute: DockerExecutor = async (
      callOptions,
      args,
      commandOptions,
    ) => {
      const stored = await readManifest(callOptions);
      phases.push(stored?.round?.scenarios[0]?.phase ?? "missing");
      return engine.execute(callOptions, args, commandOptions);
    };
    await executeScenario(
      options,
      manifest,
      { image: "explicit@sha256:keep", command: ["true"] },
      record,
      { execute },
    );
    expect([...new Set(phases)]).toEqual(["planned", "executing", "cleaning"]);
    expect((await readManifest(options))?.round?.scenarios[0]?.phase).toBe(
      "completed",
    );
  });

  test("边界判定只接受默认网络且无残留容器与卷", () => {
    const defaults = ["bridge", "host", "none"];
    expect(
      scenarioBoundaryClean(
        { containers: [], networks: defaults, volumes: [] },
        defaults,
      ),
    ).toBe(true);
    expect(
      scenarioBoundaryClean(
        { containers: [], networks: [...defaults, "net-a"], volumes: [] },
        defaults,
      ),
    ).toBe(false);
    expect(
      scenarioBoundaryClean(
        { containers: ["abc"], networks: defaults, volumes: [] },
        defaults,
      ),
    ).toBe(false);
    expect(
      scenarioBoundaryClean(
        { containers: [], networks: defaults, volumes: ["vol-a"] },
        defaults,
      ),
    ).toBe(false);
  });
});
