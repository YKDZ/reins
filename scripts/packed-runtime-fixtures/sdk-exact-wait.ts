import {
  connect,
  type ReinsConnection,
  type SessionHandle,
  type TurnHandle,
} from "@ykdz/reins-sdk";

declare const process: {
  env: Record<string, string | undefined>;
  stdout: { write(value: string): void };
};

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "")
    throw new Error(`SDK 等待验收缺少 ${name}`);
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function closeIfLive(
  connection: ReinsConnection,
  sessionHandle: SessionHandle | undefined,
): Promise<void> {
  if (sessionHandle === undefined) return;
  try {
    await connection.kill(
      { sessionHandle },
      connection.prepareOperation("kill"),
    );
  } catch {
    // 主断言失败时尽力清理；正式 daemon 停止仍由调用方负责。
  }
}

const connection = await connect({
  socketPath: required("REINS_SOCKET"),
  consumerContext: required("REINS_CONSUMER_CONTEXT"),
});
let firstSession: SessionHandle | undefined;
let secondSession: SessionHandle | undefined;
try {
  const cwd = required("REINS_WORKER_CWD");
  const first = await connection.spawn(
    {
      harness: "codex",
      sessionLabel: "packed-wait-first",
      message: "first wait target",
      cwd,
    },
    connection.prepareOperation("spawn"),
  );
  firstSession = first.sessionHandle;
  const second = await connection.spawn(
    {
      harness: "codex",
      sessionLabel: "packed-wait-second",
      message: "second wait target",
      cwd,
    },
    connection.prepareOperation("spawn"),
  );
  secondSession = second.sessionHandle;

  const orderedTargets: TurnHandle[] = [first.turnHandle, second.turnHandle];
  const anyWaiting = connection.wait({
    targets: orderedTargets,
    completion: "any",
    timeoutMs: 10_000,
  });
  const allWaiting = connection.wait({
    targets: [second.turnHandle, first.turnHandle],
    completion: "all",
    timeoutMs: 10_000,
  });
  const zeroTimeout = await connection.wait({
    targets: [first.turnHandle],
    completion: "all",
    timeoutMs: 0,
  });
  assert(
    zeroTimeout.status === "timeout" &&
      zeroTimeout.completed.length === 0 &&
      zeroTimeout.pending.length === 1 &&
      zeroTimeout.pending[0] === first.turnHandle,
    "零超时 wait 未保留精确待处理回合",
  );

  const closedSecond = await connection.kill(
    { sessionHandle: second.sessionHandle },
    connection.prepareOperation("kill"),
  );
  const anyResult = await anyWaiting;
  assert(
    closedSecond.status === "killed" &&
      anyResult.status === "satisfied" &&
      anyResult.completed.length === 1 &&
      anyResult.completed[0]?.turnHandle === second.turnHandle &&
      anyResult.pending.length === 1 &&
      anyResult.pending[0] === first.turnHandle,
    "any wait 没有返回先完成的精确回合与剩余目标",
  );
  const [firstStillBusy] = await connection.list({
    sessionHandle: first.sessionHandle,
  });
  assert(
    firstStillBusy?.state === "busy" &&
      firstStillBusy.activeTurn === first.turnHandle,
    "结束一个目标影响了另一项仍在执行的回合",
  );

  await connection.kill(
    { sessionHandle: first.sessionHandle },
    connection.prepareOperation("kill"),
  );
  const allResult = await allWaiting;
  assert(
    allResult.status === "satisfied" &&
      allResult.pending.length === 0 &&
      allResult.completed.map(({ turnHandle }) => turnHandle).join("\n") ===
        [second.turnHandle, first.turnHandle].join("\n") &&
      allResult.completed.every(({ stopReason }) => stopReason === "killed"),
    "all wait 改变了调用者目标顺序或终态",
  );
  process.stdout.write(
    `${JSON.stringify({
      anyCompleted: anyResult.completed.map(({ turnHandle }) => turnHandle),
      anyPending: anyResult.pending,
      allCompleted: allResult.completed.map(({ turnHandle }) => turnHandle),
      zeroTimeoutPending: zeroTimeout.pending,
    })}\n`,
  );
} finally {
  await closeIfLive(connection, firstSession);
  await closeIfLive(connection, secondSession);
  connection.close();
}
