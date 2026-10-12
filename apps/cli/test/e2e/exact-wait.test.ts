import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { decodeTurnHandle, encodeTurnHandle } from "@reins/protocol";
import {
  connect as connectSdk,
  type ReinsConnection,
  type SessionHandle,
  type TurnHandle,
} from "@ykdz/reins-sdk";
import { afterEach, expect, test, vi } from "vitest";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const cliBin = join(repo, "apps/cli/dist/reins.js");
const daemonBin = join(repo, "packages/daemon/dist/main.js");
const adapters = fileURLToPath(
  new URL(
    "../../../../packages/daemon/test/fixtures/wait-adapters.ts",
    import.meta.url,
  ),
);
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
});

async function fixture(adapterFile = adapters) {
  const root = await mkdtemp(join(tmpdir(), "reins-wrr15-cwd-"));
  const runtime = await mkdtemp("/dev/shm/reins-wrr15-runtime-");
  cleanup.push(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  });
  const daemonCwd = join(root, "daemon");
  const callerCwd = join(root, "caller", "nested");
  await mkdir(daemonCwd, { recursive: true });
  await mkdir(callerCwd, { recursive: true });
  await writeFile(join(daemonCwd, "marker.txt"), "daemon-owned-marker");
  await writeFile(join(callerCwd, "marker.txt"), "caller-owned-marker");
  const env = {
    ...process.env,
    REINS_SOCKET: join(runtime, "reins.sock"),
    REINS_STATE_DIR: join(runtime, "state"),
    REINS_CONSUMER_CONTEXT: "exact-wait-test",
    REINS_DAEMON_BIN: daemonBin,
  };
  const daemon: ChildProcess = spawn(
    process.execPath,
    [daemonBin, "--adapters", adapterFile],
    { cwd: daemonCwd, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const errors: string[] = [];
  daemon.stderr?.on("data", (chunk) => errors.push(String(chunk)));
  cleanup.push(async () => {
    if (daemon.exitCode !== null || daemon.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      daemon.once("close", () => resolve());
      daemon.kill("SIGTERM");
    });
  });
  async function cli(args: string[], cwd = callerCwd) {
    const child = spawn(process.execPath, [cliBin, ...args], {
      env,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    const exitCode = await new Promise<number | null>((resolve) =>
      child.once("close", resolve),
    );
    return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
  }
  await vi.waitFor(async () => {
    expect(daemon.exitCode, errors.join("")).toBeNull();
    await access(env.REINS_SOCKET);
    const result = await cli(["list"]);
    expect(result.exitCode, result.stderr + errors.join("")).toBe(0);
  });
  async function sdk(consumerContext = env.REINS_CONSUMER_CONTEXT) {
    const connection = await connectSdk({
      socketPath: env.REINS_SOCKET,
      consumerContext,
    });
    cleanup.push(async () => connection.close());
    return connection;
  }
  return { root, runtime, daemonCwd, callerCwd, env, cli, sdk };
}

test("SDK wait timeout preserves the exact target for a later wait", async () => {
  const { callerCwd, cli, root, sdk } = await fixture();
  const task = { gate: join(root, "release"), reply: "completed later" };
  const prepared = await cli(["prepare-operation", "spawn"]);
  expect(prepared.exitCode, prepared.stderr).toBe(0);
  const credential = JSON.parse(prepared.stdout).data.credential as string;
  const spawned = await cli([
    "spawn",
    "--operation",
    credential,
    "--name",
    "sdk-wait",
    "--harness",
    "codex",
    "--message",
    JSON.stringify(task),
    "--cwd",
    callerCwd,
  ]);
  expect(spawned.exitCode, spawned.stderr + spawned.stdout).toBe(0);
  const running = JSON.parse(spawned.stdout).data as {
    turnHandle: string;
    sessionHandle: string;
  };
  const connection = await sdk();
  const target = running.turnHandle as TurnHandle;

  expect(
    await connection.wait({
      targets: [target],
      completion: "all",
      timeoutMs: 0,
    }),
  ).toEqual({ status: "timeout", completed: [], pending: [target] });
  expect(await connection.list()).toMatchObject([
    { sessionHandle: running.sessionHandle, state: "busy" },
  ]);

  await writeFile(join(root, "release"), "release worker");
  await expect(
    connection.wait({ targets: [target], completion: "all" }),
  ).resolves.toMatchObject({
    status: "satisfied",
    completed: [
      {
        turnHandle: target,
        stopReason: "end_turn",
        finalReply: "completed later",
      },
    ],
    pending: [],
  });
});

test("wait reads the exact natural terminal even after the session is killed", async () => {
  const { cli, sdk } = await fixture();
  const client = await sdk();
  const turn = await spawnTarget(cli, "historical", {
    reply: "caller original task",
  });
  await waitIdle(client, turn.target.sessionId);
  const killCredential = await preparedCredential(cli, "kill");
  expect(
    (
      await cli([
        "kill",
        "--session",
        turn.target.sessionId,
        "--operation",
        killCredential,
      ])
    ).exitCode,
  ).toBe(0);
  await expect(
    client.wait({
      targets: [turn.turnHandle],
      completion: "any",
      timeoutMs: 0,
    }),
  ).resolves.toMatchObject({
    status: "satisfied",
    completed: [
      {
        turnHandle: turn.turnHandle,
        stopReason: "end_turn",
        finalReply: "caller original task",
      },
    ],
    pending: [],
  });
});

test("failed wait 的 JSON 与 pretty 从同一 typed 事实提供可读处置", async () => {
  const { cli, sdk } = await fixture();
  const client = await sdk();
  const failed = await spawnTarget(cli, "reins-wrr19-render", {
    stopReason: "failed",
    reply: "native private text",
  });
  await waitIdle(client, failed.target.sessionId);
  const json = await cli(["wait", failed.turnHandle, "--completion", "all"]);
  expect(json.exitCode).toBe(1);
  expect(JSON.parse(json.stdout).data.result).toMatchObject({
    completed: [
      {
        turnHandle: failed.turnHandle,
        failure: {
          failureCategory: "unclassified",
          retryDisposition: "unknown",
        },
        message:
          "Harness failure is unclassified. Retry disposition is unknown; inspect the available evidence before choosing another action",
      },
    ],
  });
  const pretty = await cli([
    "--output-format",
    "text",
    "wait",
    failed.turnHandle,
    "--completion",
    "all",
  ]);
  expect(pretty.exitCode).toBe(1);
  expect(pretty.stdout).toContain(
    JSON.parse(json.stdout).data.result.completed[0].message,
  );
});

test("CLI capabilities 保留成功与失败，并与 client 使用同一未知处置", async () => {
  const { cli, sdk } = await fixture(
    join(repo, "packages/daemon/test/fixtures/failure-adapters.ts"),
  );
  const client = await sdk();
  const response = await client.capabilities();
  expect(response).toMatchObject({
    capabilities: [{ harness: "codex" }],
    failures: [
      {
        harness: "unavailable",
        failureCategory: "unclassified",
        retryDisposition: "unknown",
      },
    ],
  });
  const json = await cli(["capabilities"]);
  expect(json.exitCode).toBe(0);
  const result = JSON.parse(json.stdout).data;
  expect(result).toMatchObject({
    capabilities: [{ harness: "codex" }],
    failures: [
      {
        harness: "unavailable",
        failure: {
          failureCategory: "unclassified",
          retryDisposition: "unknown",
        },
        message: expect.stringContaining("Harness failure is unclassified"),
      },
    ],
  });
  expect(json.stdout).not.toContain("private credential");
  const pretty = await cli(["--output-format", "text", "capabilities"]);
  expect(pretty.exitCode).toBe(0);
  expect(pretty.stdout).toContain("codex");
  expect(pretty.stdout).toContain(
    "Harness failure is unclassified. Retry disposition is unknown",
  );
  expect(pretty.stdout).toContain("reins diagnostics --id");
  expect(pretty.stdout).not.toContain("private credential");
});

async function spawnTarget(
  cli: Awaited<ReturnType<typeof fixture>>["cli"],
  name: string,
  task: { gate?: string; stopReason?: string; reply: string },
) {
  const prepared = await cli(["prepare-operation", "spawn"]);
  expect(prepared.exitCode, prepared.stderr).toBe(0);
  const credential = JSON.parse(prepared.stdout).data.credential as string;
  const spawned = await cli([
    "spawn",
    "--operation",
    credential,
    "--name",
    name,
    "--harness",
    "codex",
    "--message",
    JSON.stringify(task),
    "--cwd",
    process.cwd(),
  ]);
  expect(spawned.exitCode, spawned.stderr + spawned.stdout).toBe(0);
  const { sessionHandle, turnHandle } = JSON.parse(spawned.stdout).data as {
    sessionHandle: string;
    turnHandle: string;
  };
  return {
    target: decodeTurnHandle(turnHandle),
    turnHandle: turnHandle as TurnHandle,
    sessionHandle,
  };
}

async function preparedCredential(
  cli: Awaited<ReturnType<typeof fixture>>["cli"],
  operation: "spawn" | "send" | "interrupt" | "kill",
) {
  const result = await cli(["prepare-operation", operation]);
  expect(result.exitCode, result.stderr + result.stdout).toBe(0);
  expect(JSON.parse(result.stdout).data.operation).toBe(operation);
  return JSON.parse(result.stdout).data.credential as string;
}
async function waitIdle(client: ReinsConnection, sessionId: string) {
  await vi.waitFor(async () =>
    expect(await client.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionHandle: sessionId, state: "idle" }),
      ]),
    ),
  );
}

