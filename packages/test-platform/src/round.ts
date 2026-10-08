import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { executeDocker } from "./docker.ts";
import {
  appendReclamationRecord,
  assertEvidenceTarget,
  evidenceSummarySchema,
  exportDestroyEvidence,
  prepareEvidenceTarget,
} from "./evidence.ts";
import type { EvidenceFileRequest, EvidenceSummary } from "./evidence.ts";
import {
  finalizePlatformDestruction,
  innerResources,
  observePlatform,
  preparePlatform,
} from "./lifecycle.ts";
import type { DestroyResult, OuterObservation } from "./lifecycle.ts";
import {
  acquireStateLock,
  readManifest,
  releaseStateLock,
  scenarioSchema,
  verificationStateSchema,
  writeManifest,
} from "./manifest.ts";
import type {
  PlatformManifest,
  RoundRecord,
  ScenarioRecord,
  StateLock,
  VerificationState,
} from "./manifest.ts";
import {
  SCENARIO_VERIFICATION_ITEMS,
  executeScenario,
  planScenario,
  scenarioBoundaryClean,
  validateScenario,
} from "./runner.ts";
import type { ScenarioRequest } from "./runner.ts";
import { PlatformError, reclamationFactSchema } from "./types.ts";
import type {
  DockerExecutor,
  PlatformOptions,
  ReclamationFact,
} from "./types.ts";

export const ROUND_VERIFICATION_ITEMS = [
  "scenarioExecution",
  "scenarioCleanup",
  "evidenceExport",
  "platformReclaim",
] as const;

export interface RoundRequest {
  scenarios: readonly ScenarioRequest[];
  evidenceDirectory: string;
  reuse?: boolean;
  signal?: AbortSignal;
  /** 轮次级非敏感身份，例如候选摘要与运行条件；平台不编造内容。 */
  identification?: Record<string, string | number>;
  evidenceFiles?: readonly EvidenceFileRequest[];
}

export interface RoundDependencies {
  execute?: DockerExecutor;
}

export type PlatformDisposition =
  | "destroyed"
  | "retained"
  | "recovery_required";

export const roundResultSchema = z.strictObject({
  roundId: z.string(),
  platformId: z.string(),
  stateDirectory: z.string(),
  evidenceDirectory: z.string(),
  disposition: z.enum(["destroyed", "retained", "recovery_required"]),
  reuse: z.boolean(),
  startedAt: z.string(),
  finishedAt: z.string(),
  cancelled: z.enum(["SIGINT", "SIGTERM"]).nullable(),
  timedOut: z.boolean(),
  exitCode: z.number().int(),
  verification: z.record(z.string(), verificationStateSchema),
  /** 本次没有执行的必需项及原因，避免把缺失证据当作通过。 */
  notApplicable: z.record(z.string(), z.string()),
  failures: z.array(z.string()),
  platform: z.strictObject({
    bootstrapImage: z.string(),
    outerEngineId: z.string().nullable(),
    innerEngineId: z.string().nullable(),
    innerServerVersion: z.string().nullable(),
    toolchain: z.strictObject({
      node: z.string(),
      dockerCli: z.string().nullable(),
    }),
  }),
  scenarios: z.array(scenarioSchema),
  evidence: evidenceSummarySchema,
  reclamation: z.strictObject({
    facts: z.array(reclamationFactSchema),
    failures: z.array(z.string()),
  }),
});
export type RoundResult = z.infer<typeof roundResultSchema>;

interface StopReason {
  kind: "cancelled" | "unreachable" | "unclean";
  detail: string;
}

function cancelKind(
  signal: AbortSignal | undefined,
): "SIGINT" | "SIGTERM" | null {
  if (signal?.aborted !== true) return null;
  return signal.reason === "SIGINT" ? "SIGINT" : "SIGTERM";
}

function aggregate(states: readonly VerificationState[]): VerificationState {
  if (states.length === 0) return "not_run";
  if (states.every((state) => state === "passed")) return "passed";
  if (states.some((state) => state === "failed")) return "failed";
  return "incomplete";
}

/**
 * 一轮：准备或显式复用平台、按顺序执行场景并逐场景回收、留证、默认完整销毁。
 * 公开入口只有 run / status / destroy，准备步骤不对外暴露。
 */
