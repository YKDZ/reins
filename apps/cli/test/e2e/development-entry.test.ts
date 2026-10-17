import { spawn, type ChildProcess } from "node:child_process";
import {
  access,
  appendFile,
  chmod,
  cp,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import {
  controlData,
  killWithControlCli,
  spawnWithControlCli,
  type ControlCliRunner,
} from "./fixtures/control-cli.ts";

const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const codexAppServerFixture = join(
  repository,
  "apps/cli/test/e2e/fixtures/codex-app-server.mjs",
);
const fixtureDaemon = fileURLToPath(
  new URL("./fixtures/daemon-fixture.mjs", import.meta.url),
);
const cleanupDirectories: string[] = [];
const cleanupProcesses: ChildProcess[] = [];

async function createRuntimePath(): Promise<string> {
  // 安装、可执行夹具与 checkout 留在普通临时目录，只有运行状态使用 tmpfs。
  const parent = await mkdtemp(
    join(
      process.platform === "linux" ? "/dev/shm" : tmpdir(),
      "reins-dev-runtime-",
    ),
  );
  cleanupDirectories.push(parent);
  return join(parent, "development");
}

type CommandResult = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
};

function daemonGenerationFromSessionId(sessionId: string): string {
  const match = /@g([a-z0-9]+)$/u.exec(sessionId);
  if (match?.[1] === undefined) {
    throw new Error(`Session ID omitted daemon generation: ${sessionId}`);
  }
  return match[1];
}

function runDevelopmentCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  input = "",
  cwd = repository,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["reins", "--", ...args], {
      cwd,
      // launcher 显式注入消费者绑定；调用方 env 仍可覆盖。
      env: {
        REINS_CONSUMER_CONTEXT: "development-entry",
        ...process.env,
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin.end(input);
    child.once("error", reject);
    child.once("close", (status) => {
      resolve({
        status: status ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (status) => {
      resolve({
        status: status ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

const developmentRunner: ControlCliRunner = (args, env, cwd) =>
  runDevelopmentCli(args, env, "", cwd);

const installedCliRunner: ControlCliRunner = (args, env, cwd) =>
  runCommand(
    process.execPath,
    [join(cwd, "apps/cli/dist/reins.js"), ...args],
    cwd,
    env,
  );

function spawnDevelopment(
  env: NodeJS.ProcessEnv,
  cwd: string,
  sessionName: string,
) {
  return spawnWithControlCli(developmentRunner, env, cwd, {
    sessionName,
    harness: "codex",
    message: "hello",
    cwd,
  });
}

async function materializeCleanCheckout(destination: string): Promise<void> {
  const excluded = new Set([
    ".artifacts",
    ".git",
    ".pnpm-store",
    ".scratch",
    ".turbo",
    "dist",
    "node_modules",
  ]);
  await cp(repository, destination, {
    recursive: true,
    filter: (source) =>
      !source
        .slice(repository.length)
        .split("/")
        .some((part) => excluded.has(part)),
  });
  await symlink(
    join(repository, "node_modules"),
    join(destination, "node_modules"),
  );
  for (const parent of ["adapters", "apps", "packages"] as const) {
    for (const entry of await readdir(join(repository, parent), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const sourceModules = join(
        repository,
        parent,
        entry.name,
        "node_modules",
      );
      try {
        await access(sourceModules);
      } catch {
        continue;
      }
      await symlink(
        sourceModules,
        join(destination, parent, entry.name, "node_modules"),
      );
    }
  }
  for (const args of [
    ["init", "--quiet"],
    ["add", "."],
    [
      "-c",
      "user.name=Reins Test",
      "-c",
      "user.email=reins-test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "candidate",
    ],
  ] as const) {
    const result = await runCommand("git", args, destination);
    if (result.status !== 0) throw new Error(result.stderr);
  }
  const status = await runCommand(
    "git",
    ["status", "--porcelain"],
    destination,
  );
  if (status.status !== 0 || status.stdout !== "") {
    throw new Error(
      `Temporary checkout is not clean: ${status.stdout}${status.stderr}`,
    );
  }
}

afterEach(async () => {
  for (const child of cleanupProcesses.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  await Promise.all(
    cleanupDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      await access(path);
      return;
    } catch {
      if (Date.now() >= deadline)
        throw new Error(`Timed out waiting for ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function installCodexFixture(
  directory: string,
  binName = "bin",
): Promise<{ readonly binary: string; readonly path: string }> {
  const bin = join(directory, binName);
  const binary = join(bin, "codex");
  await mkdir(bin, { recursive: true });
  await copyFile(codexAppServerFixture, binary);
  await chmod(binary, 0o755);
  return {
    binary,
    path:
      process.env.PATH === undefined
        ? bin
        : `${bin}${delimiter}${process.env.PATH}`,
  };
}

describe("checkout-isolated development entry", () => {
  test("builds and runs the current CLI and daemon without falling back to caller runtime paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-development-test-"));
    cleanupDirectories.push(directory);
    const codex = await installCodexFixture(directory);
    const globalSocket = join(directory, "global.sock");
    const globalDaemon = spawn(process.execPath, [fixtureDaemon], {
      env: {
        ...process.env,
        REINS_FIXTURE_DAEMON_MODE: "invalid-envelope",
        REINS_SOCKET: globalSocket,
      },
      stdio: "ignore",
    });
    cleanupProcesses.push(globalDaemon);
    await waitForPath(globalSocket);
    const result = await runDevelopmentCli(["capabilities"], {
      PATH: codex.path,
      PNPM_CONFIG_REPORTER: "silent",
      REINS_DAEMON_BIN: join(directory, "global-reins-daemon"),
      REINS_DEVELOPMENT_ROOT: await createRuntimePath(),
      REINS_SOCKET: globalSocket,
      REINS_STATE_DIR: join(directory, "global-state"),
      REINS_IDLE_TIMEOUT_MS: "200",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(controlData(result).capabilities).toEqual(
      expect.arrayContaining([expect.objectContaining({ harness: "codex" })]),
    );
    expect(result.stderr).toBe("");
  }, 120_000);

  test("fails closed when its checkout runtime cannot be created", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-development-test-"));
    cleanupDirectories.push(directory);
    const globalSocket = join(directory, "global.sock");
    const requests = join(directory, "global-requests.txt");
    const globalDaemon = spawn(process.execPath, [fixtureDaemon], {
      env: {
        ...process.env,
        REINS_FIXTURE_DAEMON_MODE: "invalid-envelope",
        REINS_FIXTURE_REQUESTS_FILE: requests,
        REINS_SOCKET: globalSocket,
      },
      stdio: "ignore",
    });
    cleanupProcesses.push(globalDaemon);
    await waitForPath(globalSocket);
    const unavailableRoot = join(directory, "not-a-directory");
    await writeFile(unavailableRoot, "occupied\n");

    const result = await runDevelopmentCli(["capabilities"], {
      PNPM_CONFIG_REPORTER: "silent",
      REINS_DEVELOPMENT_ROOT: unavailableRoot,
      REINS_SOCKET: globalSocket,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(
      /^Failed to run the development CLI: ENOTDIR:/u,
    );
    expect(await pathExists(requests)).toBe(false);
  }, 120_000);

  test("rejects an adapter override before selecting a development runtime", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-development-test-"));
    cleanupDirectories.push(directory);
    const globalSocket = join(directory, "global.sock");
    const requests = join(directory, "global-requests.txt");
    const globalDaemon = spawn(process.execPath, [fixtureDaemon], {
      env: {
        ...process.env,
        REINS_FIXTURE_DAEMON_MODE: "invalid-envelope",
        REINS_FIXTURE_REQUESTS_FILE: requests,
        REINS_SOCKET: globalSocket,
      },
      stdio: "ignore",
    });
    cleanupProcesses.push(globalDaemon);
    await waitForPath(globalSocket);
    const developmentRoot = await createRuntimePath();
    const result = await runDevelopmentCli(["capabilities"], {
      PNPM_CONFIG_REPORTER: "silent",
      REINS_ADAPTERS_MODULE: join(directory, "opaque-adapters.mjs"),
      REINS_DEVELOPMENT_ROOT: developmentRoot,
      REINS_SOCKET: globalSocket,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Failed to run the development CLI: REINS_ADAPTERS_MODULE is not supported by the development CLI\n",
    );
    expect(await pathExists(requests)).toBe(false);
    expect(await pathExists(developmentRoot)).toBe(false);
  }, 120_000);

  test("isolates live sessions across clean checkouts and rebuilt output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-development-test-"));
    cleanupDirectories.push(directory);
    const codex = await installCodexFixture(directory);
    const checkoutA = join(directory, "checkout-a");
    const checkoutB = join(directory, "checkout-b");
    await materializeCleanCheckout(checkoutA);
    await materializeCleanCheckout(checkoutB);
    const runtimeRoot = await createRuntimePath();
    const baseEnv = {
      PATH: codex.path,
      PNPM_CONFIG_REPORTER: "silent",
      REINS_DEVELOPMENT_ROOT: runtimeRoot,
      REINS_IDLE_TIMEOUT_MS: "30000",
    };
    const envA = { ...baseEnv };
    const capabilities = await runDevelopmentCli(
      ["capabilities"],
      envA,
      "",
      checkoutA,
    );
    expect(capabilities.status, capabilities.stderr).toBe(0);
    expect(controlData(capabilities).capabilities).toEqual(
      expect.arrayContaining([expect.objectContaining({ harness: "codex" })]),
    );
    const spawned = await spawnDevelopment(envA, checkoutA, "isolated-session");
    expect(spawned.status, spawned.stderr).toBe(0);
    const sessionId = controlData(spawned).sessionHandle as string;
    const oldRuntimeDirectory = (
      await readdir(runtimeRoot, {
        withFileTypes: true,
      })
    ).find((entry) => entry.isDirectory())?.name;
    if (oldRuntimeDirectory === undefined) {
      throw new Error("Development runtime directory was not created");
    }

    const fromOtherCheckout = await runDevelopmentCli(
      ["list", "--name", "isolated-session"],
      baseEnv,
      "",
      checkoutB,
    );
    expect(fromOtherCheckout.status, fromOtherCheckout.stderr).toBe(0);
    expect(controlData(fromOtherCheckout).sessions).toEqual([]);

    await appendFile(
      join(checkoutA, "apps/cli/src/cli.ts"),
      "\nvoid process.env.REINS_BUILD_IDENTITY_SENTINEL;\n",
    );
    const afterRebuild = await runDevelopmentCli(
      ["list", "--name", "isolated-session"],
      envA,
      "",
      checkoutA,
    );
    expect(afterRebuild.status, afterRebuild.stderr).toBe(0);
    expect(controlData(afterRebuild).sessions).toEqual([]);

    const killed = await killWithControlCli(
      developmentRunner,
      envA,
      checkoutA,
      sessionId,
    );
    expect(killed.status, killed.stderr).toBe(0);
    expect(controlData(killed)).toEqual({
      sessionHandle: sessionId,
      status: "not_found",
    });

    const cleanupEnv = {
      ...envA,
      REINS_CONSUMER_CONTEXT: "development-entry",
      REINS_DAEMON_BIN: join(checkoutA, "packages/daemon/dist/main.js"),
      REINS_SOCKET: join(runtimeRoot, oldRuntimeDirectory, "reins.sock"),
      REINS_STATE_DIR: join(runtimeRoot, oldRuntimeDirectory, "state"),
    };
    const cleanup = await killWithControlCli(
      installedCliRunner,
      cleanupEnv,
      checkoutA,
      sessionId,
    );
    expect(cleanup.status, cleanup.stderr).toBe(0);
    expect(controlData(cleanup).status).toBe("killed");
  }, 240_000);

  test("reuses the same build daemon and its live sessions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-development-test-"));
    cleanupDirectories.push(directory);
    const codex = await installCodexFixture(directory);
    const env = {
      PATH: codex.path,
      PNPM_CONFIG_REPORTER: "silent",
      REINS_DEVELOPMENT_ROOT: await createRuntimePath(),
      REINS_IDLE_TIMEOUT_MS: "30000",
    };
    const spawned = await spawnDevelopment(
      env,
      repository,
      "development-session",
    );
    expect(spawned.status, spawned.stderr).toBe(0);
    const sessionId = controlData(spawned).sessionHandle as string;

    const originalBinary = await readFile(codex.binary, "utf8");
    await writeFile(
      codex.binary,
      originalBinary.replace("fixture-model", "fixture-model-changed"),
    );
    const capabilities = await runDevelopmentCli(["capabilities"], env);
    expect(capabilities.status, capabilities.stderr).toBe(0);
    expect(controlData(capabilities).capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          harness: "codex",
          models: expect.arrayContaining([
            expect.objectContaining({ id: "fixture-model-changed" }),
          ]),
        }),
      ]),
    );

    const secondSpawn = await spawnDevelopment(
      env,
      repository,
      "development-session-second",
    );
    expect(secondSpawn.status, secondSpawn.stderr).toBe(0);
    const secondSessionId = controlData(secondSpawn).sessionHandle as string;
    expect(daemonGenerationFromSessionId(secondSessionId)).toBe(
      daemonGenerationFromSessionId(sessionId),
    );

    const listed = await runDevelopmentCli(["list"], env);
    expect(listed.status, listed.stderr).toBe(0);
    const sessions = controlData(listed).sessions as Record<string, unknown>[];
    expect(sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionHandle: sessionId,
          sessionName: "development-session",
        }),
        expect.objectContaining({
          sessionHandle: secondSessionId,
          sessionName: "development-session-second",
        }),
      ]),
    );
    expect(sessions).toHaveLength(2);

    for (const target of [sessionId, secondSessionId]) {
      const killed = await killWithControlCli(
        developmentRunner,
        env,
        repository,
        target,
      );
      expect(killed.status, killed.stderr).toBe(0);
      expect(controlData(killed)).toEqual({
        sessionHandle: target,
        status: "killed",
      });
    }
  }, 120_000);

  test("isolates a live daemon when PATH changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-development-test-"));
    cleanupDirectories.push(directory);
    const codexA = await installCodexFixture(directory, "bin-a");
    const codexB = await installCodexFixture(directory, "bin-b");
    const runtimeRoot = await createRuntimePath();
    const originalEnv = {
      PATH: codexA.path,
      PNPM_CONFIG_REPORTER: "silent",
      REINS_DEVELOPMENT_ROOT: runtimeRoot,
      REINS_IDLE_TIMEOUT_MS: "30000",
    };
    const spawned = await spawnDevelopment(
      originalEnv,
      repository,
      "path-session",
    );
    expect(spawned.status, spawned.stderr).toBe(0);
    const sessionId = controlData(spawned).sessionHandle as string;
    const originalRuntimeDirectory = (
      await readdir(runtimeRoot, { withFileTypes: true })
    ).find((entry) => entry.isDirectory())?.name;
    if (originalRuntimeDirectory === undefined) {
      throw new Error("Development runtime directory was not created");
    }

    const listed = await runDevelopmentCli(["list", "--name", "path-session"], {
      ...originalEnv,
      PATH: codexB.path,
    });
    const cleanupEnv = {
      ...originalEnv,
      REINS_CONSUMER_CONTEXT: "development-entry",
      REINS_DAEMON_BIN: join(repository, "packages/daemon/dist/main.js"),
      REINS_SOCKET: join(runtimeRoot, originalRuntimeDirectory, "reins.sock"),
      REINS_STATE_DIR: join(runtimeRoot, originalRuntimeDirectory, "state"),
    };
    const cleanup = await killWithControlCli(
      installedCliRunner,
      cleanupEnv,
      repository,
      sessionId,
    );
    expect(cleanup.status, cleanup.stderr).toBe(0);
    expect(controlData(cleanup).status).toBe("killed");

    expect(listed.status, listed.stderr).toBe(0);
    expect(controlData(listed).sessions).toEqual([]);
  }, 120_000);

  test("isolates a live daemon when Node resolution conditions change without rebuilding output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-development-test-"));
    cleanupDirectories.push(directory);
    const codex = await installCodexFixture(directory);
    const runtimeRoot = await createRuntimePath();
    const baseEnv = {
      PATH: codex.path,
      PNPM_CONFIG_REPORTER: "silent",
      REINS_DEVELOPMENT_ROOT: runtimeRoot,
      REINS_IDLE_TIMEOUT_MS: "30000",
    };
    const originalEnv = {
      ...baseEnv,
      NODE_OPTIONS: "--conditions=f04-runtime-a",
    };
    const spawned = await spawnDevelopment(
      originalEnv,
      repository,
      "runtime-session",
    );
    expect(spawned.status, spawned.stderr).toBe(0);
    const sessionId = controlData(spawned).sessionHandle as string;
    const originalRuntimeDirectory = (
      await readdir(runtimeRoot, { withFileTypes: true })
    ).find((entry) => entry.isDirectory())?.name;
    if (originalRuntimeDirectory === undefined) {
      throw new Error("Development runtime directory was not created");
    }

    const listed = await runDevelopmentCli(
      ["list", "--name", "runtime-session"],
      {
        ...baseEnv,
        NODE_OPTIONS: "--conditions=f04-runtime-b",
      },
    );
    const cleanupEnv = {
      ...originalEnv,
      REINS_CONSUMER_CONTEXT: "development-entry",
      REINS_DAEMON_BIN: join(repository, "packages/daemon/dist/main.js"),
      REINS_SOCKET: join(runtimeRoot, originalRuntimeDirectory, "reins.sock"),
      REINS_STATE_DIR: join(runtimeRoot, originalRuntimeDirectory, "state"),
    };
    const cleanup = await killWithControlCli(
      installedCliRunner,
      cleanupEnv,
      repository,
      sessionId,
    );
    expect(cleanup.status, cleanup.stderr).toBe(0);
    expect(controlData(cleanup).status).toBe("killed");

    expect(listed.status, listed.stderr).toBe(0);
    expect(controlData(listed).sessions).toEqual([]);
  }, 120_000);

  test("preserves stdin, stdout, stderr, arguments, and a non-zero exit code", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-development-test-"));
    cleanupDirectories.push(directory);
    const stdinRecord = join(directory, "stdin.txt");
    const preload = join(
      repository,
      "apps/cli/test/e2e/fixtures/record-cli-stdin.mjs",
    );
    const sentinel = "caller stdin sentinel\nsecond line\n";
    const stdoutSentinel = "cli stdout sentinel\n";
    const stderrSentinel = "cli stderr sentinel\n";
    const result = await runDevelopmentCli(
      ["capabilities", "--caller-sentinel"],
      {
        NODE_OPTIONS: `--import=${preload}`,
        PNPM_CONFIG_REPORTER: "silent",
        REINS_DEVELOPMENT_ROOT: await createRuntimePath(),
        REINS_STDERR_SENTINEL: stderrSentinel,
        REINS_STDIN_RECORD: stdinRecord,
        REINS_STDOUT_SENTINEL: stdoutSentinel,
      },
      sentinel,
    );

    expect(result.status).toBe(64);
    expect(result.stdout).toBe(stdoutSentinel);
    expect(result.stderr).toContain(stderrSentinel);
    expect(result.stderr).toContain("--caller-sentinel");
    expect(await readFile(stdinRecord, "utf8")).toBe(sentinel);
  }, 120_000);
});
