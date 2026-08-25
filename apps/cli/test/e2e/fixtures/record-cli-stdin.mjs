import { readFileSync, writeFileSync } from "node:fs";

const entry = process.argv[1];
const record = process.env.REINS_STDIN_RECORD;
if (
  entry !== undefined &&
  entry.endsWith("/apps/cli/dist/reins.js") &&
  record !== undefined
) {
  writeFileSync(record, readFileSync(0));
}
