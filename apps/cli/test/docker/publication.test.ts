import { test } from "vitest";

import { runPublicationScenario } from "./publication-scenario.ts";

test(
  "publishes fixed files through the deployed worker entrypoint and explicitly receives outside the active tree",
  () => runPublicationScenario(),
  3_900_000,
);
