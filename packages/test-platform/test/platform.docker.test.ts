import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, expect, onTestFinished, test } from "vitest";
import { z } from "zod";

import { DEFAULT_BOOTSTRAP_IMAGE } from "../src/defaults.ts";
import { executeDocker } from "../src/docker.ts";
import {
  destroyPlatform,
  destroyResultSchema,
  platformStatusSchema,
  statusPlatform,
} from "../src/lifecycle.ts";
import { roundResultSchema, runRound } from "../src/round.ts";
import type { RoundRequest, RoundResult } from "../src/round.ts";
import type { ScenarioRequest } from "../src/runner.ts";
import type { PlatformOptions } from "../src/types.ts";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const cliPath = join(repository, "packages/test-platform/src/cli.ts");
const baseDirectory = join(repository, ".artifacts/s1-docker");
/** 普通业务场景镜像。 */
const scenarioImage = process.env.REINS_TEST_PLATFORM_IMAGE ?? "alpine:3.20";
/** 需要 Docker CLI 的场景镜像：引导镜像自带 CLI，且只在内层引擎里再拉一次。 */
const engineImage = DEFAULT_BOOTSTRAP_IMAGE;
const OWNER_LABEL = "io.reins.test-platform";

/** 宿主侧只做归属查询与销毁，状态目录本身不参与这些命令。 */
const hostOptions: PlatformOptions = {
  stateDirectory: baseDirectory,
  bootstrapImage: DEFAULT_BOOTSTRAP_IMAGE,
  timeoutMs: 180_000,
};

const prepared: PlatformOptions[] = [];
const cliChildren: { stateDirectory: string; child: ChildProcess }[] = [];

async function docker(
  args: readonly string[],
  timeoutMs = 180_000,
): Promise<string> {
  const result = await executeDocker({ ...hostOptions, timeoutMs }, args);
  expect(result.exitCode, `${args.join(" ")}: ${result.stderr}`).toBe(0);
  return result.stdout;
}

/** 按归属标签列出本测试创建的平台资源，这是宿主侧的权威查询。 */
async function ownedResources(): Promise<string[]> {
  const lists = await Promise.all([
    docker([
      "container",
      "ls",
      "--all",
      "--filter",
      `label=${OWNER_LABEL}`,
      "--format",
      "{{.Names}}",
    ]),
    docker([
      "network",
      "ls",
      "--filter",
      `label=${OWNER_LABEL}`,
      "--format",
      "{{.Name}}",
    ]),
    docker([
      "volume",
      "ls",
      "--filter",
      `label=${OWNER_LABEL}`,
      "--format",
      "{{.Name}}",
    ]),
  ]);
  return lists
    .join("\n")
    .split("\n")
    .filter((line) => line.trim() !== "");
}

async function expectReclaimed(slug: string): Promise<void> {
  expect(
    await ownedResources(),
    `leftover platform resources after ${slug}`,
  ).toEqual([]);
}

/**
 * 内层引擎冷拉取完全依赖外网，本机到 registry 的连接会随机 reset；生命周期的证据不该由
 * 网络稳定性决定。这里把宿主已有的同一引导镜像经 `docker cp` 送进平台容器，由内层
 * `docker load` 登记后再打标签，场景容器就只用本地标签启动、零拉取。
 * `docker load` 只交付镜像 ID（Docker 不会为纯摘要引用保留名字），所以标签必须由 ID 显式打上。
 */
const seededTag = "s1-seeded:local";

async function seedInnerImage(
  containerName: string,
  image: string,
  tarPath: string,
): Promise<void> {
  const imageId = (
    await docker(["image", "inspect", "--format", "{{.Id}}", image])
  ).trim();
  // 369 MB 的导出与转写在满载宿主上以分钟计，给它单独的宽松上限。
  await docker(["save", "--output", tarPath, image], 900_000);
  await docker(["cp", tarPath, `${containerName}:/s1-image.tar`], 900_000);
  await docker(
    ["exec", containerName, "docker", "load", "--input", "/s1-image.tar"],
    900_000,
  );
  await rm(tarPath, { force: true });
  await docker(["exec", containerName, "docker", "tag", imageId, seededTag]);
}

function evidenceOf(options: PlatformOptions): string {
  return join(options.stateDirectory, "..", "evidence");
}

