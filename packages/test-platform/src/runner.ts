import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { executeDocker } from "./docker.ts";
import {
  checked,
  innerResources,
  mainContainerLanded,
  scenarioLocalDirectory,
} from "./lifecycle.ts";
import type { InnerResources } from "./lifecycle.ts";
import { OWNER_LABEL, writeManifest } from "./manifest.ts";
import type {
  PlatformManifest,
  ScenarioRecord,
  VerificationState,
} from "./manifest.ts";
import { PlatformError } from "./types.ts";
import type {
  CommandResult,
  DockerExecutor,
  PlatformOptions,
  ReclamationFact,
} from "./types.ts";

export const SCENARIO_LABEL = "io.reins.test-platform-scenario";
export const PLATFORM_WORKSPACE_ROOT = "/platform/runs";

export interface ScenarioRequest {
  image: string;
  command: readonly string[];
  sourceDirectory?: string;
  environment?: Record<string, string>;
  timeoutMs?: number;
  workdir?: string;
  dockerAccess?: boolean;
  /** 调用方显式声明的工作区内日志位置，平台不猜测产品私有路径。 */
  logPaths?: readonly string[];
  /** 原样记入清单与证据的调用方身份，例如场景版本与输入摘要。 */
  identification?: Record<string, string | number>;
  /** 除平台自持项外本次关注的验证项；未通过时平台不得报告成功。 */
  verificationItems?: readonly string[];
}

export interface ScenarioDependencies {
  execute?: DockerExecutor;
  signal?: AbortSignal;
}

// 先发布 PID 再检查取消标记，避免外层 exec 超时后迟到的调用创建容器。
const START_CLIENT = `set -e
pid_file="$1"
cancel_file="$2"
shift 2
printf '%s\\n' "$$" > "$pid_file.tmp"
mv "$pid_file.tmp" "$pid_file"
if [ -e "$cancel_file" ] || [ ! -d "\${pid_file%/*}" ]; then exit 125; fi
exec "$@"`;

// PID 可能复用，因此每次发信号与等待都核对唯一运行名称。
const STOP_CLIENT = `set -e
pid_file="$1"
cancel_file="$2"
run_name="$3"
[ -d "\${pid_file%/*}" ] || exit 0
: > "$cancel_file"
[ -f "$pid_file" ] || exit 0
read -r client_pid < "$pid_file"
case "$client_pid" in ''|*[!0-9]*) exit 1 ;; esac
matches_run() {
  [ -r "/proc/$client_pid/cmdline" ] || return 1
  tr '\\000' '\\n' < "/proc/$client_pid/cmdline" | grep -Fxq -- "$run_name"
}
if matches_run; then kill -TERM "$client_pid" 2>/dev/null || true; fi
attempt=0
while matches_run && [ "$attempt" -lt 20 ]; do
  sleep 0.1
  attempt=$((attempt + 1))
done
if matches_run; then kill -KILL "$client_pid" 2>/dev/null || true; fi
attempt=0
while matches_run && [ "$attempt" -lt 20 ]; do
  sleep 0.1
  attempt=$((attempt + 1))
done
if matches_run; then exit 1; fi`;

// 内层创建请求的飞行窗口：客户端被中断后，docker run 的创建请求仍会在内层 daemon 中
// 继续处理，本机实测落地滞后一分半以上，因此确认窗口必须覆盖这个量级。窗口只界定
// 愿意等多久看到落地，看到与否才是判定依据，任何时长都不构成创建已终止的证明。
const LATE_LANDING_CAP_MS = 300_000;
const LATE_LANDING_STEPS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

function commandFailed(result: CommandResult): boolean {
  return result.exitCode !== 0 || result.timedOut || result.signal !== null;
}

