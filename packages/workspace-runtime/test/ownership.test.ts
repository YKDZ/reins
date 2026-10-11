import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";

import { consumerContextSchema } from "@reins/protocol";
import * as v from "valibot";

import {
  fingerprint,
  resolveWorktree,
  worktreeScopeKey,
} from "../src/index.ts";
import { openPublications } from "../src/publications.ts";
import { openWorkspaceRuntime } from "../src/runtime.ts";

const execute = promisify(execFile);
const directories: string[] = [];
const owner = v.parse(consumerContextSchema, "workspace-owner-a");
const otherOwner = v.parse(consumerContextSchema, "workspace-owner-b");

after(async () => {
  await Promise.all(
    directories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

test("ordinary actions hide another consumer's attachment, including stale paths", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "reins-workspace-owner-"));
  directories.push(fixture);
  const worktree = join(fixture, "worktree");
  const nested = join(worktree, "src");
  const stateDirectory = join(fixture, "state");
  await mkdir(nested, { recursive: true });
  await mkdir(stateDirectory);
  await execute("git", ["init", "--quiet", worktree]);
  const tree = await resolveWorktree(worktree);
  const paths = [
    ...new Set([
      tree.root,
      tree.cwd,
      join(tree.root, ".git"),
      tree.gitDir,
      tree.commonDir,
    ]),
  ];
  const identities = await Promise.all(
    paths.map(async (path) => {
      const value = await stat(path, { bigint: true });
      return { path, dev: String(value.dev), ino: String(value.ino) };
    }),
  );
  const directory = join(stateDirectory, "attachment");
  await mkdir(directory);
  await writeFile(
    join(directory, "attachment.json"),
    JSON.stringify({
      owner,
      tree,
      identities,
      intent: ["code"],
      bindingIntent: "sha256:fixture",
      directory,
      container: "unused-workspace-owner-fixture",
      environmentStage: "pending",
      info: {
        cwd: tree.cwd,
        root: tree.root,
        source: { status: "pending" },
        runtime: { status: "failed", error: { code: "material_unavailable" } },
        environment: {
          provider: "docker",
          image:
            "node@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e",
        },
        environmentFingerprint: "sha256:fixture",
        harnesses: [],
        history: { status: "unavailable", integrity: "unknown", errors: [] },
        preparation: { attempts: [{ status: "failed" }] },
      },
    }),
  );
  const runtime = await openWorkspaceRuntime({ stateDirectory });
  try {
    await assert.rejects(runtime.status(worktree, otherOwner), {
      code: "attachment_not_found",
    });
    await assert.rejects(runtime.route(worktree, otherOwner), {
      code: "attachment_not_found",
    });
    await assert.rejects(runtime.admit(worktree, otherOwner, "spawn", {}), {
      code: "attachment_not_found",
    });
    await assert.rejects(runtime.detach(worktree, otherOwner, "require_none"), {
      code: "attachment_not_found",
    });
    await assert.rejects(runtime.attach(worktree, ["code"], otherOwner), {
      code: "attachment_owned",
    });

    await rm(nested, { recursive: true });
    await assert.rejects(runtime.status(nested, otherOwner), {
      code: "attachment_not_found",
    });
  } finally {
    await runtime.close();
  }
});

test("publication discovery follows worktree scope and preserves execution location", async () => {
  const fixture = await mkdtemp(
    join(tmpdir(), "reins-workspace-publication-scope-"),
  );
  directories.push(fixture);
  const first = join(fixture, "first");
  const second = join(fixture, "second");
  const nested = join(first, "src");
  await mkdir(nested, { recursive: true });
  await mkdir(second);
  await execute("git", ["init", "--quiet", first]);
  await execute("git", ["init", "--quiet", second]);
  const rootScope = await worktreeScopeKey(first);
  const nestedScope = await worktreeScopeKey(nested);
  const otherScope = await worktreeScopeKey(second);
  assert.equal(nestedScope, rootScope);
  assert.notEqual(otherScope, rootScope);

  const publications = openPublications(join(fixture, "state"));
  const result = await publications.publish(owner, nestedScope, {
    cwd: nested,
    path: "result.txt",
    contentBase64: Buffer.from("published").toString("base64"),
  });
  assert.deepEqual(result.source, {
    cwd: nested,
    path: join(nested, "result.txt"),
  });
  assert.equal((await publications.list(owner, rootScope)).length, 1);
  assert.equal((await publications.list(owner, otherScope)).length, 0);
});