/** 每个用例独占一套状态目录、证据目录与上传脚本目录。 */
async function workspace(
  slug: string,
  scripts: Record<string, string>,
): Promise<PlatformOptions> {
  const root = join(baseDirectory, slug);
  const options: PlatformOptions = {
    stateDirectory: join(root, "state"),
    bootstrapImage: DEFAULT_BOOTSTRAP_IMAGE,
    timeoutMs: 420_000,
  };
  prepared.push(options);
  await rm(root, { recursive: true, force: true });
  await mkdir(evidenceOf(options), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "src"), { recursive: true, mode: 0o700 });
  for (const [name, contents] of Object.entries(scripts)) {
    await writeFile(join(root, "src", name), contents, { mode: 0o600 });
  }
  onTestFinished(async () => {
    // 断言或就绪等待失败时，先结束本用例仍持有清单锁的 CLI，再通过公开入口恢复。
    for (const { stateDirectory, child } of cliChildren) {
      if (stateDirectory !== options.stateDirectory) continue;
      if (child.exitCode !== null || child.signalCode !== null) continue;
      await new Promise<void>((resolveClose) => {
        child.once("close", () => resolveClose());
        child.kill("SIGKILL");
      });
    }
    // 断言失败也要立刻收回本平台，否则它故意保留的资源会污染下一条用例的宿主权威查询。
    if (!existsSync(options.stateDirectory)) return;
    await destroyPlatform(options).catch(() => undefined);
  }, 1_800_000);
  return options;
}

function sourceOf(options: PlatformOptions): string {
  return join(options.stateDirectory, "..", "src");
}

function roundOf(result: RoundResult): string {
  return join(result.evidenceDirectory, "rounds", result.roundId);
}

async function evidenceOutput(
  result: RoundResult,
  index: number,
): Promise<string> {
  const record = result.scenarios[index];
  if (record === undefined) throw new Error(`Scenario ${index} is missing.`);
  return await readFile(
    join(roundOf(result), "scenarios", record.id, "stdout.log"),
    "utf8",
  );
}

function sections(text: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^### ([a-z0-9-]+):(.*)$/.exec(line);
    if (match?.[1] !== undefined) parsed[match[1]] = match[2] ?? "";
  }
  return parsed;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function jsonLines(path: string): Promise<unknown[]> {
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

/** 证据目录由测试统一决定，用例只描述本轮要执行的业务场景。 */
type RoundInput = Omit<RoundRequest, "evidenceDirectory">;

function run(
  options: PlatformOptions,
  request: RoundInput,
): Promise<RoundResult> {
  return runRound(options, {
    ...request,
    evidenceDirectory: evidenceOf(options),
  });
}

interface ProcessExit {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

const envelopeSchema = z.looseObject({
  kind: z.string(),
  variant: z.string().default(""),
  data: z.unknown(),
});

function envelope(exit: ProcessExit): z.infer<typeof envelopeSchema> {
  const lines = [...exit.stdout.split("\n"), ...exit.stderr.split("\n")]
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"));
  expect(lines, `${exit.stdout}\n${exit.stderr}`).toHaveLength(1);
  return envelopeSchema.parse(JSON.parse(lines[0]!) as unknown);
}

function describeExit(exit: ProcessExit): string {
  return `${exit.stdout}\n${exit.stderr}`;
}

/** 全局选项必须排在 `--` 之前，位置参数原样交给契约解析。 */
function startCli(
  options: PlatformOptions,
  argv: readonly string[],
): {
  pid: number;
  kill: (signal: NodeJS.Signals) => void;
  exit: Promise<ProcessExit>;
} {
  const [command, ...rest] = argv;
  const globalOptions =
    command === "run"
      ? [
          "--state-dir",
          options.stateDirectory,
          "--evidence-dir",
          evidenceOf(options),
        ]
      : ["--state-dir", options.stateDirectory];
  const child = spawn(
    process.execPath,
    ["--conditions=source", cliPath, command!, ...globalOptions, ...rest],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  if (child.pid === undefined)
    throw new Error("The CLI process did not start.");
  cliChildren.push({ stateDirectory: options.stateDirectory, child });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return {
    pid: child.pid,
    kill: (signal) => {
      child.kill(signal);
    },
    exit: new Promise<ProcessExit>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => {
        resolveExit({ exitCode, signal, stdout, stderr });
      });
    }),
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

interface RunningScenario {
  roundId: string;
  scenarioId: string;
}

/** 轮次清单在业务执行前已落盘，据此定位可靠的打断时刻。 */
async function waitUntilExecuting(
  options: PlatformOptions,
  running: { pid: number; exit: Promise<ProcessExit> },
): Promise<RunningScenario> {
  let terminal: ProcessExit | Error | undefined;
  void running.exit.then(
    (result) => {
      terminal = result;
    },
    (error: unknown) => {
      terminal = error instanceof Error ? error : new Error(String(error));
    },
  );
  // 冷拉取和引擎就绪各有独立预算，不能用短于准备阶段的三分钟截断取消用例。
  const deadline = Date.now() + 2 * (options.timeoutMs ?? 420_000) + 60_000;
  while (Date.now() < deadline) {
    if (terminal !== undefined) {
      throw new Error(
        `The CLI exited before any scenario started: ${terminal instanceof Error ? terminal.message : describeExit(terminal)}`,
      );
    }
    const status = await statusPlatform(options);
    const round = status.manifest?.round;
    if (
      round !== undefined &&
      round !== null &&
      status.busy?.pid === running.pid
    ) {
      const executing = round.scenarios.filter(
        (record) => record.phase === "executing",
      );
      if (executing.length > 0) {
        return { roundId: round.id, scenarioId: executing[0]!.id };
      }
    }
    await delay(1_000);
  }
  throw new Error("No scenario reached the executing phase.");
}

async function waitUntilRecorded(options: PlatformOptions): Promise<string> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const status = await statusPlatform(options);
    if (status.manifest !== null) return status.manifest.id;
    await delay(500);
  }
  throw new Error("The platform manifest was never recorded.");
}

