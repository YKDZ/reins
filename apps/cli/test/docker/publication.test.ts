import { test } from "vitest";

import { runPublicationScenario } from "./publication-scenario.ts";

test(
  "imports worker-prepared published Git results only into explicit new references",
  () =>
    runPublicationScenario({
      ticket: 28,
      client: "git-result-client.ts",
      worker: "git-result-worker.ts",
    }),
  3_900_000,
);
