import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { withChildHarness } from "../helpers/child-process.ts";

describe("real child process harness", () => {
  test("times out and reaps a child that never handshakes or exits", async () => {
    const fixture = fileURLToPath(
      new URL("../fixtures/hang.ts", import.meta.url),
    );
    let child: ChildProcessWithoutNullStreams | undefined;
    await expect(
      withChildHarness(async (harness) => {
        child = harness.spawn(fixture, []);
        await harness.waitForHandshake(child, () => undefined, 25);
      }),
    ).rejects.toThrow("Child handshake timed out");
    expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
  });
});
