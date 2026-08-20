import { Buffer } from "node:buffer";

import { machineErrorSchema } from "@reins/protocol";
import * as v from "valibot";
import { expect, test } from "vitest";

import { toCliError } from "../../src/errors.ts";

test("local exception cause is UTF-8 bounded without splitting non-ASCII text", () => {
  const error = toCliError(new Error("é".repeat(3_000)));

  expect(error.code).toBe("internal_error");
  expect(v.safeParse(machineErrorSchema, error).success).toBe(true);
  if (!("cause" in error) || error.cause === undefined) {
    throw new Error("Expected an internal error cause");
  }
  expect(Buffer.byteLength(error.cause.message, "utf8")).toBeLessThanOrEqual(
    4 * 1024,
  );
  expect(error.cause.message.endsWith("é")).toBe(true);
});
