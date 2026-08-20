import {
  sessionIdSchema,
  sessionNameSchema,
  turnIdSchema,
  type WorkerDriver,
  type WorkerSpec,
} from "@reins/protocol";
import * as v from "valibot";
import { describe, expect, test } from "vitest";

import type { HarnessAdapter } from "../../src/registry.ts";
import { createRoutingDriverFactory } from "../../src/routing-driver.ts";

describe("routing driver invariants", () => {
  test("does not silently drop delivery with no session routing entry", () => {
    const driver = createRoutingDriverFactory(new Map())(() => {});

    expect(() =>
      driver.deliver(
        v.parse(sessionIdSchema, "missing@groute"),
        v.parse(turnIdSchema, "turn-route"),
        "message",
      ),
    ).toThrow("No routing entry for session missing@groute");
  });

  test("does not retain failed starts and retains failed termination for retry", () => {
    let starts = 0;
    let terminations = 0;
    const worker: WorkerDriver = {
      start() {
        starts += 1;
        if (starts === 1) throw new Error("start failed");
      },
      deliver() {},
      interrupt() {},
      resolvePermission() {},
      terminate() {
        terminations += 1;
        if (terminations === 1) throw new Error("terminate failed");
      },
    };
    const adapter: HarnessAdapter = {
      driverFactory: () => worker,
      capabilities: async () => ({ harness: "fake", models: [] }),
    };
    const driver = createRoutingDriverFactory(new Map([["fake", adapter]]))(
      () => {},
    );
    const sessionId = v.parse(sessionIdSchema, "retry@groute");
    const spec: WorkerSpec = {
      sessionId,
      turnId: v.parse(turnIdSchema, "turn-route"),
      harness: "fake",
      message: "start",
      cwd: "/tmp",
      authorizationMode: "allowAll",
      sessionName: v.parse(sessionNameSchema, "retry"),
    };
    expect(() => driver.start(spec)).toThrow("start failed");
    expect(() => driver.deliver(sessionId, spec.turnId, "message")).toThrow(
      "No routing entry",
    );
    driver.start(spec);
    expect(() => driver.terminate(sessionId)).toThrow("terminate failed");
    expect(() => driver.terminate(sessionId)).not.toThrow();
  });
});
