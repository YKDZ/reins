import { acquireGenerationAllocator } from "../../src/generation.ts";
import type { DaemonState } from "../../src/state.ts";

const directory = process.argv[2];
if (directory === undefined) throw new Error("Missing state directory");

const state: DaemonState = {
  directory,
  diagnosticsDirectory: `${directory}/diagnostics`,
  durable: true,
  retention: { maxAgeMs: 1, maxBytes: 1 },
};
process.stdout.write("ready\n");
const allocator = await acquireGenerationAllocator(state);
const generation = await allocator.allocate();
await allocator.close();
process.stdout.write(`${generation}\n`);
