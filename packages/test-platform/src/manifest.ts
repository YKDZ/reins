import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import { PlatformError } from "./types.ts";
import type { PlatformOptions } from "./types.ts";

export const MANIFEST_FILE = "platform.json";
export const LOCK_FILE = "platform.lock";
export const OWNER_LABEL = "io.reins.test-platform";

const verificationState = z.enum(["not_run", "incomplete", "passed", "failed"]);
export type VerificationState = z.infer<typeof verificationState>;

const scenarioPhase = z.enum([
  "planned",
  "executing",
  "collecting",
  "cleaning",
  "completed",
  "incomplete",
  "not_run",
]);
export type ScenarioPhase = z.infer<typeof scenarioPhase>;

const platformPhase = z.enum([
  "preparing",
  "running",
  "finalizing",
  "retained",
  "destroying",
  "recovery_required",
]);
export type PlatformPhase = z.infer<typeof platformPhase>;

const uuid = z.string().regex(/^[a-f0-9-]{36}$/);

const collectedLogRecord = z.strictObject({
  path: z.string().min(1),
  status: z.enum(["copied", "missing", "failed"]),
  detail: z.string().nullable(),
});

const scenarioRecord = z.strictObject({
  id: uuid,
  phase: scenarioPhase,
  requestedImage: z.string().min(1),
  resolvedImage: z.strictObject({
    id: z.string().nullable(),
    digests: z.array(z.string()),
  }),
  workspacePath: z.string().min(1),
  environmentNames: z.array(z.string()),
  identification: z.record(z.string(), z.json()),
  verification: z.record(z.string(), verificationState),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  cancelled: z.boolean(),
  error: z.string().nullable(),
  cleanupErrors: z.array(z.string()),
  baseline: z.strictObject({
    containers: z.array(z.string()),
    networks: z.array(z.string()),
    volumes: z.array(z.string()),
  }),
  collectedLogs: z.array(collectedLogRecord),
  localDirectory: z.string().min(1),
});
export type ScenarioRecord = z.infer<typeof scenarioRecord>;

const roundRecord = z.strictObject({
  id: uuid,
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  reuse: z.boolean(),
  evidenceDirectory: z.string().min(1),
  identification: z.record(z.string(), z.json()),
  scenarios: z.array(scenarioRecord),
});
export type RoundRecord = z.infer<typeof roundRecord>;

const manifestRecord = z.strictObject({
  version: z.literal(2),
  id: uuid,
  legacy: z.boolean(),
  phase: platformPhase,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  names: z.strictObject({
    containerName: z.string().min(1),
    dataVolumeName: z.string().min(1),
    workspaceVolumeName: z.string().min(1),
    networkName: z.string().min(1),
  }),
  ids: z.strictObject({
    container: z.string().nullable(),
    network: z.string().nullable(),
    dataVolume: z.string().nullable(),
    workspaceVolume: z.string().nullable(),
  }),
  labels: z.record(z.string(), z.string()),
  bootstrapImage: z.string().min(1),
  imageAcquisition: z.strictObject({
    existedBefore: z.boolean().nullable(),
    acquiredId: z.string().nullable(),
  }),
  outerEngineId: z.string().nullable(),
  innerEngineId: z.string().nullable(),
  innerServerVersion: z.string().nullable(),
  toolchain: z.strictObject({
    node: z.string(),
    dockerCli: z.string().nullable(),
  }),
  innerDefaults: z.strictObject({ networks: z.array(z.string()) }),
  evidence: z.strictObject({
    directory: z.string().min(1).nullable(),
    exported: z.boolean(),
    failures: z.array(z.string()),
  }),
  reclamation: z.strictObject({
    attemptedAt: z.iso.datetime().nullable(),
    failures: z.array(z.string()),
  }),
  round: roundRecord.nullable(),
});
export type PlatformManifest = z.infer<typeof manifestRecord>;

// 结果 schema 复用这些片段，使清单、CLI 载荷与测试共享同一份字段定义。
export {
  collectedLogRecord as collectedLogSchema,
  manifestRecord as manifestSchema,
  platformPhase as platformPhaseSchema,
  roundRecord as roundSchema,
  scenarioRecord as scenarioSchema,
  scenarioPhase as scenarioPhaseSchema,
  verificationState as verificationStateSchema,
};