test("SDK send rejects an unknown or omitted placement without opening a new turn", async () => {
  const { cli, sdk } = await fixture();
  const connection = await sdk();
  const initial = await spawnTarget(cli, "invalid-send-placement", {
    reply: "original turn",
  });
  await waitIdle(connection, initial.target.sessionId);
  const before = await connection.list({
    sessionHandle: initial.sessionHandle as SessionHandle,
  });
  const credential = connection.prepareOperation("send");

  for (const input of [
    {
      placement: "bogus",
      sessionHandle: initial.sessionHandle,
      message: "must not be redirected",
    },
    {
      sessionHandle: initial.sessionHandle,
      message: "must not default to new_turn",
    },
  ]) {
    await expect(
      connection.send(
        input as unknown as Parameters<ReinsConnection["send"]>[0],
        credential,
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "invalid_params",
        facts: { issues: [expect.objectContaining({ path: "placement" })] },
      },
    });
  }

  expect(
    await connection.list({
      sessionHandle: initial.sessionHandle as SessionHandle,
    }),
  ).toEqual(before);
  await expect(
    connection.wait({ targets: [initial.turnHandle], completion: "all" }),
  ).resolves.toMatchObject({
    status: "satisfied",
    completed: [
      { turnHandle: initial.turnHandle, finalReply: "original turn" },
    ],
    pending: [],
  });
});

