import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import type { Publication } from "@reins/workspace-protocol";

const execute = promisify(execFile);
type ObjectCounts = { loose: number; packed: number; packs: number };
export type GitImportChanges = {
  repository: string;
  reference: string;
  objectWriteAttempted: boolean;
  referenceCreated: boolean;
  objectDatabaseBefore?: ObjectCounts;
  objectDatabaseAfter?: ObjectCounts;
};
export type GitImportResult = GitImportChanges & {
  publication: Publication;
  commit: string;
};
export async function importGitPublication(
  payload: { publication: Publication; contentBase64: string },
  options: { repository: string; reference: string; commit: string },
): Promise<GitImportResult> {
  const changes: GitImportChanges = {
    repository: options.repository,
    reference: options.reference,
    objectWriteAttempted: false,
    referenceCreated: false,
  };
  let temporary: string | undefined;
  const git = async (args: string[]) =>
    (
      await execute("git", ["-C", changes.repository, ...args], {
        encoding: "utf8",
      })
    ).stdout.trim();
  const counts = async (): Promise<ObjectCounts> => {
    const values = Object.fromEntries(
      (await git(["count-objects", "-v"]))
        .split("\n")
        .map((line) => line.split(": ")),
    );
    return {
      loose: Number(values.count),
      packed: Number(values["in-pack"]),
      packs: Number(values.packs),
    };
  };
  const symbolicReference = (reference: string) =>
    git(["symbolic-ref", "--quiet", reference]).catch((error: unknown) => {
      if ((error as { code?: number }).code === 1) return undefined;
      throw error;
    });
  const createReference = async () => {
    const transaction = execute(
      "git",
      ["-C", changes.repository, "update-ref", "--stdin"],
      { encoding: "utf8" },
    );
    transaction.child.stdin!.on("error", () => {});
    let prepared = false;
    const ready = new Promise<void>((resolve, reject) => {
      let output = "";
      transaction.child.stdout!.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("prepare: ok\n")) {
          prepared = true;
          resolve();
        }
      });
      void transaction.then(() => {
        if (!prepared)
          reject(new Error("Reference transaction did not prepare"));
      }, reject);
    });
    transaction.child.stdin!.write(
      `start\noption no-deref\ncreate ${options.reference} ${options.commit}\nprepare\n`,
    );
    try {
      await ready;
      // prepare 持有 Git 自身的引用锁；此时检查空目标的符号引用也不会留下竞争窗口。
      const symbolic = await symbolicReference(options.reference);
      if (symbolic !== undefined)
        throw new Error("The target symbolic reference already exists");
      transaction.child.stdin!.end("commit\n");
      await transaction;
    } catch (error) {
      if (!transaction.child.stdin!.writableEnded)
        transaction.child.stdin!.end("abort\n");
      await transaction.catch(() => {});
      throw error;
    }
  };
  try {
    if (
      !isAbsolute(options.repository) ||
      !options.reference.startsWith("refs/") ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(options.commit)
    )
      throw new Error(
        "An absolute repository, full reference and commit object name are required",
      );
    changes.repository = await realpath(options.repository);
    await git(["rev-parse", "--git-dir"]);
    await git(["check-ref-format", options.reference]);
    if ((await symbolicReference("HEAD")) === options.reference)
      throw new Error("The target reference is the current branch");
    // 空旧值是 Git 的 compare-and-create；预查只减少已存在引用时的对象写入。
    if (
      (await git(["for-each-ref", "--format=%(refname)", options.reference]))
        .split("\n")
        .includes(options.reference)
    )
      throw new Error("The target reference already exists");
    const content = Buffer.from(payload.contentBase64, "base64");
    if (
      content.length !== payload.publication.bytes ||
      createHash("sha256").update(content).digest("hex") !==
        payload.publication.sha256
    )
      throw new Error("Publication payload does not match");
    temporary = await mkdtemp(join(tmpdir(), "reins-git-import-"));
    const bundle = join(temporary, "publication.bundle");
    await writeFile(bundle, content, { mode: 0o600 });
    await git(["bundle", "verify", bundle]);
    const heads = await git(["bundle", "list-heads", bundle]);
    if (
      !heads.split("\n").some((line) => line.split(" ")[0] === options.commit)
    )
      throw new Error("The selected commit is not advertised by the bundle");
    changes.objectDatabaseBefore = await counts();
    changes.objectWriteAttempted = true;
    await git(["bundle", "unbundle", bundle]);
    if ((await git(["cat-file", "-t", options.commit])) !== "commit")
      throw new Error("The selected object is not a commit");
    await git([
      "rev-list",
      "--objects",
      "--quiet",
      "--missing=error",
      options.commit,
    ]);
    await createReference();
    changes.referenceCreated = true;
    changes.objectDatabaseAfter = await counts();
    return {
      ...changes,
      publication: payload.publication,
      commit: options.commit,
    };
  } catch (error) {
    if (changes.objectWriteAttempted) {
      const after = await counts().catch(() => undefined);
      if (after !== undefined) changes.objectDatabaseAfter = after;
    }
    throw {
      code: "git_import_failed",
      detail: error instanceof Error ? error.message : "Git import failed",
      gitImport: changes,
    };
  } finally {
    if (temporary !== undefined)
      await rm(temporary, { recursive: true, force: true });
  }
}
