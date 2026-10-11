import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readlink,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";

import { createWorkspaceClient } from "@reins/client";
import {
  consumerContextSchema,
  sessionNameSchema,
  type SessionId,
} from "@reins/protocol";
import { createUnixSocketClient } from "@reins/transport";
import type { WorkspaceMessage } from "@reins/workspace-protocol";
import { captureSelectedWorkingFiles } from "@reins/workspace-source";
import * as v from "valibot";

const task = JSON.parse(process.argv[2]!) as {
  base: string;
  socket: string;
  image: string;
  runtimeImage: string;
  cliPath: string;
};
const manager = createWorkspaceClient(
  await createUnixSocketClient<WorkspaceMessage>(task.socket),
  { consumerContext: v.parse(consumerContextSchema, "reins-wrr25-owner-a") },
);
await manager.initialize();
const source = join(task.base, "caller-source");
await mkdir(join(source, "src"), { recursive: true });
const git = (...args: string[]) =>
  execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
git("init", "--quiet");
await mkdir(join(source, ".reins"));
await writeFile(
  join(source, ".reins/workspace.json"),
  JSON.stringify({
    environments: [{ provider: "docker", image: task.image }],
    runtimes: [
      { harness: "codex", version: "0.149.0", image: task.runtimeImage },
    ],
    bindings: [{ ref: "code", harness: "codex" }],
  }),
);
for (const path of ["input.txt", "staged.txt", "omit.txt", "deleted.txt"])
  await writeFile(join(source, "src", path), "base\n");
