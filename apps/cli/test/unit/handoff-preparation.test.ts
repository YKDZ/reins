import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createUnixSocketServer } from "@reins/transport";
import type {
  WorkspaceMessage,
  ManagedWorkspaceInfo,
} from "@reins/workspace-protocol";
import { expect, test } from "vitest";

const repository = fileURLToPath(new URL("../../../../", import.meta.url));

test("handoff CLI waits for nested preparation and reports failure with its workspace handle", async () => {
  const directory = await mkdtemp(
    join(
      process.platform === "linux" ? "/dev/shm" : tmpdir(),
      "reins-handoff-cli-",
    ),
  );
  const socket = join(directory, "manager.sock");
  const server = createUnixSocketServer<WorkspaceMessage>({ path: socket });
  const workspaceHandle = "workspace-12345678-1234-1234-1234-123456789abc";
  const failed: ManagedWorkspaceInfo = {
    cwd: "/target/incoming/worktree/src",
    root: "/target/incoming/worktree",
    source: { status: "verified" },
    runtime: { status: "failed", error: { code: "material_unavailable" } },
    harnesses: [],
    environment: { provider: "docker", image: `sha256:${"a".repeat(64)}` },
    environmentFingerprint: "fixed-environment",
    preparation: {
      attempts: [{ status: "failed", error: { code: "material_unavailable" } }],
    },
  };
  // 局部仅验证公开 CLI 的准备结果投影；真实物化与 worker 由 Docker 连续场景证明。
  server.onConnection((connection) =>
    connection.onEvent((event) => {
      if (event.kind !== "message" || event.message.kind !== "request") return;
      const request = event.message;
      let result: unknown;
      if (request.method === "initialize") result = { protocolMajorVersion: 1 };
      else if (request.method === "workspace.handoff")
        result = {
          workspaceHandle,
          workspace: {
            ...failed,
            runtime: { status: "preparing" },
            preparation: { attempts: [{ status: "preparing" }] },
          },
        };
      else if (request.method === "workspace.status") {
        expect(request.params.cwd).toBe(failed.cwd);
        result = failed;
      } else throw new Error("Unexpected workspace request");
      connection.send({
        kind: "response",
        requestId: request.requestId,
        result,
      });
    }),
  );
  try {
    const source = join(directory, "source");
    await mkdir(source);
    execFileSync("git", ["-C", source, "init", "--quiet"]);
    await writeFile(join(source, "input.txt"), "fixed source\n");
    execFileSync("git", ["-C", source, "add", "."]);
    execFileSync("git", [
      "-C",
      source,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixed",
    ]);
    const commit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    await server.listen();
    const actual = await new Promise<{ status: number | null; stdout: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--conditions=source",
            join(repository, "apps/cli/src/cli.ts"),
            "workspace",
            "handoff",
            "--repository",
            source,
            "--commit",
            commit,
            "--subdirectory",
            "src",
            "--binding",
            "code",
          ],
          {
            env: {
              ...process.env,
              REINS_CONSUMER_CONTEXT: "handoff-cli-owner",
              REINS_WORKSPACE_MANAGER_SOCKET: socket,
              REINS_WORKSPACE_MANAGER_STATE_DIR: join(directory, "state"),
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        child.stdout.on("data", (chunk) => (stdout += String(chunk)));
        child.stderr.resume();
        child.once("error", reject);
        child.once("close", (status) => resolve({ status, stdout }));
      },
    );
    expect(actual.status, actual.stdout).toBe(1);
    expect(JSON.parse(actual.stdout)).toEqual({
      workspaceHandle,
      workspace: failed,
    });
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
