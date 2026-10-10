import {
  decodeTurnHandle,
  encodeTurnHandle,
  sessionIdSchema,
  turnHandleSchema,
  turnIdSchema,
} from "@reins/protocol";
import * as v from "valibot";
import { expect, test } from "vitest";

test("turn handles round-trip both parent and local turn and reject changes to either", () => {
  const target = {
    sessionId: v.parse(sessionIdSchema, "reviewer@g7"),
    turnId: v.parse(turnIdSchema, "t42x"),
  };
  const handle = encodeTurnHandle(target);
  expect(handle).toMatch(/^[a-z0-9@/.-]+$/u);
  expect(decodeTurnHandle(handle)).toEqual(target);
  for (const changed of [
    handle.replace("reviewer", "another"),
    handle.replace("t42x", "t43x"),
    `${handle}x`,
    "t42x",
  ]) {
    expect(v.safeParse(turnHandleSchema, changed).success).toBe(false);
    expect(() => decodeTurnHandle(changed)).toThrow();
  }
});
