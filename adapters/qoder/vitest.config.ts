import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["source"],
    alias: [
      {
        find: /^#\//u,
        replacement: new URL("./src/", import.meta.url).pathname,
      },
      {
        find: "@reins/protocol",
        replacement: new URL(
          "../../packages/protocol/src/index.ts",
          import.meta.url,
        ).pathname,
      },
      {
        find: "@reins/adapter-kit",
        replacement: new URL(
          "../../packages/adapter-kit/src/index.ts",
          import.meta.url,
        ).pathname,
      },
    ],
  },
});
