import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertReleaseVersionAuthority,
  readJsonObject,
  releaseTarballName,
} from "./release-package.ts";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDirectory = resolve(
  process.env.REINS_ARTIFACTS_DIR ?? join(repository, ".artifacts"),
  "release",
);
const evidenceDirectory = resolve(
  process.env.REINS_RUNTIME_SMOKE_EVIDENCE_DIR ??
    join(repository, ".artifacts", "packed-runtime-smoke"),
);

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const result = spawnSync(command, [...args], {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 300_000,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${label} failed with exit ${result.status ?? 1}\n${result.stdout}${result.stderr}`,
    );
  }
}

function readManifest(path: string): Record<string, unknown> {
  return readJsonObject(join(path, "package.json"));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function createConsumerTypecheck(consumerDirectory: string): void {
  writeFileSync(
    join(consumerDirectory, "consumer.ts"),
    [
      'import { connect } from "@ykdz/reins-sdk";',
      'import { connectReins, type ConnectReinsOptions } from "@ykdz/reins/application";',
      'const options: ConnectReinsOptions = { consumerContext: "packed-runtime-consumer" };',
      "void connect;",
      "void connectReins;",
      "void options;",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(consumerDirectory, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2023",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        files: ["consumer.ts"],
      },
      null,
      2,
    )}\n`,
  );
  run(
    join(repository, "node_modules", ".bin", "tsc"),
    [
      "--project",
      join(consumerDirectory, "tsconfig.json"),
      "--pretty",
      "false",
    ],
    consumerDirectory,
    "installed consumer typecheck",
  );
}

function createRuntimeConsumer(
  consumerDirectory: string,
  daemonPath: string,
  launcherPath: string,
  pidPath: string,
): void {
  writeFileSync(
    launcherPath,
    `#!/bin/sh\nprintf '%s\\n' "$$" > ${shellQuote(pidPath)}\nexec ${shellQuote(daemonPath)} "$@"\n`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(consumerDirectory, "consumer.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import { connect } from "@ykdz/reins-sdk";',
      'import { connectReins } from "@ykdz/reins/application";',
      "",
      "const socketPath = process.env.REINS_SOCKET;",
      'const context = "packed-runtime-consumer";',
      "assert.ok(socketPath);",
      "const application = await connectReins({",
      "  consumerContext: context,",
      "  env: process.env,",
      "  timeoutMs: 10_000,",
      "});",
      "let sdk;",
      "try {",
      "  sdk = await connect({ socketPath, consumerContext: context, timeoutMs: 5_000 });",
      "  assert.equal(sdk.handshake.daemonGeneration, application.handshake.daemonGeneration);",
      '  assert.deepEqual((await sdk.capabilities()).capabilities.map(({ harness }) => harness).sort(), ["capture", "failed", "fake", "hang", "permission", "cancelled"].sort());',
      "  const spawned = await application.spawn(",
      '    { harness: "fake", message: "packed runtime", sessionName: "packed-runtime-session", cwd: process.cwd() },',
      '    application.prepareOperation("spawn"),',
      "  );",
      '  const completed = await sdk.wait({ targets: [spawned.turnHandle], completion: "all", timeoutMs: 5_000 });',
      '  assert.equal(completed.status, "satisfied");',
      '  assert.equal(completed.completed[0]?.finalReply, "ok");',
      "  assert.equal((await sdk.list({ sessionHandle: spawned.sessionHandle }))[0]?.sessionHandle, spawned.sessionHandle);",
      "} finally {",
      "  sdk?.close();",
      "  application.close();",
      "}",
      "",
    ].join("\n"),
  );
}

function stopDaemon(pidPath: string): void {
  if (!existsSync(pidPath)) return;
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ESRCH"
    )
      throw error;
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH")
        return;
      throw error;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ESRCH"
    )
      throw error;
  }
  throw new Error(`Installed daemon did not stop after SIGTERM: ${pid}`);
}

const identity = assertReleaseVersionAuthority(repository);
const runtimeTarball = join(
  artifactDirectory,
  releaseTarballName(identity.name, identity.version),
);
const sdkTarball = join(
  artifactDirectory,
  releaseTarballName("@ykdz/reins-sdk", identity.version),
);
if (!existsSync(runtimeTarball) || !existsSync(sdkTarball)) {
  throw new Error(
    "Build both release tarballs before running the consumer check",
  );
}
if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error(
    "The runtime consumer check requires the published linux-x64 target",
  );
}