const messScript = `#!/bin/sh
set -eu
docker run -d --name s1-child "$IMAGE" sleep 300 > /dev/null
docker network create s1-net > /dev/null
docker volume create s1-vol > /dev/null
printf created
`;

const boundaryScript = `#!/bin/sh
set -eu
own=$(basename "$(dirname "$PWD")")
containers=$(docker ps -a --format '{{.Names}}' | grep -v "^reins-test-scene-$own$" | tr '\\n' ' ' || true)
networks=$(docker network ls --format '{{.Name}}' | grep -vE '^(bridge|host|none)$' | tr '\\n' ' ' || true)
# 场景主容器用的是带 VOLUME 声明的引导镜像，它自己的匿名卷不属于上一轮残留。
own_volumes=$(docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}' "reins-test-scene-$own")
volumes=""
for candidate in $(docker volume ls --format '{{.Name}}'); do
  case " $own_volumes " in
    *" $candidate "*) ;;
    *) volumes="$volumes$candidate " ;;
  esac
done
runs=$(docker run --rm -v /platform/runs:/runs "$IMAGE" sh -c "ls /runs | grep -v '^$own\\$'" | tr '\\n' ' ' || true)
printf 'shared\\n' > canary.txt
canary=$(docker run --rm -v "$PWD:/ws" "$IMAGE" cat /ws/canary.txt)
printf '### containers:%s\\n' "$containers"
printf '### networks:%s\\n' "$networks"
printf '### volumes:%s\\n' "$volumes"
printf '### runs:%s\\n' "$runs"
printf '### canary:%s\\n' "$canary"
printf '### done:%s\\n' yes
`;

/** 需要内层 Docker CLI 的场景：场景容器用灌入内层引擎的引导镜像，子资源用业务镜像。 */
function engineScenario(
  options: PlatformOptions,
  script: string,
  innerImage: string,
  timeoutMs = 420_000,
): ScenarioRequest {
  return {
    image: innerImage,
    dockerAccess: true,
    sourceDirectory: sourceOf(options),
    environment: { IMAGE: scenarioImage },
    command: ["sh", script],
    timeoutMs,
  };
}

beforeAll(async () => {
  // 显式 Docker 门禁缺少运行条件时必须失败，不能静默跳过。
  await docker(["info", "--format", "{{.ServerVersion}}"]);
  await rm(baseDirectory, { recursive: true, force: true });
  await mkdir(baseDirectory, { recursive: true, mode: 0o700 });
}, 300_000);

