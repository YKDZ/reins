import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import { constants, homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildRoots = [
  "adapters/codex/dist",
  "adapters/qoder/dist",
  "apps/cli/dist",
  "packages/adapter-kit/dist",
  "packages/client/dist",
  "packages/core/dist",
  "packages/daemon/dist",
  "packages/event-journal/dist",
  "packages/protocol/dist",
  "packages/transport/dist",
  "packages/workspace-protocol/dist",
] as const;

type CommandResult = {
  readonly status: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
};

function runBuild(): Promise<CommandResult> {
  return new Promise((resolveBuild, reject) => {
    const child = spawn(
      "pnpm",
      [
        "exec",
        "turbo",
        "run",
        "build",
        "--filter=@ykdz/reins",
        "--filter=@reins/daemon",
        "--output-logs=errors-only",
        "--log-order=grouped",
        "--log-prefix=task",
      ],
      {
        cwd: repository,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (status) => {
      resolveBuild({
        status: status ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

async function filesRecursively(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesRecursively(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function buildIdentity(): Promise<string> {
  const hash = createHash("sha256");
  for (const buildRoot of buildRoots) {
    const directory = join(repository, buildRoot);
    for (const path of (await filesRecursively(directory)).sort()) {
      const metadata = await stat(path);
      hash.update(relative(repository, path));
      hash.update("\0");
      hash.update(String(metadata.mode & 0o111));
      hash.update("\0");
      hash.update(await readFile(path));
      hash.update("\0");
    }
  }
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
  const outputIdentity = await buildIdentity();
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
  const build = await runBuild();
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
