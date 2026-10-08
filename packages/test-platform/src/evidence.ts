import {
  cp,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import { OWNER_LABEL } from "./manifest.ts";
import type { PlatformManifest } from "./manifest.ts";
import { PlatformError } from "./types.ts";
import type { PlatformOptions, ReclamationFact } from "./types.ts";
import type { DockerExecutor } from "./types.ts";

export const evidenceFileFactSchema = z.strictObject({
  label: z.string(),
  path: z.string(),
  status: z.enum(["copied", "kept", "missing", "failed"]),
  detail: z.string().nullable(),
});
export type EvidenceFileFact = z.infer<typeof evidenceFileFactSchema>;

export const evidenceSummarySchema = z.strictObject({
  directory: z.string().nullable(),
  exported: z.boolean(),
  files: z.array(evidenceFileFactSchema),
  failures: z.array(z.string()),
});
export type EvidenceSummary = z.infer<typeof evidenceSummarySchema>;

export interface EvidenceFileRequest {
  label: string;
  source: string;
}

function isNotCreated(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * 证据目标必须落在状态目录之外。用最近已存在祖先的真实路径判断包含关系，
 * 避免符号链接或 `..` 使字符串前缀检查失效。
 */
export async function assertEvidenceTarget(
  evidenceDirectory: string,
  stateDirectory: string,
): Promise<void> {
  const evidence = await realNearest(evidenceDirectory);
  const state = await realNearest(stateDirectory);
  if (contains(state, evidence) || contains(evidence, state)) {
    throw new PlatformError(
      "targetUnusable",
      "The evidence directory must not contain or overlap the platform state directory.",
      [`Resolved paths: evidence ${evidence}, state ${state}.`],
    );
  }
}

function contains(outer: string, inner: string): boolean {
  return inner === outer || inner.startsWith(`${outer}${sep}`);
}

async function realNearest(path: string): Promise<string> {
  const target = resolve(path);
  const missing: string[] = [];
  let cursor = target;
  for (;;) {
    try {
      const base = await realpath(cursor);
      return missing.length === 0 ? base : join(base, ...missing);
    } catch (error) {
      if (!isNotCreated(error)) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return target;
      missing.unshift(relative(parent, cursor));
      cursor = parent;
    }
  }
}

export function roundDirectory(
  evidenceDirectory: string,
  manifest: PlatformManifest,
): string {
  return join(
    evidenceDirectory,
    "rounds",
    manifest.round?.id ?? `platform-${manifest.id}`,
  );
}

async function writeJsonAtomically(
  target: string,
  value: unknown,
): Promise<void> {
  const temporary = `${target}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
  try {
    const directory = await open(dirname(target), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    // 少数文件系统不支持目录刷新，rename 本身就是原子提交点。
  }
}

async function appendJsonLine(target: string, value: unknown): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const handle = await open(target, "a", 0o600);
  try {
    await handle.write(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNotCreated(error)) return false;
    throw error;
  }
}

async function copyRecord(
  source: string,
  target: string,
  label: string,
): Promise<EvidenceFileFact> {
  try {
    const info = await stat(source);
    if (!info.isDirectory() && !info.isFile()) {
      return {
        label,
        path: target,
        status: "failed",
        detail: `${source} is neither a file nor a directory.`,
      };
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await cp(source, target, { recursive: true, force: true });
    return { label, path: target, status: "copied", detail: null };
  } catch (error) {
    if (isNotCreated(error)) {
      return {
        label,
        path: target,
        status: "missing",
        detail: `Recorded as missing: ${source} does not exist.`,
      };
    }
    return {
      label,
      path: target,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 目标必须可写且能容纳最小外部记录，资源创建前先失败。 */
export async function prepareEvidenceTarget(
  evidenceDirectory: string,
  manifest: PlatformManifest,
): Promise<void> {
  const directory = roundDirectory(evidenceDirectory, manifest);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeJsonAtomically(join(directory, "intent.json"), {
    platformId: manifest.id,
    ownerLabel: OWNER_LABEL,
    roundId: manifest.round?.id ?? null,
    recordedAt: new Date().toISOString(),
  });
}

/**
 * 销毁前导出：候选身份、逐项已有结果、完整日志与待回收资源身份。
 * 同一轮次重入保留首次导出的唯一证据，只追加新的观察记录。
 */
export async function exportDestroyEvidence(
  options: PlatformOptions,
  manifest: PlatformManifest,
  execute: DockerExecutor,
  additionalFiles: readonly EvidenceFileRequest[] = [],
): Promise<EvidenceSummary> {
  const directory = manifest.evidence.directory;
  if (directory === null) {
    return {
      directory: null,
      exported: false,
      files: [],
      failures: [
        "No external evidence directory is recorded, so platform records would be removed without export.",
      ],
    };
  }
  const target = roundDirectory(directory, manifest);
  const files: EvidenceFileFact[] = [];
  const failures: string[] = [];
  try {
    await mkdir(target, { recursive: true, mode: 0o700 });
  } catch (error) {
    return {
      directory,
      exported: false,
      files: [],
      failures: [
        `Could not prepare the evidence directory ${target}: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  files.push(
    ...(await collectInnerDaemonLog(
      options,
      manifest,
      execute,
      target,
      failures,
    )),
  );

  const roundDocument = {
    kind: "test-platform-evidence",
    recordedAt: new Date().toISOString(),
    platform: {
      id: manifest.id,
      phase: manifest.phase,
      bootstrapImage: manifest.bootstrapImage,
      imageAcquisition: manifest.imageAcquisition,
      outerEngineId: manifest.outerEngineId,
      innerEngineId: manifest.innerEngineId,
      innerServerVersion: manifest.innerServerVersion,
      toolchain: manifest.toolchain,
    },
    round: manifest.round,
    pendingReclamation: {
      names: manifest.names,
      ids: manifest.ids,
      innerDefaults: manifest.innerDefaults,
    },
  };
  const roundPath = join(target, "round.json");
  if (await exists(roundPath)) {
    files.push({
      label: "round-facts",
      path: roundPath,
      status: "kept",
      detail: "An earlier export for this round is preserved.",
    });
    try {
      await appendJsonLine(join(target, "export.jsonl"), roundDocument);
    } catch (error) {
      failures.push(
        `Could not append repeated round facts: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    try {
      await writeJsonAtomically(roundPath, roundDocument);
      files.push({
        label: "round-facts",
        path: roundPath,
        status: "copied",
        detail: null,
      });
    } catch (error) {
      failures.push(
        `Could not export round facts to ${roundPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  for (const scenario of manifest.round?.scenarios ?? []) {
    for (const log of scenario.collectedLogs) {
      if (log.status !== "copied") {
        failures.push(
          `Could not collect scenario ${scenario.id} log ${log.path} (${log.status}): ${log.detail}`,
        );
      }
    }
    const destination = join(target, "scenarios", scenario.id);
    const preparation = await readdir(scenario.localDirectory).catch(
      (error: unknown) => {
        if (!isNotCreated(error))
          failures.push(
            `Could not list scenario diagnostics: ${error instanceof Error ? error.message : String(error)}`,
          );
        return [];
      },
    );
    for (const [label, source] of [
      ["stdout.log", join(scenario.localDirectory, "stdout.log")],
      ["stderr.log", join(scenario.localDirectory, "stderr.log")],
      ["collected", join(scenario.localDirectory, "collected")],
      ...preparation
        .filter((name) => /^preparation-\d+$/.test(name))
        .map((name) => [name, join(scenario.localDirectory, name)] as const),
    ] as const) {
      const fact = await copyRecord(
        source,
        join(destination, label),
        `scenario-${scenario.id}-${label}`,
      );
      files.push(fact);
      if (fact.status === "failed") {
        failures.push(
          `Could not export ${label} for scenario ${scenario.id}: ${fact.detail}`,
        );
      }
    }
  }
  for (const request of additionalFiles) {
    const fact = await copyRecord(
      request.source,
      join(target, "caller", request.label),
      request.label,
    );
    files.push(fact);
    if (fact.status === "failed") {
      failures.push(
        `Could not export caller file ${request.label}: ${fact.detail}`,
      );
    }
  }

  return {
    directory,
    exported: failures.length === 0,
    files,
    failures,
  };
}

async function collectInnerDaemonLog(
  options: PlatformOptions,
  manifest: PlatformManifest,
  execute: DockerExecutor,
  target: string,
  failures: string[],
): Promise<EvidenceFileFact[]> {
  const local = join(options.stateDirectory, "dockerd");
  const args = ["logs", manifest.names.containerName];
  const names = ["stdout.log", "stderr.log"] as const;
  const absent = await containerAbsent(
    execute,
    options,
    manifest.names.containerName,
  );
  // 容器已删除时仍导出上次留在本地的日志，避免重试丢失唯一副本。
  if (!absent) {
    try {
      const result = await execute(options, args, {
        outputDirectory: local,
        timeoutMs: options.timeoutMs ?? 60_000,
      });
      if (result.exitCode !== 0 || result.timedOut || result.signal !== null) {
        failures.push(
          `Could not export the inner dockerd log: Docker ${args.join(" ")} failed (${result.exitCode ?? result.signal}).`,
        );
        return [];
      }
    } catch (error) {
      failures.push(
        `Could not export the inner dockerd log: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }
  const facts: EvidenceFileFact[] = [];
  for (const name of names) {
    const fact = await copyRecord(
      join(local, name),
      join(target, `dockerd-${name}`),
      `inner-dockerd-${name}`,
    );
    facts.push(fact);
    if (fact.status === "failed" || (fact.status === "missing" && !absent)) {
      failures.push(
        `Could not export the inner dockerd ${name}: ${fact.detail}`,
      );
    }
  }
  return facts;
}

/** Docker 对缺失容器的检查失败是确定结论，其他失败（例如引擎不可达）留给后续命令如实报错。 */
async function containerAbsent(
  execute: DockerExecutor,
  options: PlatformOptions,
  containerName: string,
): Promise<boolean> {
  const probe = await execute(options, [
    "container",
    "inspect",
    "--format",
    "{{.Id}}",
    containerName,
  ]);
  return (
    probe.exitCode !== 0 &&
    /no such (container|object)/i.test(`${probe.stderr}${probe.stdout}`)
  );
}

export interface ReclamationRecord {
  attemptedAt: string;
  disposition: "reclaimed" | "retained" | "incomplete";
  facts: ReclamationFact[];
  failures: string[];
}

/** 回收事实只在留证之后追加；追加失败单列为留证错误，不掩盖已完成的回收。 */
export async function appendReclamationRecord(
  directory: string | null,
  manifest: PlatformManifest,
  record: ReclamationRecord,
): Promise<string | null> {
  if (directory === null) {
    return "No external evidence directory, so reclamation facts could not be recorded.";
  }
  try {
    await appendJsonLine(
      join(roundDirectory(directory, manifest), "reclamation.jsonl"),
      record,
    );
    return null;
  } catch (error) {
    return `Could not append reclamation facts: ${error instanceof Error ? error.message : String(error)}`;
  }
}