export function validateImageReference(image: string): void {
  if (!/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(image)) {
    throw new PlatformError(
      "invalidOptions",
      "Bootstrap image must use an immutable sha256 digest.",
    );
  }
}

export function plannedNames(id: string) {
  const prefix = `reins-test-${id}`;
  return {
    containerName: prefix,
    dataVolumeName: `${prefix}-data`,
    workspaceVolumeName: `${prefix}-workspace`,
    networkName: `${prefix}-network`,
  };
}

export function createManifest(
  options: PlatformOptions,
  evidenceDirectory: string,
): PlatformManifest {
  validateImageReference(options.bootstrapImage);
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  return {
    version: 2,
    id,
    legacy: false,
    phase: "preparing",
    createdAt: timestamp,
    updatedAt: timestamp,
    names: plannedNames(id),
    ids: {
      container: null,
      network: null,
      dataVolume: null,
      workspaceVolume: null,
    },
    labels: { [OWNER_LABEL]: id },
    bootstrapImage: options.bootstrapImage,
    imageAcquisition: { existedBefore: null, acquiredId: null },
    outerEngineId: null,
    innerEngineId: null,
    innerServerVersion: null,
    toolchain: { node: process.version, dockerCli: null },
    innerDefaults: { networks: [] },
    evidence: { directory: evidenceDirectory, exported: false, failures: [] },
    reclamation: { attemptedAt: null, failures: [] },
    round: null,
  };
}

function manifestPath(options: PlatformOptions): string {
  return join(options.stateDirectory, MANIFEST_FILE);
}

/** 清单是后续 Docker 变更的先行意图，必须先落盘并刷新，再允许执行下一步。 */
export async function writeManifest(
  options: PlatformOptions,
  manifest: PlatformManifest,
): Promise<void> {
  const updated = { ...manifest, updatedAt: new Date().toISOString() };
  const checked = manifestRecord.safeParse(updated);
  if (!checked.success) {
    throw invalidManifest(checked.error.issues[0]?.message ?? "unknown field");
  }
  const target = manifestPath(options);
  const temporary = `${target}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(checked.data, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
  await syncDirectory(dirname(target));
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (isUnsupportedSync(error)) return;
    throw error;
  }
  try {
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedSync(error)) throw error;
  } finally {
    await handle.close();
  }
}

function isUnsupportedSync(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    (error.code === "EINVAL" ||
      error.code === "EISDIR" ||
      error.code === "EPERM")
  );
}

/** 读取清单；旧版本只规范化为可读事实，禁止被当成可复用平台。 */
export async function readManifest(
  options: PlatformOptions,
): Promise<PlatformManifest | null> {
  let source: string;
  try {
    source = await readFile(manifestPath(options), "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw invalidManifest("the manifest is not valid JSON");
  }
  const current = manifestRecord.safeParse(parsed);
  if (current.success) return current.data;
  const legacy = legacyManifest(parsed);
  if (legacy !== null) return legacy;
  throw invalidManifest("the manifest does not match a supported version");
}

function legacyManifest(parsed: unknown): PlatformManifest | null {
  const guard = z
    .strictObject({
      version: z.literal(1),
      id: uuid,
      containerName: z.string().min(1),
      dataVolumeName: z.string().min(1),
      workspaceVolumeName: z.string().min(1),
      networkName: z.string().min(1),
      bootstrapImage: z.string().min(1),
      bootstrapImageExisted: z.boolean().nullable(),
      labels: z.record(z.string(), z.string()),
      createdAt: z.iso.datetime(),
    })
    .safeParse(parsed);
  if (!guard.success) return null;
  const legacy = guard.data;
  if (
    legacy.labels[OWNER_LABEL] !== legacy.id ||
    JSON.stringify({ ...plannedNames(legacy.id) }) !==
      JSON.stringify({
        containerName: legacy.containerName,
        dataVolumeName: legacy.dataVolumeName,
        workspaceVolumeName: legacy.workspaceVolumeName,
        networkName: legacy.networkName,
      })
  ) {
    throw invalidManifest(
      "the legacy manifest ownership record is inconsistent",
    );
  }
  const timestamp = new Date().toISOString();
  return {
    version: 2,
    id: legacy.id,
    legacy: true,
    phase: "running",
    createdAt: legacy.createdAt,
    updatedAt: timestamp,
    names: plannedNames(legacy.id),
    ids: {
      container: null,
      network: null,
      dataVolume: null,
      workspaceVolume: null,
    },
    labels: { [OWNER_LABEL]: legacy.id },
    bootstrapImage: legacy.bootstrapImage,
    imageAcquisition: {
      existedBefore: legacy.bootstrapImageExisted,
      acquiredId: null,
    },
    outerEngineId: null,
    innerEngineId: null,
    innerServerVersion: null,
    toolchain: { node: "unknown", dockerCli: null },
    innerDefaults: { networks: [] },
    evidence: { directory: null, exported: false, failures: [] },
    reclamation: { attemptedAt: null, failures: [] },
    round: null,
  };
}

function invalidManifest(detail: string): PlatformError {
  return new PlatformError(
    "invalidManifest",
    `Invalid test platform manifest: ${detail}.`,
  );
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export interface StateLock {
  pid: number;
  startTime: string;
  purpose: string;
  takenAt: string;
}

/**
 * 同一状态目录的修改者互斥：O_EXCL 记录持有者与进程起始时间，
 * 被 SIGKILL 的持有者可立即回收，活动持有者绝不被接管。
 */
export async function acquireStateLock(
  options: PlatformOptions,
  purpose: string,
): Promise<StateLock> {
  const target = join(options.stateDirectory, LOCK_FILE);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const lock = {
      pid: process.pid,
      startTime: await processStartTime(process.pid),
      purpose,
      takenAt: new Date().toISOString(),
    };
    try {
      await writeFile(target, `${JSON.stringify(lock)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      return lock;
    } catch (error) {
      if (!isExistenceConflict(error)) throw error;
      const holder = await readStateLock(options);
      if (holder !== null && (await isLiveProcess(holder))) {
        throw new PlatformError(
          "busy",
          `Another ${holder.purpose} is modifying this platform state directory.`,
          [`Lock holder pid ${holder.pid} is running.`],
        );
      }
      if (holder !== null) await rm(target, { force: true });
    }
  }
  throw new PlatformError(
    "busy",
    "Could not obtain exclusive access to the platform state directory.",
  );
}