test("a failed attachment resumes from its accepted bindings when runtime definitions drift", async () => {
  const fixture = await mkdtemp(
    join(tmpdir(), "reins-workspace-binding-retry-"),
  );
  directories.push(fixture);
  const worktree = join(fixture, "worktree");
  const stateDirectory = join(fixture, "state");
  await mkdir(join(worktree, ".reins"), { recursive: true });
  await mkdir(stateDirectory);
  await execute("git", ["init", "--quiet", worktree]);
  const currentEnvironment = {
    provider: "docker" as const,
    image: `sha256:${"1".repeat(64)}`,
  };
  const currentConfiguration = {
    environments: [currentEnvironment],
    runtimes: [],
    bindings: [{ ref: "code", harness: "codex" as const }],
  };
  await writeFile(
    join(worktree, ".reins", "workspace.json"),
    JSON.stringify(currentConfiguration),
  );
  const tree = await resolveWorktree(worktree);
  const paths = [
    ...new Set([
      tree.root,
      tree.cwd,
      join(tree.root, ".git"),
      tree.gitDir,
      tree.commonDir,
    ]),
  ];
  const identities = await Promise.all(
    paths.map(async (path) => {
      const value = await stat(path, { bigint: true });
      return { path, dev: String(value.dev), ino: String(value.ino) };
    }),
  );
  const credential = { kind: "omitted" as const };
  const intent = fingerprint([{ ref: "code", harness: "codex", credential }]);
  const directory = join(stateDirectory, "attachment");
  await mkdir(directory);
  await writeFile(
    join(directory, "attachment.json"),
    JSON.stringify({
      owner,
      tree,
      identities,
      intent: ["code"],
      bindingIntent: intent,
      directory,
      container: "unused-workspace-binding-retry-fixture",
      environmentStage: "creating",
      info: {
        cwd: tree.cwd,
        root: tree.root,
        source: { status: "verified" },
        runtime: {
          status: "failed",
          error: { code: "preparation_outcome_unknown" },
        },
        environment: {
          provider: "docker",
          image: `sha256:${"0".repeat(64)}`,
        },
        environmentFingerprint: "sha256:accepted-environment",
        harnesses: [
          {
            ref: "code",
            harness: "codex",
            credential,
            runtime: {
              harness: "codex",
              version: "0.149.0",
              image: `sha256:${"2".repeat(64)}`,
            },
            runtimeFingerprint: "sha256:accepted-runtime",
            supportBundle: "sha256:accepted-support",
            stage: "failed",
          },
        ],
        history: { status: "unavailable", integrity: "unknown", errors: [] },
        preparation: { attempts: [{ status: "failed" }] },
      },
    }),
  );
  const runtime = await openWorkspaceRuntime({ stateDirectory });
  try {
    await writeFile(
      join(worktree, ".reins", "workspace.json"),
      JSON.stringify({
        ...currentConfiguration,
        bindings: [{ ref: "code", harness: "qoder" }],
      }),
    );
    await assert.rejects(runtime.attach(worktree, ["code"], owner), {
      code: "attachment_intent_conflict",
    });
    await writeFile(
      join(worktree, ".reins", "workspace.json"),
      JSON.stringify({
        ...currentConfiguration,
        bindings: [
          {
            ref: "code",
            harness: "codex",
            credentialBindingRef: "new-source",
          },
        ],
      }),
    );
    await assert.rejects(runtime.attach(worktree, ["code"], owner), {
      code: "attachment_intent_conflict",
    });
    await writeFile(
      join(worktree, ".reins", "workspace.json"),
      JSON.stringify(currentConfiguration),
    );
    const resumed = await runtime.attach(worktree, ["code"], owner);
    assert.equal(resumed.runtime.status, "preparing");
    assert.equal(resumed.preparation.attempts.length, 2);
  } finally {
    await runtime.close();
  }
});
