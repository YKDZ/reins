import { rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import { DEFAULT_BOOTSTRAP_IMAGE } from "./defaults.ts";
import { executeDocker } from "./docker.ts";
import {
  evidenceSummarySchema,
  appendReclamationRecord,
  assertEvidenceTarget,
  exportDestroyEvidence,
} from "./evidence.ts";
import type { EvidenceFileRequest, EvidenceSummary } from "./evidence.ts";
import {
  OWNER_LABEL,
  acquireStateLock,
  createManifest,
  ensureStateDirectory,
  manifestSchema,
  plannedNames,
  platformPhaseSchema,
  readManifest,
  readStateLock,
  releaseStateLock,
  scenarioPhaseSchema,
  validateImageReference,
  writeManifest,
} from "./manifest.ts";
import type { PlatformManifest } from "./manifest.ts";
import { PlatformError, reclamationFactSchema } from "./types.ts";
import type {
  CommandResult,
  DockerExecutor,
  PlatformOptions,
  ReclamationFact,
  ResourceKind,
} from "./types.ts";

export { OWNER_LABEL, plannedNames };
export type { EvidenceSummary, ReclamationFact, ResourceKind };

// 内层 daemon 在慢文件系统上要等数分钟才完成存储初始化，等待预算与单条命令超时分开。
export const DEFAULT_READY_TIMEOUT_MS = 600_000;

export interface DockerInspection {
  id: string;
  labels: Record<string, string>;
  running: boolean;
}

export interface InnerResources {
  containers: string[];
  networks: string[];
  volumes: string[];
}

export interface OuterObservation {
  outer: "absent" | "running" | "stopped" | "unreachable";
  inner: "ready" | "unreachable" | "absent";
  engineId: string | null;
  containerId: string | null;
  detail: string | null;
}

export const platformStatusSchema = z.strictObject({
  phase: z.union([platformPhaseSchema, z.literal("absent")]),
  manifest: manifestSchema.nullable(),
  outer: z.enum(["absent", "running", "stopped", "unreachable"]),
  inner: z.enum(["ready", "unreachable", "absent"]),
  engineIdentityMatches: z.boolean().nullable(),
  busy: z
    .strictObject({ pid: z.number().int(), purpose: z.string() })
    .nullable(),
  unfinishedScenarios: z.array(
    z.strictObject({ id: z.string(), phase: scenarioPhaseSchema }),
  ),
  failures: z.array(z.string()),
  detail: z.string().nullable(),
});
export type PlatformStatus = z.infer<typeof platformStatusSchema>;

export const destroyResultSchema = z.strictObject({
  disposition: z.enum(["destroyed", "absent", "recovery_required"]),
  platformId: z.string().nullable(),
  facts: z.array(reclamationFactSchema),
  failures: z.array(z.string()),
  evidence: evidenceSummarySchema,
});
export type DestroyResult = z.infer<typeof destroyResultSchema>;

export interface LifecycleDependencies {
  execute?: DockerExecutor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripPrefix(value: string): string {
  return value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
}

export function commandFailure(
  args: readonly string[],
  result: CommandResult,
): PlatformError {
  const detail = result.stderr.trim() || result.stdout.trim();
  const outcome = result.timedOut
    ? "timed out"
    : `failed (${result.exitCode ?? result.signal})`;
  return new PlatformError(
    "unreachable",
    `Docker ${args.join(" ")} ${outcome}${detail ? `: ${detail}` : "."}`,
  );
}

export async function checked(
  execute: DockerExecutor,
  options: PlatformOptions,
  args: readonly string[],
  commandOptions: Parameters<DockerExecutor>[2] = {},
): Promise<CommandResult> {
  const result = await execute(options, args, commandOptions);
  if (result.exitCode !== 0 || result.timedOut || result.signal !== null) {
    throw commandFailure(args, result);
  }
  return result;
}

function isNotFoundError(result: CommandResult): boolean {
  return (
    result.exitCode === 1 &&
    !result.timedOut &&
    result.signal === null &&
    /no such (?:container|image|network|volume|object)\b|(?:network|volume) [^\n]+ not found/i.test(
      result.stderr,
    )
  );
}

export async function inspect(
  execute: DockerExecutor,
  options: PlatformOptions,
  kind: ResourceKind | "image",
  name: string,
): Promise<DockerInspection | null> {
  const args = [kind, "inspect", "--format", "{{json .}}", name];
  const result = await execute(options, args);
  if (result.exitCode === 0 && !result.timedOut && result.signal === null) {
    const data: unknown = JSON.parse(result.stdout);
    if (!isRecord(data)) {
      throw new PlatformError(
        "unreachable",
        `Invalid Docker inspection output for ${kind} ${name}.`,
      );
    }
    // 卷没有 Id 字段，其名称即唯一身份；容器与镜像的 Id 带算法前缀，统一剥离。
    const identity =
      typeof data.Id === "string"
        ? stripPrefix(data.Id)
        : typeof data.Name === "string"
          ? data.Name
          : null;
    if (identity === null) {
      throw new PlatformError(
        "unreachable",
        `Docker inspection for ${kind} ${name} has no identity.`,
      );
    }
    const labels =
      kind === "container" && isRecord(data.Config)
        ? data.Config.Labels
        : data.Labels;
    return {
      id: identity,
      labels:
        isRecord(labels) && typeof labels[OWNER_LABEL] === "string"
          ? { [OWNER_LABEL]: labels[OWNER_LABEL] }
          : {},
      running: isRecord(data.State) && data.State.Running === true,
    };
  }
  if (isNotFoundError(result)) return null;
  throw commandFailure(args, result);
}

export function checkOwnership(
  manifest: PlatformManifest,
  kind: ResourceKind | "image",
  name: string,
  inspection: DockerInspection,
): void {
  if (inspection.labels[OWNER_LABEL] !== manifest.id) {
    throw new PlatformError(
      "ownershipConflict",
      `Refusing to access ${kind} ${name}: platform ownership label does not match.`,
    );
  }
}

/** 引擎身份来自 daemon 自身的 ID；连接换到别的引擎时不得把缺失当作销毁成功。 */
export async function engineIdentity(
  execute: DockerExecutor,
  options: PlatformOptions,
  inContainer?: string,
): Promise<string | null> {
  const args =
    inContainer === undefined
      ? ["info", "--format", "{{json .ID}}"]
      : ["exec", inContainer, "docker", "info", "--format", "{{json .ID}}"];
  const result = await execute(options, args, { timeoutMs: 30_000 });
  if (result.exitCode !== 0 || result.timedOut || result.signal !== null) {
    return null;
  }
  const parsed = z.string().safeParse(JSON.parse(result.stdout) as unknown);
  return parsed.success ? parsed.data : null;
}

async function innerServerVersion(
  execute: DockerExecutor,
  options: PlatformOptions,
  containerName: string,
): Promise<string | null> {
  const result = await execute(
    options,
    [
      "exec",
      containerName,
      "docker",
      "info",
      "--format",
      "{{json .ServerVersion}}",
    ],
    { timeoutMs: 30_000 },
  );
  if (result.exitCode !== 0 || result.timedOut || result.signal !== null) {
    return null;
  }
  const parsed = z.string().safeParse(JSON.parse(result.stdout) as unknown);
  return parsed.success ? parsed.data : null;
}

async function dockerCliVersion(
  execute: DockerExecutor,
  options: PlatformOptions,
): Promise<string | null> {
  const result = await execute(options, ["--version"], { timeoutMs: 15_000 });
  if (result.exitCode !== 0 || result.timedOut || result.signal !== null) {
    return null;
  }
  return result.stdout.trim() || null;
}

/** 内层引擎的全部资源；场景起始集合与清理后的复核查询都用它。 */
export async function innerResources(
  execute: DockerExecutor,
  options: PlatformOptions,
  containerName: string,
): Promise<InnerResources> {
  const list = async (args: readonly string[]): Promise<string[]> => {
    const result = await checked(execute, options, [
      "exec",
      containerName,
      "docker",
      ...args,
    ]);
    return [
      ...new Set(
        result.stdout
          .split("\n")
          .map((line) => stripPrefix(line.trim()))
          .filter((line) => line !== ""),
      ),
    ].sort();
  };
  const [containers, networks, volumes] = await Promise.all([
    list(["ps", "--all", "--quiet", "--no-trunc"]),
    list(["network", "ls", "--quiet", "--no-trunc"]),
    list(["volume", "ls", "--quiet"]),
  ]);
  return { containers, networks, volumes };
}

/**
 * 场景主容器是否已经出现在内层清单里。被中断执行的收敛只能按它自己声明的名字判定：清单里的
 * 其它资源可能来自更早的请求，它们的存在不是这次创建已经提交的证明。
 */
export async function mainContainerLanded(
  execute: DockerExecutor,
  options: PlatformOptions,
  engineName: string,
  containerName: string,
): Promise<boolean> {
  const result = await checked(execute, options, [
    "exec",
    engineName,
    "docker",
    "ps",
    "--all",
    "--format",
    "{{.Names}}",
  ]);
  return result.stdout
    .split("\n")
    .some((line) => line.trim() === containerName);
}

function labelArguments(manifest: PlatformManifest): string[] {
  return Object.entries(manifest.labels).flatMap(([key, value]) => [
    "--label",
    `${key}=${value}`,
  ]);
}

async function ensureOuterResource(
  execute: DockerExecutor,
  options: PlatformOptions,
  manifest: PlatformManifest,
  kind: ResourceKind,
  name: string,
  field: "container" | "network" | "dataVolume" | "workspaceVolume",
  create: () => Promise<void>,
): Promise<boolean> {
  const existing = await inspect(execute, options, kind, name);
  if (existing !== null) {
    // 名称已存在时只有归属一致才可继续，否则保留外来对象与清单。
    checkOwnership(manifest, kind, name, existing);
    const changed = manifest.ids[field] !== existing.id;
    manifest.ids[field] = existing.id;
    if (changed) await writeManifest(options, manifest);
    return false;
  }
  await create();
  const created = await inspect(execute, options, kind, name);
  if (created === null) {
    throw new PlatformError(
      "unreachable",
      `Docker reported success for ${kind} ${name} but the resource is missing.`,
    );
  }
  checkOwnership(manifest, kind, name, created);
  manifest.ids[field] = created.id;
  await writeManifest(options, manifest);
  return true;
}

/**
 * 内部准备步骤：清单已先行发布，这里只做归属检查、引导与就绪等待。
 * 不对外提供公开 up；中断后由 status / destroy 依据清单判断，绝不从未知创建点继续业务。
 */
export async function preparePlatform(
  options: PlatformOptions,
  evidenceDirectory: string,
  dependencies: LifecycleDependencies = {},
): Promise<PlatformManifest> {
  const execute = dependencies.execute ?? executeDocker;
  validateImageReference(options.bootstrapImage);
  const engineId = await engineIdentity(execute, options);
  if (engineId === null) {
    throw new PlatformError(
      "unreachable",
      "The host Docker engine is not reachable, so the test platform cannot be prepared.",
    );
  }
  const manifest = createManifest(options, evidenceDirectory);
  manifest.outerEngineId = engineId;
  manifest.toolchain.dockerCli = await dockerCliVersion(execute, options);
  await ensureStateDirectory(options);
  await writeManifest(options, manifest);
  try {
    await acquireBootstrapResources(execute, options, manifest);
    await awaitInnerReadiness(
      execute,
      options,
      manifest,
      options.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    );
  } catch (error) {
    manifest.reclamation.failures.push(
      error instanceof Error ? error.message : String(error),
    );
    manifest.phase = "recovery_required";
    await writeManifest(options, manifest);
    throw error;
  }
  return manifest;
}

async function acquireBootstrapResources(
  execute: DockerExecutor,
  options: PlatformOptions,
  manifest: PlatformManifest,
): Promise<void> {
  const volumes: [string, "dataVolume" | "workspaceVolume"][] = [
    [manifest.names.dataVolumeName, "dataVolume"],
    [manifest.names.workspaceVolumeName, "workspaceVolume"],
  ];
  for (const [name, field] of volumes) {
    await ensureOuterResource(
      execute,
      options,
      manifest,
      "volume",
      name,
      field,
      () =>
        checked(execute, options, [
          "volume",
          "create",
          ...labelArguments(manifest),
          name,
        ]).then(() => undefined),
    );
  }
  await ensureOuterResource(
    execute,
    options,
    manifest,
    "network",
    manifest.names.networkName,
    "network",
    () =>
      checked(execute, options, [
        "network",
        "create",
        ...labelArguments(manifest),
        manifest.names.networkName,
      ]).then(() => undefined),
  );
  await ensureOuterResource(
    execute,
    options,
    manifest,
    "container",
    manifest.names.containerName,
    "container",
    async () => {
      await acquireBootstrapImage(execute, options, manifest);
      await checked(execute, options, [
        "run",
        "--detach",
        "--privileged",
        "--name",
        manifest.names.containerName,
        ...labelArguments(manifest),
        "--network",
        manifest.names.networkName,
        "--mount",
        `type=volume,source=${manifest.names.dataVolumeName},target=/var/lib/docker`,
        "--mount",
        `type=volume,source=${manifest.names.workspaceVolumeName},target=/platform`,
        manifest.bootstrapImage,
        "dockerd",
        "--host=unix:///var/run/docker.sock",
        "--feature=containerd-snapshotter=false",
      ]);
    },
  );
}

async function acquireBootstrapImage(
  execute: DockerExecutor,
  options: PlatformOptions,
  manifest: PlatformManifest,
): Promise<void> {
  if (manifest.imageAcquisition.existedBefore === null) {
    // 写前存在性记录必须先于任何 pull，之后才能声称拥有该摘要的清理权。
    const existing = await inspect(
      execute,
      options,
      "image",
      manifest.bootstrapImage,
    );
    manifest.imageAcquisition.existedBefore = existing !== null;
    manifest.imageAcquisition.acquiredId = existing?.id ?? null;
    await writeManifest(options, manifest);
  }
  if (manifest.imageAcquisition.existedBefore) return;
  if (
    (await inspect(execute, options, "image", manifest.bootstrapImage)) === null
  ) {
    await checked(execute, options, ["image", "pull", manifest.bootstrapImage]);
  }
  const acquired = await inspect(
    execute,
    options,
    "image",
    manifest.bootstrapImage,
  );
  manifest.imageAcquisition.acquiredId = acquired?.id ?? null;
  await writeManifest(options, manifest);
}

/** 就绪等待同时刷新内层身份，供复用的健康与归属检查使用。 */
export async function awaitInnerReadiness(
  execute: DockerExecutor,
  options: PlatformOptions,
  manifest: PlatformManifest,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const id = await engineIdentity(
      execute,
      options,
      manifest.names.containerName,
    );
    if (id !== null) {
      const version = await innerServerVersion(
        execute,
        options,
        manifest.names.containerName,
      );
      if (
        manifest.innerEngineId !== id ||
        manifest.innerServerVersion !== version ||
        manifest.phase !== "running"
      ) {
        manifest.innerEngineId = id;
        manifest.innerServerVersion = version;
        if (manifest.phase === "preparing") {
          manifest.innerDefaults = {
            networks: (
              await innerResources(
                execute,
                options,
                manifest.names.containerName,
              )
            ).networks,
          };
        }
        manifest.phase = "running";
        await writeManifest(options, manifest);
      }
      return id;
    }
    if (Date.now() >= deadline) {
      throw new PlatformError(
        "unreachable",
        `The inner Docker engine in ${manifest.names.containerName} did not become ready within ${timeoutMs} ms.`,
      );
    }
    await delay(Math.min(500, Math.max(1, deadline - Date.now())));
  }
}

export async function observePlatform(
  execute: DockerExecutor,
  options: PlatformOptions,
  manifest: PlatformManifest,
): Promise<OuterObservation> {
  const engineId = await engineIdentity(execute, options);
  if (engineId === null) {
    return {
      outer: "unreachable",
      inner: "unreachable",
      engineId: null,
      containerId: null,
      detail: "The host Docker engine is not reachable.",
    };
  }
  if (manifest.outerEngineId !== null && manifest.outerEngineId !== engineId) {
    return {
      outer: "unreachable",
      inner: "unreachable",
      engineId,
      containerId: null,
      detail: `Connected engine ${engineId} differs from the recorded platform engine ${manifest.outerEngineId}.`,
    };
  }
  let container: DockerInspection | null;
  try {
    container = await inspect(
      execute,
      options,
      "container",
      manifest.names.containerName,
    );
  } catch (error) {
    return {
      outer: "unreachable",
      inner: "unreachable",
      engineId,
      containerId: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (container === null) {
    return {
      outer: "absent",
      inner: "absent",
      engineId,
      containerId: null,
      detail: null,
    };
  }
  if (container.labels[OWNER_LABEL] !== manifest.id) {
    return {
      outer: "unreachable",
      inner: "unreachable",
      engineId,
      containerId: container.id,
      detail: `Planned container name ${manifest.names.containerName} belongs to ${container.labels[OWNER_LABEL] ?? "a resource without the platform label"}.`,
    };
  }
  if (!container.running) {
    return {
      outer: "stopped",
      inner: "absent",
      engineId,
      containerId: container.id,
      detail: null,
    };
  }
  const innerId = await engineIdentity(
    execute,
    options,
    manifest.names.containerName,
  );
  const matches = innerId !== null && innerId === manifest.innerEngineId;
  return {
    outer: "running",
    inner: innerId === null ? "unreachable" : matches ? "ready" : "unreachable",
    engineId,
    containerId: container.id,
    detail:
      innerId === null
        ? "The inner Docker engine is not reachable through the platform container."
        : !matches
          ? `Inner engine ${innerId} differs from the recorded identity ${manifest.innerEngineId}.`
          : null,
  };
}

export async function statusPlatform(
  options: PlatformOptions,
  dependencies: LifecycleDependencies = {},
): Promise<PlatformStatus> {
  const execute = dependencies.execute ?? executeDocker;
  const manifest = await readManifest(options);
  const lock = await readStateLock(options).catch(() => null);
  const busy = lock === null ? null : { pid: lock.pid, purpose: lock.purpose };
  if (manifest === null) {
    return {
      phase: "absent",
      manifest: null,
      outer:
        (await engineIdentity(execute, options)) === null
          ? "unreachable"
          : "absent",
      inner: "absent",
      engineIdentityMatches: null,
      busy,
      unfinishedScenarios: [],
      failures: [],
      detail: null,
    };
  }
  const observation = await observePlatform(execute, options, manifest);
  return {
    phase: manifest.phase,
    manifest,
    outer: observation.outer,
    inner: observation.inner,
    engineIdentityMatches:
      manifest.outerEngineId === null || observation.engineId === null
        ? null
        : manifest.outerEngineId === observation.engineId,
    busy,
    unfinishedScenarios:
      manifest.round === null
        ? []
        : manifest.round.scenarios
            .filter(
              (scenario) =>
                scenario.phase !== "completed" && scenario.phase !== "not_run",
            )
            .map((scenario) => ({ id: scenario.id, phase: scenario.phase })),
    failures: [
      ...new Set([
        ...manifest.reclamation.failures,
        ...manifest.evidence.failures,
        ...(observation.detail === null ? [] : [observation.detail]),
      ]),
    ],
    detail: observation.detail,
  };
}

export interface DestroyOptions {
  evidenceDirectory?: string;
  evidenceFiles?: readonly EvidenceFileRequest[];
  execute?: DockerExecutor;
}

/** 主动销毁与失败恢复入口；与 runRound 的默认销毁共用同一个收尾实现。 */
export async function destroyPlatform(
  options: PlatformOptions,
  destroyOptions: DestroyOptions = {},
): Promise<DestroyResult> {
  const execute = destroyOptions.execute ?? executeDocker;
  const manifest = await readManifest(options);
  if (manifest === null) {
    return {
      disposition: "absent",
      platformId: null,
      facts: [],
      failures: [],
      evidence: { directory: null, exported: false, files: [], failures: [] },
    };
  }
  const lock = await acquireStateLock(options, "destroy");
  try {
    // 取得修改权后重新读取，避免与并发轮次的清单写入交错。
    const current = await readManifest(options);
    if (current === null) {
      return {
        disposition: "absent",
        platformId: null,
        facts: [],
        failures: [],
        evidence: { directory: null, exported: false, files: [], failures: [] },
      };
    }
    if (
      destroyOptions.evidenceDirectory !== undefined &&
      destroyOptions.evidenceDirectory !== current.evidence.directory
    ) {
      await assertEvidenceTarget(
        destroyOptions.evidenceDirectory,
        options.stateDirectory,
      );
      // 修复后的外部目标不覆盖旧目标已有事实，只重新开启导出。
      current.evidence.directory = destroyOptions.evidenceDirectory;
      current.evidence.exported = false;
    }
    return await finalizePlatformDestruction(
      options,
      current,
      execute,
      destroyOptions.evidenceFiles ?? [],
    );
  } finally {
    await releaseStateLock(options, lock).catch(() => undefined);
  }
}

/**
 * 留证、外层回收、追加回收事实、删除本地记录。调用方必须已持有状态目录修改权。
 * 任一步失败都保留原始错误与恢复清单，成功回收不改写已导出的唯一证据。
 */
export async function finalizePlatformDestruction(
  options: PlatformOptions,
  manifest: PlatformManifest,
  execute: DockerExecutor,
  evidenceFiles: readonly EvidenceFileRequest[] = [],
): Promise<DestroyResult> {
  manifest.phase = "destroying";
  await writeManifest(options, manifest);
  const evidence = await exportDestroyEvidence(
    options,
    manifest,
    execute,
    evidenceFiles,
  );
  const reclaim = await reclaimPlatform(execute, options, manifest);
  manifest.reclamation.attemptedAt = new Date().toISOString();
  manifest.reclamation.failures = [
    ...new Set([...manifest.reclamation.failures, ...reclaim.failures]),
  ];
  manifest.evidence.failures = [
    ...new Set([...manifest.evidence.failures, ...evidence.failures]),
  ];
  manifest.evidence.exported = evidence.exported;
  const appendFailure = await appendReclamationRecord(
    manifest.evidence.directory,
    manifest,
    {
      attemptedAt: manifest.reclamation.attemptedAt,
      disposition: reclaim.failures.length === 0 ? "reclaimed" : "incomplete",
      facts: reclaim.facts,
      failures: reclaim.failures,
    },
  );
  const failures = [
    ...reclaim.failures,
    ...evidence.failures,
    ...(appendFailure === null ? [] : [appendFailure]),
  ];
  if (failures.length > 0) {
    manifest.phase = "recovery_required";
    await writeManifest(options, manifest);
    return {
      disposition: "recovery_required",
      platformId: manifest.id,
      facts: reclaim.facts,
      failures,
      evidence,
    };
  }
  try {
    await rm(options.stateDirectory, { recursive: true, force: true });
  } catch (error) {
    // Docker 资源已全部消失但本地删除失败时，保留清单只完成剩余步骤。
    const detail = `Could not remove the platform state directory ${options.stateDirectory}: ${error instanceof Error ? error.message : String(error)}`;
    manifest.phase = "recovery_required";
    manifest.reclamation.failures = [
      ...new Set([...manifest.reclamation.failures, detail]),
    ];
    await writeManifest(options, manifest);
    return {
      disposition: "recovery_required",
      platformId: manifest.id,
      facts: [
        ...reclaim.facts,
        {
          kind: "stateDirectory",
          name: options.stateDirectory,
          outcome: "failed",
          detail,
        },
      ],
      failures: [detail],
      evidence,
    };
  }
  return {
    disposition: "destroyed",
    platformId: manifest.id,
    facts: reclaim.facts,
    failures: [],
    evidence,
  };
}

/** 外层回收：只按清单记录的归属与身份变更，内层失联不影响这些步骤。 */
export async function reclaimPlatform(
  execute: DockerExecutor,
  options: PlatformOptions,
  manifest: PlatformManifest,
): Promise<{ facts: ReclamationFact[]; failures: string[] }> {
  const facts: ReclamationFact[] = [];
  const failures: string[] = [];
  const engineId = await engineIdentity(execute, options);
  if (
    engineId === null ||
    (manifest.outerEngineId !== null && engineId !== manifest.outerEngineId)
  ) {
    failures.push(
      `Refusing reclamation: connected engine ${engineId ?? "unreachable"} differs from recorded engine ${manifest.outerEngineId}.`,
    );
    return { facts, failures };
  }
  const targets: [
    ResourceKind,
    string,
    "container" | "network" | "dataVolume" | "workspaceVolume",
  ][] = [
    ["container", manifest.names.containerName, "container"],
    ["network", manifest.names.networkName, "network"],
    ["volume", manifest.names.dataVolumeName, "dataVolume"],
    ["volume", manifest.names.workspaceVolumeName, "workspaceVolume"],
  ];
  for (const [kind, name, field] of targets) {
    try {
      const existing = await inspect(execute, options, kind, name);
      if (existing === null) {
        facts.push({ kind, name, outcome: "absent", detail: null });
        continue;
      }
      checkOwnership(manifest, kind, name, existing);
      if (manifest.ids[field] !== null && manifest.ids[field] !== existing.id) {
        throw new PlatformError(
          "ownershipConflict",
          `Refusing to remove ${kind} ${name}: recorded id ${manifest.ids[field]} differs from inspected ${existing.id}.`,
        );
      }
      await checked(execute, options, [
        kind,
        "rm",
        ...(kind === "container" ? ["--force", "--volumes"] : []),
        name,
      ]);
      facts.push({ kind, name, outcome: "removed", detail: existing.id });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      facts.push({ kind, name, outcome: "failed", detail });
      failures.push(detail);
    }
  }
  const image = await reclaimBootstrapImage(execute, options, manifest);
  facts.push(image.fact);
  failures.push(...image.failures);
  return { facts, failures };
}

async function reclaimBootstrapImage(
  execute: DockerExecutor,
  options: PlatformOptions,
  manifest: PlatformManifest,
): Promise<{ fact: ReclamationFact; failures: string[] }> {
  const name = manifest.bootstrapImage;
  const failures: string[] = [];
  if (manifest.imageAcquisition.existedBefore !== false) {
    // 已有镜像或尚未取得清理权时都不接管，也不做宿主级清理。
    return {
      fact: {
        kind: "image",
        name,
        outcome: "skipped",
        detail:
          manifest.imageAcquisition.existedBefore === null
            ? "No pre-pull existence record, so the platform holds no removal rights."
            : "Image existed before this platform was created.",
      },
      failures,
    };
  }
  try {
    const present = await inspect(execute, options, "image", name);
    const residualId = manifest.imageAcquisition.acquiredId ?? present?.id;
    if (present === null && residualId === undefined) {
      return {
        fact: { kind: "image", name, outcome: "absent", detail: null },
        failures,
      };
    }
    if (present !== null)
      await checked(execute, options, ["image", "rm", name]);
    const residual =
      residualId === undefined
        ? null
        : await inspect(execute, options, "image", residualId);
    if (residual !== null) {
      failures.push(
        `Bootstrap image reference removed but new content ${residualId} is still held by other references.`,
      );
      return {
        fact: {
          kind: "image",
          name,
          outcome: "failed",
          detail: residualId ?? null,
        },
        failures,
      };
    }
    return {
      fact: {
        kind: "image",
        name,
        outcome: present === null ? "absent" : "removed",
        detail: present?.id ?? null,
      },
      failures,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    failures.push(detail);
    return {
      fact: { kind: "image", name, outcome: "failed", detail },
      failures,
    };
  }
}

export function platformOptions(input: {
  stateDirectory: string;
  bootstrapImage?: string;
  dockerBinary?: string;
  timeoutMs?: number;
}): PlatformOptions {
  const bootstrapImage = input.bootstrapImage ?? DEFAULT_BOOTSTRAP_IMAGE;
  validateImageReference(bootstrapImage);
  return {
    stateDirectory: input.stateDirectory,
    bootstrapImage,
    ...(input.dockerBinary === undefined
      ? {}
      : { dockerBinary: input.dockerBinary }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  };
}

export function scenarioLocalDirectory(
  options: PlatformOptions,
  scenarioId: string,
): string {
  return join(options.stateDirectory, "runs", scenarioId);
}