afterAll(async () => {
  // 只按各自清单销毁本用例创建的平台，绝不做宿主级清理。
  for (const options of prepared) {
    if (!existsSync(options.stateDirectory)) continue;
    const destroyed = await destroyPlatform(options);
    if (destroyed.disposition === "recovery_required") {
      throw new Error(
        `Could not reclaim ${options.stateDirectory}: ${destroyed.failures.join("; ")}`,
      );
    }
  }
  await expectReclaimed("afterAll");
}, 1_800_000);

test("默认销毁的一轮先导出完整事实与日志再回收，并按归属标签消失", async () => {
  const options = await workspace("default-destroy", { "mess.sh": messScript });
  const secret = "token-never-in-records";
  const result = await run(options, {
    scenarios: [
      {
        image: scenarioImage,
        environment: { S1_TOKEN: secret },
        logPaths: ["marker.txt"],
        command: [
          "sh",
          "-eu",
          "-c",
          "printf '%s\\n' \"$S1_TOKEN\" > marker.txt; printf scenario-one",
        ],
        timeoutMs: 420_000,
      },
      engineScenario(options, "mess.sh", engineImage),
    ],
    identification: { slice: "s1" },
  });
  expect(result, JSON.stringify(result.verification)).toMatchObject({
    disposition: "destroyed",
    reuse: false,
    exitCode: 0,
    cancelled: null,
    timedOut: false,
    verification: {
      scenarioExecution: "passed",
      scenarioCleanup: "passed",
      evidenceExport: "passed",
      platformReclaim: "passed",
    },
  });
  expect(result.scenarios.map((record) => record.exitCode)).toEqual([0, 0]);
  // 场景自行创建的子容器、网络与卷在同场景内已回收。
  expect(result.scenarios[1]!.cleanupErrors).toEqual([]);
  expect(await evidenceOutput(result, 0)).toBe("scenario-one");

  const directory = roundOf(result);
  const round = z
    .looseObject({
      recordedAt: z.iso.datetime(),
      platform: z.looseObject({
        bootstrapImage: z.string(),
        imageAcquisition: z.looseObject({
          existedBefore: z.boolean(),
          acquiredId: z.string(),
        }),
      }),
      round: z.looseObject({
        identification: z.record(z.string(), z.unknown()),
        scenarios: z.array(
          z.looseObject({
            requestedImage: z.string(),
            environmentNames: z.array(z.string()),
            collectedLogs: z.array(z.looseObject({ status: z.string() })),
          }),
        ),
      }),
      pendingReclamation: z.looseObject({
        names: z.looseObject({ containerName: z.string() }),
      }),
    })
    .parse(await readJson(join(directory, "round.json")));
  expect(round.round.identification).toEqual({ slice: "s1" });
  expect(round.round.scenarios[0]?.environmentNames).toEqual(["S1_TOKEN"]);
  expect(round.round.scenarios[0]?.collectedLogs).toEqual([
    { path: "marker.txt", status: "copied", detail: null },
  ]);
  // 清单只记录变量名，凭据只出现在被采集的工作区日志里。
  expect(JSON.stringify(round)).not.toContain(secret);
  expect(
    await readFile(
      join(
        directory,
        "scenarios",
        result.scenarios[0]!.id,
        "collected",
        "marker.txt",
      ),
      "utf8",
    ),
  ).toBe(`${secret}\n`);

  const reclamation = z
    .array(
      z.strictObject({
        attemptedAt: z.iso.datetime(),
        disposition: z.string(),
        facts: z.array(
          z.strictObject({
            kind: z.string(),
            name: z.string(),
            outcome: z.string(),
            detail: z.string().nullable(),
          }),
        ),
        failures: z.array(z.string()),
      }),
    )
    .parse(await jsonLines(join(directory, "reclamation.jsonl")));
  expect(reclamation).toHaveLength(1);
  expect(reclamation[0]!.disposition).toBe("reclaimed");
  expect(reclamation[0]!.failures).toEqual([]);
  const removedKinds = reclamation[0]!.facts
    .filter((fact) => fact.outcome === "removed" && fact.kind !== "image")
    .map((fact) => fact.kind);
  expect(removedKinds.sort()).toEqual([
    "container",
    "network",
    "volume",
    "volume",
  ]);
  // 冷启动取得的镜像必须回收；调用方原有镜像必须保留。
  const { existedBefore, acquiredId } = round.platform.imageAcquisition;
  expect(reclamation[0]!.facts.filter((fact) => fact.kind === "image")).toEqual(
    [
      expect.objectContaining({
        name: round.platform.bootstrapImage,
        outcome: existedBefore ? "skipped" : "removed",
      }),
    ],
  );
  for (const image of [round.platform.bootstrapImage, acquiredId]) {
    const inspected = await executeDocker(hostOptions, [
      "image",
      "inspect",
      image,
    ]);
    expect(inspected.exitCode).toBe(existedBefore ? 0 : 1);
  }
  // 留证在前、回收事实追加在后，且成功回收没有抹掉已导出的唯一证据。
  expect(Date.parse(reclamation[0]!.attemptedAt)).toBeGreaterThanOrEqual(
    Date.parse(round.recordedAt),
  );
  expect(
    (await stat(join(directory, "reclamation.jsonl"))).mtimeMs,
  ).toBeGreaterThanOrEqual((await stat(join(directory, "round.json"))).mtimeMs);
  expect(existsSync(options.stateDirectory)).toBe(false);
  await expectReclaimed("default-destroy");
}, 1_800_000);

