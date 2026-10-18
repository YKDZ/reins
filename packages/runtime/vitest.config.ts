import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["source"],
    alias: [
      {
        find: "@reins/protocol",
        replacement: new URL(
          "../../packages/protocol/src/index.ts",
          import.meta.url,
        ).pathname,
      },
      {
        find: "@reins/transport",
        replacement: new URL(
          "../../packages/transport/src/index.ts",
          import.meta.url,
        ).pathname,
      },
    ],
  },
});
