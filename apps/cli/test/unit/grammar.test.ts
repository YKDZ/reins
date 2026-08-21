import type { MachineError } from "@reins/protocol";
import { expect, test } from "vitest";

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
