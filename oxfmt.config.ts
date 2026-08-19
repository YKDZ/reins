import { defineConfig } from "oxfmt";

export default defineConfig({
  ignorePatterns: ["adapters/codex/src/generated"],
  printWidth: 80,
  sortImports: true,
});
