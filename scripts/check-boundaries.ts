import { spawnSync } from "node:child_process";

import { checkConformanceDependencyContract } from "./boundary-contract.ts";

const contractTests = spawnSync(
  "node",
  ["--test", "--conditions=source", "scripts/test/boundary-contract.test.ts"],
  { stdio: "inherit" },
);
if (contractTests.error !== undefined) throw contractTests.error;
if (contractTests.status !== 0) process.exit(contractTests.status ?? 1);

checkConformanceDependencyContract(process.cwd());

const result = spawnSync(
  "pnpm",
  ["exec", "turbo", "boundaries", "--no-color"],
  {
    stdio: "inherit",
  },
);

if (result.error !== undefined) throw result.error;
process.exit(result.status ?? 1);
