import { openDiagnosticsStoreForTest } from "../../src/diagnostics-store.testing.ts";

const directory = process.argv[2];
if (directory === undefined) throw new Error("Missing diagnostics directory");

const store = await openDiagnosticsStoreForTest({
  directory,
  lock: {
    staleMs: 2_000,
    updateMs: 1_000,
  },
});
process.stdout.write("ready\n");
process.stdin.resume();
process.stdin.on("end", async () => {
  await store.close();
});
