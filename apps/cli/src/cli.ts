#!/usr/bin/env node

import { createRequire } from "node:module";

import { CliWriteError, type WriteCliOutput } from "@ykdz/cli-contract";
import { isNodeBrokenPipe, nodeCliOutput } from "@ykdz/cli-contract/node";

import { connectReins } from "./application.ts";
import { main } from "./main.ts";

const require = createRequire(import.meta.url);
const manifest: unknown = require("../package.json");
const version =
  typeof manifest === "object" &&
  manifest !== null &&
  "version" in manifest &&
  typeof manifest.version === "string"
    ? manifest.version
    : "unpublished";
const outputPort = nodeCliOutput({
  stdout: process.stdout,
  stderr: process.stderr,
});
let outputCancelled = false;
let cancelPendingWrite: (() => void) | undefined;
const write: WriteCliOutput = (output) => {
  if (outputCancelled) return Promise.resolve();
  const pendingWrite = outputPort(output);
  const cancelledWrite = new Promise<void>((resolve) => {
    cancelPendingWrite = resolve;
  });
  return Promise.race([pendingWrite, cancelledWrite]).finally(() => {
    cancelPendingWrite = undefined;
  });
};

let exitCode: number;
try {
  exitCode = await main({
    argv: process.argv,
    version,
    write,
    cancelOutput() {
      if (cancelPendingWrite === undefined) return;
      outputCancelled = true;
      cancelPendingWrite?.();
    },
    dependencies: {
      connect: () =>
        connectReins({
          consumerContext: process.env.REINS_CONSUMER_CONTEXT ?? "",
          env: process.env,
        }),
    },
  });
} catch (error) {
  if (!(error instanceof CliWriteError)) throw error;
  if (isNodeBrokenPipe(error)) {
    exitCode = 0;
  } else {
    process.stderr.write("error: CLI output failed\n");
    exitCode = 1;
  }
}
process.exitCode = exitCode;
if (outputCancelled) process.exit(exitCode);