export function validateScenario(request: ScenarioRequest): void {
  if (
    !request.image ||
    request.image.startsWith("-") ||
    /\s|\0/.test(request.image)
  ) {
    throw new PlatformError(
      "invalidOptions",
      "Provide a nonempty container image without whitespace.",
    );
  }
  if (
    request.command.length === 0 ||
    !request.command[0] ||
    request.command.some((argument) => argument.includes("\0"))
  ) {
    throw new PlatformError(
      "invalidOptions",
      "Provide a command with unchanged arguments; arguments cannot contain NUL.",
    );
  }
  if (
    request.timeoutMs !== undefined &&
    (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0)
  ) {
    throw new PlatformError(
      "invalidOptions",
      "Scenario timeout must be a positive integer in milliseconds.",
    );
  }
  if (
    request.workdir !== undefined &&
    (!isAbsolute(request.workdir) || request.workdir.includes("\0"))
  ) {
    throw new PlatformError(
      "invalidOptions",
      "Container workdir must be an absolute path.",
    );
  }
  for (const [name, value] of Object.entries(request.environment ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new PlatformError(
        "invalidOptions",
        "Environment variable names must be valid identifiers.",
      );
    }
    if (/[\r\n\0]/.test(value)) {
      throw new PlatformError(
        "invalidOptions",
        `Environment variable ${name} cannot contain CR, LF, or NUL.`,
      );
    }
  }
  for (const path of request.logPaths ?? []) {
    if (
      path === "" ||
      path.startsWith("/") ||
      path.includes("\0") ||
      path.split("/").includes("..")
    ) {
      throw new PlatformError(
        "invalidOptions",
        "Scenario log paths must be workspace-relative paths without parent traversal.",
      );
    }
  }
}

// 场景级验证项；留证与平台回收按轮次在 round.ts 中记录。
export const SCENARIO_VERIFICATION_ITEMS = [
  "scenarioExecution",
  "scenarioCleanup",
] as const;

export function planScenario(
  options: PlatformOptions,
  request: ScenarioRequest,
): ScenarioRecord {
  validateScenario(request);
  const id = randomUUID();
  const verification: Record<string, VerificationState> = {};
  for (const item of [
    ...SCENARIO_VERIFICATION_ITEMS,
    ...(request.verificationItems ?? []),
  ]) {
    verification[item] = "not_run";
  }
  return {
    id,
    phase: "planned",
    requestedImage: request.image,
    resolvedImage: { id: null, digests: [] },
    workspacePath: `${PLATFORM_WORKSPACE_ROOT}/${id}/workspace`,
    environmentNames: Object.keys(request.environment ?? {}),
    identification: request.identification ?? {},
    verification,
    exitCode: null,
    signal: null,
    timedOut: false,
    cancelled: false,
    error: null,
    cleanupErrors: [],
    baseline: { containers: [], networks: [], volumes: [] },
    localDirectory: scenarioLocalDirectory(options, id),
    collectedLogs: [],
  };
}

interface ScenarioPaths {
  containerName: string;
  remoteDirectory: string;
  workspace: string;
  environmentPath: string;
  remoteEnvironmentPath: string;
  clientPidPath: string;
  cancelPath: string;
}

function scenarioPaths(record: ScenarioRecord): ScenarioPaths {
  const remoteDirectory = `${PLATFORM_WORKSPACE_ROOT}/${record.id}`;
  return {
    containerName: `reins-test-scene-${record.id}`,
    remoteDirectory,
    workspace: record.workspacePath,
    environmentPath: join(record.localDirectory, "environment.env"),
    remoteEnvironmentPath: `${remoteDirectory}/environment.env`,
    clientPidPath: `${remoteDirectory}/client.pid`,
    cancelPath: `${remoteDirectory}/cancel`,
  };
}

/**
 * 执行一个场景并在同一调用内回收其业务资源：主容器、子容器、自定义网络、
 * 业务卷与工作区副本。清理不继承已取消的 signal，取消只停止业务执行。
 */
