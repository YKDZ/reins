import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

import {
  connect,
  ReinsSdkError,
  type ReinsConnection,
  type SessionHandle,
  type TurnHandle,
} from "@ykdz/reins-sdk";

declare const process: {
  env: Record<string, string | undefined>;
  kill(pid: number, signal: 0): void;
  stdout: { write(value: string): void };
};

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "")
    throw new Error(`The installed SDK isolation fixture needs ${name}`);
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitFor<T>(
  label: string,
  read: () => T,
  matches: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = read();
    if (matches(value)) return value;
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

async function expectSessionMissing(
  action: () => Promise<unknown>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (
      error instanceof ReinsSdkError &&
      error.failure.code === "session_not_found"
    )
      return;
    throw error;
  }
  throw new Error("A foreign consumer controlled another consumer's session");
}

const socketPath = required("REINS_SOCKET");
const ownerContext = required("REINS_CONSUMER_CONTEXT");
const observationPath = required("REINS_PACKED_FIXTURE_OBSERVATIONS");
const activityPath = required("REINS_PACKED_FIXTURE_ACTIVITY");
const owner = await connect({ socketPath, consumerContext: ownerContext });
let foreign: ReinsConnection | undefined;
let recovery: ReinsConnection | undefined;
let firstSession: SessionHandle | undefined;
let secondSession: SessionHandle | undefined;
let firstTurn: TurnHandle | undefined;
let secondTurn: TurnHandle | undefined;
try {
  const cwd = required("REINS_WORKER_CWD");
  const first = await owner.spawn(
    {
      harness: "codex",
      sessionName: "packed-session-a",
      message: "session A",
      cwd,
    },
    owner.prepareOperation("spawn"),
  );
  firstSession = first.sessionHandle;
  firstTurn = first.turnHandle;
  const second = await owner.spawn(
    {
      harness: "codex",
      sessionName: "packed-session-b",
      message: "session B",
      cwd,
    },
    owner.prepareOperation("spawn"),
  );
  secondSession = second.sessionHandle;
  secondTurn = second.turnHandle;

  const observationRecords = (): Array<Record<string, unknown>> =>
    readFileSync(observationPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  const firstReady = await waitFor(
    "the first packed worker",
    observationRecords,
    (records) =>
      records.some(
        (record) =>
          record.type === "worker_ready" && record.sessionId === firstSession,
      ),
  );
  const secondReady = await waitFor(
    "the second packed worker",
    observationRecords,
    (records) =>
      records.some(
        (record) =>
          record.type === "worker_ready" && record.sessionId === secondSession,
      ),
  );
  const firstWorker = firstReady.find(
    (record) =>
      record.type === "worker_ready" && record.sessionId === firstSession,
  );
  const secondWorker = secondReady.find(
    (record) =>
      record.type === "worker_ready" && record.sessionId === secondSession,
  );
  assert(
    typeof firstWorker?.workerPid === "number" &&
      typeof firstWorker.descendantPid === "number" &&
      typeof secondWorker?.workerPid === "number" &&
      typeof secondWorker.descendantPid === "number",
    "the packed worker observations omitted process identities",
  );

  foreign = await connect({
    socketPath,
    consumerContext: `${ownerContext}-foreign`,
  });
  assert((await foreign.list()).length === 0, "foreign list exposed a session");
  const foreignKill = await foreign.kill(
    { sessionHandle: firstSession },
    foreign.prepareOperation("kill"),
  );
  assert(
    foreignKill.status === "not_found",
    "foreign consumer killed another consumer's session",
  );
  await expectSessionMissing(() =>
    foreign!.send(
      {
        placement: "new_turn",
        sessionHandle: firstSession!,
        message: "foreign input",
      },
      foreign!.prepareOperation("send"),
    ),
  );
  await expectSessionMissing(() =>
    foreign!.wait({ targets: [firstTurn!], completion: "all" }),
  );
  assert(
    (await owner.list({ sessionHandle: firstSession })).some(
      (session) => session.state === "busy",
    ),
    "foreign operations changed the owned session",
  );

  const killedFirst = await owner.kill(
    { sessionHandle: firstSession },
    owner.prepareOperation("kill"),
  );
  assert(
    killedFirst.status === "killed",
    "the SDK did not close the selected session",
  );
  const secondAfterFirstKill = await owner.list({
    sessionHandle: secondSession,
  });
  assert(
    secondAfterFirstKill.length === 1 &&
      secondAfterFirstKill[0]?.state === "busy" &&
      secondAfterFirstKill[0].activeTurn === secondTurn,
    "closing one session affected another live session",
  );
  process.kill(secondWorker.workerPid, 0);
  process.kill(secondWorker.descendantPid, 0);

  owner.close();
  recovery = await connect({ socketPath, consumerContext: ownerContext });
  const afterClientClose = await recovery.list({
    sessionHandle: secondSession,
  });
  assert(
    afterClientClose.length === 1 && afterClientClose[0]?.state === "busy",
    "closing the SDK client ended its still-live session",
  );
  assert(
    (await recovery.modelCatalog()).catalogs.some(
      ({ harness }) => harness === "codex",
    ),
    "closing the SDK client stopped the shared daemon",
  );

  const killedSecond = await recovery.kill(
    { sessionHandle: secondSession },
    recovery.prepareOperation("kill"),
  );
  assert(
    killedSecond.status === "killed",
    "the reconnected SDK could not control the surviving session",
  );
  const sessionsAfterClose = await recovery.list();
  assert(
    sessionsAfterClose.some(
      (session) =>
        session.sessionHandle === firstSession && session.state === "killed",
    ) &&
      sessionsAfterClose.some(
        (session) =>
          session.sessionHandle === secondSession && session.state === "killed",
      ),
    "the SDK did not retain both exact session close results",
  );

  const activity = (await readFile(activityPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  for (const worker of [firstWorker, secondWorker]) {
    for (const role of ["worker", "descendant"]) {
      const pid = role === "worker" ? worker.workerPid : worker.descendantPid;
      assert(
        activity.filter(
          (record) =>
            record.type === "closed" &&
            record.role === role &&
            record.pid === pid,
        ).length === 1,
        `session cleanup did not close the ${role} resource exactly once`,
      );
    }
  }
  process.stdout.write(
    `${JSON.stringify({
      ownerContext,
      sessions: [firstSession, secondSession],
      foreignKill: foreignKill.status,
      isolatedClose: true,
      clientClosePreservedSession: true,
      processResourcesClosed: true,
    })}\n`,
  );
} finally {
  foreign?.close();
  recovery?.close();
  if (firstSession !== undefined && owner.handshake !== undefined) {
    try {
      await owner.kill(
        { sessionHandle: firstSession },
        owner.prepareOperation("kill"),
      );
    } catch {
      // 清理仅在原断言失败后兜底，保留最初失败原因。
    }
  }
  if (secondSession !== undefined && recovery !== undefined) {
    try {
      await recovery.kill(
        { sessionHandle: secondSession },
        recovery.prepareOperation("kill"),
      );
    } catch {
      // 清理仅在原断言失败后兜底，保留最初失败原因。
    }
  }
  owner.close();
}