test("SDK and CLI send preserve the original message and return the exact new turn", async () => {
  const { callerCwd, cli, sdk } = await fixture();
  const connection = await sdk();
  const initial = await spawnTarget(cli, "faithful-send", { reply: "ready" });
  await waitIdle(connection, initial.target.sessionId);

  const sdkMessage = "  SDK follow-up\nkeep spacing  ";
  const sdkCredential = connection.prepareOperation("send");
  const sdkAck = await connection.send(
    {
      placement: "new_turn",
      sessionHandle: initial.sessionHandle as SessionHandle,
      message: sdkMessage,
    },
    sdkCredential,
  );
  expect(sdkAck).toMatchObject({
    sessionHandle: initial.sessionHandle,
    deliveryPoint: "new_turn",
  });
  expect(sdkAck.turnHandle).not.toBe(initial.turnHandle);
  await expect(
    connection.wait({
      targets: [sdkAck.turnHandle],
      completion: "all",
    }),
  ).resolves.toMatchObject({
    completed: [
      {
        turnHandle: sdkAck.turnHandle,
        finalReply: sdkMessage,
      },
    ],
    pending: [],
  });

  const cliMessage = "  CLI follow-up\nkeep exact bytes  ";
  const cliCredential = await preparedCredential(cli, "send");
  const cliAck = await cli(
    [
      "send",
      initial.sessionHandle,
      "--placement",
      "new_turn",
      "--message",
      cliMessage,
      "--operation",
      cliCredential,
    ],
    callerCwd,
  );
  expect(cliAck.exitCode, cliAck.stderr + cliAck.stdout).toBe(0);
  const cliResult = JSON.parse(cliAck.stdout).data as {
    sessionHandle: string;
    turnHandle: TurnHandle;
  };
  expect(cliResult).toMatchObject({
    sessionHandle: initial.sessionHandle,
  });
  expect(Object.keys(cliResult).sort()).toEqual([
    "sessionHandle",
    "turnHandle",
  ]);
  expect(cliResult.turnHandle).not.toBe(sdkAck.turnHandle);
  await expect(
    connection.wait({
      targets: [cliResult.turnHandle],
      completion: "all",
    }),
  ).resolves.toMatchObject({
    completed: [
      {
        turnHandle: cliResult.turnHandle,
        finalReply: cliMessage,
      },
    ],
    pending: [],
  });

  const textMessage = "third turn without transport details";
  const textCredential = await preparedCredential(cli, "send");
  const textAck = await cli(
    [
      "send",
      initial.sessionHandle,
      "--placement",
      "new_turn",
      "--message",
      textMessage,
      "--operation",
      textCredential,
      "--output-format",
      "text",
    ],
    callerCwd,
  );
  expect(textAck.exitCode, textAck.stderr).toBe(0);
  const textTurnHandle = textAck.stdout
    .trim()
    .match(/Message delivered to (\S+)/u)?.[1];
  expect(textTurnHandle).toBeTruthy();
  expect(textAck.stdout.trim()).toBe(`Message delivered to ${textTurnHandle}`);
  await expect(
    connection.wait({
      targets: [textTurnHandle as TurnHandle],
      completion: "all",
    }),
  ).resolves.toMatchObject({ status: "satisfied", pending: [] });
});

