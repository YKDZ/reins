import { readFileSync, writeFileSync } from "node:fs";

const entry = process.argv[1];
const record = process.env.REINS_STDIN_RECORD;
const stdoutSentinel = process.env.REINS_STDOUT_SENTINEL;
const stderrSentinel = process.env.REINS_STDERR_SENTINEL;
if (
  entry !== undefined &&
  entry.endsWith("/apps/cli/dist/reins.js") &&
  record !== undefined
) {
  writeFileSync(record, readFileSync(0));
  if (stdoutSentinel !== undefined) process.stdout.write(stdoutSentinel);
  if (stderrSentinel !== undefined) process.stderr.write(stderrSentinel);
}