test("显式复用的多轮共用同一内层引擎，并逐场景回收子容器、网络与卷", async () => {
  const options = await workspace("reuse-boundary", {
    "mess.sh": messScript,
    "boundary.sh": boundaryScript,
  });
  // 第一轮只用一次小体积业务场景把平台建立并保留下来，随后把引导摘要灌入内层引擎。
  const warm = await run(options, {
    reuse: true,
    scenarios: [
      {
        image: scenarioImage,
        command: ["sh", "-c", "printf warm-round"],
        timeoutMs: 420_000,
      },
    ],
  });
  expect(warm, JSON.stringify(warm.verification)).toMatchObject({
    disposition: "retained",
    reuse: true,
    exitCode: 0,
    verification: {
      scenarioExecution: "passed",
      scenarioCleanup: "passed",
      evidenceExport: "passed",
      platformReclaim: "not_run",
    },
  });
  const containerName = (await statusPlatform(options)).manifest!.names
    .containerName;
  await seedInnerImage(
    containerName,
    engineImage,
    join(baseDirectory, "reuse-boundary", "image.tar"),
  );

  const first = await run(options, {
    reuse: true,
    scenarios: [
      // 引导镜像已由宿主灌入内层引擎：本轮零冷拉取，正好体现跨轮保留的缓存。
      engineScenario(options, "mess.sh", seededTag),
      {
        image: seededTag,
        command: ["sh", "-c", "printf second-round"],
        timeoutMs: 420_000,
      },
    ],
  });
  expect(first, JSON.stringify(first.verification)).toMatchObject({
    disposition: "retained",
    reuse: true,
    timedOut: false,
    exitCode: 0,
    verification: {
      scenarioExecution: "passed",
      scenarioCleanup: "passed",
      evidenceExport: "passed",
      platformReclaim: "not_run",
    },
  });
  expect(first.notApplicable.platformReclaim).toContain("retained");
  expect(first.scenarios[1]).toMatchObject({
    phase: "completed",
    cleanupErrors: [],
  });
  expect(existsSync(options.stateDirectory)).toBe(true);
  // 灌入确实生效：场景容器没有发起任何冷拉取。
  expect(
    await readFile(
      join(roundOf(first), "scenarios", first.scenarios[0]!.id, "stderr.log"),
      "utf8",
    ),
  ).not.toContain("Unable to find image");

  const boundary = await run(options, {
    reuse: true,
    scenarios: [engineScenario(options, "boundary.sh", seededTag)],
  });
  expect(boundary, JSON.stringify(boundary.verification)).toMatchObject({
    disposition: "retained",
    platformId: warm.platformId,
    timedOut: false,
    verification: { scenarioExecution: "passed", scenarioCleanup: "passed" },
  });
  expect(boundary.roundId).not.toBe(first.roundId);
  // 三轮共用同一个内层引擎身份，缓存因此不需要再次冷拉取。
  expect(boundary.platform.innerEngineId).toBe(warm.platform.innerEngineId);
  expect(first.platform.innerEngineId).toBe(warm.platform.innerEngineId);
  expect(boundary.scenarios[0]!.id).not.toBe(first.scenarios[0]!.id);
  const observed = sections(await evidenceOutput(boundary, 0));
  // 上一轮的主容器、子容器、自定义网络、卷与工作区目录都不复存在。
  expect(observed.containers).toBe("");
  expect(observed.networks).toBe("");
  expect(observed.volumes).toBe("");
  expect(observed.runs).toBe("");
  // 子容器以同一绝对路径挂载并读到了本次场景工作区里的文件。
  expect(observed.canary).toBe("shared");
  expect(observed.done).toBe("yes");

  // 真实的 8 秒中断：客户端被杀掉时创建请求可能仍在内层 daemon 中飞行，所以只有真的看到这个
  // 场景自己的主容器并把它收回才算清理收敛；窗口尽头仍看不到就如实记为无法确认，本轮因此
  // 不能被当作健康平台保留，后续场景不执行，平台由外层完整回收。两条分支都是真实结果。
  const interrupted = await run(options, {
    reuse: true,
    scenarios: [
      {
        image: seededTag,
        command: ["sh", "-c", "sleep 120"],
        timeoutMs: 8_000,
      },
      engineScenario(options, "boundary.sh", seededTag),
    ],
  });
  expect(interrupted.timedOut).toBe(true);
  expect(interrupted.exitCode).toBe(124);
  expect(interrupted.scenarios[0]).toMatchObject({ timedOut: true });
  if (interrupted.verification.scenarioCleanup === "passed") {
    // 确认收回之后才允许继续保留同一个平台与同一个内层引擎，后轮按清单核对没有残留。
    expect(interrupted.disposition).toBe("retained");
    expect(interrupted.platform.innerEngineId).toBe(
      warm.platform.innerEngineId,
    );
    expect(interrupted.scenarios[1]).toMatchObject({
      phase: "completed",
      cleanupErrors: [],
    });
    expect(existsSync(options.stateDirectory)).toBe(true);
    const isolated = sections(await evidenceOutput(interrupted, 1));
    expect(isolated.containers).toBe("");
    expect(isolated.networks).toBe("");
    expect(isolated.volumes).toBe("");
    expect(isolated.runs).toBe("");
    expect(isolated.done).toBe("yes");
  } else {
    expect(interrupted.disposition).toBe("destroyed");
    expect(interrupted.verification.platformReclaim).toBe("passed");
    expect(interrupted.scenarios[0]!.cleanupErrors.length).toBeGreaterThan(0);
    expect(interrupted.scenarios[1]!.phase).toBe("not_run");
    expect(interrupted.failures.join("\n")).toContain(
      "left uncleaned resources",
    );
    // 原始清理错误留在唯一证据里，外层回收成功不把它改写成通过。
    const exported = await readJson(join(roundOf(interrupted), "round.json"));
    expect(JSON.stringify(exported)).toContain(
      interrupted.scenarios[0]!.cleanupErrors[0]!,
    );
    expect(existsSync(options.stateDirectory)).toBe(false);
  }

  if (existsSync(options.stateDirectory)) {
    const destroyed = await destroyPlatform(options);
    expect(destroyed, JSON.stringify(destroyed.failures)).toMatchObject({
      disposition: "destroyed",
      platformId: first.platformId,
      failures: [],
    });
  }
  expect(existsSync(options.stateDirectory)).toBe(false);
  await expectReclaimed("reuse-boundary");
}, 2_400_000);

