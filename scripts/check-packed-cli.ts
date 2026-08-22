import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  assertReleaseVersionAuthority,
  readJsonObject,
  releaseTarballName,
  resolveReleaseRuntimeDependencies,
} from "./release-package.ts";

type CommandResult = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readManifest(directory: string): Record<string, unknown> {
  return readJsonObject(join(directory, "package.json"));
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

async function waitForPresence(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for path: ${path}`);
    await delay(25);
  }
}

async function stopChild(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    closed.then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
  if (stopped) return;
  child.kill("SIGKILL");
  await closed;
  throw new Error("Timed out stopping packed daemon");
}

function filesRecursively(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesRecursively(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const repository = process.cwd();
const releaseIdentity = assertReleaseVersionAuthority(repository);
const expectedRuntimeDependencies =
  resolveReleaseRuntimeDependencies(repository);

const temporaryRoot = mkdtempSync(join(tmpdir(), "reins-packed-cli-"));
const installDirectory = join(temporaryRoot, "install");
const runtimeDirectory = join(temporaryRoot, "runtime");
const artifactDirectory = join(process.cwd(), ".artifacts", "release");
const tarballName = releaseTarballName(
  releaseIdentity.name,
  releaseIdentity.version,
);
const tarball = join(artifactDirectory, tarballName);
let runningDaemon: ChildProcess | undefined;

try {
  mkdirSync(installDirectory);
  mkdirSync(runtimeDirectory);

  const artifacts = readdirSync(artifactDirectory).sort();
  if (
    artifacts.length !== 2 ||
    artifacts[0] !== "SHA256SUMS" ||
    artifacts[1] !== tarballName
  ) {
    throw new Error(`Unexpected release artifact set: ${artifacts.join(", ")}`);
  }
  const actualDigest = createHash("sha256")
    .update(readFileSync(tarball))
    .digest("hex");
  const expectedDigest = `${actualDigest}  ${tarballName}\n`;
  if (
    readFileSync(join(artifactDirectory, "SHA256SUMS"), "utf8") !==
    expectedDigest
  )
    throw new Error("SHA256SUMS does not match the release tarball");

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
    ["install", "--no-audit", "--no-fund", "--package-lock=false", tarball],
    { cwd: installDirectory },
  );

  const binDirectory = join(installDirectory, "node_modules", ".bin");
  const installedPackage = join(
    installDirectory,
    "node_modules",
    releaseIdentity.name,
  );
  const cli = join(binDirectory, "reins");
  const daemon = join(binDirectory, "reins-daemon");
  if (!existsSync(cli) || !existsSync(daemon))
    throw new Error("Packed install did not expose both runtime executables");

  const installedManifest = readManifest(installedPackage);
  if (
    installedManifest.name !== releaseIdentity.name ||
    installedManifest.version !== releaseIdentity.version ||
    installedManifest.license !== "MIT" ||
    JSON.stringify(installedManifest.dependencies) !==
      JSON.stringify(expectedRuntimeDependencies) ||
    JSON.stringify(installedManifest.os) !== JSON.stringify(["linux"]) ||
    JSON.stringify(installedManifest.cpu) !== JSON.stringify(["x64"]) ||
    "private" in installedManifest ||
    "exports" in installedManifest ||
    "imports" in installedManifest
  ) {
    throw new Error("Installed manifest diverged from the release authority");
  }
  if (
    readFileSync(join(installedPackage, "README.md"), "utf8") !==
    readFileSync("README.md", "utf8")
  ) {
    throw new Error("Packed README did not come from the repository authority");
  }
  if (
    readFileSync(join(installedPackage, "LICENSE"), "utf8") !==
    readFileSync("LICENSE", "utf8")
  ) {
    throw new Error(
      "Packed LICENSE did not come from the repository authority",
    );
  }
  for (const name of ["reins.js", "reins-daemon.js"] as const) {
    const path = join(installedPackage, "dist", name);
    if ((statSync(path).mode & 0o777) !== 0o755)
      throw new Error(`Packed executable mode is not 0755: ${name}`);
  }

  const qoderWorker = join(
    installDirectory,
    "node_modules",
    "@qodercn-ai",
    "qodercn-agent-sdk",
    "dist",
    "_worker",
    "qoder-worker-runtime.obf.mjs",
  );
  const qoderRuntimeInfo = join(
    installDirectory,
    "node_modules",
    "@qodercn-ai",
    "qodercn-agent-sdk",
    "dist",
    "_worker",
    "runtime-info.json",
  );
  if (
    !existsSync(qoderRuntimeInfo) ||
    !existsSync(qoderWorker) ||
    statSync(qoderWorker).size < 10 * 1024 * 1024
  ) {
    throw new Error("Qoder postinstall did not provision its worker runtime");
  }

  const maps = filesRecursively(join(installedPackage, "dist")).filter((path) =>
    path.endsWith(".js.map"),
  );
  if (maps.length === 0)
    throw new Error("Packed distribution omitted source maps");
  for (const path of maps) {
    const sourceMap: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(sourceMap)) throw new Error(`Invalid source map: ${path}`);
    const sources = sourceMap.sources;
    const sourcesContent = sourceMap.sourcesContent;
    if (
      !Array.isArray(sources) ||
      !Array.isArray(sourcesContent) ||
      sources.length === 0 ||
      sourcesContent.length !== sources.length ||
      !sourcesContent.every((content) => typeof content === "string")
    ) {
      throw new Error(`Packed source map omitted sourcesContent: ${path}`);
    }
  }

  const help = run(cli, ["--help"]);
  assertOutput("packed help", help, { status: 0, stderr: "" });
  if (
    !help.stdout.includes("Usage: reins [options] <command>") ||
    !help.stdout.includes(
      "spawn <harness> <message...> --name <session-name> [options]",
    )
  )
    throw new Error("Packed help omitted canonical command usage");

  const version = run(cli, ["--version"]);
  assertOutput("packed version", version, { status: 0, stderr: "" });
  if (version.stdout !== `${releaseIdentity.version}\n`) {
    throw new Error(`Packed version diverged: ${version.stdout}`);
  }

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

  const adaptersModule = join(temporaryRoot, "fake-adapters.mjs");
  writeFileSync(
    adaptersModule,
    `export default {
  fixture: {
    driverFactory() { throw new Error("driver not used"); },
    async capabilities() {
      return {
        harness: "fixture",
        models: [{
          id: "fixture-model",
          displayName: "Fixture model",
          reasoningEfforts: ["low", "high"],
        }],
      };
    },
  },
};
`,
  );

  const directDirectory = join(runtimeDirectory, "direct");
  mkdirSync(directDirectory);
  const directSocket = join(directDirectory, "reins.sock");
  const directEnv: NodeJS.ProcessEnv = {
    ...process.env,
    REINS_SOCKET: directSocket,
    REINS_STATE_DIR: join(directDirectory, "state"),
    REINS_ADAPTERS_MODULE: adaptersModule,
    REINS_IDLE_TIMEOUT_MS: "10000",
  };
  runningDaemon = spawn(daemon, [], {
    env: directEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForPresence(directSocket, 5_000);

  const directList = run(cli, ["list"], { env: directEnv });
  assertOutput("direct packed daemon list", directList, {
    status: 0,
    stderr: "",
  });
  if (directList.stdout !== "[]\n")
    throw new Error(
      `Packed daemon returned unexpected output: ${directList.stdout}`,
    );

  const capabilities = run(cli, ["capabilities"], { env: directEnv });
  assertOutput("direct packed daemon capabilities", capabilities, {
    status: 0,
    stderr: "",
  });
  const expectedCapabilities = {
    capabilities: [
      {
        harness: "fixture",
        models: [
          {
            id: "fixture-model",
            displayName: "Fixture model",
            reasoningEfforts: ["low", "high"],
          },
        ],
      },
    ],
    failures: [],
  };
  if (
    JSON.stringify(JSON.parse(capabilities.stdout) as unknown) !==
    JSON.stringify(expectedCapabilities)
  ) {
    throw new Error(
      `Packed capabilities were unexpected: ${capabilities.stdout}`,
    );
  }

  await stopChild(runningDaemon, 5_000);
  runningDaemon = undefined;
  await waitForRemoval(directSocket, 5_000);
  await waitForRemoval(`${directSocket}.lock`, 5_000);

  const automaticDirectory = join(runtimeDirectory, "automatic");
  mkdirSync(automaticDirectory);
  const automaticSocket = join(automaticDirectory, "reins.sock");
  const automaticEnv: NodeJS.ProcessEnv = {
    ...process.env,
    REINS_SOCKET: automaticSocket,
    REINS_STATE_DIR: join(automaticDirectory, "state"),
    REINS_ADAPTERS_MODULE: adaptersModule,
    REINS_IDLE_TIMEOUT_MS: "50",
  };
  delete automaticEnv.REINS_DAEMON_BIN;
  const automaticList = run(cli, ["list"], { env: automaticEnv });
  assertOutput("sibling packed daemon list", automaticList, {
    status: 0,
    stderr: "",
  });
  if (automaticList.stdout !== "[]\n") {
    throw new Error(
      `Sibling daemon returned unexpected output: ${automaticList.stdout}`,
    );
  }
  await waitForRemoval(automaticSocket, 5_000);
  await waitForRemoval(`${automaticSocket}.lock`, 5_000);

  const invalidAdaptersModule = join(temporaryRoot, "invalid-adapters.mjs");
  writeFileSync(invalidAdaptersModule, "export default null;\n");
  const mappedFailure = run(daemon, ["--adapters", invalidAdaptersModule], {
    env: {
      ...process.env,
      NODE_OPTIONS:
        `${process.env.NODE_OPTIONS ?? ""} --enable-source-maps`.trim(),
      REINS_SOCKET: join(runtimeDirectory, "mapped-error.sock"),
      REINS_STATE_DIR: join(runtimeDirectory, "mapped-error-state"),
    },
  });
  if (
    mappedFailure.status === 0 ||
    !mappedFailure.stderr.includes("packages/daemon/src/main.ts:")
  ) {
    throw new Error(
      `Packed source map did not map the daemon stack\n${mappedFailure.stdout}${mappedFailure.stderr}`,
    );
  }

  process.stdout.write("Packed CLI smoke passed\n");
} finally {
  if (runningDaemon !== undefined) {
    await stopChild(runningDaemon, 5_000).catch(() => undefined);
  }
  rmSync(temporaryRoot, { recursive: true, force: true });
}
