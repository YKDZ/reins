import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const image =
  "node@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";

function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
) {
  return new Promise<{ status: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.once("error", reject);
      child.once("close", (status) =>
        resolve({ status: status ?? 1, stdout, stderr }),
      );
    },
  );
}

test("discovers explicit bindings and pinned material before attaching a real worktree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reins-wrr02-catalog-"));
  try {
    expect((await run("git", ["init", "--quiet"], directory)).status).toBe(0);
    await mkdir(join(directory, ".reins"));
    await mkdir(join(directory, "src"));
    await writeFile(
      join(directory, ".reins", "workspace.json"),
      JSON.stringify({
        environments: [{ provider: "docker", image }],
        runtimes: [{ harness: "codex", version: "0.149.0", image }],
        bindings: [{ ref: "code", harness: "codex" }],
      }),
    );
    const result = await run(
      process.execPath,
      [
        "--conditions=source",
        join(repository, "apps/cli/src/cli.ts"),
        "workspace",
        "harnesses",
        "-C",
        join(directory, "src"),
      ],
      directory,
      {
        REINS_CONSUMER_CONTEXT: "reins-wrr02-catalog",
        REINS_WORKSPACE_MANAGER_SOCKET: join(directory, "manager.sock"),
        REINS_WORKSPACE_MANAGER_STATE_DIR: join(directory, "state"),
        REINS_WORKSPACE_MANAGER_BIN: join(
          repository,
          "apps/workspace-manager/src/main.ts",
        ),
      },
    );
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      environment: { provider: "docker", image },
      environmentFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      bindings: [
        {
          ref: "code",
          harness: "codex",
          credential: { kind: "omitted" },
          runtime: { version: "0.149.0", image },
          runtimeFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
          supportBundle: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
          compatibility: "supported",
        },
      ],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  ["missing environment", { environments: [] }, "environment_binding_missing"],
  ["missing runtime", { runtimes: [] }, "runtime_definition_missing"],
  [
    "ambiguous runtime",
    {
      runtimes: [
        { harness: "codex", version: "0.149.0", image },
        { harness: "codex", version: "0.150.0", image },
      ],
    },
    "runtime_definition_ambiguous",
  ],
  [
    "unpinned material",
    { environments: [{ provider: "docker", image: "node:latest" }] },
    "configuration_invalid",
  ],
] as const)(
  "rejects %s before preparing a provider",
  async (_name, changes, code) => {
    const directory = await mkdtemp(join(tmpdir(), "reins-wrr02-definition-"));
    try {
      await run("git", ["init", "--quiet"], directory);
      await mkdir(join(directory, ".reins"));
      await writeFile(
        join(directory, ".reins", "workspace.json"),
        JSON.stringify({
          environments: [{ provider: "docker", image }],
          runtimes: [{ harness: "codex", version: "0.149.0", image }],
          bindings: [{ ref: "code", harness: "codex" }],
          ...changes,
        }),
      );
      const result = await run(
        process.execPath,
        [
          "--conditions=source",
          join(repository, "apps/cli/src/cli.ts"),
          "workspace",
          "harnesses",
          "-C",
          directory,
        ],
        directory,
        {
          REINS_CONSUMER_CONTEXT: "reins-wrr02-definition",
          REINS_WORKSPACE_MANAGER_SOCKET: join(directory, "manager.sock"),
          REINS_WORKSPACE_MANAGER_STATE_DIR: join(directory, "state"),
          REINS_WORKSPACE_MANAGER_BIN: join(
            repository,
            "apps/workspace-manager/src/main.ts",
          ),
        },
      );
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({ code });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("refuses an ambiguous project environment without selecting a fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reins-wrr02-ambiguous-"));
  try {
    await run("git", ["init", "--quiet"], directory);
    await mkdir(join(directory, ".reins"));
    await writeFile(
      join(directory, ".reins", "workspace.json"),
      JSON.stringify({
        environments: [
          { provider: "docker", image },
          { provider: "docker", image },
        ],
        runtimes: [{ harness: "codex", version: "0.149.0", image }],
        bindings: [{ ref: "code", harness: "codex" }],
      }),
    );
    const result = await run(
      process.execPath,
      [
        "--conditions=source",
        join(repository, "apps/cli/src/cli.ts"),
        "workspace",
        "harnesses",
        "-C",
        directory,
      ],
      directory,
      {
        REINS_CONSUMER_CONTEXT: "reins-wrr02-ambiguous",
        REINS_WORKSPACE_MANAGER_SOCKET: join(directory, "manager.sock"),
        REINS_WORKSPACE_MANAGER_STATE_DIR: join(directory, "state"),
        REINS_WORKSPACE_MANAGER_BIN: join(
          repository,
          "apps/workspace-manager/src/main.ts",
        ),
      },
    );
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      code: "environment_binding_ambiguous",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects attaching a directory that is not a native Git worktree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reins-wrr02-non-git-"));
  try {
    const result = await run(
      process.execPath,
      [
        "--conditions=source",
        join(repository, "apps/cli/src/cli.ts"),
        "workspace",
        "attach",
        "-C",
        directory,
        "--binding",
        "code",
      ],
      directory,
      {
        REINS_CONSUMER_CONTEXT: "reins-wrr02-non-git",
        REINS_WORKSPACE_MANAGER_SOCKET: join(directory, "manager.sock"),
        REINS_WORKSPACE_MANAGER_STATE_DIR: join(directory, "state"),
        REINS_WORKSPACE_MANAGER_BIN: join(
          repository,
          "apps/workspace-manager/src/main.ts",
        ),
      },
    );
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ code: "invalid_directory" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("returns the finite configured binding choices when attachment names an unknown binding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reins-wrr02-binding-"));
  try {
    await run("git", ["init", "--quiet"], directory);
    await mkdir(join(directory, ".reins"));
    await writeFile(
      join(directory, ".reins", "workspace.json"),
      JSON.stringify({
        environments: [{ provider: "docker", image }],
        runtimes: [{ harness: "codex", version: "0.149.0", image }],
        bindings: [{ ref: "code", harness: "codex" }],
      }),
    );
    const result = await run(
      process.execPath,
      [
        "--conditions=source",
        join(repository, "apps/cli/src/cli.ts"),
        "workspace",
        "attach",
        "-C",
        directory,
        "--binding",
        "missing",
      ],
      directory,
      {
        REINS_CONSUMER_CONTEXT: "reins-wrr02-binding",
        REINS_WORKSPACE_MANAGER_SOCKET: join(directory, "manager.sock"),
        REINS_WORKSPACE_MANAGER_STATE_DIR: join(directory, "state"),
        REINS_WORKSPACE_MANAGER_BIN: join(
          repository,
          "apps/workspace-manager/src/main.ts",
        ),
      },
    );
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      code: "binding_unknown",
      availableBindings: ["code"],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
