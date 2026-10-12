#!/usr/bin/env node

import { createRequire } from "node:module";

import { nodeCliOutput } from "@ykdz/cli-contract/node";

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

process.exitCode = await main({
  argv: process.argv,
  version,
  write: nodeCliOutput({ stdout: process.stdout, stderr: process.stderr }),
  dependencies: {
    connect: () =>
      connectReins({
        consumerContext: process.env.REINS_CONSUMER_CONTEXT ?? "",
        env: process.env,
      }),
  },
});
