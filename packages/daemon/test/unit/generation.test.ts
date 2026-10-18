import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  diagnosticIdSchema,
  sessionIdSchema,
  sessionNameSchema,
} from "@reins/protocol";
import * as v from "valibot";
import { afterEach, describe, expect, test } from "vitest";

import {
  acquireGenerationAllocator,
  createDaemonIdFactory,
  daemonGenerationSchema,
} from "../../src/generation.ts";
import type { DaemonGeneration } from "../../src/generation.ts";
import { resolveDaemonState } from "../../src/state.ts";
import type { DaemonState } from "../../src/state.ts";
import {
  type ChildProcessHarness,
  withChildHarness,
} from "../helpers/child-process.ts";

const directories: string[] = [];

async function durableState() {
  const home = await mkdtemp(join(tmpdir(), "reins-generation-test-"));
  directories.push(home);
  return await resolveDaemonState({ env: { HOME: home } });
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("daemon generation", () => {
  test("twenty independent processes allocate unique monotonic generations", async () => {
    const state = await durableState();
    const fixture = fileURLToPath(
      new URL("../fixtures/allocate-generation.ts", import.meta.url),
    );
    const allocations = await withChildHarness(
      async (harness) =>
        await Promise.all(
          Array.from({ length: 20 }, () =>
            runAllocatorProcess(harness, fixture, state.directory),
          ),
        ),
    );

    expect(new Set(allocations)).toHaveLength(20);
    for (const allocation of allocations) {
      expect(v.safeParse(daemonGenerationSchema, allocation).success).toBe(
        true,
      );
    }
    // 单调性由持久状态谱系计数器保证：20 个独立进程串行提交，计数器到 20。
    expect((await persistedGeneration(state)).trim()).toBe(20n.toString(36));
  });
  test("durable allocations survive restarts and serialize concurrent starters", async () => {
    const state = await durableState();
    const first = await allocateOnce(state);
    const second = await allocateOnce(state);
    expect(second).not.toBe(first);

    const concurrent = await Promise.all(
      Array.from({ length: 4 }, () => allocateOnce(state)),
    );
    expect(new Set(concurrent)).toHaveLength(4);
    expect(concurrent).not.toContain(first);
    expect(concurrent).not.toContain(second);
  });

  test("a rolled-back state lineage does not reissue an identity an agent still holds", async () => {
    const state = await durableState();
    const generationFile = join(state.directory, "generation");

    await allocateOnce(state);
    const savedState = await readFile(generationFile);

    const secondGeneration = await allocateOnce(state);
    const heldHandle = createDaemonIdFactory(secondGeneration).session(
      v.parse(sessionNameSchema, "foo"),
    );

    await writeFile(generationFile, savedState);
    const rolledBackGeneration = await allocateOnce(state);
    const reissuedHandle = createDaemonIdFactory(rolledBackGeneration).session(
      v.parse(sessionNameSchema, "foo"),
    );

    expect(rolledBackGeneration).not.toBe(secondGeneration);
    expect(reissuedHandle).not.toBe(heldHandle);
  });

  test("a test temporary directory is an explicit durable state root", async () => {
    const root = await mkdtemp(join(tmpdir(), "reins-ephemeral-test-"));
    directories.push(root);
    const state = await resolveDaemonState({
      env: { REINS_STATE_DIR: root },
    });
    const allocator = await acquireGenerationAllocator(state, {
      randomBytes: () => Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    });

    const generation = await allocator.allocate();
    await allocator.close();
    expect(generation).toMatch(/^[0-9a-z]+$/);
    expect(generation.length).toBeGreaterThanOrEqual(8);
  });

  test("a failed durable update does not publish a new generation", async () => {
    const state = await durableState();
    const generationFile = join(state.directory, "generation");
    await mkdir(generationFile);
    const allocator = await acquireGenerationAllocator(state);

    await expect(allocator.allocate()).rejects.toThrow();
    await rm(generationFile, { recursive: true });
    const published = await allocator.allocate();
    await allocator.close();

    expect(v.safeParse(daemonGenerationSchema, published).success).toBe(true);
    // 失败尝试没有落盘计数器；恢复障碍后谱系计数器从起点前进一次。
    expect((await persistedGeneration(state)).trim()).toBe("1");
  });

  test("a lost allocator lease fails closed before publishing a generation", async () => {
    const state = await durableState();
    const allocator = await acquireGenerationAllocator(state, {
      lock: { closeTimeoutMs: 500 },
    });
    await rm(join(state.directory, "generation-allocator.lock"), {
      recursive: true,
    });

    await expect(allocator.allocate()).rejects.toMatchObject({
      code: "LOCK_COMPROMISED",
    });
    await expect(
      readFile(join(state.directory, "generation")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await allocator.close().catch(() => undefined);
  });

  test("an entropy failure before acquiring the lease does not strand it", async () => {
    const state = await durableState();

    await expect(
      acquireGenerationAllocator(state, {
        randomBytes: () => {
          throw new Error("entropy_source_failed");
        },
      }),
    ).rejects.toThrow("entropy_source_failed");

    // 失败路径既没持锁也没落盘计数器：随机源抛错发生在取得 lease 之前。
    await expect(
      readFile(join(state.directory, "generation")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    // 锁未泄漏，随后同 state、timeoutMs:0 的正常分配仍成功并发布合法 token。
    const allocator = await acquireGenerationAllocator(state, {
      lock: { timeoutMs: 0 },
    });
    const published = await allocator.allocate();
    await allocator.close();
    expect(v.safeParse(daemonGenerationSchema, published).success).toBe(true);
  });

  test("a destructive state reset explicitly starts a new identity lineage", async () => {
    const state = await durableState();
    const home = directories[directories.length - 1]!;
    const beforeReset = await allocateOnce(state);

    await rm(state.directory, { recursive: true });
    const replacement = await resolveDaemonState({ env: { HOME: home } });
    const afterReset = await allocateOnce(replacement);

    // 删除整个 state 目录会终止原谱系；重启后即便谱系计数器回到 1，
    // 发布的 generation token 也不能与重置前相同，否则旧引用被冒充连续接管。
    expect(afterReset).not.toBe(beforeReset);
    expect((await persistedGeneration(replacement)).trim()).toBe("1");
  });

  test("pure ID factory only creates protocol-owned branded IDs for its generation", async () => {
    const state = await durableState();
    const generation = await allocateOnce(state);
    const ids = createDaemonIdFactory(generation);

    expect(
      v.safeParse(
        sessionIdSchema,
        ids.session(v.parse(sessionNameSchema, "reviewer")),
      ).success,
    ).toBe(true);
    expect(v.safeParse(diagnosticIdSchema, ids.diagnostic()).success).toBe(
      true,
    );
    expect(ids.diagnostic()).not.toBe(ids.diagnostic());
  });
});

function runAllocatorProcess(
  harness: ChildProcessHarness,
  fixture: string,
  directory: string,
): Promise<string> {
  return run();

  async function run(): Promise<string> {
    const child = harness.spawn(fixture, [directory]);
    child.stdin.end();
    await harness.waitForHandshake(
      child,
      (observation) =>
        observation.stdout.includes("ready\n") ? true : undefined,
      5_000,
    );
    const result = await harness.waitForExit(child, 10_000);
    if (result.exitCode !== 0) {
      throw new Error(
        `allocator child exited ${String(result.exitCode)}: ${result.stderr}`,
      );
    }
    return result.stdout.trim().split("\n").at(-1)!;
  }
}

function persistedGeneration(state: DaemonState): Promise<string> {
  return readFile(join(state.directory, "generation"), "utf8");
}

async function allocateOnce(state: DaemonState): Promise<DaemonGeneration> {
  const allocator = await acquireGenerationAllocator(state);
  try {
    return await allocator.allocate();
  } finally {
    await allocator.close();
  }
}
