import { defineConfig } from "oxlint";

// OXC's current erasing-op rule does not reject enum, runtime namespace, or
// parameter properties. TypeScript 7 erasableSyntaxOnly is authoritative.
export default defineConfig({
  options: { typeAware: true },
  categories: { correctness: "error", suspicious: "warn" },
});
