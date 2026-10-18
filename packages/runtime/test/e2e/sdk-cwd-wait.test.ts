import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { decodeTurnHandle, encodeTurnHandle } from "@reins/protocol";
import {
  connect,
  ReinsSdkError,
  type ReinsConnection,
  type TurnHandle,
} from "@ykdz/reins-sdk";
import { afterEach, expect, test, vi } from "vitest";

const runtimePackage = fileURLToPath(new URL("../../", import.meta.url));
const daemonBin = join(runtimePackage, "node_modules/.bin/reins-daemon");
const adapters = fileURLToPath(
  new URL("./fixtures/cwd-adapters.ts", import.meta.url),
);
const waitAdapters = fileURLToPath(
  new URL("./fixtures/wait-adapters.ts", import.meta.url),
);
const failureAdapters = fileURLToPath(
  new URL("./fixtures/failure-adapters.ts", import.meta.url),
);
const clients: ReinsConnection[] = [];
const fixtures: Array<{ directory: string; daemon: ChildProcess }> = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const fixture of fixtures.splice(0)) {
    if (
      fixture.daemon.exitCode === null &&
      fixture.daemon.signalCode === null
    ) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          fixture.daemon.kill("SIGKILL");
          resolve();
        }, 5_000);
        fixture.daemon.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
        fixture.daemon.kill("SIGTERM");
      });
    }
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function fixture(adapterFile = adapters) {
  const directory = await mkdtemp(join(tmpdir(), "reins-sdk-cwd-wait-"));
  const daemonCwd = join(directory, "daemon");
  const firstCwd = join(directory, "caller-one", "nested");
  const secondCwd = join(directory, "caller-two", "nested");
  await mkdir(daemonCwd, { recursive: true });
  await mkdir(firstCwd, { recursive: true });
  await mkdir(secondCwd, { recursive: true });
  await writeFile(join(daemonCwd, "marker.txt"), "daemon-owned");
  await writeFile(join(firstCwd, "marker.txt"), "first-caller");
  await writeFile(join(secondCwd, "marker.txt"), "second-caller");
  const env = {
    ...process.env,
    REINS_SOCKET: join(directory, "reins.sock"),
    REINS_STATE_DIR: join(directory, "state"),
    REINS_CONSUMER_CONTEXT: "sdk-cwd-wait-test",
    REINS_IDLE_TIMEOUT_MS: "120000",
  };
  const daemon = spawn(daemonBin, ["--adapters", adapterFile], {
    cwd: daemonCwd,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderr: string[] = [];
  daemon.stderr?.on("data", (chunk: Buffer) => stderr.push(String(chunk)));
  fixtures.push({ directory, daemon });
  await vi.waitFor(async () => {
    expect(daemon.exitCode, stderr.join("")).toBeNull();
    expect((await stat(env.REINS_SOCKET)).isSocket()).toBe(true);
  });
  const connection = await connect({
    socketPath: env.REINS_SOCKET,
    consumerContext: env.REINS_CONSUMER_CONTEXT,
  });
  clients.push(connection);
  return { directory, firstCwd, secondCwd, env, connection };
}

test("SDK validates worker cwd and preserves exact busy, idle, and killed snapshots", async () => {
  const f = await fixture();
  for (const [index, cwd] of [
    "relative",
    join(f.directory, "absent"),
    join(f.firstCwd, "marker.txt"),
  ].entries()) {
    await expect(
      f.connection.spawn(
        {
          sessionLabel: `invalid-cwd-${index}`,
          harness: "codex",
          message: "read-marker",
          cwd,
        },
        f.connection.prepareOperation("spawn"),
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "invalid_params",
        facts: {
          issues: [expect.objectContaining({ path: "cwd" })],
        },
      },
    });
    expect(await f.connection.list()).toEqual([]);
  }

  const spawned = await f.connection.spawn(
    {
      sessionLabel: "caller-cwd",
      harness: "codex",
      message: "hold",
      cwd: f.firstCwd,
    },
    f.connection.prepareOperation("spawn"),
  );
  expect(
    await f.connection.list({ sessionHandle: spawned.sessionHandle }),
  ).toMatchObject([
    {
      sessionHandle: spawned.sessionHandle,
      cwd: f.firstCwd,
      state: "busy",
      activeTurn: spawned.turnHandle,
    },
  ]);
  const timedOut = await f.connection.wait({
    targets: [spawned.turnHandle],
    completion: "all",
    timeoutMs: 0,
  });
  expect(timedOut).toEqual({
    status: "timeout",
    completed: [],
    pending: [spawned.turnHandle],
  });

  await writeFile(join(f.firstCwd, "release"), "finish");
  const completed = await f.connection.wait({
    targets: [spawned.turnHandle],
    completion: "all",
    timeoutMs: 5_000,
  });
  expect(completed).toMatchObject({
    status: "satisfied",
    completed: [{ turnHandle: spawned.turnHandle }],
  });
  expect(JSON.parse(completed.completed[0]?.finalReply ?? "null")).toEqual({
    cwd: f.firstCwd,
    marker: "first-caller",
  });
  const [idle] = await f.connection.list({
    sessionHandle: spawned.sessionHandle,
  });
  expect(idle).toMatchObject({
    sessionHandle: spawned.sessionHandle,
    cwd: f.firstCwd,
    state: "idle",
    lastCompletedTurn: {
      turnHandle: spawned.turnHandle,
      stopReason: "end_turn",
    },
  });
  expect(idle).not.toHaveProperty("activeTurn");

  expect(
    await f.connection.kill(
      { sessionHandle: spawned.sessionHandle },
      f.connection.prepareOperation("kill"),
    ),
  ).toEqual({ sessionHandle: spawned.sessionHandle, status: "killed" });
  const [killed] = await f.connection.list({
    sessionHandle: spawned.sessionHandle,
  });
  expect(killed).toMatchObject({
    state: "killed",
    lastCompletedTurn: {
      turnHandle: spawned.turnHandle,
      stopReason: "end_turn",
    },
  });
  expect(killed).not.toHaveProperty("activeTurn");
  expect(
    await f.connection.wait({
      targets: [spawned.turnHandle],
      completion: "any",
      timeoutMs: 0,
    }),
  ).toMatchObject({
    status: "satisfied",
    completed: [
      {
        turnHandle: spawned.turnHandle,
        stopReason: "end_turn",
        finalReply: completed.completed[0]?.finalReply,
      },
    ],
  });
});

test("SDK any and all waits report the exact target set across out-of-order completion", async () => {
  const f = await fixture();
  const first = await f.connection.spawn(
    {
      sessionLabel: "first-target",
      harness: "codex",
      message: "hold",
      cwd: f.firstCwd,
    },
    f.connection.prepareOperation("spawn"),
  );
  const second = await f.connection.spawn(
    {
      sessionLabel: "second-target",
      harness: "codex",
      message: "hold",
      cwd: f.secondCwd,
    },
    f.connection.prepareOperation("spawn"),
  );

  await writeFile(join(f.secondCwd, "release"), "finish second first");
  expect(
    await f.connection.wait({
      targets: [first.turnHandle, second.turnHandle],
      completion: "any",
      timeoutMs: 5_000,
    }),
  ).toEqual({
    status: "satisfied",
    completed: [
      expect.objectContaining({
        turnHandle: second.turnHandle,
        finalReply: JSON.stringify({
          cwd: f.secondCwd,
          marker: "second-caller",
        }),
      }),
    ],
    pending: [first.turnHandle],
  });

  await writeFile(join(f.firstCwd, "release"), "finish first second");
  expect(
    await f.connection.wait({
      targets: [first.turnHandle, second.turnHandle],
      completion: "all",
      timeoutMs: 5_000,
    }),
  ).toMatchObject({
    status: "satisfied",
    completed: [
      { turnHandle: first.turnHandle },
      { turnHandle: second.turnHandle },
    ],
    pending: [],
  });

  await expect(
    f.connection.wait({
      targets: [],
      completion: "all",
    }),
  ).rejects.toMatchObject({
    stage: "query",
    failure: { code: "invalid_params" },
  });
  await expect(
    f.connection.wait({
      targets: [first.turnHandle, first.turnHandle],
      completion: "all",
    }),
  ).rejects.toBeInstanceOf(ReinsSdkError);
  const firstTarget = decodeTurnHandle(first.turnHandle);
  const secondTarget = decodeTurnHandle(second.turnHandle);
  const wrongParent = encodeTurnHandle({
    sessionId: secondTarget.sessionId,
    turnId: firstTarget.turnId,
  }) as unknown as TurnHandle;
  await expect(
    f.connection.wait({
      targets: [first.turnHandle, wrongParent],
      completion: "all",
    }),
  ).rejects.toMatchObject({ failure: { code: "invalid_params" } });
  await expect(
    f.connection.wait({
      targets: ["invalid" as TurnHandle],
      completion: "all",
    }),
  ).rejects.toMatchObject({
    stage: "query",
    failure: { code: "invalid_params" },
  });
  const foreign = await connect({
    socketPath: f.env.REINS_SOCKET,
    consumerContext: "other-sdk-cwd-wait-consumer",
  });
  clients.push(foreign);
  await expect(
    foreign.wait({
      targets: [first.turnHandle, second.turnHandle],
      completion: "all",
    }),
  ).rejects.toMatchObject({ failure: { code: "session_not_found" } });
});

test("SDK any and all preserve every partial result, pending target, and request order", async () => {
  const f = await fixture(waitAdapters);
  const spawn = async (sessionLabel: string, message: string) =>
    f.connection.spawn(
      { sessionLabel, harness: "codex", message, cwd: f.firstCwd },
      f.connection.prepareOperation("spawn"),
    );
  const a = await spawn(
    "any-all-a",
    JSON.stringify({ stopReason: "failed", reply: "A" }),
  );
  const b = await spawn(
    "any-all-b",
    JSON.stringify({ gate: join(f.directory, "release-b"), reply: "B" }),
  );
  const c = await spawn("any-all-c", "C");
  const d = await spawn(
    "any-all-d",
    JSON.stringify({ gate: join(f.directory, "release-d"), reply: "D" }),
  );
  await f.connection.wait({
    targets: [a.turnHandle, c.turnHandle],
    completion: "all",
    timeoutMs: 5_000,
  });
  const targets = [c.turnHandle, d.turnHandle, a.turnHandle, b.turnHandle];
  expect(
    await f.connection.wait({
      targets,
      completion: "any",
      timeoutMs: 0,
    }),
  ).toMatchObject({
    status: "satisfied",
    completed: [
      { turnHandle: c.turnHandle, finalReply: "C" },
      {
        turnHandle: a.turnHandle,
        stopReason: "failed",
        finalReply: "A",
        failure: {
          failureCategory: "unclassified",
          retryDisposition: "unknown",
        },
      },
    ],
    pending: [d.turnHandle, b.turnHandle],
  });
  expect(
    await f.connection.wait({ targets, completion: "all", timeoutMs: 80 }),
  ).toMatchObject({
    status: "timeout",
    completed: [
      { turnHandle: c.turnHandle, finalReply: "C" },
      {
        turnHandle: a.turnHandle,
        stopReason: "failed",
        finalReply: "A",
        failure: {
          failureCategory: "unclassified",
          retryDisposition: "unknown",
        },
      },
    ],
    pending: [d.turnHandle, b.turnHandle],
  });

  let settled = false;
  const waiting = f.connection
    .wait({ targets, completion: "all" })
    .then((result) => {
      settled = true;
      return result;
    });
  await writeFile(join(f.directory, "release-d"), "complete D");
  await f.connection.wait({ targets: [d.turnHandle], completion: "all" });
  expect(settled).toBe(false);
  await writeFile(join(f.directory, "release-b"), "complete B");
  expect(await waiting).toMatchObject({
    status: "satisfied",
    completed: [
      { turnHandle: c.turnHandle, finalReply: "C" },
      { turnHandle: d.turnHandle, finalReply: "D" },
      {
        turnHandle: a.turnHandle,
        stopReason: "failed",
        finalReply: "A",
        failure: {
          failureCategory: "unclassified",
          retryDisposition: "unknown",
        },
      },
      { turnHandle: b.turnHandle, finalReply: "B" },
    ],
    pending: [],
  });
});

test("an old exact SDK target remains completed while its session runs a later turn", async () => {
  const f = await fixture(waitAdapters);
  const first = await f.connection.spawn(
    {
      sessionLabel: "turn-history",
      harness: "codex",
      message: "first",
      cwd: f.firstCwd,
    },
    f.connection.prepareOperation("spawn"),
  );
  await f.connection.wait({
    targets: [first.turnHandle],
    completion: "all",
    timeoutMs: 5_000,
  });
  const second = await f.connection.send(
    {
      placement: "new_turn",
      sessionHandle: first.sessionHandle,
      message: JSON.stringify({
        gate: join(f.directory, "release-second-turn"),
        reply: "second",
      }),
    },
    f.connection.prepareOperation("send"),
  );
  expect(second.turnHandle).not.toBe(first.turnHandle);
  expect(
    await f.connection.wait({
      targets: [second.turnHandle, first.turnHandle],
      completion: "any",
      timeoutMs: 0,
    }),
  ).toMatchObject({
    status: "satisfied",
    completed: [{ turnHandle: first.turnHandle, finalReply: "first" }],
    pending: [second.turnHandle],
  });

  const waiting = f.connection.wait({
    targets: [second.turnHandle, first.turnHandle],
    completion: "all",
  });
  await writeFile(join(f.directory, "release-second-turn"), "complete");
  expect(await waiting).toMatchObject({
    status: "satisfied",
    completed: [
      { turnHandle: second.turnHandle, finalReply: "second" },
      { turnHandle: first.turnHandle, finalReply: "first" },
    ],
    pending: [],
  });
});

test("a long finite SDK wait deadline is not clamped to an immediate timeout", async () => {
  const f = await fixture(waitAdapters);
  const gate = join(f.directory, "release-long-deadline");
  const spawned = await f.connection.spawn(
    {
      sessionLabel: "long-deadline",
      harness: "codex",
      message: JSON.stringify({ gate, reply: "long result" }),
      cwd: f.firstCwd,
    },
    f.connection.prepareOperation("spawn"),
  );
  let observed: unknown;
  const waiting = f.connection
    .wait({
      targets: [spawned.turnHandle],
      completion: "all",
      timeoutMs: 2_147_483_648,
    })
    .then((result) => {
      observed = result;
      return result;
    });

  await f.connection.list();
  expect(observed).toBeUndefined();
  await writeFile(gate, "complete");
  expect(await waiting).toMatchObject({
    status: "satisfied",
    completed: [{ turnHandle: spawned.turnHandle, finalReply: "long result" }],
    pending: [],
  });
});

test("SDK preserves typed harness failure facts on the exact completed target", async () => {
  const f = await fixture(waitAdapters);
  expect(await f.connection.capabilities()).toMatchObject({
    capabilities: [{ harness: "codex" }],
    failures: [],
  });
  const spawned = await f.connection.spawn(
    {
      sessionLabel: "failed-turn",
      harness: "codex",
      message: JSON.stringify({
        stopReason: "failed",
        reply: "partial result",
      }),
      cwd: f.firstCwd,
    },
    f.connection.prepareOperation("spawn"),
  );
  expect(
    await f.connection.wait({
      targets: [spawned.turnHandle],
      completion: "all",
      timeoutMs: 5_000,
    }),
  ).toMatchObject({
    status: "satisfied",
    completed: [
      {
        turnHandle: spawned.turnHandle,
        stopReason: "failed",
        finalReply: "partial result",
        failure: {
          failureCategory: "unclassified",
          retryDisposition: "unknown",
        },
      },
    ],
    pending: [],
  });
});

test("SDK capability failures retain typed retry facts without exposing adapter text", async () => {
  const f = await fixture(failureAdapters);
  const capabilities = await f.connection.capabilities();
  expect(capabilities).toMatchObject({
    capabilities: [{ harness: "codex" }],
    failures: [
      {
        harness: "unavailable",
        failureCategory: "unclassified",
        retryDisposition: "unknown",
      },
    ],
  });
  expect(JSON.stringify(capabilities)).not.toContain("private credential");
});
