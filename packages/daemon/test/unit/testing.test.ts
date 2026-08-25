import { expect, test } from "vitest";

import { openEphemeralDaemonForTest } from "../../src/testing.ts";

test("ephemeral composition owns connections and closes idempotently", async () => {
  const daemon = await openEphemeralDaemonForTest({ adapters: new Map() });
  const connection = daemon.connect();

  await expect(Promise.all([daemon.close(), daemon.close()])).resolves.toEqual([
    undefined,
    undefined,
  ]);
  expect(() => connection.close()).not.toThrow();
});
