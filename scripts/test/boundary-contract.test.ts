import assert from "node:assert/strict";
import { test } from "node:test";

import { assertConformanceDependencyContract } from "../boundary-contract.ts";

const dependencies = {
  "@reins/client": "workspace:*",
  "@reins/daemon": "workspace:*",
  "@reins/protocol": "workspace:*",
  "@reins/qoder": "workspace:*",
};

const targetTags = new Map([
  ["@reins/client", ["client"]],
  ["@reins/daemon", ["daemon"]],
  ["@reins/protocol", ["protocol"]],
  ["@reins/qoder", ["adapter"]],
]);

test("accepts the exact conformance dependency contract", () => {
  assert.doesNotThrow(() =>
    assertConformanceDependencyContract({ dependencies }, targetTags),
  );
});

test("rejects an extra direct core dependency", () => {
  assert.throws(
    () =>
      assertConformanceDependencyContract(
        {
          dependencies: {
            ...dependencies,
            "@reins/core": "workspace:*",
          },
        },
        new Map([...targetTags, ["@reins/core", ["core"]]]),
      ),
    /Conformance dependencies must be exact/u,
  );
});

test("rejects a missing qoder dependency", () => {
  const { "@reins/qoder": _removed, ...missingQoder } = dependencies;
  assert.throws(
    () =>
      assertConformanceDependencyContract(
        { dependencies: missingQoder },
        targetTags,
      ),
    /Conformance dependencies must be exact/u,
  );
});

test("rejects an unknown package target", () => {
  const { "@reins/qoder": _removed, ...withoutQoder } = dependencies;
  assert.throws(
    () =>
      assertConformanceDependencyContract(
        {
          dependencies: {
            ...withoutQoder,
            "@reins/unknown": "workspace:*",
          },
        },
        targetTags,
      ),
    /Conformance dependencies must be exact/u,
  );
});

test("rejects a non-workspace dependency specifier", () => {
  assert.throws(
    () =>
      assertConformanceDependencyContract(
        {
          dependencies: { ...dependencies, "@reins/qoder": "^1.0.0" },
        },
        targetTags,
      ),
    /Conformance dependency must use workspace:\*/u,
  );
});

test("rejects an unexpected target tag", () => {
  assert.throws(
    () =>
      assertConformanceDependencyContract(
        { dependencies },
        new Map([...targetTags, ["@reins/qoder", ["core"]]]),
      ),
    /Conformance dependency target has an unexpected tag/u,
  );
});

test("rejects an invalid manifest shape", () => {
  assert.throws(
    () => assertConformanceDependencyContract({ dependencies: [] }, targetTags),
    /Conformance manifest dependencies must be an object/u,
  );
});
