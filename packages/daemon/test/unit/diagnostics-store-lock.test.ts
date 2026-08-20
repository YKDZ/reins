import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  acquireAdvisoryFileLease,
  AdvisoryLockCompromisedError,
  AdvisoryLockSystemError,
  AdvisoryLockUnavailableError,
} from "../../src/diagnostics-store-lock.ts";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reins-lock-test-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("advisory file lease", () => {
  test("has no PATH or external binary dependency", async () => {
    const directory = await temporaryDirectory();
    const previousPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const lease = await acquireAdvisoryFileLease(join(directory, "writer"));
      await lease.close();
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test("does not follow or chmod a symlink lock target", async () => {
    const directory = await temporaryDirectory();
    const external = join(directory, "external.txt");
    const target = join(directory, "writer");
    await writeFile(external, "unchanged", { mode: 0o644 });
    await chmod(external, 0o644);
    await symlink(external, target);

    const lease = await acquireAdvisoryFileLease(target);
    try {
      expect((await lstat(external)).mode & 0o777).toBe(0o644);
      expect(await readFile(external, "utf8")).toBe("unchanged");
    } finally {
      await lease.close();
    }
  });

  test("rejects a symbolic lock directory without touching its external target", async () => {
    const directory = await temporaryDirectory();
    const external = join(directory, "external.txt");
    const target = join(directory, "writer");
    await writeFile(external, "unchanged", { mode: 0o644 });
    await chmod(external, 0o644);
    await symlink(external, `${target}.lock`);

    await expect(acquireAdvisoryFileLease(target)).rejects.toBeInstanceOf(
      AdvisoryLockUnavailableError,
    );
    expect((await lstat(external)).mode & 0o777).toBe(0o644);
    expect(await readFile(external, "utf8")).toBe("unchanged");
  });

  test("canonicalizes parent aliases and bounds contention waits", async () => {
    const directory = await temporaryDirectory();
    const real = join(directory, "real");
    const alias = join(directory, "alias");
    await mkdir(real);
    await symlink(real, alias);
    const first = await acquireAdvisoryFileLease(join(real, "writer"));
    try {
      const started = Date.now();
      await expect(
        acquireAdvisoryFileLease(join(alias, "writer"), {
          timeoutMs: 50,
          retryDelayMs: 5,
        }),
      ).rejects.toBeInstanceOf(AdvisoryLockUnavailableError);
      expect(Date.now() - started).toBeLessThan(500);

      const controller = new AbortController();
      controller.abort(new DOMException("Cancelled", "AbortError"));
      await expect(
        acquireAdvisoryFileLease(join(alias, "writer"), {
          timeoutMs: 10_000,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      await first.close();
    }
  });

  test("fails closed and does not clean a replacement lock inode", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "writer");
    const lease = await acquireAdvisoryFileLease(target, {
      closeTimeoutMs: 500,
    });
    try {
      await rm(`${target}.lock`, { recursive: true });
      await mkdir(`${target}.lock`);
      await writeFile(join(`${target}.lock`, "replacement"), "owned elsewhere");
      await expect(lease.assertHeld()).rejects.toBeInstanceOf(
        AdvisoryLockCompromisedError,
      );
      expect(await descriptorsFor(`${target}.lock`)).toEqual([]);
      await expect(lease.close()).resolves.toBeUndefined();
      expect(
        await readFile(join(`${target}.lock`, "replacement"), "utf8"),
      ).toBe("owned elsewhere");
    } finally {
      await lease.close().catch(() => undefined);
    }
  });

  test.skipIf(process.platform !== "linux")(
    "closes its directory handle even when release fails",
    async () => {
      const directory = await temporaryDirectory();
      const target = join(directory, "writer");
      const lease = await acquireAdvisoryFileLease(target);
      try {
        expect(await descriptorsFor(`${target}.lock`)).toHaveLength(1);
        await writeFile(join(`${target}.lock`, "blocks-rmdir"), "failure");
        await expect(lease.close()).rejects.toBeInstanceOf(
          AdvisoryLockSystemError,
        );
        await lease.close();
      } finally {
        await lease.close().catch(() => undefined);
      }
      expect(await descriptorsFor(`${target}.lock`)).toEqual([]);
    },
  );

  test("cleans a half-acquired lock when post-lock validation fails", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "writer");
    const attempt = await acquireAdvisoryFileLease(target, {
      afterLockAcquired: async () => {
        throw new Error("post-lock validation failed");
      },
    }).then(
      (lease) => ({ lease }),
      (error: unknown) => ({ error }),
    );
    if ("lease" in attempt) await attempt.lease.close();
    expect(attempt).toMatchObject({
      error: { code: "LOCK_SYSTEM_ERROR" },
    });

    const retry = await acquireAdvisoryFileLease(target);
    await retry.close();
    expect(await descriptorsFor(`${target}.lock`)).toEqual([]);
  });

  test("stops a half-acquired updater without touching a replacement inode", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "writer");
    let replacementInode: bigint | undefined;
    const attempt = await acquireAdvisoryFileLease(target, {
      afterLockAcquired: async (lockDirectory) => {
        await rm(lockDirectory, { recursive: true });
        await mkdir(lockDirectory);
        await writeFile(join(lockDirectory, "replacement"), "external");
        replacementInode = (await lstat(lockDirectory, { bigint: true })).ino;
        throw new Error("post-lock validation failed after replacement");
      },
    }).then(
      (lease) => ({ lease }),
      (error: unknown) => ({ error }),
    );
    if ("lease" in attempt) await attempt.lease.close().catch(() => undefined);
    expect(attempt).toMatchObject({
      error: { code: "LOCK_SYSTEM_ERROR" },
    });
    expect((await lstat(`${target}.lock`, { bigint: true })).ino).toBe(
      replacementInode,
    );
    expect(await readFile(join(`${target}.lock`, "replacement"), "utf8")).toBe(
      "external",
    );
    expect(await descriptorsFor(`${target}.lock`)).toEqual([]);
  });
});

async function descriptorsFor(path: string): Promise<string[]> {
  const descriptors = await readdir("/proc/self/fd");
  const targets = await Promise.all(
    descriptors.map(async (descriptor) => {
      try {
        return await readlink(`/proc/self/fd/${descriptor}`);
      } catch {
        return "";
      }
    }),
  );
  return targets.filter((target) => target.startsWith(path));
}
