import adapters from "./wait-adapters.ts";

export default {
  ...adapters,
  qoder: {
    driverFactory: adapters.codex.driverFactory,
    async modelCatalog() {
      throw new Error("private credential quota rate limit text");
    },
  },
};