test("SDK interrupt returns acceptance while wait keeps the same turn pending", async () => {
  const { root, cli, sdk } = await fixture();
  const connection = await sdk();
  const turn = await spawnTarget(cli, "sdk-interrupt", {
    gate: join(root, "interrupt-release"),
    reply: "worker ended naturally",
  });
  const accepted = await connection.interrupt(
    { turnHandle: turn.turnHandle },
    connection.prepareOperation("interrupt"),
  );
  expect(accepted).toEqual({
    turnHandle: turn.turnHandle,
    status: "accepted",
  });
  await expect(
    connection.wait({
      targets: [turn.turnHandle],
      completion: "all",
      timeoutMs: 0,
    }),
  ).resolves.toEqual({
    status: "timeout",
    completed: [],
    pending: [turn.turnHandle],
  });

  await writeFile(join(root, "interrupt-release"), "release worker");
  await expect(
    connection.wait({ targets: [turn.turnHandle], completion: "all" }),
  ).resolves.toMatchObject({
    status: "satisfied",
    completed: [
      {
        turnHandle: turn.turnHandle,
        stopReason: "end_turn",
        finalReply: "worker ended naturally",
      },
    ],
    pending: [],
  });
});

test("any returns every already completed target and pending targets in request order", async () => {
  const { cli, root, sdk } = await fixture();
  const client = await sdk();
  const a = await spawnTarget(cli, "any-a", { reply: "A" });
  const b = await spawnTarget(cli, "any-b", {
    gate: join(root, "b"),
    reply: "B",
  });
  const c = await spawnTarget(cli, "any-c", { reply: "C" });
  const d = await spawnTarget(cli, "any-d", {
    gate: join(root, "d"),
    reply: "D",
  });
  await Promise.all([
    waitIdle(client, a.target.sessionId),
    waitIdle(client, c.target.sessionId),
  ]);
  expect(
    await client.wait({
      targets: [c.turnHandle, d.turnHandle, a.turnHandle, b.turnHandle],
      completion: "any",
      timeoutMs: 0,
    }),
  ).toMatchObject({
    status: "satisfied",
    completed: [
      { turnHandle: c.turnHandle, finalReply: "C" },
      { turnHandle: a.turnHandle, finalReply: "A" },
    ],
    pending: [d.turnHandle, b.turnHandle],
  });
});

