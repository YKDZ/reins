import { test } from "vitest";

import { runDurableWorkspaceScenario } from "./durable-workspace-scenario.ts";

test("recovers the original consumer or releases its actual runtime before a new lineage", async () => {
  await runDurableWorkspaceScenario({
    name: "reins-wrr23",
    client: "apps/cli/test/docker/consumer-recovery-client.ts",
    environmentPrefix: "REINS_WRR23_",
  });
}, 4_200_000);
