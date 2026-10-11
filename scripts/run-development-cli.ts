import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, realpath } from "node:fs/promises";
import { constants, homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const turboBuildArguments = [
  "exec",
  "turbo",
  "run",
  "build",
  "--filter=@ykdz/reins",
  "--filter=@reins/daemon",
  "--filter=@reins/workspace-manager",
  "--output-logs=errors-only",
  "--log-order=grouped",
  "--log-prefix=task",
] as const;

type CommandResult = {
  readonly status: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
};

function runPnpm(args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn("pnpm", [...args], {
      cwd: repository,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (status) => {
      resolveCommand({
        status: status ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

type BuildTaskIdentity = {
  readonly taskId: string;
  readonly hash: string;
  readonly hashOfExternalDependencies: string;
  readonly directory: string;
  readonly command: string;
  readonly outputs: readonly string[];
};

type BuildGraphIdentity = {
  readonly turboVersion: string;
  readonly tasks: readonly BuildTaskIdentity[];
};

type DaemonCompositionIdentity = {
  readonly path: string | null;
  readonly idleTimeoutMs: string | null;
  readonly diagnosticsMaxAgeMs: string | null;
  readonly diagnosticsMaxBytes: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`Turbo build graph omitted ${key}`);
  }
  return value;
}

function parseBuildGraph(stdout: Buffer): BuildGraphIdentity {
  const parsed: unknown = JSON.parse(stdout.toString("utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed.tasks)) {
    throw new Error("Turbo returned an invalid build graph");
  }
  const tasks = parsed.tasks.map((value): BuildTaskIdentity => {
    if (!isRecord(value) || !Array.isArray(value.outputs)) {
      throw new Error("Turbo returned an invalid build task");
    }
    const outputs = value.outputs.map((output) => {
      if (typeof output !== "string") {
        throw new Error("Turbo build task returned an invalid output");
      }
      return output;
    });
    return {
      taskId: readString(value, "taskId"),
      hash: readString(value, "hash"),
      hashOfExternalDependencies: readString(
        value,
        "hashOfExternalDependencies",
      ),
      directory: readString(value, "directory"),
      command: readString(value, "command"),
      outputs,
    };
  });
  if (tasks.length === 0)
    throw new Error("Turbo build graph contained no tasks");
  tasks.sort((left, right) => left.taskId.localeCompare(right.taskId));
  return {
    turboVersion: readString(parsed, "turboVersion"),
    tasks,
  };
}

async function readBuildGraph(): Promise<BuildGraphIdentity> {
  const result = await runPnpm([...turboBuildArguments, "--dry=json"]);
  if (result.status !== 0) {
    throw new Error(
      `Turbo build graph failed with exit ${result.status}: ${result.stderr.toString("utf8").trim()}`,
    );
  }
  return parseBuildGraph(result.stdout);
}

function assertSupportedDevelopmentEnvironment(env: NodeJS.ProcessEnv): void {
  if (env.REINS_ADAPTERS_MODULE !== undefined) {
    throw new Error(
      "REINS_ADAPTERS_MODULE is not supported by the development CLI",
    );
  }
}

function daemonCompositionIdentity(
  env: NodeJS.ProcessEnv,
): DaemonCompositionIdentity {
  return {
    path: env.PATH ?? null,
    idleTimeoutMs: env.REINS_IDLE_TIMEOUT_MS ?? null,
    diagnosticsMaxAgeMs: env.REINS_DIAGNOSTICS_MAX_AGE_MS ?? null,
    diagnosticsMaxBytes: env.REINS_DIAGNOSTICS_MAX_BYTES ?? null,
  };
}

function updateIdentity(
  hash: ReturnType<typeof createHash>,
  label: string,
  value: string | Buffer,
): void {
  hash.update(label);
  hash.update("\0");
  hash.update(String(Buffer.byteLength(value)));
  hash.update("\0");
  hash.update(value);
  hash.update("\0");
}

async function buildIdentity(
  graph: BuildGraphIdentity,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const hash = createHash("sha256");
  updateIdentity(
    hash,
    "pnpm-lock",
    await readFile(join(repository, "pnpm-lock.yaml")),
  );
  updateIdentity(hash, "turbo-build-graph", JSON.stringify(graph));
  updateIdentity(
    hash,
    "daemon-composition",
    JSON.stringify(daemonCompositionIdentity(env)),
  );
  updateIdentity(
    hash,
    "node-runtime",
    JSON.stringify({
      arch: process.arch,
      platform: process.platform,
      execPath: await realpath(process.execPath),
      execArgv: process.execArgv,
      nodeOptions: env.NODE_OPTIONS ?? null,
      versions: Object.fromEntries(
        Object.entries(process.versions).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    }),
  );
  return hash.digest("hex").slice(0, 20);
}

function developmentRoot(env: NodeJS.ProcessEnv): string {
  if (env.REINS_DEVELOPMENT_ROOT !== undefined) {
    if (env.REINS_DEVELOPMENT_ROOT === "") {
      throw new Error("REINS_DEVELOPMENT_ROOT must not be empty");
    }
    return resolve(env.REINS_DEVELOPMENT_ROOT);
  }
  if (env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME !== "") {
    return join(env.XDG_STATE_HOME, "reins-development");
  }
  const home = env.HOME === "" ? homedir() : (env.HOME ?? homedir());
  if (home !== "") return join(home, ".local", "state", "reins-development");
  return join(tmpdir(), `reins-development-${process.getuid?.() ?? "user"}`);
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function runCli(args: readonly string[]): Promise<number> {
  const checkout = await realpath(repository);
  const checkoutIdentity = createHash("sha256")
    .update(checkout)
    .digest("hex")
    .slice(0, 20);
  const outputIdentity = await buildIdentity(
    await readBuildGraph(),
    process.env,
  );
  const root = developmentRoot(process.env);
  const runtimeDirectory = join(root, `${checkoutIdentity}-${outputIdentity}`);
  await ensurePrivateDirectory(runtimeDirectory);

  return await new Promise((resolveCli, reject) => {
    const child = spawn(
      process.execPath,
      [join(repository, "apps/cli/dist/reins.js"), ...args],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          REINS_DAEMON_BIN: join(repository, "packages/daemon/dist/main.js"),
          REINS_SOCKET: join(runtimeDirectory, "reins.sock"),
          REINS_STATE_DIR: join(runtimeDirectory, "state"),
          REINS_WORKSPACE_MANAGER_BIN: join(
            repository,
            "apps/workspace-manager/dist/main.js",
          ),
          REINS_WORKSPACE_MANAGER_SOCKET: join(
            runtimeDirectory,
            "workspace-manager.sock",
          ),
          REINS_WORKSPACE_MANAGER_STATE_DIR: join(
            runtimeDirectory,
            "workspace-manager-state",
          ),
        },
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("close", (status, signal) => {
      if (status !== null) {
        resolveCli(status);
        return;
      }
      const signalNumber =
        signal === null ? undefined : constants.signals[signal];
      resolveCli(signalNumber === undefined ? 1 : 128 + signalNumber);
    });
  });
}

try {
  assertSupportedDevelopmentEnvironment(process.env);
  const build = await runPnpm(turboBuildArguments);
  if (build.status !== 0) {
    process.stdout.write(build.stdout);
    process.stderr.write(build.stderr);
    process.exitCode = build.status;
  } else {
    const forwardedArgs = process.argv.slice(2);
    if (forwardedArgs[0] === "--") forwardedArgs.shift();
    process.exitCode = await runCli(forwardedArgs);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Failed to run the development CLI: ${message}\n`);
  process.exitCode = 1;
}