test("真实 CLI 保留被测命令退出码 7，平台以 1 退出并默认完整销毁", async () => {
  const options = await workspace("cli-exit-seven", {});
  const exit = await startCli(options, [
    "run",
    "--image",
    scenarioImage,
    "--timeout-ms",
    "420000",
    "--",
    "sh",
    "-c",
    "printf expected-failure; exit 7",
  ]).exit;
  expect(exit, describeExit(exit)).toMatchObject({ exitCode: 1, signal: null });
  const payload = envelope(exit);
  expect(payload.kind).toBe("failure");
  expect(payload.variant).toBe("failed");
  const result = roundResultSchema.parse(payload.data);
  expect(result.scenarios.map((record) => record.exitCode)).toEqual([7]);
  expect(result.verification).toMatchObject({
    scenarioExecution: "failed",
    platformReclaim: "passed",
  });
  expect(existsSync(options.stateDirectory)).toBe(false);
  await expectReclaimed("cli-exit-seven");
}, 1_200_000);

test("真实 CLI 在场景超时后返回固定码 124 并回收内层容器", async () => {
  const options = await workspace("cli-timeout", {});
  const exit = await startCli(options, [
    "run",
    "--image",
    scenarioImage,
    "--timeout-ms",
    "20000",
    "--",
    "sh",
    "-c",
    "sleep 120",
  ]).exit;
  expect(exit, describeExit(exit)).toMatchObject({
    exitCode: 124,
    signal: null,
  });
  const result = roundResultSchema.parse(envelope(exit).data);
  expect(result).toMatchObject({ timedOut: true, disposition: "destroyed" });
  // 被中断执行的清理只有在真的看到并收回它自己的主容器之后才算收敛；否则本轮如实记录无法
  // 确认，平台仍被完整回收。两条分支都必须保留真实的超时与固定码。
  expect(result.verification.platformReclaim).toBe("passed");
  const record = result.scenarios[0]!;
  if (result.verification.scenarioCleanup === "passed") {
    expect(record).toMatchObject({ timedOut: true, cleanupErrors: [] });
  } else {
    expect(record.phase).toBe("incomplete");
    expect(record.cleanupErrors.length).toBeGreaterThan(0);
  }
  expect(existsSync(options.stateDirectory)).toBe(false);
  await expectReclaimed("cli-timeout");
}, 1_200_000);

