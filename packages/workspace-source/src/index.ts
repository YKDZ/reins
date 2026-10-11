import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";

import type { ConsumerContext } from "@reins/protocol";
import type {
  FixedCommitMaterial,
  WorkspaceHandle,
} from "@reins/workspace-protocol";
import type { WorkspaceError } from "@reins/workspace-protocol";
function workspaceFailure(
  code: "source_invalid" | "attachment_not_found",
): WorkspaceError {
  return { code };
}

const execute = promisify(execFile);
export const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const gitEnvironment = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_NO_LAZY_FETCH: "1",
};
async function git(args: string[], input?: Buffer): Promise<Buffer> {
  if (input === undefined)
    return (
      await execute("git", args, {
        env: gitEnvironment,
        encoding: "buffer",
        maxBuffer: MAX_SOURCE_BYTES,
      })
    ).stdout;
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      env: gitEnvironment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_SOURCE_BYTES) child.kill();
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(new Error("Git source operation failed")),
    );
    child.stdin.end(input);
  });
}
function validCommit(commit: string) {
  return /^[a-f0-9]{40}$/u.test(commit);
}
function checksum(pack: Buffer) {
  return createHash("sha256").update(pack).digest("hex");
}
export async function captureFixedCommit(
  repositoryPath: string,
  commit: string,
): Promise<FixedCommitMaterial> {
  try {
    if (!isAbsolute(repositoryPath) || !validCommit(commit))
      throw new Error("Invalid source");
    const root = await realpath(
      (await git(["-C", repositoryPath, "rev-parse", "--show-toplevel"]))
        .toString()
        .trim(),
    );
    if (root !== (await realpath(repositoryPath)))
      throw new Error("One Git root is required");
    const pack = await git(
      ["-C", root, "pack-objects", "--stdout", "--revs"],
      Buffer.from(`${commit}\n`),
    );
    return {
      commit,
      packBase64: pack.toString("base64"),
      sha256: checksum(pack),
    };
  } catch {
    throw workspaceFailure("source_invalid");
  }
}
export async function materializeFixedCommit(
  target: string,
  material: FixedCommitMaterial,
  subdirectory: string,
): Promise<string> {
  let created = false;
  try {
    if (
      !validCommit(material.commit) ||
      isAbsolute(subdirectory) ||
      subdirectory.split(/[\\/]/u).includes("..")
    )
      throw new Error("Invalid source");
    const pack = Buffer.from(material.packBase64, "base64");
    if (
      pack.length === 0 ||
      pack.length > MAX_SOURCE_BYTES ||
      pack.toString("base64") !== material.packBase64 ||
      checksum(pack) !== material.sha256
    )
      throw new Error("Invalid pack");
    await mkdir(target, { recursive: false, mode: 0o700 });
    created = true;
    const objects = join(target, "objects.git");
    await git(["init", "--bare", objects]);
    await git([`--git-dir=${objects}`, "index-pack", "--stdin"], pack);
    await git([
      `--git-dir=${objects}`,
      "fsck",
      "--strict",
      "--no-dangling",
      material.commit,
    ]);
    if (
      (await git([`--git-dir=${objects}`, "cat-file", "-t", material.commit]))
        .toString()
        .trim() !== "commit"
    )
      throw new Error("Not a commit");
    const entries = (
      await git([
        `--git-dir=${objects}`,
        "ls-tree",
        "-r",
        "-z",
        material.commit,
      ])
    )
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const match =
          /^(100644|100755|120000) blob ([a-f0-9]{40})\t([\s\S]+)$/u.exec(
            entry,
          );
        if (match === null) throw new Error("Unsupported Git entry");
        return { mode: match[1]!, object: match[2]!, path: match[3]! };
      });
    const worktree = join(target, "worktree");
    await git([
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.attributesfile=/dev/null",
      "-c",
      "core.hooksPath=/dev/null",
      `--git-dir=${objects}`,
      "worktree",
      "add",
      "--detach",
      worktree,
      material.commit,
    ]);
    for (const entry of entries) {
      const file = join(worktree, entry.path);
      const info = await lstat(file);
      const actual =
        entry.mode === "120000"
          ? Buffer.from(await readlink(file))
          : await readFile(file);
      const expected = await git([
        `--git-dir=${objects}`,
        "cat-file",
        "blob",
        entry.object,
      ]);
      if (
        !actual.equals(expected) ||
        (entry.mode === "120000"
          ? !info.isSymbolicLink()
          : !info.isFile() ||
            ((info.mode & 0o111) !== 0) !== (entry.mode === "100755"))
      )
        throw new Error("Source attributes mismatch");
    }
    const cwd = await realpath(join(worktree, subdirectory));
    const within = relative(worktree, cwd);
    if (
      within === ".." ||
      within.startsWith("../") ||
      !(await lstat(cwd)).isDirectory()
    )
      throw new Error("Invalid source directory");
    return cwd;
  } catch {
    if (created) await rm(target, { recursive: true, force: true });
    throw workspaceFailure("source_invalid");
  }
}
// 只有跨源码现实域的消费者使用本映射；runtime 仍仅消费真实原生路径。
export function openWorkspaceSourceBridge(stateDirectory: string) {
  const directory = join(stateDirectory, "incoming");
  return {
    async receive(
      material: FixedCommitMaterial,
      subdirectory: string,
      consumer: ConsumerContext,
    ) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const workspaceHandle = `workspace-${randomUUID()}` as WorkspaceHandle;
      const target = join(directory, workspaceHandle);
      const cwd = await materializeFixedCommit(target, material, subdirectory);
      await writeFile(
        join(target, "context.json"),
        JSON.stringify({ consumer, cwd }),
        { mode: 0o600 },
      );
      return { workspaceHandle, cwd };
    },
    async locate(
      workspaceHandle: WorkspaceHandle,
      consumer: ConsumerContext,
    ): Promise<string> {
      try {
        if (!/^workspace-[a-f0-9-]{36}$/u.test(workspaceHandle))
          throw new Error("Invalid workspace handle");
        const value = JSON.parse(
          await readFile(
            join(directory, workspaceHandle, "context.json"),
            "utf8",
          ),
        ) as { consumer: string; cwd: string };
        if (value.consumer !== consumer)
          throw new Error("Workspace is outside consumer scope");
        return value.cwd;
      } catch {
        throw workspaceFailure("attachment_not_found");
      }
    },
  };
}