export async function executeScenario(
  options: PlatformOptions,
  manifest: PlatformManifest,
  request: ScenarioRequest,
  record: ScenarioRecord,
  dependencies: ScenarioDependencies = {},
): Promise<ScenarioRecord> {
  const execute = dependencies.execute ?? executeDocker;
  const { signal } = dependencies;
  const paths = scenarioPaths(record);
  validateScenario(request);
  const sourceDirectory =
    request.sourceDirectory === undefined
      ? undefined
      : resolve(request.sourceDirectory);
  if (sourceDirectory !== undefined) {
    const info = await stat(sourceDirectory).catch(() => null);
    if (!info?.isDirectory()) {
      record.error = `Source directory ${sourceDirectory} does not exist or is not a directory.`;
      record.phase = "incomplete";
      await writeManifest(options, manifest);
      throw new PlatformError(
        "invalidOptions",
        `Scenario source directory ${sourceDirectory} is missing.`,
      );
    }
  }
  await mkdir(record.localDirectory, { recursive: true, mode: 0o700 });
  record.phase = "executing";
  record.baseline = toBaseline(
    await innerResources(execute, options, manifest.names.containerName),
  );
  await writeManifest(options, manifest);

  let containerMayExist = false;
  let engineFailure: PlatformError | undefined;
  let stage = "prepare the workspace";
  let step = 0;
  const requireSuccess = async (args: readonly string[]): Promise<void> => {
    if (signal?.aborted === true) throw cancelled();
    step += 1;
    const diagnosticsPath = join(record.localDirectory, `preparation-${step}`);
    const response = await execute(options, args, {
      outputDirectory: diagnosticsPath,
      ...(signal === undefined ? {} : { signal }),
    });
    if (commandFailed(response)) {
      record.timedOut = response.timedOut;
      record.signal = response.signal;
      const outcome = response.timedOut
        ? "timeout"
        : `exit ${response.exitCode ?? response.signal ?? "unknown"}`;
      record.error = `Could not ${stage} (${outcome}). See preparation logs in ${diagnosticsPath}.`;
      throw new PlatformError("unreachable", `Could not ${stage}.`);
    }
  };

  try {
    await requireSuccess([
      "exec",
      manifest.names.containerName,
      "mkdir",
      "-p",
      "-m",
      "700",
      paths.workspace,
    ]);
    if (sourceDirectory !== undefined) {
      stage = "upload the source directory";
      await requireSuccess([
        "cp",
        `${sourceDirectory}/.`,
        `${manifest.names.containerName}:${paths.workspace}/`,
      ]);
    }
    const environmentNames = record.environmentNames;
    if (environmentNames.length > 0) {
      stage = "prepare the environment";
      // 凭据文件只供内层 Docker 读取，不挂载进被测容器。
      await writeFile(
        paths.environmentPath,
        environmentNames
          .map((name) => `${name}=${request.environment?.[name] ?? ""}\n`)
          .join(""),
        { mode: 0o600, flag: "wx" },
      );
      await requireSuccess([
        "cp",
        paths.environmentPath,
        `${manifest.names.containerName}:${paths.remoteEnvironmentPath}`,
      ]);
    }

    const args = [
      "exec",
      manifest.names.containerName,
      "sh",
      "-c",
      START_CLIENT,
      paths.containerName,
      paths.clientPidPath,
      paths.cancelPath,
      "docker",
      "run",
      "--name",
      paths.containerName,
      "--label",
      `${OWNER_LABEL}=${manifest.id}`,
      "--label",
      `${SCENARIO_LABEL}=${record.id}`,
      "--mount",
      `type=bind,src=${paths.workspace},dst=${paths.workspace}`,
      "--workdir",
      request.workdir ?? paths.workspace,
    ];
    if (request.dockerAccess === true) {
      args.push(
        "--mount",
        "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock",
      );
    }
    if (environmentNames.length > 0) {
      args.push("--env-file", paths.remoteEnvironmentPath);
    }
    args.push(request.image, ...request.command);
    stage = "execute the requested command";
    if (signal?.aborted === true) throw cancelled();
    containerMayExist = true;
    const execution = await execute(options, args, {
      outputDirectory: record.localDirectory,
      ...(request.timeoutMs === undefined
        ? {}
        : { timeoutMs: request.timeoutMs }),
      ...(signal === undefined ? {} : { signal }),
    });
    record.exitCode = execution.exitCode;
    record.signal = execution.signal;
    record.timedOut = execution.timedOut;
    record.cancelled = signal?.aborted ?? false;
    record.verification.scenarioExecution =
      !record.cancelled && !record.timedOut && execution.exitCode === 0
        ? "passed"
        : "failed";
    record.resolvedImage = await resolveInnerImage(
      execute,
      options,
      manifest,
      request.image,
    );
    await collectScenarioLogs(options, manifest, request, record, execute);
  } catch (error) {
    if (isCancelled(error) || signal?.aborted === true) {
      record.cancelled = true;
      if (record.verification.scenarioExecution === "not_run") {
        record.verification.scenarioExecution = "incomplete";
      }
      record.error ??= "The round was cancelled before this scenario finished.";
    } else {
      if (error instanceof PlatformError && error.code === "unreachable") {
        engineFailure = error;
      }
      if (record.error === null) {
        record.error = error instanceof Error ? error.message : String(error);
        if (record.verification.scenarioExecution === "not_run") {
          record.verification.scenarioExecution = "incomplete";
        }
      }
    }
  }

  record.phase = "collecting";
  await writeManifest(options, manifest);
  record.phase = "cleaning";
  await writeManifest(options, manifest);
  const cleanup = await cleanupScenario(
    options,
    manifest,
    record,
    paths,
    execute,
    containerMayExist,
  );
  record.cleanupErrors = cleanup.failures;
  record.verification.scenarioCleanup =
    cleanup.failures.length === 0 ? "passed" : "failed";
  record.phase =
    cleanup.failures.length === 0 &&
    !record.cancelled &&
    record.exitCode !== null
      ? "completed"
      : "incomplete";
  await writeManifest(options, manifest);
  // 引擎级失败在清理与落盘后重新抛出，轮次据此停止而不是继续下一个场景。
  if (engineFailure !== undefined) throw engineFailure;
  return record;
}

