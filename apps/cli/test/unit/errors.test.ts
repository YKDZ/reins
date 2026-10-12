import { Buffer } from "node:buffer";

import { ReinsClientError } from "@reins/client/control";
import { machineErrorSchema } from "@reins/protocol";
import * as v from "valibot";
import { expect, test } from "vitest";

import {
  EXIT_RESOURCE,
  exitCodeForError,
  outputError,
  toCliError,
} from "../../src/errors.ts";

test("local exception cause is UTF-8 bounded without splitting non-ASCII text", () => {
  const error = toCliError(new Error("é".repeat(3_000)));

  expect(error.code).toBe("internal_error");
  expect(v.safeParse(machineErrorSchema, error).success).toBe(true);
  if (error.code !== "internal_error" || error.cause === undefined) {
    throw new Error("Expected an internal error cause");
  }
  expect(Buffer.byteLength(error.cause.message, "utf8")).toBeLessThanOrEqual(
    4 * 1024,
  );
  expect(error.cause.message.endsWith("é")).toBe(true);
});

test("a local stdout failure remains a typed output error", () => {
  const error = outputError("EIO");

  expect(toCliError(error)).toEqual({
    code: "output_error",
    reason: "stdout_write_failed",
    systemCode: "EIO",
  });
  expect(v.safeParse(machineErrorSchema, error).success).toBe(false);
  expect(exitCodeForError(error)).toBe(EXIT_RESOURCE);
});

test("client failures retain typed facts without reading Error.message", () => {
  const failure = {
    code: "protocol_version_mismatch",
    requestedProtocolMajorVersion: 1,
    supportedProtocolMajorVersion: 2,
  } as const;
  const clientError = new ReinsClientError(failure);
  clientError.message = "opaque client failure";

  expect(toCliError(clientError)).toEqual(failure);
});

test("an output error with a non-string system code is rejected", () => {
  const error = toCliError({
    code: "output_error",
    reason: "stdout_write_failed",
    systemCode: 5,
  });

  expect(error.code).toBe("internal_error");
});
