import { spawn, type ChildProcess } from "node:child_process";
import {
  access,
  appendFile,
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const adaptersModule = join(
  repository,
  "apps/cli/test/e2e/fixtures/fake-adapters.ts",
);
const fixtureDaemon = join(
  repository,
  "apps/cli/test/e2e/fixtures/daemon-fixture.mjs",
);
const cleanupDirectories: string[] = [];
const cleanupProcesses: ChildProcess[] = [];

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
      env: { ...process.env, ...env },
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

async function materializeCleanCheckout(destination: string): Promise<void> {
  const excluded = new Set([
    ".artifacts",
    ".git",
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

describe("checkout-isolated development entry", () => {
  test("builds and runs the current CLI and daemon without falling back to caller runtime paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-development-test-"));
    cleanupDirectories.push(directory);
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
      PNPM_CONFIG_REPORTER: "silent",
      REINS_ADAPTERS_MODULE: adaptersModule,
      REINS_DAEMON_BIN: join(directory, "global-reins-daemon"),
      REINS_DEVELOPMENT_ROOT: join(directory, "development"),
      REINS_SOCKET: globalSocket,
      REINS_STATE_DIR: join(directory, "global-state"),
      REINS_IDLE_TIMEOUT_MS: "200",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      capabilities: expect.arrayContaining([
        expect.objectContaining({ harness: "fake" }),
      ]),
      failures: [],
    });
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

  test("isolates live sessions across clean checkouts and rebuilt output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-development-test-"));
    cleanupDirectories.push(directory);
    const checkoutA = join(directory, "checkout-a");
    const checkoutB = join(directory, "checkout-b");
    await materializeCleanCheckout(checkoutA);
    await materializeCleanCheckout(checkoutB);
    const runtimeRoot = join(directory, "development");
    const baseEnv = {
      PNPM_CONFIG_REPORTER: "silent",
      REINS_DEVELOPMENT_ROOT: runtimeRoot,
      REINS_IDLE_TIMEOUT_MS: "50",
    };
    const envA = {
      ...baseEnv,
      REINS_ADAPTERS_MODULE: join(
        checkoutA,
        "apps/cli/test/e2e/fixtures/fake-adapters.ts",
      ),
    };
    const capabilities = await runDevelopmentCli(
      ["capabilities"],
      envA,
      "",
      checkoutA,
    );
    expect(capabilities.status, capabilities.stderr).toBe(0);
    expect(JSON.parse(capabilities.stdout)).toMatchObject({
      capabilities: expect.arrayContaining([
        expect.objectContaining({ harness: "fake" }),
      ]),
      failures: [],
    });
    const spawned = await runDevelopmentCli(
      ["spawn", "fake", "hello", "--name", "isolated-session"],
      envA,
      "",
      checkoutA,
    );
    expect(spawned.status, spawned.stderr).toBe(0);
    const sessionId = (JSON.parse(spawned.stdout) as { sessionId: string })
      .sessionId;
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
      {
        ...baseEnv,
        REINS_ADAPTERS_MODULE: join(
          checkoutB,
          "apps/cli/test/e2e/fixtures/fake-adapters.ts",
        ),
      },
      "",
      checkoutB,
    );
    expect(fromOtherCheckout.status, fromOtherCheckout.stderr).toBe(0);
    expect(JSON.parse(fromOtherCheckout.stdout)).toEqual([]);

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
    expect(JSON.parse(afterRebuild.stdout)).toEqual([]);

    const killed = await runDevelopmentCli(
      ["kill", sessionId],
      envA,
      "",
      checkoutA,
    );
    expect(killed.status, killed.stderr).toBe(0);
    expect(JSON.parse(killed.stdout)).toEqual([
      { sessionId, status: "not_found" },
    ]);

    const cleanup = await runCommand(
      process.execPath,
      [join(checkoutA, "apps/cli/dist/reins.js"), "kill", sessionId],
      checkoutA,
      {
        ...envA,
        REINS_DAEMON_BIN: join(checkoutA, "packages/daemon/dist/main.js"),
        REINS_SOCKET: join(runtimeRoot, oldRuntimeDirectory, "reins.sock"),
        REINS_STATE_DIR: join(runtimeRoot, oldRuntimeDirectory, "state"),
      },
    );
    expect(cleanup.status, cleanup.stderr).toBe(0);
  }, 240_000);

  test("reuses the same build daemon and its live sessions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-development-test-"));
    cleanupDirectories.push(directory);
    const env = {
      PNPM_CONFIG_REPORTER: "silent",
      REINS_ADAPTERS_MODULE: adaptersModule,
      REINS_DEVELOPMENT_ROOT: join(directory, "development"),
      REINS_IDLE_TIMEOUT_MS: "50",
    };
    const spawned = await runDevelopmentCli(
      ["spawn", "fake", "hello", "--name", "development-session"],
      env,
    );
    expect(spawned.status, spawned.stderr).toBe(0);
    const sessionId = (JSON.parse(spawned.stdout) as { sessionId: string })
      .sessionId;

    const secondSpawn = await runDevelopmentCli(
      ["spawn", "fake", "hello", "--name", "development-session-second"],
      env,
    );
    expect(secondSpawn.status, secondSpawn.stderr).toBe(0);
    const secondSessionId = (
      JSON.parse(secondSpawn.stdout) as { sessionId: string }
    ).sessionId;
    expect(daemonGenerationFromSessionId(secondSessionId)).toBe(
      daemonGenerationFromSessionId(sessionId),
    );

    const listed = await runDevelopmentCli(
      ["list", "--name", "development-session"],
      env,
    );
    expect(listed.status, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([
      expect.objectContaining({ sessionId }),
    ]);

    const killed = await runDevelopmentCli(
      ["kill", sessionId, secondSessionId],
      env,
    );
    expect(killed.status, killed.stderr).toBe(0);
  }, 120_000);

  test("isolates a live daemon when Node resolution conditions change without rebuilding output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-development-test-"));
    cleanupDirectories.push(directory);
    const runtimeRoot = join(directory, "development");
    const baseEnv = {
      PNPM_CONFIG_REPORTER: "silent",
      REINS_ADAPTERS_MODULE: adaptersModule,
      REINS_DEVELOPMENT_ROOT: runtimeRoot,
      REINS_IDLE_TIMEOUT_MS: "50",
    };
    const originalEnv = {
      ...baseEnv,
      NODE_OPTIONS: "--conditions=f04-runtime-a",
    };
    const spawned = await runDevelopmentCli(
      ["spawn", "fake", "hello", "--name", "runtime-session"],
      originalEnv,
    );
    expect(spawned.status, spawned.stderr).toBe(0);
    const sessionId = (JSON.parse(spawned.stdout) as { sessionId: string })
      .sessionId;
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
    const cleanup = await runCommand(
      process.execPath,
      [join(repository, "apps/cli/dist/reins.js"), "kill", sessionId],
      repository,
      {
        ...originalEnv,
        REINS_DAEMON_BIN: join(repository, "packages/daemon/dist/main.js"),
        REINS_SOCKET: join(runtimeRoot, originalRuntimeDirectory, "reins.sock"),
        REINS_STATE_DIR: join(runtimeRoot, originalRuntimeDirectory, "state"),
      },
    );
    expect(cleanup.status, cleanup.stderr).toBe(0);

    expect(listed.status, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([]);
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
      ["--pretty", "capabilities", "--caller-sentinel"],
      {
        NODE_OPTIONS: `--import=${preload}`,
        PNPM_CONFIG_REPORTER: "silent",
        REINS_DEVELOPMENT_ROOT: join(directory, "development"),
        REINS_STDERR_SENTINEL: stderrSentinel,
        REINS_STDIN_RECORD: stdinRecord,
        REINS_STDOUT_SENTINEL: stdoutSentinel,
      },
      sentinel,
    );

    expect(result.status).toBe(64);
    expect(result.stdout).toBe(stdoutSentinel);
    expect(result.stderr).toBe(
      stderrSentinel +
        "error: Unknown option '--caller-sentinel'\n" +
        "suggestion: Allowed: --pretty\n" +
        "usage: reins capabilities [options]\n",
    );
    expect(await readFile(stdinRecord, "utf8")).toBe(sentinel);
  }, 120_000);
});