function cancelled(): PlatformError {
  return new PlatformError("unreachable", "The round was cancelled.");
}

function isCancelled(error: unknown): boolean {
  return (
    error instanceof PlatformError &&
    error.message === "The round was cancelled."
  );
}

function toBaseline(resources: InnerResources): ScenarioRecord["baseline"] {
  return {
    containers: resources.containers,
    networks: resources.networks,
    volumes: resources.volumes,
  };
}

/** 记录本次真正运行的镜像身份；标签不被当作固定摘要。 */
async function resolveInnerImage(
  execute: DockerExecutor,
  options: PlatformOptions,
  manifest: PlatformManifest,
  image: string,
): Promise<ScenarioRecord["resolvedImage"]> {
  const result = await execute(options, [
    "exec",
    manifest.names.containerName,
    "docker",
    "image",
    "inspect",
    image,
  ]);
  if (result.exitCode !== 0 || result.timedOut || result.signal !== null) {
    return { id: null, digests: [] };
  }
  const [parsed] = JSON.parse(result.stdout) as {
    Id?: unknown;
    RepoDigests?: unknown;
  }[];
  return {
    id: typeof parsed?.Id === "string" ? parsed.Id : null,
    digests: Array.isArray(parsed?.RepoDigests)
      ? parsed.RepoDigests.filter(
          (digest): digest is string => typeof digest === "string",
        )
      : [],
  };
}

async function collectScenarioLogs(
  options: PlatformOptions,
  manifest: PlatformManifest,
  request: ScenarioRequest,
  record: ScenarioRecord,
  execute: DockerExecutor,
): Promise<void> {
  for (const path of request.logPaths ?? []) {
    const target = join(record.localDirectory, "collected", path);
    try {
      await mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
      await checked(execute, options, [
        "cp",
        `${manifest.names.containerName}:${record.workspacePath}/${path}`,
        target,
      ]);
      record.collectedLogs.push({ path, status: "copied", detail: null });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      record.collectedLogs.push({
        path,
        status: /no such file|not found|Could not find/i.test(detail)
          ? "missing"
          : "failed",
        detail,
      });
    }
  }
}

async function cleanupScenario(
  options: PlatformOptions,
  manifest: PlatformManifest,
  record: ScenarioRecord,
  paths: ScenarioPaths,
  execute: DockerExecutor,
  containerMayExist: boolean,
): Promise<{ failures: string[]; facts: ReclamationFact[] }> {
  const failures: string[] = [];
  const facts: ReclamationFact[] = [];
  let clientStopFailed = false;
  try {
    const stopped = await execute(
      options,
      [
        "exec",
        manifest.names.containerName,
        "sh",
        "-c",
        STOP_CLIENT,
        "reins-test-stop-client",
        paths.clientPidPath,
        paths.cancelPath,
        paths.containerName,
      ],
      { timeoutMs: 15_000 },
    );
    clientStopFailed = containerMayExist && commandFailed(stopped);
  } catch {
    clientStopFailed = containerMayExist;
  }
  if (clientStopFailed) {
    failures.push("Could not stop the scenario's Docker client.");
  }
  // 客户端被中断时，docker run 的创建请求可能仍在内层 daemon 中飞行，容器要等本轮
  // 回收扑空之后才落地；这类场景必须复扫到落地为止，否则未回收的容器会被谎报为已清理。
  const inner = await reclaimInnerResources(
    options,
    manifest,
    record,
    paths,
    execute,
    containerMayExist &&
      (record.timedOut || record.cancelled || clientStopFailed),
  );
  failures.push(...inner.failures);
  facts.push(...inner.facts);
  try {
    await rm(paths.environmentPath, { force: true });
  } catch {
    failures.push("Could not remove the temporary environment file.");
  }
  return { failures, facts };
}

