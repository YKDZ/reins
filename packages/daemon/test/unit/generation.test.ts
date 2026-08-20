import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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

import { createDaemonIdFactory } from "../../src/generation.ts";
import { acquireGenerationAllocator } from "../../src/generation.ts";
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
    expect(allocations.map(base36).sort((left, right) => left - right)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
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

  test("ephemeral allocation uses injected random boot material and makes no durability promise", async () => {
    const root = await mkdtemp(join(tmpdir(), "reins-ephemeral-test-"));
    directories.push(root);
    const state = await resolveDaemonState({ env: {}, temporaryParent: root });
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
    await mkdir(join(state.directory, "generation"));
    const allocator = await acquireGenerationAllocator(state);

    await expect(allocator.allocate()).rejects.toThrow();
    await rm(join(state.directory, "generation"), { recursive: true });
    expect(await allocator.allocate()).toBe("1");
    await allocator.close();
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

  test("a destructive state reset explicitly starts a new identity lineage", async () => {
    const state = await durableState();
    expect(await allocateOnce(state)).toBe("1");

    await rm(state.directory, { recursive: true });
    const replacement = await resolveDaemonState({
      env: { HOME: directories[directories.length - 1] },
    });
    expect(await allocateOnce(replacement)).toBe("1");
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

function base36(value: string): number {
  return Number.parseInt(value, 36);
}

async function allocateOnce(state: DaemonState): Promise<DaemonGeneration> {
  const allocator = await acquireGenerationAllocator(state);
  try {
    return await allocator.allocate();
  } finally {
    await allocator.close();
  }
}
