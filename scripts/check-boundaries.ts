import { spawnSync } from "node:child_process";

const result = spawnSync(
  "pnpm",
  ["exec", "turbo", "boundaries", "--no-color"],
  {
    stdio: "inherit",
  },
);

if (result.error !== undefined) throw result.error;
process.exit(result.status ?? 1);
