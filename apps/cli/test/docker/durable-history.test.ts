import { test } from "vitest";

import { runDurableWorkspaceScenario } from "./durable-workspace-scenario.ts";

test("retains consumed workspace events across detach and manager restart", async () => {
  await runDurableWorkspaceScenario({
    name: "reins-wrr22",
    client: "apps/cli/test/docker/durable-history-client.ts",
    environmentPrefix: "REINS_WRR22_",
  });
}, 4_200_000);
