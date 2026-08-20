import { expect, test } from "vitest";

import { parseCommandInvocation } from "../../src/command-spec.ts";

test("direct invocation parsing rejects missing required arguments", () => {
  expect(() =>
    parseCommandInvocation("send", ["prompt@g1"], {}, "json"),
  ).toThrowError(
    expect.objectContaining({ code: "usage_error", issue: "missing_argument" }),
  );
});

test("direct invocation parsing rejects excess arguments", () => {
  expect(() =>
    parseCommandInvocation("capabilities", ["extra"], {}, "json"),
  ).toThrowError(
    expect.objectContaining({ code: "usage_error", issue: "invalid_value" }),
  );
});

test("direct invocation parsing rejects a missing required option", () => {
  expect(() =>
    parseCommandInvocation("spawn", ["fake", ["hello"]], {}, "json"),
  ).toThrowError(
    expect.objectContaining({ code: "usage_error", issue: "missing_argument" }),
  );
});

test("direct invocation parsing applies spec defaults", () => {
  const invocation = parseCommandInvocation(
    "wait",
    [["prompt@g1"]],
    {},
    "json",
  );
  expect(invocation).toMatchObject({
    command: "wait",
    options: { timeout: 60_000 },
  });
});

test("direct invocation parsing validates variadic fields as arrays", () => {
  expect(() =>
    parseCommandInvocation("wait", ["prompt@g1"], {}, "json"),
  ).toThrowError(
    expect.objectContaining({ code: "usage_error", issue: "invalid_value" }),
  );
});
