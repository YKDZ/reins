import { test } from "vitest";

import { runPublicationScenario } from "./publication-scenario.ts";

test(
  "publishes fixed files through the deployed worker entrypoint and explicitly receives outside the active tree",
  () => runPublicationScenario(),
  3_900_000,
);

test(
  "imports worker-prepared published Git results only into explicit new references",
  () =>
    runPublicationScenario(false, {
      ticket: 28,
      client: "git-result-client.ts",
      worker: "git-result-worker.ts",
    }),
  3_900_000,
);
