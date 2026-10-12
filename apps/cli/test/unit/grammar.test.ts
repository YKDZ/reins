import type { MachineError } from "@reins/protocol";
import type { WorkspaceError } from "@reins/workspace-protocol";
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

test("pretty grammar retains typed workspace correction and outcome facts", () => {
  const binding = {
    code: "binding_unknown",
    availableBindings: ["code", "review"],
  } satisfies WorkspaceError;
  const importFailure = {
    code: "git_import_failed",
    gitImport: {
      repository: "/repo",
      reference: "refs/heads/main",
      objectWriteAttempted: false,
      referenceCreated: false,
      objectDatabaseBefore: { loose: 2, packed: 3, packs: 1 },
    },
  } satisfies WorkspaceError;
  const nativeViewFailure = {
    code: "native_view_lost",
    nativeView: { reason: "moved", currentRoot: "/moved/worktree" },
  } satisfies WorkspaceError;

  const bindingOutput = renderCliError(binding).items[0]!.message;
  expect(bindingOutput).toContain("Available bindings: code, review");
  expect(jsonErrorMessage({ items: [{ message: bindingOutput }] })).toContain(
    "Available bindings: code, review",
  );

  const importOutput = renderCliError(importFailure).items[0]!.message;
  expect(importOutput).toContain("reference: refs/heads/main");
  expect(importOutput).toContain("object write attempted: no");
  expect(importOutput).toContain("object database before: 2 loose objects");

  expect(renderCliError(nativeViewFailure).items[0]!.message).toContain(
    "Native view reason: moved; current root: /moved/worktree",
  );
  expect(
    renderCliError({
      code: "native_view_lost",
      nativeView: { reason: "unreachable" },
    }).items[0]!.message,
  ).toContain("Native view reason: unreachable");
});