test.each([
  { signal: "SIGINT" as const, exitCode: 130, variant: "interrupted" },
  { signal: "SIGTERM" as const, exitCode: 143, variant: "terminated" },
])(
  "真实 CLI 收到 $signal 时以固定码 $exitCode 收尾并停止业务执行",
  async ({ signal, exitCode, variant }) => {
    const slug = `cli-${signal.toLowerCase()}`;
    const options = await workspace(slug, {});
    const running = startCli(options, [
      "run",
      "--image",
      scenarioImage,
      "--timeout-ms",
      "420000",
      "--",
      "sh",
      "-c",
      "sleep 120",
    ]);
    const scenarioId = await waitUntilExecuting(options, running);
    running.kill(signal);
    const exit = await running.exit;
    expect(exit, describeExit(exit)).toMatchObject({ exitCode, signal: null });
    const payload = envelope(exit);
    expect(payload.variant).toBe(variant);
    const result = roundResultSchema.parse(payload.data);
    expect(result).toMatchObject({
      cancelled: signal,
      disposition: "destroyed",
    });
    expect(result.scenarios.map((record) => record.id)).toEqual([
      scenarioId.scenarioId,
    ]);
    expect(result.scenarios[0]).toMatchObject({ cancelled: true });
    expect(existsSync(options.stateDirectory)).toBe(false);
    await expectReclaimed(slug);
  },
  1_200_000,
);

