import { test } from "vitest";

import { runPublicationScenario } from "./publication-scenario.ts";

test(
  "retains publications after detach and explicitly cleans selected independent copies",
  () => runPublicationScenario("retention"),
  3_900_000,
);