const temporaryDirectory = mkdtempSync(
  join(tmpdir(), "reins-runtime-consumer-"),
);
const consumerDirectory = join(temporaryDirectory, "consumer");
const pidPath = join(temporaryDirectory, "daemon.pid");
const socketPath = join(temporaryDirectory, "runtime.sock");
const stateDirectory = join(temporaryDirectory, "state");
const installedRuntimePath = join(
  consumerDirectory,
  "node_modules",
  "@ykdz",
  "reins",
);
const installedSdkPath = join(
  consumerDirectory,
  "node_modules",
  "@ykdz",
  "reins-sdk",
);
const binDirectory = join(consumerDirectory, "node_modules", ".bin");
const daemonPath = join(binDirectory, "reins-daemon");
const launcherPath = join(temporaryDirectory, "daemon-launcher");
const adaptersPath = join(
  repository,
  "packages",
  "runtime",
  "test",
  "e2e",
  "fixtures",
  "fake-adapters.ts",
);
mkdirSync(consumerDirectory, { recursive: true });
mkdirSync(evidenceDirectory, { recursive: true });

let primaryFailure: unknown;
try {
  writeFileSync(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "reins-runtime-consumer",
        version: "0.0.0",
        private: true,
        overrides: { "@ykdz/reins-sdk": "$@ykdz/reins-sdk" },
      },
      null,
      2,
    )}\n`,
  );
  run(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--prefer-offline",
      runtimeTarball,
      sdkTarball,
    ],
    consumerDirectory,
    "clean dual-package install",
  );

  const runtimeManifest = readManifest(installedRuntimePath);
  const sdkManifest = readManifest(installedSdkPath);
  if (
    runtimeManifest.name !== identity.name ||
    runtimeManifest.version !== identity.version ||
    sdkManifest.name !== "@ykdz/reins-sdk" ||
    sdkManifest.version !== identity.version ||
    JSON.stringify(Object.keys(runtimeManifest.bin as object).sort()) !==
      JSON.stringify(["reins-daemon"]) ||
    JSON.stringify(Object.keys(runtimeManifest.exports as object).sort()) !==
      JSON.stringify(["./application"])
  ) {
    throw new Error(
      "Installed packages do not expose the same-version runtime and SDK contracts",
    );
  }
  if (!existsSync(daemonPath))
    throw new Error("Installed daemon machine entry is missing");

  createConsumerTypecheck(consumerDirectory);
  createRuntimeConsumer(consumerDirectory, daemonPath, launcherPath, pidPath);
  run(
    process.execPath,
    [join(consumerDirectory, "consumer.mjs")],
    consumerDirectory,
    "installed runtime and SDK consumer",
    {
      ...process.env,
      REINS_SOCKET: socketPath,
      REINS_STATE_DIR: stateDirectory,
      REINS_DAEMON_BIN: launcherPath,
      REINS_ADAPTERS_MODULE: adaptersPath,
      REINS_IDLE_TIMEOUT_MS: "120000",
    },
  );
} catch (error) {
  primaryFailure = error;
} finally {
  let cleanupFailure: unknown;
  try {
    stopDaemon(pidPath);
  } catch (error) {
    cleanupFailure = error;
  }
  rmSync(temporaryDirectory, { recursive: true, force: true });
  if (primaryFailure !== undefined) {
    if (cleanupFailure !== undefined)
      throw new AggregateError(
        [primaryFailure, cleanupFailure],
        "Consumer check and cleanup failed",
      );
    throw primaryFailure;
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
}

writeFileSync(
  join(evidenceDirectory, "consumer-check.json"),
  `${JSON.stringify(
    {
      runtime: { name: identity.name, version: identity.version },
      sdk: { name: "@ykdz/reins-sdk", version: identity.version },
      checks: [
        "clean-install",
        "public-types",
        "local-startup",
        "daemon-entry",
        "sdk-consumer",
      ],
      result: "passed",
    },
    null,
    2,
  )}\n`,
);
process.stdout.write("Packed runtime consumer check passed\n");