/**
 * 场景回收的收敛只由内层资源清单判定：官方 Docker CLI 29.8.2 的强制删除会把 NotFound 吞成
 * 成功返回，所以 `docker rm --force` 的退出码既不证明目标存在过，也不证明创建请求已在 daemon
 * 中提交。未被中断的执行没有飞行中的创建请求，删一遍后复核一次清单即收敛。
 *
 * 被中断的执行只有一种情况算确认收敛：这次创建的主容器按它自己声明的名字出现在清单里，随后被
 * 收回，且相对基线的清单不再有多余资源。清单里出现别的资源不算证明——三类资源是三次并行查询，
 * 组合结果不是同一 daemon 时刻的快照，更早请求留下的资源也可能出现在这里，所以任何多余资源都
 * 不能替代对主容器本身的观察。空清单同样只描述这段时间，不证明尚未出现的创建请求已经结束；
 * 窗口尽头仍看不到主容器就如实报告无法确认，由轮次停止并走外层回收，而不是把未确认当健康保留。
 */
async function reclaimInnerResources(
  options: PlatformOptions,
  manifest: PlatformManifest,
  record: ScenarioRecord,
  paths: ScenarioPaths,
  execute: DockerExecutor,
  watchLateLanding: boolean,
): Promise<{ failures: string[]; facts: ReclamationFact[] }> {
  const failures: string[] = [];
  const facts: ReclamationFact[] = [];
  const startedAt = Date.now();
  let mainLanded = false;
  let pass = 0;
  let poll = 0;
  for (;;) {
    let extra: ExtraResources;
    try {
      extra = await extraInnerResources(
        execute,
        options,
        manifest,
        record.baseline,
      );
    } catch (error) {
      failures.push(
        `Could not enumerate inner resources for scenario ${record.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      break;
    }
    const hasExtra = extraCount(extra) > 0;
    if (watchLateLanding && !mainLanded) {
      try {
        mainLanded = await mainContainerLanded(
          execute,
          options,
          manifest.names.containerName,
          paths.containerName,
        );
      } catch (error) {
        failures.push(
          `Could not confirm the scenario container ${paths.containerName}: ${error instanceof Error ? error.message : String(error)}`,
        );
        break;
      }
    }
    if (!watchLateLanding) {
      if (pass === 0) {
        if (hasExtra) {
          await removeExtraResources(
            execute,
            options,
            manifest,
            extra,
            facts,
            failures,
          );
        }
        pass = 1;
        continue;
      }
      if (hasExtra) {
        failures.push(
          `Scenario ${record.id} still has uncleaned inner resources: ${describeExtra(extra)}.`,
        );
      }
      break;
    }
    if (hasExtra) {
      await removeExtraResources(
        execute,
        options,
        manifest,
        extra,
        facts,
        failures,
      );
    } else if (mainLanded) {
      break;
    }
    if (Date.now() - startedAt >= LATE_LANDING_CAP_MS) {
      failures.push(
        hasExtra
          ? `Scenario ${record.id} still has uncleaned inner resources: ${describeExtra(extra)}.`
          : `Could not confirm that scenario ${record.id} reclaimed its inner resources: its container ${paths.containerName} was never observed in the inner listing.`,
      );
      break;
    }
    // 用全局定时器而不是 node:timers/promises，回收窗口的等待才能被可控时钟推进。
    await new Promise<void>((wake) => {
      setTimeout(
        wake,
        LATE_LANDING_STEPS_MS[
          Math.min(poll, LATE_LANDING_STEPS_MS.length - 1)
        ]!,
      );
    });
    poll += 1;
  }
  const workspace = await execute(options, [
    "exec",
    manifest.names.containerName,
    "rm",
    "-rf",
    paths.remoteDirectory,
  ]);
  if (commandFailed(workspace)) {
    failures.push(
      `Could not remove the scenario workspace ${paths.remoteDirectory}.`,
    );
  } else {
    facts.push({
      kind: "scenarioResource",
      name: paths.remoteDirectory,
      outcome: "removed",
      detail: "workspace",
    });
  }
  const seen = new Set<string>();
  return {
    failures: [...new Set(failures)],
    facts: facts.filter((fact) => {
      const key = `${fact.kind}|${fact.name}|${fact.outcome}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
}

interface ExtraResources {
  containers: string[];
  networks: string[];
  volumes: string[];
}

function extraCount(extra: ExtraResources): number {
  return extra.containers.length + extra.networks.length + extra.volumes.length;
}

/**
 * 相对场景起始集合列出仍属本轮的内层资源。被中断执行的创建请求稍后落地时同样出现在这里，
 * 所以只有清单本身能说明回收是否收敛。
 */
async function extraInnerResources(
  execute: DockerExecutor,
  options: PlatformOptions,
  manifest: PlatformManifest,
  baseline: ScenarioRecord["baseline"],
): Promise<ExtraResources> {
  const resources = await innerResources(
    execute,
    options,
    manifest.names.containerName,
  );
  return {
    containers: resources.containers.filter(
      (id) => !baseline.containers.includes(id),
    ),
    networks: resources.networks.filter(
      (id) => !baseline.networks.includes(id),
    ),
    volumes: resources.volumes.filter(
      (name) => !baseline.volumes.includes(name),
    ),
  };
}

/** 主容器与它派生的子容器、网络、卷都按清单回收；容器强制删除同时带走它的匿名卷。 */
async function removeExtraResources(
  execute: DockerExecutor,
  options: PlatformOptions,
  manifest: PlatformManifest,
  extra: ExtraResources,
  facts: ReclamationFact[],
  failures: string[],
): Promise<void> {
  for (const id of extra.containers) {
    await removeInner(
      execute,
      options,
      manifest,
      "container",
      id,
      facts,
      failures,
      ["--force", "--volumes"],
    );
  }
  for (const id of extra.networks) {
    await removeInner(
      execute,
      options,
      manifest,
      "network",
      id,
      facts,
      failures,
    );
  }
  for (const name of extra.volumes) {
    await removeInner(
      execute,
      options,
      manifest,
      "volume",
      name,
      facts,
      failures,
    );
  }
}

function describeExtra(extra: ExtraResources): string {
  return [
    ...extra.containers.map((id) => `container ${id}`),
    ...extra.networks.map((id) => `network ${id}`),
    ...extra.volumes.map((name) => `volume ${name}`),
  ].join(", ");
}

async function removeInner(
  execute: DockerExecutor,
  options: PlatformOptions,
  manifest: PlatformManifest,
  kind: "container" | "network" | "volume",
  name: string,
  facts: ReclamationFact[],
  failures: string[],
  extraArgs: readonly string[] = [],
): Promise<void> {
  const result = await execute(options, [
    "exec",
    manifest.names.containerName,
    "docker",
    kind,
    "rm",
    ...extraArgs,
    name,
  ]);
  if (!commandFailed(result)) {
    facts.push({
      kind: "scenarioResource",
      name,
      outcome: "removed",
      detail: kind,
    });
    return;
  }
  const detail = result.stderr.trim() || result.stdout.trim();
  // 主容器的 --force --volumes 会顺带删掉它的匿名卷，快照里列出的资源因此可能已经不在，
  // 归属已确认消失就是回收完成，不能按失败上报。
  if (
    /no such (?:container|network|volume)|not found|does not exist/i.test(
      detail,
    )
  ) {
    facts.push({
      kind: "scenarioResource",
      name,
      outcome: "absent",
      detail: kind,
    });
    return;
  }
  failures.push(`Could not remove scenario ${kind} ${name}: ${detail}`);
}

/** 平台失联时场景无法继续：清理边界不成立，禁止进入下一场景。 */
export function scenarioBoundaryClean(
  current: InnerResources,
  defaults: string[],
): boolean {
  return (
    current.containers.length === 0 &&
    current.networks.every((id) => defaults.includes(id)) &&
    current.volumes.length === 0
  );
}