test("all waits for the whole collection and keeps request order instead of completion order", async () => {
  const { cli, root, sdk } = await fixture();
  const client = await sdk();
  const a = await spawnTarget(cli, "all-a", {
    gate: join(root, "a"),
    reply: "A",
  });
  const b = await spawnTarget(cli, "all-b", { reply: "B" });
  const c = await spawnTarget(cli, "all-c", {
    gate: join(root, "c"),
    reply: "C",
  });
  await waitIdle(client, b.target.sessionId);
  expect(
    await client.wait({
      targets: [a.turnHandle, b.turnHandle, c.turnHandle],
      completion: "all",
      timeoutMs: 0,
    }),
  ).toMatchObject({
    status: "timeout",
    completed: [{ turnHandle: b.turnHandle, finalReply: "B" }],
    pending: [a.turnHandle, c.turnHandle],
  });
  let settled = false;
  const waiting = client
    .wait({
      targets: [a.turnHandle, b.turnHandle, c.turnHandle],
      completion: "all",
    })
    .then((reply) => {
      settled = true;
      return reply;
    });
  await writeFile(join(root, "c"), "release C");
  await waitIdle(client, c.target.sessionId);
  expect(settled).toBe(false);
  await writeFile(join(root, "a"), "release A");
  expect(await waiting).toMatchObject({
    status: "satisfied",
    completed: [
      { turnHandle: a.turnHandle, finalReply: "A" },
      { turnHandle: b.turnHandle, finalReply: "B" },
      { turnHandle: c.turnHandle, finalReply: "C" },
    ],
    pending: [],
  });
});

test("any wakes on its first satisfying snapshot without waiting for the other worker", async () => {
  const { cli, root, sdk } = await fixture();
  const client = await sdk();
  const a = await spawnTarget(cli, "wake-a", {
    gate: join(root, "a"),
    reply: "A",
  });
  const b = await spawnTarget(cli, "wake-b", {
    gate: join(root, "b"),
    reply: "B",
  });
  expect(
    await client.wait({
      targets: [a.turnHandle, b.turnHandle],
      completion: "any",
      timeoutMs: 0,
    }),
  ).toMatchObject({
    status: "timeout",
    completed: [],
    pending: [a.turnHandle, b.turnHandle],
  });
  const waiting = client.wait({
    targets: [a.turnHandle, b.turnHandle],
    completion: "any",
  });
  await writeFile(join(root, "b"), "release B");
  expect(await waiting).toMatchObject({
    status: "satisfied",
    completed: [{ turnHandle: b.turnHandle, finalReply: "B" }],
    pending: [a.turnHandle],
  });
});

