import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const runtimePackages = [
  "packages/protocol",
  "packages/adapter-kit",
  "packages/core",
  "packages/transport",
  "adapters/codex",
  "adapters/qoder",
  "packages/daemon",
  "apps/cli",
] as const;

type CommandResult = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function run(
  command: string,
  args: readonly string[],
  options?: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
  },
): CommandResult {
  const result = spawnSync(command, [...args], {
    cwd: options?.cwd,
    env: options?.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function requireSuccess(
  label: string,
  command: string,
  args: readonly string[],
  options?: Parameters<typeof run>[2],
): CommandResult {
  const result = run(command, args, options);
  if (result.status !== 0) {
    throw new Error(
      `${label} failed with exit ${result.status}\n${result.stdout}${result.stderr}`,
    );
  }
  return result;
}

function packageIdentity(directory: string): { name: string; version: string } {
  const manifest: unknown = JSON.parse(
    readFileSync(join(directory, "package.json"), "utf8"),
  );
  if (
    !isRecord(manifest) ||
    typeof manifest.name !== "string" ||
    typeof manifest.version !== "string"
  )
    throw new Error(`Invalid package identity: ${directory}`);
  return { name: manifest.name, version: manifest.version };
}

function tarballName(name: string, version: string): string {
  return `${name.replace(/^@/u, "").replace("/", "-")}-${version}.tgz`;
}

function assertOutput(
  label: string,
  result: CommandResult,
  expected: { status: number; stderr: string },
): void {
  if (result.status !== expected.status || result.stderr !== expected.stderr) {
    throw new Error(
      `${label} returned exit ${result.status}\n${result.stdout}${result.stderr}`,
    );
  }
}

async function waitForRemoval(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (existsSync(path)) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for removal: ${path}`);
    await delay(25);
  }
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "reins-packed-cli-"));
const packDirectory = join(temporaryRoot, "packs");
const installDirectory = join(temporaryRoot, "install");
const runtimeDirectory = join(temporaryRoot, "runtime");

try {
  mkdirSync(packDirectory);
  mkdirSync(installDirectory);
  mkdirSync(runtimeDirectory);

  const tarballs: string[] = [];
  for (const directory of runtimePackages) {
    const identity = packageIdentity(directory);
    requireSuccess(`pack ${identity.name}`, "pnpm", [
      "--filter",
      identity.name,
      "pack",
      "--pack-destination",
      packDirectory,
    ]);
    const tarball = join(
      packDirectory,
      tarballName(identity.name, identity.version),
    );
    if (!existsSync(tarball))
      throw new Error(`Pack did not create expected tarball: ${tarball}`);
    tarballs.push(tarball);
  }
  if (
    readdirSync(packDirectory).filter((entry) => entry.endsWith(".tgz"))
      .length !== tarballs.length
  )
    throw new Error("Unexpected packed tarball set");

  writeFileSync(
    join(installDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "reins-packed-cli-smoke",
        version: "0.0.0",
        private: true,
      },
      null,
      2,
    )}\n`,
  );
  requireSuccess(
    "clean install",
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      ...tarballs,
    ],
    { cwd: installDirectory },
  );

  const binDirectory = join(installDirectory, "node_modules", ".bin");
  const cli = join(binDirectory, "reins");
  const daemon = join(binDirectory, "reins-daemon");
  if (!existsSync(cli) || !existsSync(daemon))
    throw new Error("Packed install did not expose both runtime executables");

  const help = run(cli, ["--help"]);
  assertOutput("packed help", help, { status: 0, stderr: "" });
  if (
    !help.stdout.includes("Usage: reins [options] <command>") ||
    !help.stdout.includes(
      "spawn <harness> <message...> --name <session-name> [options]",
    )
  )
    throw new Error("Packed help omitted canonical command usage");

  const usage = run(cli, ["resolve-permission", "test@g2"]);
  assertOutput("packed usage error", usage, { status: 64, stderr: "" });
  const usageError: unknown = JSON.parse(usage.stdout);
  if (
    !isRecord(usageError) ||
    usageError.code !== "usage_error" ||
    !Array.isArray(usageError.issues) ||
    usageError.issues.length !== 2 ||
    usageError.usage !==
      "reins resolve-permission <sessionId> <permissionId> --outcome <allow|deny> [options]"
  )
    throw new Error(`Packed usage error was incomplete: ${usage.stdout}`);

  const socketPath = join(runtimeDirectory, "reins.sock");
  const listed = run(cli, ["list"], {
    env: {
      ...process.env,
      REINS_DAEMON_BIN: daemon,
      REINS_SOCKET: socketPath,
      REINS_STATE_DIR: join(runtimeDirectory, "state"),
      REINS_IDLE_TIMEOUT_MS: "50",
    },
  });
  assertOutput("packed daemon round trip", listed, {
    status: 0,
    stderr: "",
  });
  if (listed.stdout !== "[]\n")
    throw new Error(
      `Packed daemon returned unexpected output: ${listed.stdout}`,
    );
  await waitForRemoval(socketPath, 5_000);
  await waitForRemoval(`${socketPath}.lock`, 5_000);

  process.stdout.write("Packed CLI smoke passed\n");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
