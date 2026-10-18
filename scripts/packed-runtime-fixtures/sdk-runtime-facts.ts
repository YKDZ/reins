import { readFile } from "node:fs/promises";

import { connect, type AgentFact, type ReinsConnection } from "@ykdz/reins-sdk";

declare const process: {
  env: Record<string, string | undefined>;
  stdout: { write(value: string): void };
};

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "")
    throw new Error(`The installed SDK facts fixture needs ${name}`);
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

const connection = await connect({
  socketPath: required("REINS_SOCKET"),
  consumerContext: required("REINS_CONSUMER_CONTEXT"),
});
try {
  const gate = required("REINS_FACT_GATE");
  const resolutionFile = required("REINS_PERMISSION_RESULT");
  const spawned = await connection.spawn(
    {
      harness: "codex",
      sessionLabel: "packed-facts",
      message: JSON.stringify({
        gate,
        reply: "done",
        callerMessage: "follow-up",
        permission: true,
        resolutionFile,
      }),
      cwd: required("REINS_WORKER_CWD"),
    },
    { operationKey: connection.prepareOperation("spawn") },
  );
  const target = { scope: "turn" as const, turnHandle: spawned.turnHandle };
  const live = await connection.attach(target, { mode: "none" });
  const initialCursor = live.checkpoint;
  const facts: AgentFact[] = [];
  const consuming = (async () => {
    for await (const fact of live) {
      facts.push(fact);
      if (fact.type === "permission.requested") {
        await connection.resolvePermission(
          fact.permissionHandle,
          { outcome: "deny", feedback: "caller feedback" },
          { operationKey: connection.prepareOperation("resolvePermission") },
        );
      }
    }
  })();

  await (await import("node:fs/promises")).writeFile(gate, "released", "utf8");
  await consuming;
  const end = await live.done;
  assert(end.reason === "end_turn", "live SDK observation ended unexpectedly");
  assert(
    JSON.stringify(facts.map((fact) => fact.type)) ===
      JSON.stringify([
        "message",
        "text.delta",
        "text.delta",
        "message",
        "tool.requested",
        "tool.completed",
        "permission.requested",
        "permission.resolved",
        "turn.completed",
      ]),
    "the installed SDK changed the ordered domain facts",
  );

  const callerMessage = facts.find(
    (fact): fact is Extract<AgentFact, { type: "message" }> =>
      fact.type === "message" && fact.role === "caller",
  );
  const textFacts = facts.filter((fact) => fact.type === "text.delta");
  const workerMessage = facts.find(
    (fact): fact is Extract<AgentFact, { type: "message" }> =>
      fact.type === "message" && fact.role === "worker",
  );
  assert(callerMessage?.content === "follow-up", "caller message changed");
  assert(
    JSON.stringify(textFacts.map((fact) => fact.delta)) ===
      JSON.stringify(["hello ", "world"]),
    "message deltas changed",
  );
  assert(
    textFacts[0]?.messageKey === workerMessage?.messageKey &&
      workerMessage?.content === "hello world",
    "message snapshots lost their identity or reconstructed body",
  );

  const toolRequested = facts.find((fact) => fact.type === "tool.requested");
  const toolCompleted = facts.find((fact) => fact.type === "tool.completed");
  assert(
    toolRequested?.toolKey === toolCompleted?.toolKey &&
      toolRequested?.name === "read-file" &&
      toolCompleted?.name === "native-result-name" &&
      toolCompleted.result === "file contents" &&
      toolCompleted.isError === false,
    "tool facts lost their identity or result",
  );

  const permissionRequested = facts.find(
    (fact) => fact.type === "permission.requested",
  );
  const permissionResolved = facts.find(
    (fact) => fact.type === "permission.resolved",
  );
  assert(
    permissionRequested?.type === "permission.requested" &&
      permissionResolved?.type === "permission.resolved" &&
      permissionRequested.permissionHandle ===
        permissionResolved.permissionHandle &&
      JSON.stringify(permissionResolved.resolution) ===
        JSON.stringify({ outcome: "deny", feedback: "caller feedback" }),
    "permission facts lost their decision or identity",
  );
  assert(
    JSON.stringify(JSON.parse(await readFile(resolutionFile, "utf8"))) ===
      JSON.stringify({ outcome: "deny", feedback: "caller feedback" }),
    "the adapter did not receive the exact permission decision",
  );

  const resumed = await connection.attach(target, {
    mode: "after",
    cursor: initialCursor,
  });
  const resumedFacts = await collect(resumed);
  const available = await connection.attach(target, { mode: "available" });
  const availableFacts = await collect(available);
  assert(
    JSON.stringify(resumedFacts) === JSON.stringify(facts),
    "event continuation skipped or changed facts after the checkpoint",
  );
  assert(
    JSON.stringify(availableFacts.slice(-facts.length)) ===
      JSON.stringify(facts),
    "full replay did not preserve the live fact sequence",
  );

  const wait = await connection.wait({
    targets: [spawned.turnHandle],
    completion: "all",
  });
  assert(
    wait.status === "satisfied" &&
      wait.completed[0]?.turnHandle === spawned.turnHandle &&
      wait.completed[0]?.finalReply === "done",
    "wait did not observe the exact completed turn",
  );
  const newTurn = await connection.send(
    {
      placement: "new_turn",
      sessionHandle: spawned.sessionHandle,
      message: JSON.stringify({ gate, reply: "second turn" }),
    },
    { operationKey: connection.prepareOperation("send") },
  );
  assert(
    newTurn.sessionHandle === spawned.sessionHandle &&
      newTurn.turnHandle !== spawned.turnHandle &&
      newTurn.deliveryPoint === "new_turn",
    "SDK did not deliver a new turn to the exact completed session",
  );
  const newTurnWait = await connection.wait({
    targets: [newTurn.turnHandle],
    completion: "all",
  });
  assert(
    newTurnWait.status === "satisfied" &&
      newTurnWait.completed[0]?.turnHandle === newTurn.turnHandle &&
      newTurnWait.completed[0]?.finalReply === "second turn",
    "SDK did not observe the exact new-turn completion",
  );
  process.stdout.write(
    `${JSON.stringify({
      sessionHandle: spawned.sessionHandle,
      turnHandle: spawned.turnHandle,
      newTurnHandle: newTurn.turnHandle,
      factTypes: facts.map((fact) => fact.type),
      resumedFactCount: resumedFacts.length,
      replayedFactCount: availableFacts.length,
      waitStatus: wait.status,
      newTurnDeliveryPoint: newTurn.deliveryPoint,
      newTurnStatus: newTurnWait.status,
    })}\n`,
  );
} finally {
  connection.close();
}
