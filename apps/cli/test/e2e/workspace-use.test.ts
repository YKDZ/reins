import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const repository = fileURLToPath(new URL("../../../../", import.meta.url));
async function run(
  binary: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
) {
  return await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("normal path-context spawn rejects an unattached worktree without starting a local worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reins-wrr08-unattached-"));
  const runtime = await mkdtemp("/dev/shm/reins-wrr08-manager-");
  try {
    expect((await run("git", ["init", "--quiet"], directory)).code).toBe(0);
    const cwd = join(directory, "src");
    await mkdir(cwd);
    await mkdir(join(directory, ".reins"));
    const image = `sha256:${"a".repeat(64)}`;
    await writeFile(
      join(directory, ".reins", "workspace.json"),
      JSON.stringify({
        environments: [{ provider: "docker", image }],
        runtimes: [{ harness: "codex", version: "0.149.0", image }],
        bindings: [{ ref: "code", harness: "codex" }],
      }),
    );
    const environment = {
      REINS_CONSUMER_CONTEXT: "reins-wrr08-owner",
      REINS_WORKSPACE_MANAGER_SOCKET: join(runtime, "m.sock"),
      REINS_WORKSPACE_MANAGER_STATE_DIR: join(runtime, "state"),
      REINS_WORKSPACE_MANAGER_BIN: join(
        repository,
        "apps/workspace-manager/src/main.ts",
      ),
      REINS_SOCKET: "",
    };
    const catalog = await run(
      process.execPath,
      [
        "--conditions=source",
        join(repository, "apps/cli/src/cli.ts"),
        "workspace",
        "harnesses",
        "-C",
        cwd,
      ],
      repository,
      environment,
    );
    expect(catalog.code, catalog.stdout + catalog.stderr).toBe(0);
    expect(JSON.parse(catalog.stdout).bindings[0].ref).toBe("code");
    const explicitCwd = await run(
      process.execPath,
      [
        "--conditions=source",
        join(repository, "apps/cli/src/cli.ts"),
        "spawn",
        "codex",
        "Read caller-selected target.txt",
        "--cwd",
        cwd,
        "--name",
        "explicit-reader",
      ],
      tmpdir(),
      environment,
    );
    expect(explicitCwd.code, explicitCwd.stdout + explicitCwd.stderr).toBe(65);
    expect(JSON.parse(explicitCwd.stdout).code).toBe("attachment_not_found");
    const result = await run(
      process.execPath,
      [
        "--conditions=source",
        join(repository, "apps/cli/src/cli.ts"),
        "-C",
        cwd,
        "spawn",
        "codex",
        "Read caller-selected target.txt",
        "--name",
        "reader",
      ],
      directory,
      {
        REINS_CONSUMER_CONTEXT: "reins-wrr08-owner",
        REINS_WORKSPACE_MANAGER_SOCKET: join(runtime, "m.sock"),
        REINS_WORKSPACE_MANAGER_STATE_DIR: join(runtime, "state"),
        REINS_WORKSPACE_MANAGER_BIN: join(
          repository,
          "apps/workspace-manager/src/main.ts",
        ),
        REINS_SOCKET: "",
      },
    );
    expect(result.code, result.stdout + result.stderr).toBe(65);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "attachment_not_found",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
});
