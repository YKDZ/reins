import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInMemoryTransportPair } from "@reins/transport";
import type { WorkspaceMessage } from "@reins/workspace-protocol";
import { expect, test } from "vitest";

import { createWorkspaceClient } from "../../src/index.ts";

test("Git import preserves an existing dangling symbolic reference and creates a competing new reference only once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reins-git-result-"));
  const git = (args: string[]) =>
    execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
    }).trim();
  git(["init", "--quiet"]);
  await writeFile(join(directory, "result.txt"), "prepared result\n");
  git(["add", "result.txt"]);
  git([
    "-c",
    "user.name=Worker",
    "-c",
    "user.email=worker@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "prepared result",
  ]);
  const commit = git(["rev-parse", "HEAD"]);
  git(["bundle", "create", join(directory, "result.bundle"), "HEAD"]);
  const content = await readFile(join(directory, "result.bundle"));
  const wire = createInMemoryTransportPair<WorkspaceMessage>();
  const client = createWorkspaceClient(wire.client, {
    consumerContext: "owner" as never,
  });
  const publicationId = "pub-00000000-0000-0000-0000-000000000001";
  wire.server.onEvent((event) => {
    if (event.kind !== "message" || event.message.kind !== "request") return;
    wire.server.send({
      kind: "response",
      requestId: event.message.requestId,
      result:
        event.message.method === "initialize"
          ? { protocolMajorVersion: 1 }
          : {
              publication: {
                publicationId,
                source: {
                  cwd: directory,
                  path: join(directory, "result.bundle"),
                },
                bytes: content.length,
                sha256: createHash("sha256").update(content).digest("hex"),
                state: "ready",
              },
              contentBase64: content.toString("base64"),
            },
    });
  });
  try {
    await client.initialize();
    const reference = "refs/received/symbolic";
    git(["symbolic-ref", reference, "refs/heads/missing"]);
    await expect(
      client.importGitPublication(publicationId, {
        repository: directory,
        reference,
        commit,
      }),
    ).rejects.toMatchObject({
      code: "git_import_failed",
      gitImport: { referenceCreated: false },
    });
    expect(git(["symbolic-ref", reference])).toBe("refs/heads/missing");
    const competing = await Promise.allSettled(
      [1, 2].map(() =>
        client.importGitPublication(publicationId, {
          repository: directory,
          reference: "refs/received/race",
          commit,
        }),
      ),
    );
    expect(
      competing.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      competing.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(git(["rev-parse", "refs/received/race"])).toBe(commit);
    const empty = join(directory, "empty");
    await mkdir(empty);
    git(["init", "--quiet", empty]);
    execFileSync("git", [
      "-C",
      empty,
      "symbolic-ref",
      "HEAD",
      "refs/heads/active",
    ]);
    await expect(
      client.importGitPublication(publicationId, {
        repository: empty,
        reference: "refs/heads/active",
        commit,
      }),
    ).rejects.toMatchObject({
      code: "git_import_failed",
      gitImport: { referenceCreated: false },
    });
    expect(
      execFileSync("git", ["-C", empty, "for-each-ref"], { encoding: "utf8" }),
    ).toBe("");
  } finally {
    client.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
