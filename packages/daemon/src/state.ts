import { chmod, mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const defaultDiagnosticsRetention = {
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxBytes: 64 * 1024 * 1024,
} as const;

export type DiagnosticsRetention = {
  readonly maxAgeMs: number;
  readonly maxBytes: number;
};

export type DaemonState = {
  readonly directory: string;
  readonly diagnosticsDirectory: string;
  readonly durable: boolean;
  readonly retention: DiagnosticsRetention;
};

export class StateConfigurationError extends Error {
  readonly code = "invalid_configuration";
  readonly field: string;

  constructor(field: string) {
    super(`Invalid ${field}`);
    this.name = "StateConfigurationError";
    this.field = field;
  }
}

type StateEnvironment = Readonly<Record<string, string | undefined>>;

function parsePositiveInteger(
  value: string | undefined,
  field: string,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new StateConfigurationError(field);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new StateConfigurationError(field);
  return parsed;
}

export function resolveDiagnosticsRetention(
  env: StateEnvironment = process.env,
): DiagnosticsRetention {
  return {
    maxAgeMs: parsePositiveInteger(
      env.REINS_DIAGNOSTICS_MAX_AGE_MS,
      "REINS_DIAGNOSTICS_MAX_AGE_MS",
      defaultDiagnosticsRetention.maxAgeMs,
    ),
    maxBytes: parsePositiveInteger(
      env.REINS_DIAGNOSTICS_MAX_BYTES,
      "REINS_DIAGNOSTICS_MAX_BYTES",
      defaultDiagnosticsRetention.maxBytes,
    ),
  };
}

// state 与 diagnostics 目录只能收紧为私有权限，绝不把已有目录扩大为更宽权限。
async function ensurePrivateDirectory(directory: string): Promise<void> {
  let existed = true;
  try {
    await stat(directory);
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      existed = false;
    } else {
      throw error;
    }
  }
  await mkdir(directory, { mode: 0o700, recursive: true });
  const currentMode = (await stat(directory)).mode & 0o777;
  if (!existed || (currentMode & 0o077) !== 0) {
    await chmod(directory, 0o700);
  }
  const mode = (await stat(directory)).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error("State directory is not private");
}

export async function resolveDaemonState(options?: {
  env?: StateEnvironment;
  temporaryParent?: string;
}): Promise<DaemonState> {
  const env = options?.env ?? process.env;
  const retention = resolveDiagnosticsRetention(env);
  const explicit = env.REINS_STATE_DIR;
  if (explicit === "") throw new StateConfigurationError("REINS_STATE_DIR");
  const xdg = env.XDG_STATE_HOME === "" ? undefined : env.XDG_STATE_HOME;
  const home = env.HOME === "" ? undefined : env.HOME;
  const durable =
    explicit !== undefined || xdg !== undefined || home !== undefined;
  const directory =
    explicit ??
    (xdg === undefined ? undefined : join(xdg, "reins")) ??
    (home === undefined ? undefined : join(home, ".local", "state", "reins")) ??
    (await mkdtemp(join(options?.temporaryParent ?? tmpdir(), "reins-state-")));

  await ensurePrivateDirectory(directory);
  const diagnosticsDirectory = join(directory, "diagnostics");
  await ensurePrivateDirectory(diagnosticsDirectory);
  return { directory, diagnosticsDirectory, durable, retention };
}