test("SDK domain timeout retains partial facts without cancelling work", async () => {
  const { cli, root, sdk } = await fixture();
  const client = await sdk();
  const done = await spawnTarget(cli, "partial-done", {
    stopReason: "failed",
    reply: "failure fact",
  });
  const running = await spawnTarget(cli, "partial-running", {
    gate: join(root, "release"),
    reply: "late fact",
  });
  await waitIdle(client, done.target.sessionId);
  expect(
    await client.wait({
      targets: [running.turnHandle, done.turnHandle],
      completion: "all",
      timeoutMs: 80,
    }),
  ).toMatchObject({
    status: "timeout",
    completed: [
      {
        turnHandle: done.turnHandle,
        stopReason: "failed",
        finalReply: "failure fact",
      },
    ],
    pending: [running.turnHandle],
  });
  expect(await client.list()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        sessionHandle: running.target.sessionId,
        state: "busy",
      }),
    ]),
  );
  await writeFile(join(root, "release"), "caller permits completion");
  expect(
    await client.wait({
      targets: [running.turnHandle],
      completion: "all",
    }),
  ).toMatchObject({
    status: "satisfied",
    completed: [{ turnHandle: running.turnHandle, finalReply: "late fact" }],
    pending: [],
  });
});

test("the complete target collection is rejected before any wait, including duplicate, foreign and wrong-parent targets", async () => {
  const { cli, root, sdk } = await fixture();
  const client = await sdk();
  const foreign = await sdk("another-wait-consumer");
  const a = await spawnTarget(cli, "validate-a", {
    gate: join(root, "a"),
    reply: "A",
  });
  const b = await spawnTarget(cli, "validate-b", {
    gate: join(root, "b"),
    reply: "B",
  });
  for (const targets of [
    [] as TurnHandle[],
    [a.turnHandle, a.turnHandle],
    [
      a.turnHandle,
      encodeTurnHandle({
        sessionId: b.target.sessionId,
        turnId: a.target.turnId,
      }) as unknown as TurnHandle,
    ],
  ]) {
    await expect(
      client.wait({ targets, completion: "any" }),
    ).rejects.toMatchObject({
      failure: { code: "invalid_params" },
    });
  }
  await expect(
    foreign.wait({
      targets: [a.turnHandle, b.turnHandle],
      completion: "all",
    }),
  ).rejects.toMatchObject({ failure: { code: "session_not_found" } });
  expect(
    await client.wait({
      targets: [a.turnHandle, b.turnHandle],
      completion: "all",
      timeoutMs: 0,
    }),
  ).toMatchObject({
    status: "timeout",
    completed: [],
    pending: [a.turnHandle, b.turnHandle],
  });
  await writeFile(join(root, "a"), "release A");
  expect(
    await client.wait({ targets: [a.turnHandle], completion: "all" }),
  ).toMatchObject({
    status: "satisfied",
    completed: [{ turnHandle: a.turnHandle, finalReply: "A" }],
  });
});

test.each([
  { reasons: ["end_turn"], pending: false, exit: 0 },
  { reasons: ["end_turn", "cancelled"], pending: false, exit: 2 },
  { reasons: ["cancelled", "killed"], pending: false, exit: 3 },
  { reasons: ["killed", "failed", "cancelled"], pending: false, exit: 1 },
  { reasons: ["failed", "killed", "cancelled"], pending: true, exit: 4 },
])(
  "CLI preserves mixed facts with exit priority $exit",
  async ({ reasons, pending, exit }) => {
    const { cli, root, sdk } = await fixture();
    const client = await sdk();
    const turns: Awaited<ReturnType<typeof spawnTarget>>[] = [];
    for (const [index, stopReason] of reasons.entries()) {
      const turn = await spawnTarget(cli, "exit-" + index, {
        ...(stopReason === "killed"
          ? { gate: join(root, "kill-" + index) }
          : { stopReason }),
        reply: "caller fact " + index,
      });
      turns.push(turn);
      if (stopReason === "killed") {
        const credential = await preparedCredential(cli, "kill");
        expect(
          (
            await cli([
              "kill",
              "--session",
              turn.target.sessionId,
              "--operation",
              credential,
            ])
          ).exitCode,
        ).toBe(0);
      } else await waitIdle(client, turn.target.sessionId);
    }
    const active = pending
      ? await spawnTarget(cli, "exit-pending", {
          gate: join(root, "pending"),
          reply: "later",
        })
      : undefined;
    const handles = [
      ...turns.map((turn) => turn.turnHandle),
      ...(active === undefined ? [] : [active.turnHandle]),
    ];
    const result = await cli([
      "wait",
      ...handles,
      "--completion",
      "all",
      ...(pending ? ["--timeout", "0"] : []),
    ]);
    expect(result.exitCode, result.stderr).toBe(exit);
    expect(JSON.parse(result.stdout).data.result).toEqual({
      status: pending ? "timeout" : "satisfied",
      completed: turns.map(({ turnHandle }, index) => ({
        turnHandle,
        stopReason: reasons[index],
        ...(reasons[index] === "failed"
          ? {
              failure: {
                failureCategory: "unclassified",
                retryDisposition: "unknown",
              },
              message:
                "Harness failure is unclassified. Retry disposition is unknown; inspect the available evidence before choosing another action",
            }
          : {}),
        finalReply: reasons[index] === "killed" ? null : "caller fact " + index,
      })),
      pending: active === undefined ? [] : [{ turnHandle: active.turnHandle }],
    });
    const pretty = await cli([
      "--output-format",
      "text",
      "wait",
      ...handles,
      "--completion",
      "all",
      "--timeout",
      "0",
    ]);
    expect(pretty.exitCode, pretty.stderr).toBe(exit);
    for (const [index, turn] of turns.entries()) {
      expect(pretty.stdout).toContain(turn.turnHandle);
      if (reasons[index] !== "killed")
        expect(pretty.stdout).toContain("caller fact " + index);
    }
    if (active !== undefined)
      expect(pretty.stdout).toContain(active.turnHandle);
  },
);

