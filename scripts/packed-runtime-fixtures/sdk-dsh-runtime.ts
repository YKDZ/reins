import { openLocal } from "@ykdz/reins";
import type { AgentFact, ReinsConnection } from "@ykdz/reins-sdk";

declare const process: {
  env: Record<string, string | undefined>;
  stdout: { write(value: string): void };
};

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "")
    throw new Error(`DSH 运行时验收需要环境变量 ${name}`);
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function collect(
  subscription: Awaited<ReturnType<ReinsConnection["attach"]>>,
): Promise<AgentFact[]> {
  const facts: AgentFact[] = [];
  try {
    for await (const fact of subscription) facts.push(fact);
    return facts;
  } finally {
    subscription.close();
  }
}

const environment = process.env;
let connection: ReinsConnection | undefined;
try {
  connection = await openLocal({
    consumerContext: "packed-dsh-runtime",
    env: environment,
    timeoutMs: 60_000,
  });
  const catalogResult = await connection.modelCatalog();
  const dshCatalog = catalogResult.catalogs.find(
    (catalog) => catalog.harness === "dsh",
  );
  assert(
    dshCatalog !== undefined &&
      catalogResult.failures.every((failure) => failure.harness !== "dsh") &&
      dshCatalog.models.length > 0 &&
      dshCatalog.models.some((model) => model.reasoningEfforts.length > 0),
    "SDK 未能读取官方 DSH 模型目录",
  );
  const model = dshCatalog.models[0];
  assert(model !== undefined, "官方 DSH 模型目录为空");

  const started = await connection.spawn(
    {
      harness: "dsh",
      model: model.id,
      authorizationMode: "allowAll",
      cwd: required("REINS_DSH_WORKSPACE"),
      message: "Read evidence.txt and report its contents.",
    },
    { operationKey: connection.prepareOperation("spawn") },
  );

  const baseUrl = required("REINS_DSH_FIXTURE_BASE_URL");
  const ready = await fetch(`${baseUrl}/wait-first`);
  assert(ready.ok, "确定性 DSH provider 未收到首个请求");

  connection.close();
  connection = await openLocal({
    consumerContext: "packed-dsh-runtime",
    env: environment,
    timeoutMs: 60_000,
  });
  const stillRunning = await connection.list({
    sessionHandle: started.sessionHandle,
  });
  assert(
    stillRunning.length === 1 &&
      stillRunning[0]?.state === "busy" &&
      stillRunning[0].activeTurn === started.turnHandle,
    "Closing the SDK connection ended its live DSH session",
  );

  const released = await fetch(`${baseUrl}/release-first`);
  assert(released.ok, "确定性 DSH provider 未释放首个响应");
  const firstWait = await connection.wait({
    targets: [started.turnHandle],
    completion: "all",
  });
  assert(
    firstWait.status === "satisfied" &&
      firstWait.completed[0]?.finalReply === "DSH_READ_CONFIRMED",
    "官方 DSH profile 未完成首个含工具调用的回合",
  );
  const firstFacts = await collect(
    await connection.attach(
      { scope: "turn", turnHandle: started.turnHandle },
      { mode: "available" },
    ),
  );
  const callerMessages = firstFacts.filter(
    (fact): fact is Extract<AgentFact, { type: "message" }> =>
      fact.type === "message" && fact.role === "caller",
  );
  const toolRequested = firstFacts.find(
    (fact) => fact.type === "tool.requested",
  );
  const toolCompleted = firstFacts.find(
    (fact) => fact.type === "tool.completed",
  );
  assert(
    callerMessages.length === 1 &&
      callerMessages[0]?.content.includes("Read evidence.txt") &&
      toolRequested?.name === "read" &&
      toolCompleted?.name === "read" &&
      toolCompleted.isError === false &&
      toolCompleted.result?.includes("OFFICIAL_TOOL_READ_ONCE") &&
      toolRequested.toolKey === toolCompleted.toolKey &&
      firstFacts.some(
        (fact) =>
          fact.type === "message" &&
          fact.role === "worker" &&
          fact.content === "DSH_READ_CONFIRMED",
      ),
    "DSH 工具结果、消息身份或 caller 关联不正确",
  );

  const second = await connection.send(
    {
      placement: "new_turn",
      sessionHandle: started.sessionHandle,
      message: "Continue in the same session and say DSH_NEW_TURN_CONFIRMED.",
    },
    { operationKey: connection.prepareOperation("send") },
  );
  assert(
    second.sessionHandle === started.sessionHandle &&
      second.turnHandle !== started.turnHandle &&
      second.deliveryPoint === "new_turn",
    "官方 DSH profile 未在同一会话接受新回合",
  );
  const secondWait = await connection.wait({
    targets: [second.turnHandle],
    completion: "all",
  });
  assert(
    secondWait.status === "satisfied" &&
      secondWait.completed[0]?.finalReply === "DSH_NEW_TURN_CONFIRMED",
    "官方 DSH profile 未完成同一会话的新回合",
  );

  const killed = await connection.kill(
    { sessionHandle: started.sessionHandle },
    { operationKey: connection.prepareOperation("kill") },
  );
  assert(
    killed.status === "killed" &&
      killed.sessionHandle === started.sessionHandle,
    "公开 SDK 未能关闭官方 DSH profile",
  );
  const closed = await connection.wait({
    targets: [second.turnHandle],
    completion: "all",
  });
  assert(
    closed.status === "satisfied" &&
      closed.completed[0]?.stopReason === "end_turn",
    "关闭空闲 DSH 会话改变了已完成回合",
  );
  process.stdout.write(
    `${JSON.stringify({
      harness: "dsh",
      model: model.displayName,
      sessionHandle: started.sessionHandle,
      firstTurnHandle: started.turnHandle,
      secondTurnHandle: second.turnHandle,
      firstFactTypes: firstFacts.map((fact) => fact.type),
      newTurnDeliveryPoint: second.deliveryPoint,
      closeStatus: killed.status,
    })}\n`,
  );
} finally {
  connection?.close();
}
