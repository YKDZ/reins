import type { MachineError } from "@reins/protocol";
import { expect, test } from "vitest";

import { outputError } from "../../src/errors.ts";
import { jsonErrorMessage, renderCliError } from "../../src/grammar.ts";

test("invalid_params renders every protocol issue in order", () => {
  const error = {
    code: "invalid_params",
    issues: [
      { issue: "missing_required", path: "model" },
      { issue: "invalid_type", path: "reasoning", expected: "string" },
    ],
  } satisfies MachineError;

  const rendered = renderCliError(error);
  expect(rendered.items).toEqual([
    { message: "Missing required parameter: model" },
    { message: "Invalid parameter type at reasoning; expected string" },
  ]);
  expect(jsonErrorMessage(rendered)).toBe(
    "Missing required parameter: model. Invalid parameter type at reasoning; expected string",
  );
});

test("stdout failure uses the centralized CLI-local error grammar", () => {
  const rendered = renderCliError(outputError("EIO"));

  expect(rendered.items).toEqual([
    { message: "Unable to write CLI output (EIO)" },
  ]);
  expect(jsonErrorMessage(rendered)).toBe("Unable to write CLI output (EIO)");
});

test("attach replay mismatch renders only safe identities through centralized grammar", () => {
  const error = {
    code: "attach_replay_unavailable",
    reason: "message_suffix_mismatch",
    sessionId: "reviewer@g1" as never,
    turnId: "t1" as never,
    messageId: "m1" as never,
  } satisfies MachineError;

  expect(renderCliError(error)).toEqual({
    items: [
      {
        message: "Attach replay is unavailable for message m1 in turn t1",
      },
    ],
  });
});