export async function readStateLock(
  options: PlatformOptions,
): Promise<StateLock | null> {
  let source: string;
  try {
    source = await readFile(join(options.stateDirectory, LOCK_FILE), "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
  const parsed = z
    .strictObject({
      pid: z.number().int().positive(),
      startTime: z.string(),
      purpose: z.string(),
      takenAt: z.iso.datetime(),
    })
    .safeParse(JSON.parse(source) as unknown);
  return parsed.success ? parsed.data : null;
}

/** 只删除仍属于本次持有的锁，避免旧持有者抹掉新目录操作者的锁。 */
export async function releaseStateLock(
  options: PlatformOptions,
  lock: StateLock,
): Promise<void> {
  const holder = await readStateLock(options);
  if (
    holder !== null &&
    holder.pid === lock.pid &&
    holder.startTime === lock.startTime
  ) {
    await rm(join(options.stateDirectory, LOCK_FILE), { force: true });
  }
}

async function processStartTime(pid: number): Promise<string> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return fields[19] ?? "";
}

async function isLiveProcess(holder: StateLock): Promise<boolean> {
  try {
    return (await processStartTime(holder.pid)) === holder.startTime;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

function isExistenceConflict(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

/** 空目录或仅有已失效锁的目录可以安全继续创建；未知内容一律拒绝接管。 */
export async function assertStateDirectoryUsable(
  options: PlatformOptions,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(options.stateDirectory);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  const unknown = entries.filter(
    (entry) => entry !== MANIFEST_FILE && entry !== LOCK_FILE,
  );
  if (unknown.length > 0 || entries.includes(MANIFEST_FILE)) {
    throw new PlatformError(
      "occupiedStateDirectory",
      "Refusing to take over an existing platform state directory.",
      [`Unexpected entries: ${unknown.join(", ") || MANIFEST_FILE}`],
    );
  }
}

export async function ensureStateDirectory(
  options: PlatformOptions,
): Promise<void> {
  await mkdir(dirname(options.stateDirectory), { recursive: true });
  await assertStateDirectoryUsable(options);
  await mkdir(options.stateDirectory, { mode: 0o700, recursive: true });
}
