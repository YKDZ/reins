import { z } from "zod";

export interface PlatformOptions {
  stateDirectory: string;
  bootstrapImage: string;
  dockerBinary?: string;
  timeoutMs?: number;
}

export interface DockerCommandOptions {
  input?: string | Buffer;
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  outputDirectory?: string;
  signal?: AbortSignal;
}

export interface CommandResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type DockerExecutor = (
  options: PlatformOptions,
  args: readonly string[],
  commandOptions?: DockerCommandOptions,
) => Promise<CommandResult>;

export type ResourceKind = "container" | "network" | "volume";

/** 每一项回收都留下独立事实，兜底成功不改写此前的失败。 */
export const reclamationFactSchema = z.strictObject({
  kind: z.enum([
    "container",
    "network",
    "volume",
    "image",
    "stateDirectory",
    "scenarioResource",
  ]),
  name: z.string(),
  outcome: z.enum(["removed", "absent", "failed", "skipped", "kept"]),
  detail: z.string().nullable(),
});
export type ReclamationFact = z.infer<typeof reclamationFactSchema>;

export type PlatformErrorCode =
  | "busy"
  | "invalidManifest"
  | "invalidOptions"
  | "occupiedStateDirectory"
  | "ownershipConflict"
  | "reclamationFailed"
  | "reuseRejected"
  | "targetUnusable"
  | "unreachable";

/** 平台自身的结构化拒绝；CLI 把它转换成声明的结果类别，不动态改写退出码。 */
export class PlatformError extends Error {
  readonly code: PlatformErrorCode;
  readonly details: readonly string[];

  constructor(
    code: PlatformErrorCode,
    message: string,
    details: readonly string[] = [],
  ) {
    super(message);
    this.name = "PlatformError";
    this.code = code;
    this.details = details;
  }
}
