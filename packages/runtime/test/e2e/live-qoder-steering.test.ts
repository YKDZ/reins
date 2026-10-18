import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDaemonState } from "@reins/daemon/state";
import {
  connect,
  parseRuntimeScopeId,
  type AgentFact,
  type ReinsConnection,
} from "@ykdz/reins-sdk";
import { afterEach, expect, test as baseTest, vi } from "vitest";

const runtimePackage = fileURLToPath(new URL("../../", import.meta.url));
const daemonBin = join(runtimePackage, "node_modules/.bin/reins-daemon");
const test =
  process.env.REINS_LIVE_QODER_STEERING === "1" ? baseTest : baseTest.skip;
const fixtures: Array<{
  readonly directory: string;
  readonly daemon: ChildProcess;
  connection?: ReinsConnection;
}> = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) {
    fixture.connection?.close();
    if (
      fixture.daemon.exitCode === null &&
      fixture.daemon.signalCode === null
    ) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          fixture.daemon.kill("SIGKILL");
          resolve();
        }, 10_000);
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

async function fixture() {
  if (!process.env.QODERCLI_PATH)
    throw new Error("QODERCLI_PATH must select the installed Qoder CLI");
  const directory = await mkdtemp(join(tmpdir(), "reins-live-qoder-steering-"));
  const cwd = join(directory, "caller");
  const runtime = join(directory, "runtime");
  await mkdir(cwd, { recursive: true });
  await mkdir(runtime, { recursive: true });
  const env = {
    ...process.env,
    REINS_SOCKET: join(runtime, "reins.sock"),
    REINS_STATE_DIR: join(runtime, "state"),
    REINS_CONSUMER_CONTEXT: "live-qoder-steering-ticket-24",
    REINS_IDLE_TIMEOUT_MS: "120000",
  };
  const daemon = spawn(daemonBin, [], {
    cwd,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const entry: (typeof fixtures)[number] = { directory, daemon };
  fixtures.push(entry);
  const stderr: string[] = [];
  daemon.stderr?.on("data", (chunk: Buffer) => stderr.push(String(chunk)));
  await vi.waitFor(
    async () => {
      expect(daemon.exitCode, stderr.join("")).toBeNull();
      await access(env.REINS_SOCKET);
    },
    { timeout: 10_000 },
  );
  const runtimeScopeId = parseRuntimeScopeId(
    (await resolveDaemonState({ env })).runtimeScopeId,
  );
  const connection = await connect({
    socketPath: env.REINS_SOCKET,
    consumerContext: env.REINS_CONSUMER_CONTEXT,
    runtimeScopeId,
  });
  entry.connection = connection;
  return { cwd, connection };
}

async function waitForFact(
  facts: AgentFact[],
  predicate: (fact: AgentFact) => boolean,
  message: string,
): Promise<AgentFact> {
  await vi.waitFor(
    () => {
      expect(facts.some(predicate), message).toBe(true);
    },
    { timeout: 120_000, interval: 100 },
  );
  const fact = facts.find(predicate);
  if (fact === undefined) throw new Error(message);
  return fact;
}

test("公开 SDK 经生产 daemon 与固定 Qoder CLI 完成精确中断续接", async () => {
  const { cwd, connection } = await fixture();
  const marker = join(cwd, "effect.txt");
  const initial = await connection.spawn(
    {
      sessionLabel: "ticket-24-qoder-steering",
      harness: "qoder",
      authorizationMode: "allowAll",
      message: `Use exactly one Bash tool call with this exact command: printf 'ONCE\\n' >> ${marker}; sleep 60. Do not use other tools. After that command ends, reply ORIGINAL_DONE. If a new user message arrives before it ends, stop the old task and follow that request.`,
      cwd,
    },
    { operationKey: connection.prepareOperation("spawn") },
  );
  const subscription = await connection.attach(
    { scope: "turn", turnHandle: initial.turnHandle },
    { mode: "history" },
  );
  const facts: AgentFact[] = [];
  const consume = (async () => {
    for await (const fact of subscription) {
      facts.push(fact);
      subscription.acknowledge(fact);
    }
  })();

  await waitForFact(
    facts,
    (fact) => fact.type === "tool.requested" && fact.name === "Bash",
    "Qoder did not start the requested Bash call",
  );
  await vi.waitFor(
    async () => {
      expect(await readFile(marker, "utf8")).toBe("ONCE\n");
    },
    { timeout: 120_000, interval: 50 },
  );

  const correction =
    "Stop the unfinished command. Do not call any tools. Reply CONTROL_CONTINUED only.";
  const activeSendKey = connection.prepareOperation("send");
  const activeSend = connection.send(
    {
      placement: "active_turn",
      turnHandle: initial.turnHandle,
      message: correction,
    },
    { operationKey: activeSendKey },
  );
  const prematureNewTurn = connection.send(
    {
      placement: "new_turn",
      sessionHandle: initial.sessionHandle,
      message: "Reply NEW_TURN_OK only. Do not call tools.",
    },
    { operationKey: connection.prepareOperation("send") },
  );
  await expect(prematureNewTurn).rejects.toMatchObject({
    failure: { code: "session_busy" },
  });
  const accepted = await activeSend;
  expect(accepted).toMatchObject({
    sessionHandle: initial.sessionHandle,
    turnHandle: initial.turnHandle,
    deliveryPoint: "active_turn",
  });
  expect(await connection.getOperation(activeSendKey)).toMatchObject({
    status: "succeeded",
    result: accepted,
  });
  expect(facts.filter((fact) => fact.type === "turn.completed")).toEqual([]);

  const terminal = await waitForFact(
    facts,
    (fact) => fact.type === "turn.completed",
    "The corrected Qoder turn did not reach its terminal event",
  );
  expect(terminal).toMatchObject({
    type: "turn.completed",
    turnHandle: initial.turnHandle,
    stopReason: "end_turn",
  });
  expect(await readFile(marker, "utf8")).toBe("ONCE\n");
  expect(
    facts.filter(
      (fact) => fact.type === "tool.requested" && fact.name === "Bash",
    ),
  ).toHaveLength(1);
  await consume;

  const nextTurn = await connection.send(
    {
      placement: "new_turn",
      sessionHandle: initial.sessionHandle,
      message: "Reply NEW_TURN_OK only. Do not call tools.",
    },
    { operationKey: connection.prepareOperation("send") },
  );
  expect(nextTurn.turnHandle).not.toBe(initial.turnHandle);
  expect(nextTurn.deliveryPoint).toBe("new_turn");

  const nextSubscription = await connection.attach(
    { scope: "turn", turnHandle: nextTurn.turnHandle },
    { mode: "history" },
  );
  const nextFacts: AgentFact[] = [];
  for await (const fact of nextSubscription) {
    nextFacts.push(fact);
    nextSubscription.acknowledge(fact);
  }
  expect(
    nextFacts.filter((fact) => fact.type === "turn.completed"),
  ).toMatchObject([
    { turnHandle: nextTurn.turnHandle, stopReason: "end_turn" },
  ]);
}, 240_000);