await writeFile(
  join(source, ".gitignore"),
  "src/ignored.txt\nsrc/ignored-omit.txt\n",
);
git("add", ".");
git(
  "-c",
  "user.name=Fixture",
  "-c",
  "user.email=fixture@example.invalid",
  "commit",
  "-qm",
  "base",
);
const commit = git("rev-parse", "HEAD");
await writeFile(join(source, "src/staged.txt"), "selected staged\n");
await writeFile(join(source, "src/input.txt"), "intermediate index\n");
git("add", "src/staged.txt", "src/input.txt");
await writeFile(join(source, "src/staged.txt"), "unselected working version\n");
await writeFile(join(source, "src/input.txt"), "selected unstaged\n");
await writeFile(join(source, "src/omit.txt"), "unselected edit\n");
await rm(join(source, "src/deleted.txt"));
await writeFile(join(source, "src/untracked.txt"), "selected untracked\n");
await writeFile(
  join(source, "src/untracked-omit.txt"),
  "unselected untracked\n",
);
await writeFile(join(source, "src/ignored.txt"), "selected ignored\n");
await writeFile(join(source, "src/ignored-omit.txt"), "unselected ignored\n");
await writeFile(join(source, "src/binary"), Buffer.from([0, 255, 128, 10]));
await writeFile(join(source, "src/run"), "#!/bin/sh\nexit 0\n");
await chmod(join(source, "src/run"), 0o755);
await symlink("input.txt", join(source, "src/link"));
const selection = [
  { path: "src/staged.txt", source: "index" as const },
  ...[
    "input.txt",
    "deleted.txt",
    "untracked.txt",
    "ignored.txt",
    "binary",
    "run",
    "link",
  ].map((path) => ({ path: `src/${path}`, source: "worktree" as const })),
];
const indexPath = git(
  "rev-parse",
  "--path-format=absolute",
  "--git-path",
  "index",
);
const digest = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");
const original = async () => ({
  head: git("rev-parse", "HEAD"),
  index: digest(await readFile(indexPath)),
  files: await Promise.all(
    (await readdir(join(source, "src"))).map(async (path) => ({
      path,
      bytes:
        path === "link"
          ? await readlink(join(source, "src", path))
          : digest(await readFile(join(source, "src", path))),
      mode: (await stat(join(source, "src", path))).mode & 0o777,
    })),
  ),
});
await writeFile(join(task.base, "original-index"), await readFile(indexPath));
const before = await original();
const material = await captureSelectedWorkingFiles(source, commit, selection);
assert.deepEqual(await original(), before);
const facts: unknown[] = [];
const record = async (name: string, value: unknown) => {
  facts.push({ name, value });
  await writeFile(
    join(task.base, "evidence/selected-source-facts.json"),
    JSON.stringify(facts, null, 2),
  );
};
await record("caller-original", before);
await record("captured-material", material);
const controls: Awaited<ReturnType<typeof manager.control>>[] = [];
const sessions: {
  control: Awaited<ReturnType<typeof manager.control>>;
  sessionId: SessionId;
}[] = [];
const incoming: string[] = [];
const PREPARATION_CLEANUP_WAIT_MS = 300_000;
const waitForPreparation = async (cwd: string) => {
  const deadline = Date.now() + PREPARATION_CLEANUP_WAIT_MS;
  let polls = 0;
  let status = await manager.request("workspace.status", { cwd });
  while (status.runtime.status === "preparing" && Date.now() < deadline) {
    await delay(1_000);
    status = await manager.request("workspace.status", { cwd });
    polls += 1;
  }
  return { status, polls };
};
try {
  const first = JSON.parse(
    execFileSync(
      process.execPath,
      [
        task.cliPath,
        "workspace",
        "handoff",
        "--repository",
        source,
        "--commit",
        commit,
        "--subdirectory",
        "src",
        "--binding",
        "code",
        "--index-file",
        "src/staged.txt",
        "--worktree-file",
        ...selection.filter((x) => x.source === "worktree").map((x) => x.path),
      ],
      { encoding: "utf8" },
    ),
  ) as Awaited<ReturnType<typeof manager.request<"workspace.handoff">>>;
  incoming.push(first.workspace.cwd);
  assert.equal(first.workspace.runtime.status, "ready", JSON.stringify(first));
  assert.deepEqual(await original(), before);
  assert.equal(
    execFileSync("git", ["-C", first.workspace.cwd, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    commit,
  );
  const control = await manager.control({
    workspaceHandle: first.workspaceHandle,
  });
  controls.push(control);
  assert.ok("result" in (await control.initialize()));
  const paths = [
    "staged.txt",
    "input.txt",
    "deleted.txt",
    "untracked.txt",
    "ignored.txt",
    "binary",
    "run",
    "link",
    "omit.txt",
    "untracked-omit.txt",
    "ignored-omit.txt",
  ];
  const message = JSON.stringify({ path: "input.txt", paths });
  const spawned = await control.request("spawn", {
    harness: "codex",
    cwd: first.workspace.cwd,
    sessionName: v.parse(sessionNameSchema, "selected-reader"),
    message,
  });
  assert.ok("result" in spawned, JSON.stringify(spawned));
  sessions.push({ control, sessionId: spawned.result.sessionId });
  const waited = await control.request("wait", {
    targets: [
      { sessionId: spawned.result.sessionId, turnId: spawned.result.turnId },
    ],
    completion: "all",
  });
  assert.ok("result" in waited);
  const read = JSON.parse(waited.result.completed[0]!.finalReply!);
  assert.equal(read.cwd, first.workspace.cwd);
  assert.equal(read.message, message);
  assert.deepEqual(read.options, {});
  const expected = [
    {
      path: "staged.txt",
      mode: 0o644,
      kind: "file",
      bytes: Buffer.from("selected staged\n").toString("base64"),
    },
    {
      path: "input.txt",
      mode: 0o644,
      kind: "file",
      bytes: Buffer.from("selected unstaged\n").toString("base64"),
    },
    { path: "deleted.txt", missing: true },
    {
      path: "untracked.txt",
      mode: 0o644,
      kind: "file",
      bytes: Buffer.from("selected untracked\n").toString("base64"),
    },
    {
      path: "ignored.txt",
      mode: 0o644,
      kind: "file",
      bytes: Buffer.from("selected ignored\n").toString("base64"),
    },
    { path: "binary", mode: 0o644, kind: "file", bytes: "AP+ACg==" },
    {
      path: "run",
      mode: 0o755,
      kind: "file",
      bytes: Buffer.from("#!/bin/sh\nexit 0\n").toString("base64"),
    },
    { path: "link", mode: 0o777, kind: "symlink", bytes: "input.txt" },
    {
      path: "omit.txt",
      mode: 0o644,
      kind: "file",
      bytes: Buffer.from("base\n").toString("base64"),
    },
    { path: "untracked-omit.txt", missing: true },
    { path: "ignored-omit.txt", missing: true },
  ];
  assert.deepEqual(read.files, expected);
  await record("worker-selected-read", read);
  await writeFile(join(source, "src/input.txt"), "next selected input\n");
  const nextBefore = await original();
  const next = await manager.request(
    "workspace.handoff",
    {
      material: await captureSelectedWorkingFiles(source, commit, selection),
      subdirectory: "src",
      bindings: ["code"],
    },
    120000,
  );
  incoming.push(next.workspace.cwd);
  assert.notEqual(first.workspace.root, next.workspace.root);
  assert.notEqual(first.workspaceHandle, next.workspaceHandle);
  assert.deepEqual(await original(), nextBefore);
  const firstInput = await readFile(
    join(first.workspace.cwd, "input.txt"),
    "utf8",
  );
  const successorInput = await readFile(
    join(next.workspace.cwd, "input.txt"),
    "utf8",
  );
  assert.equal(firstInput, "selected unstaged\n");
  assert.equal(successorInput, "next selected input\n");
  // 本票只核对后继新树及首树保留；旧会话复读由固定提交场景覆盖。
  await record("successor-new-tree-first-input-preserved", {
    first,
    next,
    firstInput,
    successorInput,
    callerUnchanged: true,
  });
  const captureReject = async (name: string, selected = selection) => {
    await assert.rejects(
      captureSelectedWorkingFiles(source, commit, selected),
      { code: "source_invalid" },
    );
    await record(name, { rejected: true });
  };
  await writeFile(join(source, ".git/MERGE_HEAD"), commit + "\n");
  await captureReject("ongoing-git-operation");
  await rm(join(source, ".git/MERGE_HEAD"));
  const blob = git("rev-parse", "HEAD:src/input.txt");
  execFileSync("git", ["-C", source, "update-index", "--index-info"], {
    input: `0 ${"0".repeat(40)}\tsrc/input.txt\n100644 ${blob} 1\tsrc/input.txt\n100644 ${blob} 2\tsrc/input.txt\n100644 ${blob} 3\tsrc/input.txt\n`,
  });
  await captureReject("unmerged-index");
  await writeFile(indexPath, await readFile(join(task.base, "original-index")));
  execFileSync("mkfifo", [join(source, "src/fifo")]);
  await captureReject("unsupported-file-attribute", [
    { path: "src/fifo", source: "worktree" },
  ]);
  await rm(join(source, "src/fifo"));
  await writeFile(join(source, "src/large"), Buffer.alloc(33 * 1024 * 1024));
  await captureReject("over-size-limit", [
    { path: "src/large", source: "worktree" },
  ]);
  await rm(join(source, "src/large"));
  // 独立工作线程持续覆写选定文件；产品不得把不稳定输入报告为成功。
  const changingPath = join(source, "src/changing");
  await writeFile(changingPath, Buffer.alloc(8 * 1024 * 1024));
  const writeCount = new Int32Array(
    new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
  );
  const writer = new Worker(
    `
      const fs = require("node:fs");
      const { parentPort, workerData } = require("node:worker_threads");
      const count = new Int32Array(workerData.writeCount);
      const descriptor = fs.openSync(workerData.path, "r+");
      const bytes = Buffer.alloc(64 * 1024);
      let version = 0;
      function write() {
        bytes.fill(++version % 251);
        fs.writeSync(descriptor, bytes, 0, bytes.length, 0);
        Atomics.add(count, 0, 1);
        if (version === 1) parentPort.postMessage("ready");
        setImmediate(write);
      }
      write();
    `,
    {
      eval: true,
      workerData: { path: changingPath, writeCount: writeCount.buffer },
    },
  );
  let writerError: unknown;
  writer.on("error", (error) => {
    writerError = error;
  });
  try {
    const ready = new Promise<void>((resolve, reject) => {
      writer.once("message", (message) => {
        if (message === "ready") resolve();
        else
          reject(
            new Error(`Unexpected selected-source writer message: ${message}`),
          );
      });
      writer.once("error", reject);
      writer.once("exit", (code) => {
        if (code !== 0)
          reject(new Error(`Selected-source writer exited with ${code}`));
      });
    });
    await ready;
    const writesBeforeCapture = Atomics.load(writeCount, 0);
    let captureError: unknown;
    try {
      await captureSelectedWorkingFiles(source, commit, [
        { path: "src/changing", source: "worktree" },
      ]);
    } catch (error) {
      captureError = error;
    }
    const writesAfterCapture = Atomics.load(writeCount, 0);
    const writerErrorFact =
      writerError instanceof Error
        ? { name: writerError.name, message: writerError.message }
        : writerError === undefined
          ? null
          : typeof writerError;
    await record("continuously-changing", {
      rejected:
        (captureError as { code?: unknown } | undefined)?.code ===
        "source_invalid",
      writesBeforeCapture,
      writesAfterCapture,
      writesDuringCapture: writesAfterCapture - writesBeforeCapture,
      writerError: writerErrorFact,
    });
    assert.equal(
      (captureError as { code?: unknown } | undefined)?.code,
      "source_invalid",
    );
    assert.ok(
      writesAfterCapture > writesBeforeCapture,
      "The selected file must change while capture is running",
    );
    assert.equal(writerError, undefined);
  } finally {
    await writer.terminate();
    await rm(changingPath);
  }
  const beforeReject = await readdir(join(task.base, "manager-state/incoming"));
  const invalid = {
    ...material,
    selectedFiles: [
      { path: "../escape", mode: "100644" as const, contentBase64: "YQ==" },
    ],
  };
  await assert.rejects(
    manager.request(
      "workspace.handoff",
      { material: invalid, subdirectory: "src", bindings: ["code"] },
      120000,
    ),
    { code: "source_invalid" },
  );
  assert.deepEqual(
    await readdir(join(task.base, "manager-state/incoming")),
    beforeReject,
  );
  await record("whole-target-rejection", { incomingUnchanged: true });
  await record("result", "passed");
} finally {
  const cleanupFailures: string[] = [];
  for (const { control, sessionId } of sessions) {
    try {
      const killed = await control.request("kill", { sessionId });
      assert.ok("result" in killed, JSON.stringify(killed));
    } catch (error) {
      cleanupFailures.push(`kill ${sessionId}: ${String(error)}`);
    }
  }
  for (const control of controls) control.close();
  for (const cwd of incoming) {
    try {
      const ready = await waitForPreparation(cwd);
      await record("cleanup-preparation-settled", {
        cwd,
        polls: ready.polls,
        status: ready.status.runtime.status,
      });
      if (ready.status.runtime.status !== "ready")
        cleanupFailures.push(
          `preparation ${cwd}: ${ready.status.runtime.status}`,
        );
      const detached = await manager.request(
        "workspace.detach",
        { cwd, sessionDisposition: "require_none" },
        120000,
      );
      assert.equal(
        detached.runtime.status,
        "released",
        JSON.stringify(detached),
      );
    } catch (error) {
      cleanupFailures.push(`detach ${cwd}: ${String(error)}`);
    }
  }
  manager.close();
  await record("product-cleanup", {
    sessionsKilled: sessions.length,
    detached: incoming,
    status: cleanupFailures.length === 0 ? "passed" : "failed",
    failures: cleanupFailures,
  });
  assert.deepEqual(cleanupFailures, []);
}
