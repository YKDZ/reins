import { fileURLToPath } from "node:url";

import { createCodexDriver, createCodexTransport } from "@reins/codex";

const closeFailureSessions = new Set<string>();

const codexFactory = createCodexDriver({
  transportFactory: (options) => {
    const transport = createCodexTransport({
      ...options,
      binaryPath: process.execPath,
      binaryArgs: [fileURLToPath(new URL("./kill-native.ts", import.meta.url))],
      shutdownGraceMs: 25,
    });
    let failCloseAfterDelete = false;
    return {
      ...transport,
      async request(method, params) {
        const result = await transport.request(method, params);
        const sessionId = options.diagnosticContext()?.sessionId;
        if (
          method === "thread/delete" &&
          sessionId !== undefined &&
          closeFailureSessions.delete(sessionId)
        )
          failCloseAfterDelete = true;
        return result;
      },
      async close() {
        if (failCloseAfterDelete) {
          failCloseAfterDelete = false;
          throw new Error("Fixture local resource release failed");
        }
        await transport.close();
      },
    };
  },
});

export default {
  codex: {
    driverFactory: ((options) => {
      const driver = codexFactory(options);
      let failTermination = false;
      return {
        ...driver,
        start(spec) {
          failTermination = spec.message === "fail first termination";
          if (spec.message === "fail local release after official close")
            closeFailureSessions.add(spec.sessionId);
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
