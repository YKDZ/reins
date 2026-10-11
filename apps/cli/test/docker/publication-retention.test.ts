import { test } from "vitest";

import { runPublicationScenario } from "./publication-scenario.ts";

test(
  "retains publications after detach and explicitly cleans selected independent copies",
  () =>
    runPublicationScenario(false, {
      ticket: 29,
      client: "publication-retention-client.ts",
      worker: "publishing-worker.ts",
    }),
  3_900_000,
);