export async function runRound(
  options: PlatformOptions,
  request: RoundRequest,
  dependencies: RoundDependencies = {},
): Promise<RoundResult> {
  if (request.scenarios.length === 0) {
    throw new PlatformError(
      "invalidOptions",
      "A round requires at least one scenario.",
    );
  }
  for (const scenario of request.scenarios) validateScenario(scenario);
  const execute = dependencies.execute ?? executeDocker;
  const evidenceDirectory = resolve(request.evidenceDirectory);
  const reuse = request.reuse === true;
  await assertEvidenceTarget(evidenceDirectory, options.stateDirectory);
  // 目标不可写时必须在任何 Docker 资源创建之前失败。
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });

  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
  const lock = await acquireStateLock(options, reuse ? "run-reuse" : "run");
  try {
    return await executeRound(options, execute, request, evidenceDirectory, {
      lock,
      reuse,
    });
  } finally {
    await releaseStateLock(options, lock).catch(() => undefined);
  }
}

interface LockedRoundContext {
  lock: StateLock;
  reuse: boolean;
}

async function executeRound(
  options: PlatformOptions,
  execute: DockerExecutor,
  request: RoundRequest,
  evidenceDirectory: string,
  context: LockedRoundContext,
): Promise<RoundResult> {
  const reuse = context.reuse;
  const existing = await readManifest(options);
  let manifest: PlatformManifest;
  let preparationFailure: StopReason | null = null;
  if (existing === null) {
    try {
      manifest = await preparePlatform(options, evidenceDirectory, { execute });
    } catch (error) {
      const partial = await readManifest(options);
      if (partial === null) throw error;
      manifest = partial;
      preparationFailure = {
        kind: "unreachable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  } else {
    if (!reuse) {
      throw new PlatformError(
        "reuseRejected",
        "A platform already exists for this state directory, and this round did not request reuse.",
        [
          `Recorded phase is ${existing.phase}.`,
          `Inspect it with status, or reclaim it with destroy.`,
        ],
      );
    }
    await assertReusable(execute, options, existing);
    manifest = existing;
    manifest.evidence = {
      directory: evidenceDirectory,
      exported: false,
      failures: [],
    };
  }

  const startedAt = new Date().toISOString();
  const round: RoundRecord = {
    id: randomUUID(),
    startedAt,
    finishedAt: null,
    reuse,
    evidenceDirectory,
    identification: request.identification ?? {},
    scenarios: request.scenarios.map((scenario) =>
      planScenario(options, scenario),
    ),
  };
  manifest.round = round;
  manifest.phase = "running";
  await writeManifest(options, manifest);
  await prepareEvidenceTarget(evidenceDirectory, manifest);

  const failures: string[] = [];
  const stopReason =
    preparationFailure ??
    (await runScenarios(options, execute, manifest, round, request, failures));

  const signal = request.signal;
  if (stopReason !== null || signal?.aborted === true) {
    for (const record of round.scenarios) {
      if (record.phase === "planned") {
        record.phase = "not_run";
        for (const item of Object.keys(record.verification)) {
          record.verification[item] = "not_run";
        }
      }
    }
    if (stopReason !== null) failures.push(stopReason.detail);
  }

  round.finishedAt = new Date().toISOString();
  manifest.phase = "finalizing";
  await writeManifest(options, manifest);

  const canRetain =
    reuse &&
    stopReason === null &&
    (await isHealthyAndClean(execute, options, manifest));
  const outcome = canRetain
    ? await retainRound(options, execute, manifest, request)
    : await destroyRound(options, execute, manifest, request);

  const reclamationFailures = outcome.reclamation.failures;
  const evidenceExport: VerificationState =
    outcome.evidence.exported && outcome.evidence.failures.length === 0
      ? "passed"
      : "failed";
  const executed = round.scenarios.filter(
    (record) => record.phase !== "not_run" && record.phase !== "planned",
  );
  const verification: Record<string, VerificationState> = {
    scenarioExecution: aggregate(
      executed.map(
        (record) => record.verification.scenarioExecution ?? "not_run",
      ),
    ),
    scenarioCleanup: aggregate(
      executed.map(
        (record) => record.verification.scenarioCleanup ?? "not_run",
      ),
    ),
    evidenceExport,
    platformReclaim:
      outcome.disposition === "retained"
        ? "not_run"
        : reclamationFailures.length === 0
          ? "passed"
          : "failed",
  };
  const notApplicable: Record<string, string> = {};
  if (outcome.disposition === "retained") {
    notApplicable.platformReclaim =
      "This round explicitly retained a verified healthy platform; reclaim it with destroy.";
  }
  const callerItems = new Set<string>();
  for (const record of executed) {
    for (const item of Object.keys(record.verification)) {
      if (!(SCENARIO_VERIFICATION_ITEMS as readonly string[]).includes(item)) {
        callerItems.add(item);
      }
    }
  }
  for (const item of callerItems) {
    verification[item] = aggregate(
      executed.map((record) => record.verification[item] ?? "not_run"),
    );
  }

  const cancelled = cancelKind(signal);
  const timedOut = round.scenarios.some((record) => record.timedOut);
  const requiredItems = Object.entries(verification).filter(
    ([item]) => notApplicable[item] === undefined,
  );
  const unresolved = requiredItems.filter(
    ([, state]) => state !== "passed" && state !== "failed",
  );
  const failedItems = requiredItems.filter(([, state]) => state === "failed");
  const exitCode =
    cancelled !== null
      ? cancelled === "SIGINT"
        ? 130
        : 143
      : timedOut
        ? 124
        : failedItems.length + unresolved.length + failures.length > 0
          ? 1
          : 0;

  const result: RoundResult = {
    roundId: round.id,
    platformId: manifest.id,
    stateDirectory: options.stateDirectory,
    evidenceDirectory,
    disposition: outcome.disposition,
    reuse,
    startedAt,
    finishedAt: round.finishedAt,
    cancelled,
    timedOut,
    exitCode,
    verification,
    notApplicable,
    failures: [...new Set(failures)],
    platform: {
      bootstrapImage: manifest.bootstrapImage,
      outerEngineId: manifest.outerEngineId,
      innerEngineId: manifest.innerEngineId,
      innerServerVersion: manifest.innerServerVersion,
      toolchain: manifest.toolchain,
    },
    scenarios: round.scenarios,
    evidence: outcome.evidence,
    reclamation: outcome.reclamation,
  };
  return result;
}

async function runScenarios(
  options: PlatformOptions,
  execute: DockerExecutor,
  manifest: PlatformManifest,
  round: RoundRecord,
  request: RoundRequest,
  failures: string[],
): Promise<StopReason | null> {
  const signal = request.signal;
  for (let index = 0; index < round.scenarios.length; index += 1) {
    const record = round.scenarios[index]!;
    const scenario = request.scenarios[index]!;
    if (signal?.aborted === true) {
      return {
        kind: "cancelled",
        detail: `Cancellation arrived before scenario ${record.id} started.`,
      };
    }
    try {
      await executeScenario(options, manifest, scenario, record, {
        execute,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      const reason = classifyScenarioError(error, signal);
      if (reason !== null) {
        await writeManifest(options, manifest);
        return reason;
      }
      failures.push(
        `Scenario ${record.id} could not start: ${error instanceof Error ? error.message : String(error)}`,
      );
      await writeManifest(options, manifest);
      continue;
    }
    if (record.cleanupErrors.length > 0) {
      await writeManifest(options, manifest);
      return {
        kind: "unclean",
        detail: `Scenario ${record.id} left uncleaned resources: ${record.cleanupErrors.join("; ")}.`,
      };
    }
    const boundary = await verifyBoundary(execute, options, manifest, record);
    if (boundary !== null) {
      await writeManifest(options, manifest);
      return boundary;
    }
    await writeManifest(options, manifest);
  }
  return null;
}

function classifyScenarioError(
  error: unknown,
  signal: AbortSignal | undefined,
): StopReason | null {
  if (signal?.aborted === true) {
    return {
      kind: "cancelled",
      detail: "The round was cancelled while a scenario was running.",
    };
  }
  if (error instanceof PlatformError && error.code === "unreachable") {
    return {
      kind: "unreachable",
      detail:
        `The platform engine is unavailable: ${error.message} ${error.details.join(" ")}`.trim(),
    };
  }
  return null;
}

/** 每场景结束后复核清洁边界；不收敛就不允许启动下一场景或保留平台。 */
async function verifyBoundary(
  execute: DockerExecutor,
  options: PlatformOptions,
  manifest: PlatformManifest,
  record: ScenarioRecord,
): Promise<StopReason | null> {
  let resources;
  try {
    resources = await innerResources(
      execute,
      options,
      manifest.names.containerName,
    );
  } catch (error) {
    return {
      kind: "unreachable",
      detail: `Could not verify the inner resource boundary for scenario ${record.id}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (scenarioBoundaryClean(resources, manifest.innerDefaults.networks)) {
    return null;
  }
  const detail = `Scenario ${record.id} did not converge to a clean inner boundary: containers ${resources.containers.join(", ") || "none"}, networks ${resources.networks.join(", ") || "none"}, volumes ${resources.volumes.join(", ") || "none"}.`;
  record.cleanupErrors.push(detail);
  record.verification.scenarioCleanup = "failed";
  record.phase = "incomplete";
  return { kind: "unclean", detail };
}

async function assertReusable(
  execute: DockerExecutor,
  options: PlatformOptions,
  manifest: PlatformManifest,
): Promise<void> {
  function reject(detail: string): never {
    throw new PlatformError(
      "reuseRejected",
      `Refusing to reuse this platform: ${detail}.`,
      [
        `State directory ${options.stateDirectory}.`,
        "Inspect it with status, or reclaim it with destroy and prepare a new platform.",
      ],
    );
  }
  if (manifest.legacy) {
    reject("the manifest was written by an older platform version");
  }
  if (manifest.phase !== "retained") {
    reject(
      `the recorded phase is ${manifest.phase}, which is not a retained platform`,
    );
  }
  if (manifest.bootstrapImage !== options.bootstrapImage) {
    reject("the pinned bootstrap digest differs from this round's request");
  }
  if (manifest.round === null) {
    reject("no round record proves this platform is clean");
  }
  if (
    !manifest.round.scenarios.every(
      (record) =>
        record.phase === "completed" && record.cleanupErrors.length === 0,
    )
  ) {
    reject("the previous round has unfinished or uncleaned scenarios");
  }
  if (!(await isHealthyAndClean(execute, options, manifest))) {
    reject("the engines or the inner resource boundary are not verified clean");
  }
}

async function isHealthyAndClean(
  execute: DockerExecutor,
  options: PlatformOptions,
  manifest: PlatformManifest,
): Promise<boolean> {
  const observation: OuterObservation = await observePlatform(
    execute,
    options,
    manifest,
  );
  if (observation.outer !== "running" || observation.inner !== "ready") {
    return false;
  }
  let resources;
  try {
    resources = await innerResources(
      execute,
      options,
      manifest.names.containerName,
    );
  } catch {
    return false;
  }
  return (
    scenarioBoundaryClean(resources, manifest.innerDefaults.networks) &&
    resources.containers.length === 0 &&
    resources.volumes.length === 0
  );
}

interface RoundOutcome {
  disposition: PlatformDisposition;
  evidence: EvidenceSummary;
  reclamation: { facts: ReclamationFact[]; failures: string[] };
}

/** 保留也要留证：导出轮次事实与日志，但不伪装成完整销毁。 */
async function retainRound(
  options: PlatformOptions,
  execute: DockerExecutor,
  manifest: PlatformManifest,
  request: RoundRequest,
): Promise<RoundOutcome> {
  const evidence = await exportDestroyEvidence(
    options,
    manifest,
    execute,
    request.evidenceFiles ?? [],
  );
  manifest.evidence = {
    directory: evidence.directory ?? manifest.evidence.directory,
    exported: evidence.exported,
    failures: [
      ...new Set([...manifest.evidence.failures, ...evidence.failures]),
    ],
  };
  const appendFailure = await appendReclamationRecord(
    manifest.evidence.directory,
    manifest,
    {
      attemptedAt: new Date().toISOString(),
      disposition: "retained",
      facts: [],
      failures: evidence.failures,
    },
  );
  const failures = [
    ...evidence.failures,
    ...(appendFailure === null ? [] : [appendFailure]),
  ];
  manifest.phase = failures.length === 0 ? "retained" : "recovery_required";
  await writeManifest(options, manifest);
  return {
    disposition: failures.length === 0 ? "retained" : "recovery_required",
    evidence,
    reclamation: { facts: [], failures },
  };
}

async function destroyRound(
  options: PlatformOptions,
  execute: DockerExecutor,
  manifest: PlatformManifest,
  request: RoundRequest,
): Promise<RoundOutcome> {
  const result: DestroyResult = await finalizePlatformDestruction(
    options,
    manifest,
    execute,
    request.evidenceFiles ?? [],
  );
  return {
    disposition:
      result.disposition === "destroyed" ? "destroyed" : "recovery_required",
    evidence: result.evidence,
    reclamation: {
      facts: result.facts,
      failures: result.failures,
    },
  };
}