test("SIGKILL 打断创建后公共 status 报告未收尾状态，公共 destroy 依据清单回收", async () => {
  const options = await workspace("sigkill-create", {});
  const interrupted = startCli(options, [
    "run",
    "--image",
    scenarioImage,
    "--",
    "sh",
    "-c",
    "printf unreached",
  ]);
  const platformId = await waitUntilRecorded(options);
  interrupted.kill("SIGKILL");
  const exit = await interrupted.exit;
  expect(exit.exitCode).toBeNull();
  expect(exit.signal).toBe("SIGKILL");

  const recorded = (await statusPlatform(options)).manifest!;
  const snapshot = await startCli(options, ["status"]).exit;
  expect(snapshot, describeExit(snapshot)).toMatchObject({ exitCode: 0 });
  // 公开 status 的载荷必须原样满足生命周期自己的状态契约。
  const reported = platformStatusSchema.parse(envelope(snapshot).data);
  expect(reported.manifest?.id).toBe(platformId);
  expect(["preparing", "running"]).toContain(reported.phase);
  // 中断留下的锁仍指向已消失的持有者，状态报告不得伪装成空闲。
  expect(reported.busy).toEqual({ pid: interrupted.pid, purpose: "run" });

  const destroyed = await startCli(options, ["destroy"]).exit;
  expect(destroyed, describeExit(destroyed)).toMatchObject({ exitCode: 0 });
  const payload = envelope(destroyed);
  expect(payload.variant).toBe("destroyed");
  // 销毁载荷同样按生命周期自己的契约逐字校验，测试不另写一份字段清单。
  const result = destroyResultSchema.parse(payload.data);
  expect(result).toMatchObject({
    disposition: "destroyed",
    platformId,
    failures: [],
  });
  // 恢复销毁严格按清单处理每一个已记录资源，不遗漏也不越界。
  const names = recorded.names;
  for (const name of [
    names.containerName,
    names.networkName,
    names.dataVolumeName,
    names.workspaceVolumeName,
  ]) {
    expect(result.facts.map((fact) => fact.name)).toContain(name);
  }
  expect(result.facts.filter((fact) => fact.outcome === "failed")).toEqual([]);
  expect(existsSync(options.stateDirectory)).toBe(false);
  await expectReclaimed("sigkill-create");
}, 900_000);

test("SIGKILL 打断场景后未完成任务可见，销毁补齐证据并从外层回收", async () => {
  const options = await workspace("sigkill-run", {});
  const interrupted = startCli(options, [
    "run",
    "--image",
    scenarioImage,
    "--timeout-ms",
    "420000",
    "--",
    "sh",
    "-c",
    "sleep 120",
  ]);
  const running = await waitUntilExecuting(options, interrupted);
  interrupted.kill("SIGKILL");
  expect((await interrupted.exit).signal).toBe("SIGKILL");

  const status = await statusPlatform(options);
  expect(status.phase).toBe("running");
  expect(status.busy).toEqual({ pid: interrupted.pid, purpose: "run" });
  expect(status.unfinishedScenarios).toEqual([
    { id: running.scenarioId, phase: "executing" },
  ]);

  const destroyed = await destroyPlatform(options);
  expect(destroyed, JSON.stringify(destroyed.failures)).toMatchObject({
    disposition: "destroyed",
    failures: [],
  });
  const directory = join(evidenceOf(options), "rounds", running.roundId);
  const exported = await readJson(join(directory, "round.json"));
  expect(JSON.stringify(exported)).toContain("executing");
  expect(
    z
      .array(
        z.strictObject({
          attemptedAt: z.iso.datetime(),
          disposition: z.string(),
          facts: z.array(
            z.looseObject({ kind: z.string(), outcome: z.string() }),
          ),
          failures: z.array(z.string()),
        }),
      )
      .parse(await jsonLines(join(directory, "reclamation.jsonl"))),
  ).toHaveLength(1);
  expect(existsSync(options.stateDirectory)).toBe(false);
  await expectReclaimed("sigkill-run");
}, 1_200_000);

test("内层引擎失联时仍按清单从宿主回收，并保留失败留证", async () => {
  const options = await workspace("inner-stopped", {});
  const retained = await startCli(options, [
    "run",
    "--reuse",
    "--image",
    scenarioImage,
    "--",
    "sh",
    "-c",
    "printf retained",
  ]).exit;
  expect(retained, describeExit(retained)).toMatchObject({ exitCode: 0 });
  const platformId = await waitUntilRecorded(options);
  const manifest = (await statusPlatform(options)).manifest!;
  await docker([
    "container",
    "stop",
    "--time",
    "2",
    manifest.names.containerName,
  ]);

  const stopped = await statusPlatform(options);
  expect(stopped, JSON.stringify(stopped.failures)).toMatchObject({
    phase: "retained",
    outer: "stopped",
    inner: "absent",
    busy: null,
    engineIdentityMatches: true,
  });

  const destroyed = await destroyPlatform(options);
  expect(destroyed, JSON.stringify(destroyed.failures)).toMatchObject({
    disposition: "destroyed",
    platformId,
  });
  expect(existsSync(options.stateDirectory)).toBe(false);
  await expectReclaimed("inner-stopped");
}, 900_000);
