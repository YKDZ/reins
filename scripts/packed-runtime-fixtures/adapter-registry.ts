import fixtureAdapter from "./adapter-fixture.ts";
import historyAdapter from "./history-adapter.ts";
import readableEventsAdapter from "./readable-events-adapter.ts";

export default {
  ...fixtureAdapter,
  ...historyAdapter,
  ...readableEventsAdapter,
};
