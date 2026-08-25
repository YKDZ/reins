import assert from "node:assert/strict";
import { test } from "node:test";

import { assertConformanceDependencyContract } from "../boundary-contract.ts";

const dependencies = {
  "@reins/client": "workspace:*",
  "@reins/daemon": "workspace:*",
  "@reins/protocol": "workspace:*",
  "@reins/qoder": "workspace:*",
};

const devDependencies = {
  "@reins/typescript-config": "workspace:*",
  "@types/node": "catalog:",
  oxfmt: "catalog:",
  oxlint: "catalog:",
  "oxlint-tsgolint": "catalog:",
  "typescript-7": "catalog:",
  vitest: "catalog:",
};

const dependenciesMeta = Object.fromEntries(
  Object.keys(dependencies).map((name) => [name, { injected: false }]),
);

const manifest = { dependencies, devDependencies, dependenciesMeta };

const targetTags = new Map([
  ["@reins/client", ["client"]],
  ["@reins/daemon", ["daemon"]],
  ["@reins/protocol", ["protocol"]],
  ["@reins/qoder", ["adapter"]],
]);

test("accepts the exact conformance dependency contract", () => {
  assert.doesNotThrow(() =>
    assertConformanceDependencyContract(manifest, targetTags),
  );
});

test("rejects an extra direct core dependency", () => {
  assert.throws(
    () =>
      assertConformanceDependencyContract(
        {
          ...manifest,
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
        { ...manifest, dependencies: missingQoder },
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
          ...manifest,
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
          ...manifest,
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
        manifest,
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

for (const [section, value] of [
  ["devDependencies", { ...devDependencies, "@reins/core": "workspace:*" }],
  ["optionalDependencies", { "@reins/core": "workspace:*" }],
  ["peerDependencies", { "@reins/core": "workspace:*" }],
  ["dependencies", { ...dependencies, chalk: "catalog:" }],
] as const) {
  test(`rejects an unexpected ${section} edge`, () => {
    assert.throws(
      () =>
        assertConformanceDependencyContract(
          { ...manifest, [section]: value },
          targetTags,
        ),
      /Conformance .* must be exact/u,
    );
  });
}

test("rejects missing tooling and bad dev dependency specs", () => {
  const { vitest: _missing, ...missingTooling } = devDependencies;
  assert.throws(
    () =>
      assertConformanceDependencyContract(
        { ...manifest, devDependencies: missingTooling },
        targetTags,
      ),
    /Conformance devDependencies must be exact/u,
  );
  assert.throws(
    () =>
      assertConformanceDependencyContract(
        {
          ...manifest,
          devDependencies: {
            ...devDependencies,
            "@types/node": "latest",
          },
        },
        targetTags,
      ),
    /Conformance devDependencies must be exact/u,
  );
});

test("rejects dependenciesMeta drift and bundled dependencies", () => {
  assert.throws(
    () =>
      assertConformanceDependencyContract(
        {
          ...manifest,
          dependenciesMeta: {
            ...dependenciesMeta,
            "@reins/core": { injected: false },
          },
        },
        targetTags,
      ),
    /Conformance dependenciesMeta must be exact/u,
  );
  assert.throws(
    () =>
      assertConformanceDependencyContract(
        { ...manifest, bundledDependencies: ["@reins/core"] },
        targetTags,
      ),
    /Conformance bundledDependencies must be absent/u,
  );
  assert.throws(
    () =>
      assertConformanceDependencyContract(
        { ...manifest, bundleDependencies: ["@reins/core"] },
        targetTags,
      ),
    /Conformance bundleDependencies must be absent/u,
  );
});