test("an old exact target remains completed while a later turn runs in the same session", async () => {
  const { cli, root, sdk } = await fixture();
  const client = await sdk();
  const first = await spawnTarget(cli, "turn-history", { reply: "first fact" });
  await waitIdle(client, first.target.sessionId);
  const credential = await preparedCredential(cli, "send");
  const sent = await cli([
    "send",
    first.target.sessionId,
    "--placement",
    "new_turn",
    "--message",
    JSON.stringify({ gate: join(root, "next"), reply: "second fact" }),
    "--operation",
    credential,
  ]);
  expect(sent.exitCode, sent.stdout).toBe(0);
  const second = JSON.parse(sent.stdout).data.turnHandle as TurnHandle;
  expect(decodeTurnHandle(second).turnId).not.toBe(first.target.turnId);
  expect(
    await client.wait({
      targets: [second, first.turnHandle],
      completion: "any",
      timeoutMs: 0,
    }),
  ).toMatchObject({
    status: "satisfied",
    completed: [{ turnHandle: first.turnHandle, finalReply: "first fact" }],
    pending: [second],
  });
  const waiting = client.wait({
    targets: [second, first.turnHandle],
    completion: "all",
  });
  await writeFile(join(root, "next"), "release second turn");
  expect(await waiting).toMatchObject({
    status: "satisfied",
    completed: [
      { turnHandle: second, finalReply: "second fact" },
      { turnHandle: first.turnHandle, finalReply: "first fact" },
    ],
    pending: [],
  });
});

test("a long finite domain deadline is not clamped to an immediate timeout", async () => {
  const { cli, root, sdk } = await fixture();
  const client = await sdk();
  const turn = await spawnTarget(cli, "long-deadline", {
    gate: join(root, "long"),
    reply: "caller long result",
  });
  let observed: unknown;
  const waiting = client
    .wait({
      targets: [turn.turnHandle],
      completion: "all",
      timeoutMs: 2_147_483_648,
    })
    .then((reply) => {
      observed = reply;
      return reply;
    });
  // 独立 CLI 完成一次真实往返，确认超大领域期限没有被压成 1 ms。
  expect((await cli(["list"])).exitCode).toBe(0);
  expect(observed).toBeUndefined();
  await writeFile(join(root, "long"), "caller releases long wait");
  expect(await waiting).toMatchObject({
    status: "satisfied",
    completed: [
      { turnHandle: turn.turnHandle, finalReply: "caller long result" },
    ],
    pending: [],
  });
});
