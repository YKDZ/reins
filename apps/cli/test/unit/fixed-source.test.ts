import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  chmod,
  symlink,
  readlink,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  captureFixedCommit,
  materializeFixedCommit,
} from "@reins/workspace-source";
import { expect, test } from "vitest";

test("moves one fixed commit into an independent ordinary Git worktree with exact attributes", async () => {
  const base = await mkdtemp(join(tmpdir(), "reins-source-test-"));
  const source = join(base, "caller");
  const target = join(base, "target");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
  try {
    await mkdir(join(source, "src"), { recursive: true });
    git("init", "--quiet");
    await writeFile(join(source, "src", "input"), "fixed bytes\n");
    await writeFile(join(source, "run"), "#!/bin/sh\nexit 0\n");
    await chmod(join(source, "run"), 0o755);
    await symlink("input", join(source, "src", "link"));
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixed",
    );
    const commit = git("rev-parse", "HEAD");
    const material = await captureFixedCommit(source, commit);
    await writeFile(join(source, "src", "input"), "caller changed\n");
    const cwd = await materializeFixedCommit(target, material, "src");
    expect(await readFile(join(cwd, "input"), "utf8")).toBe("fixed bytes\n");
    expect(await readlink(join(cwd, "link"))).toBe("input");
    expect((await stat(join(target, "worktree", "run"))).mode & 0o111).not.toBe(
      0,
    );
    expect(
      execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
    ).toBe(commit);
    expect(await readFile(join(target, "worktree", ".git"), "utf8")).toMatch(
      /^gitdir: /u,
    );
    await expect(
      materializeFixedCommit(target, material, "src"),
    ).rejects.toMatchObject({ code: "source_invalid" });
    expect(await readFile(join(cwd, "input"), "utf8")).toBe("fixed bytes\n");
    for (const invalid of [
      { ...material, packBase64: "" },
      { ...material, commit: "f".repeat(40) },
    ]) {
      await expect(
        materializeFixedCommit(join(base, "rejected"), invalid, "src"),
      ).rejects.toMatchObject({ code: "source_invalid" });
      await expect(stat(join(base, "rejected"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    await expect(
      captureFixedCommit(join(source, "src"), commit),
    ).rejects.toMatchObject({ code: "source_invalid" });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}, 30_000);
