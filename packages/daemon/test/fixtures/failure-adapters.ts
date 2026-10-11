import adapters from "./wait-adapters.ts";

export default {
  ...adapters,
  unavailable: {
    driverFactory: adapters.codex.driverFactory,
    async capabilities() {
      throw new Error("private credential quota rate limit text");
    },
  },
};
