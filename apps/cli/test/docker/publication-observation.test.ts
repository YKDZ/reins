import { test } from "vitest";

import { runPublicationScenario } from "./publication-scenario.ts";

test(
  "discovers saved publications through wait and subscriptions independently of turn completion",
  () => runPublicationScenario(true),
  3_900_000,
);
