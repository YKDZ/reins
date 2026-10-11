import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  symlink,
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
  SelectedFile,
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
    await applySelectedFiles(worktree, material);
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

export type WorkingFileSelection = {
  path: string;
  source: "index" | "worktree";
};
export const MAX_SELECTED_FILES = 1024;
function validSelectedPath(path: string) {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path
      .split("/")
      .every(
        (part) =>
          part !== "" &&
          part !== "." &&
          part !== ".." &&
          part.toLowerCase() !== ".git",
      )
  );
}
// 逐层检查父目录，避免跟随源树或固定提交中的符号链接。
async function selectedParent(root: string, path: string, create: boolean) {
  let parent = root;
  for (const part of path.split("/").slice(0, -1)) {
    parent = join(parent, part);
    try {
      if (!(await lstat(parent)).isDirectory())
        throw new Error("Unsupported selected parent");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (create) await mkdir(parent);
    }
  }
}
async function optionalBytes(path: string) {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return Buffer.alloc(0);
    throw error;
  }
}
async function sourceState(root: string) {
  const gitPath = async (name: string) =>
    (
      await git([
        "-C",
        root,
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        name,
      ])
    )
      .toString()
      .trim();
  for (const name of [
    "MERGE_HEAD",
    "REBASE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
    "index.lock",
  ]) {
    try {
      await lstat(await gitPath(name));
      throw new Error("Unsupported ongoing Git operation");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if ((await git(["-C", root, "ls-files", "--unmerged", "-z"])).length !== 0)
    throw new Error("Unmerged index");
  return {
    head: (await git(["-C", root, "rev-parse", "HEAD"])).toString(),
    index: checksum(await optionalBytes(await gitPath("index"))),
  };
}
async function readSelected(
  root: string,
  commit: string,
  selection: WorkingFileSelection[],
): Promise<SelectedFile[]> {
  const entries: SelectedFile[] = [];
  let total = 0;
  for (const selected of selection) {
    const { path } = selected;
    if (!validSelectedPath(path)) throw new Error("Invalid selected path");
    await selectedParent(root, path, false);
    let mode: "100644" | "100755" | "120000";
    let bytes: Buffer;
    if (selected.source === "index") {
      const entry = (
        await git([
          "-C",
          root,
          "ls-files",
          "--stage",
          "-z",
          "--",
          `:(literal)${path}`,
        ])
      ).toString();
      if (entry === "") {
        if (
          (
            await git([
              "-C",
              root,
              "ls-tree",
              "-z",
              commit,
              "--",
              `:(literal)${path}`,
            ])
          ).length === 0
        )
          throw new Error("Missing selected file");
        entries.push({ path, mode: "delete" });
        continue;
      }
      const match = /^(100644|100755|120000) ([a-f0-9]{40}) 0\t[^\0]+\0$/u.exec(
        entry,
      );
      if (match === null) throw new Error("Unsupported index entry");
      mode = match[1] as typeof mode;
      bytes = await git(["-C", root, "cat-file", "blob", match[2]!]);
    } else if (selected.source === "worktree") {
      const file = join(root, path);
      let info;
      try {
        info = await lstat(file, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const known = await git([
          "-C",
          root,
          "ls-tree",
          "-z",
          commit,
          "--",
          `:(literal)${path}`,
        ]);
        if (
          known.length === 0 &&
          (await git(["-C", root, "ls-files", "-z", "--", `:(literal)${path}`]))
            .length === 0
        )
          throw new Error("Missing selected file");
        entries.push({ path, mode: "delete" });
        continue;
      }
      if (info.isSymbolicLink()) {
        mode = "120000";
        bytes = Buffer.from(await readlink(file));
      } else if (
        info.isFile() &&
        info.nlink === 1n &&
        ((info.mode & 0o7777n) === 0o644n || (info.mode & 0o7777n) === 0o755n)
      ) {
        if (info.size > BigInt(MAX_SOURCE_BYTES))
          throw new Error("Selected source exceeds size limit");
        mode = (info.mode & 0o111n) === 0n ? "100644" : "100755";
        bytes = await readFile(file);
      } else throw new Error("Unsupported selected attributes");
      const after = await lstat(file, { bigint: true });
      if (
        ["dev", "ino", "size", "mode", "mtimeNs", "ctimeNs"].some(
          (key) =>
            info[key as keyof typeof info] !== after[key as keyof typeof after],
        )
      )
        throw new Error("Selected source changed");
    } else throw new Error("Invalid selection source");
    total += bytes.length;
    if (total > MAX_SOURCE_BYTES)
      throw new Error("Selected source exceeds size limit");
    entries.push({ path, mode, contentBase64: bytes.toString("base64") });
  }
  return entries;
}
export async function captureSelectedWorkingFiles(
  repositoryPath: string,
  commit: string,
  selection: WorkingFileSelection[],
): Promise<FixedCommitMaterial> {
  try {
    if (
      selection.length === 0 ||
      selection.length > MAX_SELECTED_FILES ||
      new Set(selection.map((file) => file.path)).size !== selection.length
    )
      throw new Error("Invalid selected files");
    const before = await sourceState(repositoryPath);
    const material = await captureFixedCommit(repositoryPath, commit);
    const selectedFiles = await readSelected(repositoryPath, commit, selection);
    const repeated = await readSelected(repositoryPath, commit, selection);
    if (
      JSON.stringify(selectedFiles) !== JSON.stringify(repeated) ||
      JSON.stringify(before) !==
        JSON.stringify(await sourceState(repositoryPath))
    )
      throw new Error("Selected source changed");
    const result = { ...material, selectedFiles };
    validateSelectedFiles(result);
    return result;
  } catch {
    throw workspaceFailure("source_invalid");
  }
}
function validateSelectedFiles(material: FixedCommitMaterial) {
  const entries = material.selectedFiles ?? [];
  if (
    entries.length > MAX_SELECTED_FILES ||
    new Set(entries.map((file) => file.path)).size !== entries.length
  )
    throw new Error("Invalid selected files");
  let total = Buffer.from(material.packBase64, "base64").length;
  for (const entry of entries) {
    if (!validSelectedPath(entry.path))
      throw new Error("Invalid selected path");
    if (entry.mode === "delete") continue;
    const bytes = Buffer.from(entry.contentBase64, "base64");
    if (
      bytes.toString("base64") !== entry.contentBase64 ||
      !["100644", "100755", "120000"].includes(entry.mode)
    )
      throw new Error("Invalid selected bytes");
    if (
      entry.mode === "120000" &&
      (bytes.length === 0 ||
        bytes.includes(0) ||
        Buffer.from(bytes.toString()).compare(bytes) !== 0)
    )
      throw new Error("Unsupported symlink");
    total += bytes.length;
    if (total > MAX_SOURCE_BYTES)
      throw new Error("Selected source exceeds size limit");
  }
}
async function applySelectedFiles(
  worktree: string,
  material: FixedCommitMaterial,
) {
  validateSelectedFiles(material);
  for (const entry of material.selectedFiles ?? []) {
    await selectedParent(worktree, entry.path, true);
    const file = join(worktree, entry.path);
    try {
      const current = await lstat(file);
      if (!current.isFile() && !current.isSymbolicLink())
        throw new Error("Unsupported selected replacement");
      await rm(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (entry.mode === "delete") continue;
    const bytes = Buffer.from(entry.contentBase64, "base64");
    if (entry.mode === "120000") await symlink(bytes.toString(), file);
    else {
      await writeFile(file, bytes);
      await chmod(file, entry.mode === "100755" ? 0o755 : 0o644);
    }
    const info = await lstat(file);
    const actual =
      entry.mode === "120000"
        ? Buffer.from(await readlink(file))
        : await readFile(file);
    if (
      !actual.equals(bytes) ||
      (entry.mode === "120000"
        ? !info.isSymbolicLink()
        : !info.isFile() ||
          (info.mode & 0o777) !== (entry.mode === "100755" ? 0o755 : 0o644))
    )
      throw new Error("Selected source mismatch");
  }
}
