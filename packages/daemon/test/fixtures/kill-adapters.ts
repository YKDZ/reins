import { fileURLToPath } from "node:url";

import { createCodexDriver, createCodexTransport } from "@reins/codex";

const codexFactory = createCodexDriver({
  transportFactory: (options) =>
    createCodexTransport({
      ...options,
      binaryPath: process.execPath,
      binaryArgs: [fileURLToPath(new URL("./kill-native.ts", import.meta.url))],
      shutdownGraceMs: 25,
    }),
});

export default {
  codex: {
    driverFactory: ((options) => {
      const driver = codexFactory(options);
      let failTermination = false;
      return {
        ...driver,
        async start(spec) {
          failTermination = spec.message === "fail first termination";
          return driver.start(spec);
        },
        async terminate(sessionId) {
          if (failTermination) {
            failTermination = false;
            throw new Error(
              "Fixture termination failed before stopping the worker",
            );
          }
          await driver.terminate(sessionId);
        },
      };
    }) satisfies typeof codexFactory,
    modelCatalog: async () => ({ harness: "codex", models: [] }),
  },
};
