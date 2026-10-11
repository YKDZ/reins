import { encodeTurnHandle } from "@reins/protocol";
import { expect, test } from "vitest";

import { parseCommandInvocation } from "../../src/command-spec.ts";

test("direct invocation parsing rejects missing required arguments", () => {
  expect(() =>
    parseCommandInvocation(
      "send",
      ["prompt@g1"],
      { placement: "new_turn" },
      "json",
    ),
  ).toThrowError(
    expect.objectContaining({
      code: "usage_error",
      issues: [expect.objectContaining({ issue: "missing_argument" })],
    }),
  );
});

test("direct invocation parsing rejects excess arguments", () => {
  expect(() =>
    parseCommandInvocation("capabilities", ["extra"], {}, "json"),
  ).toThrowError(
    expect.objectContaining({
      code: "usage_error",
      issues: [expect.objectContaining({ issue: "invalid_value" })],
    }),
  );
});

test("direct invocation parsing rejects a missing required option", () => {
  expect(() =>
    parseCommandInvocation("spawn", ["fake", ["hello"]], {}, "json"),
  ).toThrowError(
    expect.objectContaining({
      code: "usage_error",
      issues: [expect.objectContaining({ issue: "missing_argument" })],
    }),
  );
});

test("wait parsing preserves the omitted infinite budget and decodes complete turn targets", () => {
  const invocation = parseCommandInvocation(
    "wait",
    [
      [
        encodeTurnHandle({
          sessionId: "prompt@g1" as never,
          turnId: "t1" as never,
        }),
      ],
    ],
    { completion: "all" },
    "json",
  );
  expect(invocation.options).not.toHaveProperty("timeout");
  expect(invocation).toMatchObject({
    command: "wait",
    args: [[{ sessionId: "prompt@g1", turnId: "t1" }]],
    options: { completion: "all" },
  });
});

test("direct invocation parsing validates variadic fields as arrays", () => {
  expect(() =>
    parseCommandInvocation(
      "wait",
      ["prompt@g1"],
      { completion: "all" },
      "json",
    ),
  ).toThrowError(
    expect.objectContaining({
      code: "usage_error",
      issues: [expect.objectContaining({ issue: "invalid_value" })],
    }),
  );
});
