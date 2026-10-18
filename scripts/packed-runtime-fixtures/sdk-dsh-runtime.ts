import { access, readFile } from "node:fs/promises";

import { openLocal } from "@ykdz/reins";
import {
  ReinsSdkError,
  type AgentFact,
  type MessageContent,
  type ReinsConnection,
  type TurnHandle,
} from "@ykdz/reins-sdk";

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

async function collectHistory(
  subscription: Awaited<ReturnType<ReinsConnection["attach"]>>,
): Promise<AgentFact[]> {
  if (subscription.initial.mode === "snapshot")
    throw new Error("历史验收夹具需要 history 初始游标");
  const facts: AgentFact[] = [];
  try {
    for (let index = 0; index < subscription.initial.replayed; index += 1) {
      const item = await subscription.next();
      if (item.done) break;
      facts.push(item.value);
    }
  } finally {
    subscription.close();
  }
  return facts;
}

async function waitForPermission(
  connection: ReinsConnection,
  turnHandle: TurnHandle,
): Promise<Extract<AgentFact, { type: "permission.requested" }>> {
  const subscription = await connection.attach(
    { scope: "turn", turnHandle },
    { mode: "history" },
  );
  try {
    for await (const fact of subscription) {
      if (fact.type === "permission.requested") return fact;
    }
  } finally {
    subscription.close();
  }
  throw new Error("官方 DSH 未向公开 SDK 发出授权请求");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await fileExists(path)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`DSH 工具未创建验收文件 ${path}`);
}

function containsMessageText(
  content: MessageContent,
  expected: string,
): boolean {
  if (typeof content === "string") return content.includes(expected);
  return content.some(
    (part) =>
      (part.type === "text" || part.type === "thinking") &&
      part.text.includes(expected),
  );
}

function containsValueText(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value.includes(expected);
  if (Array.isArray(value))
    return value.some((part) => containsValueText(part, expected));
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).some((part) => containsValueText(part, expected));
}

function backgroundJobId(value: unknown): string | undefined {
  if (typeof value === "string")
    return /started background job (bash-[A-Za-z0-9_-]+)/u.exec(value)?.[1];
  if (Array.isArray(value)) {
    for (const part of value) {
      const jobId = backgroundJobId(part);
      if (jobId !== undefined) return jobId;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  for (const part of Object.values(value)) {
    const jobId = backgroundJobId(part);
    if (jobId !== undefined) return jobId;
  }
  return undefined;
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

  const activeSteer = await connection.send(
    {
      placement: "active_turn",
      turnHandle: started.turnHandle,
      message: "Please include DSH_ACTIVE_STEER_CONFIRMED after reading.",
    },
    { operationKey: connection.prepareOperation("send") },
  );
  assert(
    activeSteer.turnHandle === started.turnHandle &&
      activeSteer.deliveryPoint === "active_turn",
    "公开 SDK 未将纠偏准确送入指定的活动回合",
  );

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
      { mode: "history" },
    ),
  );
  const callerMessages = firstFacts.filter(
    (fact): fact is Extract<AgentFact, { type: "message" }> =>
      fact.type === "message" && fact.role === "caller",
  );
  const callerMessageKey = callerMessages[0]?.messageKey;
  const activeSteerSnapshots = callerMessages.filter(
    (fact) =>
      Array.isArray(fact.content) &&
      containsMessageText(fact.content, "DSH_ACTIVE_STEER_CONFIRMED"),
  );
  const callerSnapshots = callerMessages.filter(
    (fact) =>
      Array.isArray(fact.content) &&
      containsMessageText(fact.content, "Read evidence.txt"),
  );
  const toolRequested = firstFacts.find(
    (fact) => fact.type === "tool.requested",
  );
  const toolCompleted = firstFacts.find(
    (fact) => fact.type === "tool.completed",
  );
  const workerMessages = firstFacts.filter(
    (fact): fact is Extract<AgentFact, { type: "message" }> =>
      fact.type === "message" && fact.role === "worker",
  );
  assert(
    callerMessages.length >= 2 &&
      new Set(callerMessages.map((fact) => fact.messageKey)).size === 2 &&
      callerSnapshots.length === 1 &&
      callerSnapshots[0]?.messageKey === callerMessageKey &&
      activeSteerSnapshots.length === 1 &&
      activeSteerSnapshots[0]?.messageKey === activeSteer.messageKey,
    "DSH 未按各自身份保留原始输入与活动回合纠偏",
  );
  assert(
    toolRequested?.name === "read" &&
      containsValueText(toolRequested.input, "evidence.txt"),
    "DSH 未保留工具调用名称与原始输入",
  );
  assert(
    toolCompleted?.name === "read" &&
      toolCompleted.isError === false &&
      containsValueText(toolCompleted.result, "OFFICIAL_TOOL_READ_ONCE") &&
      toolRequested?.toolKey === toolCompleted.toolKey,
    "DSH 未保留带关联身份的完整工具结果",
  );
  assert(
    workerMessages.some((fact) =>
      containsMessageText(fact.content, "DSH_READ_CONFIRMED"),
    ),
    "DSH 未保留助手正文",
  );
  assert(
    toolRequested !== undefined &&
      workerMessages.some(
        (fact) =>
          Array.isArray(fact.content) &&
          fact.content.some(
            (part) =>
              part.type === "tool_call" &&
              part.toolKey === toolRequested.toolKey,
          ),
      ),
    "DSH 助手正文中的工具引用与工具调用身份不一致",
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
  const secondFacts = await collect(
    await connection.attach(
      { scope: "turn", turnHandle: second.turnHandle },
      { mode: "history" },
    ),
  );
  const secondCallerMessages = secondFacts.filter(
    (fact): fact is Extract<AgentFact, { type: "message" }> =>
      fact.type === "message" && fact.role === "caller",
  );
  const secondCallerKey = secondCallerMessages[0]?.messageKey;
  const secondNativeCallerSnapshots = secondCallerMessages.filter(
    (fact) =>
      Array.isArray(fact.content) &&
      containsMessageText(fact.content, "Continue in the same session"),
  );
  assert(
    secondCallerMessages.length > 0 &&
      new Set(secondCallerMessages.map((fact) => fact.messageKey)).size === 1 &&
      secondNativeCallerSnapshots.length === 1 &&
      secondNativeCallerSnapshots[0]?.messageKey === secondCallerKey,
    "DSH 新回合未保留精确 caller 消息",
  );

  const interruptTarget = await connection.send(
    {
      placement: "new_turn",
      sessionHandle: started.sessionHandle,
      message: "Start DSH_INTERRUPT_TARGET before its exact interruption.",
    },
    { operationKey: connection.prepareOperation("send") },
  );
  const interruptReady = await fetch(`${baseUrl}/wait-interrupt-target`);
  assert(interruptReady.ok, "确定性 DSH provider 未收到待中断回合请求");
  const interruptResult = await connection.interrupt(
    { turnHandle: interruptTarget.turnHandle },
    { operationKey: connection.prepareOperation("interrupt") },
  );
  assert(
    interruptResult.status === "accepted" &&
      interruptResult.turnHandle === interruptTarget.turnHandle,
    "公开 SDK 未能中断精确的 DSH Reins 回合",
  );

  const drainMessage = "DSH_DRAIN_INPUT_MUST_NOT_EXECUTE";
  const drainOperation = connection.prepareOperation("send");
  let drainRejected = false;
  try {
    await connection.send(
      {
        placement: "active_turn",
        turnHandle: interruptTarget.turnHandle,
        message: drainMessage,
      },
      { operationKey: drainOperation },
    );
  } catch {
    drainRejected = true;
  }
  const drainRecord = await connection.getOperation(drainOperation);
  assert(
    drainRejected &&
      drainRecord.status === "failed" &&
      ["session_busy", "turn_not_active"].includes(drainRecord.error.code),
    "清退期的精确活动目标未被拒绝并持久记录",
  );
  const interruptReleased = await fetch(`${baseUrl}/release-interrupt-target`);
  assert(interruptReleased.ok, "确定性 DSH provider 未释放待中断请求");
  const interruptedWait = await connection.wait({
    targets: [interruptTarget.turnHandle],
    completion: "all",
  });
  assert(
    interruptedWait.status === "satisfied" &&
      interruptedWait.completed[0]?.stopReason === "cancelled",
    "官方 DSH 的已接受中断未保留实际取消终态",
  );

  const afterInterrupt = await connection.send(
    {
      placement: "new_turn",
      sessionHandle: started.sessionHandle,
      message: "Say DSH_AFTER_INTERRUPT_CONFIRMED in this independent turn.",
    },
    { operationKey: connection.prepareOperation("send") },
  );
  const afterInterruptWait = await connection.wait({
    targets: [afterInterrupt.turnHandle],
    completion: "all",
  });
  const historyAfterInterrupt = await collect(
    await connection.attach(
      { scope: "turn", turnHandle: afterInterrupt.turnHandle },
      { mode: "history" },
    ),
  );
  const historyAfterInterruptText = JSON.stringify(historyAfterInterrupt);
  assert(
    afterInterruptWait.status === "satisfied" &&
      afterInterruptWait.completed[0]?.finalReply ===
        "DSH_AFTER_INTERRUPT_CONFIRMED" &&
      !historyAfterInterruptText.includes(drainMessage),
    "清退期已拒绝的正文进入后续独立回合事实",
  );

  const backgroundStart = await connection.send(
    {
      placement: "new_turn",
      sessionHandle: started.sessionHandle,
      message:
        "Start one DSH_BACKGROUND_JOB_START and report when it is running.",
    },
    { operationKey: connection.prepareOperation("send") },
  );
  const backgroundStartWait = await connection.wait({
    targets: [backgroundStart.turnHandle],
    completion: "all",
  });
  assert(
    backgroundStartWait.status === "satisfied" &&
      backgroundStartWait.completed[0]?.finalReply ===
        "DSH_BACKGROUND_START_CONFIRMED",
    "官方 DSH base 未接受完整后台 Bash 工具调用",
  );
  const backgroundStartFacts = await collect(
    await connection.attach(
      { scope: "turn", turnHandle: backgroundStart.turnHandle },
      { mode: "history" },
    ),
  );
  const backgroundTool = backgroundStartFacts.find(
    (fact) => fact.type === "tool.requested" && fact.name === "bash",
  );
  const backgroundToolResult = backgroundStartFacts.find(
    (fact) => fact.type === "tool.completed" && fact.name === "bash",
  );
  const nativeJobId =
    backgroundToolResult?.type === "tool.completed"
      ? backgroundJobId(backgroundToolResult.result)
      : undefined;
  assert(
    backgroundTool?.type === "tool.requested" &&
      backgroundToolResult?.type === "tool.completed" &&
      backgroundToolResult.toolKey === backgroundTool.toolKey &&
      nativeJobId !== undefined,
    "DSH 后台工具未保留精确工具调用与原生 job 身份",
  );

  const releasedBackgroundJob = await fetch(
    `${baseUrl}/release-background-job`,
  );
  assert(releasedBackgroundJob.ok, "确定性 provider 未释放 DSH 后台 job");
  const backgroundWakeReady = await fetch(`${baseUrl}/wait-background-wake`);
  assert(backgroundWakeReady.ok, "完整官方 profile 未唤醒已空闲的 DSH Agent");
  const wakeHistory = await collectHistory(
    await connection.attach(
      { scope: "session", sessionHandle: started.sessionHandle },
      { mode: "history" },
    ),
  );
  const autonomousTurn = wakeHistory.find(
    (fact) =>
      fact.type === "turn.started" &&
      fact.origin?.kind === "harness" &&
      fact.origin.harness === "dsh" &&
      fact.cause?.source?.kind === "tool-jobs" &&
      fact.cause.source.id === nativeJobId &&
      fact.cause.causedBy?.turnHandle === backgroundStart.turnHandle &&
      fact.cause.causedBy.toolKey === backgroundTool.toolKey,
  );
  assert(
    autonomousTurn?.type === "turn.started",
    "完整官方 profile 的空闲后台通知未开启带来源因果的自治回合",
  );
  const backgroundWake = await connection.wait({
    targets: [autonomousTurn.turnHandle],
    completion: "all",
  });
  assert(
    backgroundWake.status === "satisfied" &&
      backgroundWake.completed[0]?.finalReply ===
        "DSH_BACKGROUND_WAKE_CONFIRMED",
    "DSH 后台完成通知未完成独立自治回合",
  );
  const sessionHistory = await collectHistory(
    await connection.attach(
      { scope: "session", sessionHandle: started.sessionHandle },
      { mode: "history" },
    ),
  );
  const backgroundActivities = sessionHistory.filter(
    (fact): fact is Extract<AgentFact, { type: "background.activity" }> =>
      fact.type === "background.activity" &&
      fact.source.kind === "tool-jobs" &&
      fact.source.id === nativeJobId,
  );
  const backgroundMessages = sessionHistory.filter(
    (fact): fact is Extract<AgentFact, { type: "message" }> =>
      fact.type === "message" &&
      fact.role === "harness" &&
      fact.source.kind === "tool-jobs" &&
      fact.source.id === nativeJobId,
  );
  assert(
    backgroundActivities.length === 2 &&
      backgroundActivities[0]?.status === "active" &&
      backgroundActivities[1]?.status === "completed" &&
      backgroundActivities.every(
        (fact) =>
          fact.causedBy?.turnHandle === backgroundStart.turnHandle &&
          fact.causedBy.toolKey === backgroundTool.toolKey,
      ) &&
      backgroundMessages.length === 1 &&
      backgroundMessages[0] !== undefined &&
      containsMessageText(
        backgroundMessages[0].content,
        "DSH_BACKGROUND_JOB_RESULT",
      ),
    "DSH 后台完成通知未以完整正文、来源、因果和自治回合写入会话历史",
  );
  const originalBackgroundTurn = await connection.wait({
    targets: [backgroundStart.turnHandle],
    completion: "all",
  });
  assert(
    backgroundWake.status === "satisfied" &&
      backgroundWake.completed[0]?.finalReply ===
        "DSH_BACKGROUND_WAKE_CONFIRMED" &&
      originalBackgroundTurn.status === "satisfied" &&
      originalBackgroundTurn.completed[0]?.finalReply ===
        "DSH_BACKGROUND_START_CONFIRMED",
    "DSH 后台完成唤醒没有形成独立自治回合，或改写了已完成的原回合",
  );

  const interruptBackgroundStart = await connection.send(
    {
      placement: "new_turn",
      sessionHandle: started.sessionHandle,
      message:
        "Start one DSH_BACKGROUND_INTERRUPT_JOB_START and report when it is running.",
    },
    { operationKey: connection.prepareOperation("send") },
  );
  const interruptBackgroundStartWait = await connection.wait({
    targets: [interruptBackgroundStart.turnHandle],
    completion: "all",
  });
  assert(
    interruptBackgroundStartWait.status === "satisfied" &&
      interruptBackgroundStartWait.completed[0]?.finalReply ===
        "DSH_BACKGROUND_INTERRUPT_START_CONFIRMED",
    `官方 DSH 未进入精确中断验收的后台工具回合：${JSON.stringify({
      status: interruptBackgroundStartWait.status,
      finalReply: interruptBackgroundStartWait.completed[0]?.finalReply,
    })}`,
  );
  const interruptBackgroundFacts = await collect(
    await connection.attach(
      { scope: "turn", turnHandle: interruptBackgroundStart.turnHandle },
      { mode: "history" },
    ),
  );
  const interruptBackgroundTool = interruptBackgroundFacts.find(
    (fact) => fact.type === "tool.requested" && fact.name === "bash",
  );
  const interruptBackgroundToolResult = interruptBackgroundFacts.find(
    (fact) => fact.type === "tool.completed" && fact.name === "bash",
  );
  const interruptNativeJobId =
    interruptBackgroundToolResult?.type === "tool.completed"
      ? backgroundJobId(interruptBackgroundToolResult.result)
      : undefined;
  assert(
    interruptBackgroundTool?.type === "tool.requested" &&
      interruptBackgroundToolResult?.type === "tool.completed" &&
      interruptBackgroundToolResult.toolKey ===
        interruptBackgroundTool.toolKey &&
      interruptNativeJobId !== undefined,
    `DSH 中断验收后台工具未保留精确调用与原生 job 身份：${JSON.stringify({
      requested: interruptBackgroundTool?.type,
      completed: interruptBackgroundToolResult?.type,
      jobId: interruptNativeJobId,
    })}`,
  );

  const releasedInterruptBackgroundJob = await fetch(
    `${baseUrl}/release-background-interrupt-job`,
  );
  assert(
    releasedInterruptBackgroundJob.ok,
    "确定性 provider 未释放用于精确中断验收的后台 job",
  );
  const interruptBackgroundWakeReady = await fetch(
    `${baseUrl}/wait-background-interrupt-wake`,
  );
  assert(
    interruptBackgroundWakeReady.ok,
    "完整官方 profile 未唤醒用于精确中断验收的 DSH Agent",
  );
  const interruptWakeHistory = await collectHistory(
    await connection.attach(
      { scope: "session", sessionHandle: started.sessionHandle },
      { mode: "history" },
    ),
  );
  const interruptAutonomousTurn = interruptWakeHistory.find(
    (fact) =>
      fact.type === "turn.started" &&
      fact.origin?.kind === "harness" &&
      fact.origin.harness === "dsh" &&
      fact.cause?.source?.kind === "tool-jobs" &&
      fact.cause.source.id === interruptNativeJobId &&
      fact.cause.causedBy?.turnHandle === interruptBackgroundStart.turnHandle &&
      fact.cause.causedBy.toolKey === interruptBackgroundTool.toolKey,
  );
  assert(
    interruptAutonomousTurn?.type === "turn.started",
    "第二个官方后台唤醒未形成可精确控制的自主回合",
  );
  const autonomousSteer = await connection.send(
    {
      placement: "active_turn",
      turnHandle: interruptAutonomousTurn.turnHandle,
      message: "DSH_AUTONOMOUS_STEER_ACCEPTED_BEFORE_INTERRUPT",
    },
    { operationKey: connection.prepareOperation("send") },
  );
  assert(
    autonomousSteer.turnHandle === interruptAutonomousTurn.turnHandle &&
      autonomousSteer.deliveryPoint === "active_turn",
    "公开 SDK 未能将活动输入精确送入自主 DSH 回合",
  );
  const autonomousInterrupt = await connection.interrupt(
    { turnHandle: interruptAutonomousTurn.turnHandle },
    { operationKey: connection.prepareOperation("interrupt") },
  );
  assert(
    autonomousInterrupt.status === "accepted" &&
      autonomousInterrupt.turnHandle === interruptAutonomousTurn.turnHandle,
    "公开 SDK 未能中断精确的自主 DSH 回合",
  );
  const releasedInterruptBackgroundWake = await fetch(
    `${baseUrl}/release-background-interrupt-wake`,
  );
  assert(
    releasedInterruptBackgroundWake.ok,
    "确定性 provider 未释放已中断的自主 DSH 回合",
  );
  const autonomousInterruptWait = await connection.wait({
    targets: [interruptAutonomousTurn.turnHandle],
    completion: "all",
  });
  assert(
    autonomousInterruptWait.status === "satisfied" &&
      autonomousInterruptWait.completed[0]?.stopReason === "cancelled",
    "自主 DSH 回合的已接受中断未保留实际取消终态",
  );
  const interruptAutonomousFacts = await collect(
    await connection.attach(
      { scope: "turn", turnHandle: interruptAutonomousTurn.turnHandle },
      { mode: "history" },
    ),
  );
  const autonomousCallerSnapshots = interruptAutonomousFacts.filter(
    (fact): fact is Extract<AgentFact, { type: "message" }> =>
      fact.type === "message" &&
      fact.role === "caller" &&
      containsMessageText(
        fact.content,
        "DSH_AUTONOMOUS_STEER_ACCEPTED_BEFORE_INTERRUPT",
      ),
  );
  assert(
    autonomousCallerSnapshots.some(
      (fact) => fact.messageKey === autonomousSteer.messageKey,
    ),
    "自主回合的活动输入未以同一公开消息身份进入持久历史",
  );

  const afterAutonomousInterrupt = await connection.send(
    {
      placement: "new_turn",
      sessionHandle: started.sessionHandle,
      message:
        "Say DSH_AUTONOMOUS_OLD_TARGET_NEW_TURN after this new turn starts.",
    },
    { operationKey: connection.prepareOperation("send") },
  );
  const afterAutonomousInterruptReady = await fetch(
    `${baseUrl}/wait-after-autonomous-interrupt`,
  );
  assert(
    afterAutonomousInterruptReady.ok,
    "确定性 provider 未收到自主回合之后的新 caller 回合",
  );
  const staleAutonomousOperation = connection.prepareOperation("send");
  let staleAutonomousTargetRejected = false;
  try {
    await connection.send(
      {
        placement: "active_turn",
        turnHandle: interruptAutonomousTurn.turnHandle,
        message: "DSH_OLD_AUTONOMOUS_TARGET_MUST_NOT_REACH_NEW_TURN",
      },
      { operationKey: staleAutonomousOperation },
    );
  } catch {
    staleAutonomousTargetRejected = true;
  }
  const staleAutonomousRecord = await connection.getOperation(
    staleAutonomousOperation,
  );
  const afterStaleAutonomousTarget = await connection.list({
    sessionHandle: started.sessionHandle,
  });
  assert(
    staleAutonomousTargetRejected &&
      staleAutonomousRecord.status === "failed" &&
      ["session_busy", "turn_not_active"].includes(
        staleAutonomousRecord.error.code,
      ) &&
      afterStaleAutonomousTarget.length === 1 &&
      afterStaleAutonomousTarget[0]?.state === "busy" &&
      afterStaleAutonomousTarget[0].activeTurn ===
        afterAutonomousInterrupt.turnHandle,
    "旧自主回合目标未被拒绝，或影响了随后独立的新回合",
  );
  const releasedAfterAutonomousInterrupt = await fetch(
    `${baseUrl}/release-after-autonomous-interrupt`,
  );
  assert(
    releasedAfterAutonomousInterrupt.ok,
    "确定性 provider 未释放自主中断后的新回合",
  );
  const afterAutonomousInterruptWait = await connection.wait({
    targets: [afterAutonomousInterrupt.turnHandle],
    completion: "all",
  });
  const afterAutonomousInterruptFacts = await collect(
    await connection.attach(
      { scope: "turn", turnHandle: afterAutonomousInterrupt.turnHandle },
      { mode: "history" },
    ),
  );
  assert(
    afterAutonomousInterruptWait.status === "satisfied" &&
      afterAutonomousInterruptWait.completed[0]?.finalReply ===
        "DSH_AUTONOMOUS_OLD_TARGET_NEW_TURN_CONFIRMED" &&
      !JSON.stringify(afterAutonomousInterruptFacts).includes(
        "DSH_OLD_AUTONOMOUS_TARGET_MUST_NOT_REACH_NEW_TURN",
      ),
    "旧自主回合输入污染或阻止了后续 caller 回合",
  );

  const permissionAllowPath = required("REINS_DSH_PERMISSION_ALLOW_PATH");
  const permissionCancelPath = required("REINS_DSH_PERMISSION_CANCEL_PATH");
  const closeJobPidPath = required("REINS_DSH_CLOSE_JOB_PID_PATH");
  const closeJobResultPath = required("REINS_DSH_CLOSE_JOB_RESULT_PATH");
  const authorized = await connection.spawn(
    {
      harness: "dsh",
      model: model.id,
      authorizationMode: "interactive",
      cwd: required("REINS_DSH_WORKSPACE"),
      message:
        "Run the requested bash tool that writes DSH_PERMISSION_ALLOW_TOOL, then report the exact result.",
    },
    { operationKey: connection.prepareOperation("spawn") },
  );
  const permissionRequested = await waitForPermission(
    connection,
    authorized.turnHandle,
  );
  assert(
    permissionRequested.kind === "tool:bash" &&
      permissionRequested.options.length === 2 &&
      permissionRequested.options[0]?.outcome === "allow" &&
      permissionRequested.options[0].scope === "once" &&
      permissionRequested.options[1]?.outcome === "deny" &&
      permissionRequested.options[1].feedback === false &&
      permissionRequested.toolKey !== undefined &&
      containsValueText(permissionRequested.input, "bash"),
    "官方 DSH 原生问询未按其一次性授权能力完整呈现",
  );
  const mismatchedPermissionOperationKey =
    connection.prepareOperation("resolvePermission");
  let mismatchedPermissionFailure: unknown;
  try {
    await connection.resolvePermission(
      permissionRequested.permissionHandle,
      { outcome: "allow", scope: "session" },
      { operationKey: mismatchedPermissionOperationKey },
    );
  } catch (error) {
    mismatchedPermissionFailure = error;
  }
  const mismatchedPermissionOperation = await connection.getOperation(
    mismatchedPermissionOperationKey,
  );
  const mismatchFailureFacts =
    mismatchedPermissionFailure instanceof ReinsSdkError &&
    mismatchedPermissionFailure.failure.code ===
      "permission_resolution_mismatch"
      ? mismatchedPermissionFailure.failure.facts
      : undefined;
  assert(
    mismatchFailureFacts?.permissionHandle ===
      permissionRequested.permissionHandle &&
      mismatchedPermissionOperation.status === "failed" &&
      mismatchedPermissionOperation.error.code ===
        "permission_resolution_mismatch" &&
      mismatchedPermissionOperation.error.facts.permissionHandle ===
        permissionRequested.permissionHandle,
    "授权菜单不匹配的直接错误与同 key 查询未保留精确 PermissionHandle",
  );
  const permissionOperationKey =
    connection.prepareOperation("resolvePermission");
  const permissionResolution = { outcome: "allow", scope: "once" } as const;
  const acceptedPermission = await connection.resolvePermission(
    permissionRequested.permissionHandle,
    permissionResolution,
    { operationKey: permissionOperationKey },
  );
  const repeatedPermission = await connection.resolvePermission(
    permissionRequested.permissionHandle,
    permissionResolution,
    { operationKey: permissionOperationKey },
  );
  const permissionOperation = await connection.getOperation(
    permissionOperationKey,
  );
  assert(
    acceptedPermission.status === "resolved" &&
      repeatedPermission.permissionHandle ===
        acceptedPermission.permissionHandle &&
      permissionOperation.status === "succeeded",
    "公开 SDK 未通过统一操作账本确认原生授权决议或精确重试",
  );
  const authorizedWait = await connection.wait({
    targets: [authorized.turnHandle],
    completion: "all",
  });
  const authorizedFacts = await collectHistory(
    await connection.attach(
      { scope: "turn", turnHandle: authorized.turnHandle },
      { mode: "history" },
    ),
  );
  const authorizedTool = authorizedFacts.find(
    (fact) => fact.type === "tool.requested" && fact.name === "bash",
  );
  const authorizedToolResult = authorizedFacts.find(
    (fact) => fact.type === "tool.completed" && fact.name === "bash",
  );
  assert(
    authorizedWait.status === "satisfied" &&
      authorizedWait.completed[0]?.finalReply ===
        "DSH_PERMISSION_TOOL_CONFIRMED" &&
      authorizedTool?.type === "tool.requested" &&
      authorizedToolResult?.type === "tool.completed" &&
      permissionRequested.toolKey === authorizedTool.toolKey &&
      authorizedTool.toolKey === authorizedToolResult.toolKey &&
      containsValueText(authorizedTool.input, permissionAllowPath) &&
      containsValueText(authorizedTool.input, "danger-full-access") &&
      containsValueText(
        authorizedToolResult.result,
        "DSH_PERMISSION_ALLOWED",
      ) &&
      containsValueText(authorizedFacts, "permission.resolved") &&
      (await fileExists(permissionAllowPath)),
    "DSH 的一次性原生授权未执行对应工具，或未保留关联工具事实",
  );

  const cancelled = await connection.spawn(
    {
      harness: "dsh",
      model: model.id,
      authorizationMode: "interactive",
      cwd: required("REINS_DSH_WORKSPACE"),
      message:
        "Run the requested bash tool that writes DSH_PERMISSION_CANCEL_TOOL, then report the exact result.",
    },
    { operationKey: connection.prepareOperation("spawn") },
  );
  const cancelledPermission = await waitForPermission(
    connection,
    cancelled.turnHandle,
  );
  const cancellation = await connection.interrupt(
    { turnHandle: cancelled.turnHandle },
    { operationKey: connection.prepareOperation("interrupt") },
  );
  const cancellationWait = await connection.wait({
    targets: [cancelled.turnHandle],
    completion: "all",
  });
  const latePermissionOperationKey =
    connection.prepareOperation("resolvePermission");
  let latePermissionRejected = false;
  let latePermissionFailure: unknown;
  try {
    await connection.resolvePermission(
      cancelledPermission.permissionHandle,
      permissionResolution,
      { operationKey: latePermissionOperationKey },
    );
  } catch (error) {
    latePermissionRejected = true;
    latePermissionFailure = error;
  }
  const latePermissionOperation = await connection.getOperation(
    latePermissionOperationKey,
  );
  const cancelledFacts = await collectHistory(
    await connection.attach(
      { scope: "turn", turnHandle: cancelled.turnHandle },
      { mode: "history" },
    ),
  );
  const cancelledToolRequested = cancelledFacts.some(
    (fact) =>
      fact.type === "tool.requested" &&
      fact.name === "bash" &&
      containsValueText(fact.input, "danger-full-access"),
  );
  const cancelMarkerExists = await fileExists(permissionCancelPath);
  const latePermissionErrorCode =
    latePermissionFailure instanceof ReinsSdkError
      ? latePermissionFailure.failure.code
      : undefined;
  const latePermissionHandle =
    latePermissionFailure instanceof ReinsSdkError &&
    latePermissionFailure.failure.code === "permission_not_pending"
      ? latePermissionFailure.failure.facts.permissionHandle
      : undefined;
  const storedLatePermissionErrorCode =
    latePermissionOperation.status === "failed" &&
    latePermissionOperation.error.code === "permission_not_pending"
      ? latePermissionOperation.error.code
      : undefined;
  const storedLatePermissionHandle =
    latePermissionOperation.status === "failed" &&
    latePermissionOperation.error.code === "permission_not_pending"
      ? latePermissionOperation.error.facts.permissionHandle
      : undefined;
  const cancellationPassed =
    cancellation.status === "accepted" &&
    cancellationWait.status === "satisfied" &&
    cancellationWait.completed[0]?.stopReason === "cancelled" &&
    latePermissionRejected &&
    latePermissionErrorCode === "permission_not_pending" &&
    latePermissionHandle === cancelledPermission.permissionHandle &&
    latePermissionOperation.status === "failed" &&
    storedLatePermissionErrorCode === "permission_not_pending" &&
    storedLatePermissionHandle === cancelledPermission.permissionHandle &&
    cancelledFacts.some((fact) => fact.type === "permission.requested") &&
    cancelledToolRequested &&
    !cancelledFacts.some((fact) => fact.type === "permission.resolved") &&
    !cancelMarkerExists;
  assert(
    cancellationPassed,
    "取消后的 DSH 授权迟到决议仍被接受或执行了工具正文",
  );

  const closeJobStart = await connection.send(
    {
      placement: "new_turn",
      sessionHandle: started.sessionHandle,
      message:
        "Start one DSH_CLOSE_BACKGROUND_START bash job and report when it is running.",
    },
    { operationKey: connection.prepareOperation("send") },
  );
  const closeJobWait = await connection.wait({
    targets: [closeJobStart.turnHandle],
    completion: "all",
  });
  const closeJobAccepted =
    closeJobWait.status === "satisfied" &&
    closeJobWait.completed[0]?.finalReply ===
      "DSH_CLOSE_BACKGROUND_TOOL_STARTED";
  assert(closeJobAccepted, "官方 DSH 未接受用于关闭验收的后台工具");
  await waitForFile(closeJobPidPath);
  const closeJobPid = Number((await readFile(closeJobPidPath, "utf8")).trim());
  assert(
    Number.isSafeInteger(closeJobPid) && closeJobPid > 0,
    "后台工具 PID 无效",
  );
  const closeJobHistory = await collectHistory(
    await connection.attach(
      { scope: "turn", turnHandle: closeJobStart.turnHandle },
      { mode: "history" },
    ),
  );
  const closeJobRequested = closeJobHistory.find(
    (fact) => fact.type === "tool.requested" && fact.name === "bash",
  );
  const closeJobCompleted = closeJobHistory.find(
    (fact) => fact.type === "tool.completed" && fact.name === "bash",
  );
  assert(
    closeJobRequested?.type === "tool.requested" &&
      closeJobCompleted?.type === "tool.completed" &&
      containsValueText(
        closeJobCompleted.result,
        "started background job bash-",
      ),
    "关闭验收的 Bash 工具未形成官方后台 job",
  );

  const closedSession = await connection.kill(
    { sessionHandle: started.sessionHandle },
    { operationKey: connection.prepareOperation("kill") },
  );
  assert(
    closedSession.status === "killed" &&
      closedSession.sessionHandle === started.sessionHandle,
    "关闭一个 DSH 会话未完成其官方 AgentHandle 关闭",
  );
  let closeJobAlive = true;
  try {
    process.kill(closeJobPid, 0);
  } catch {
    closeJobAlive = false;
  }
  const releasedCloseJob = await fetch(`${baseUrl}/release-close-job`);
  assert(releasedCloseJob.ok, "确定性 provider 未释放关闭验收后台 job");
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  assert(
    !closeJobAlive && !(await fileExists(closeJobResultPath)),
    "官方 DSH 会话关闭后仍有后台 Bash 资源存活或执行",
  );

  const isolationTurn = await connection.send(
    {
      placement: "new_turn",
      sessionHandle: authorized.sessionHandle,
      message:
        "Continue in this separate official DSH session and say DSH_ISOLATION_KEEPALIVE.",
    },
    { operationKey: connection.prepareOperation("send") },
  );
  const isolationWait = await connection.wait({
    targets: [isolationTurn.turnHandle],
    completion: "all",
  });
  assert(
    isolationWait.status === "satisfied" &&
      isolationWait.completed[0]?.finalReply ===
        "DSH_ISOLATION_KEEPALIVE_CONFIRMED" &&
      (await connection.list({ sessionHandle: authorized.sessionHandle }))[0]
        ?.state === "idle",
    "关闭一个 DSH 会话影响了另一个独立官方会话",
  );
  const cancelledClosed = await connection.kill(
    { sessionHandle: cancelled.sessionHandle },
    { operationKey: connection.prepareOperation("kill") },
  );
  const authorizedClosed = await connection.kill(
    { sessionHandle: authorized.sessionHandle },
    { operationKey: connection.prepareOperation("kill") },
  );

  const killed = await connection.kill(
    { sessionHandle: started.sessionHandle },
    { operationKey: connection.prepareOperation("kill") },
  );
  assert(
    cancelledClosed.status === "killed" &&
      authorizedClosed.status === "killed" &&
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
      interruptedTurnHandle: interruptTarget.turnHandle,
      afterInterruptTurnHandle: afterInterrupt.turnHandle,
      backgroundStartTurnHandle: backgroundStart.turnHandle,
      backgroundWakeTurnHandle: autonomousTurn.turnHandle,
      firstFactTypes: firstFacts.map((fact) => fact.type),
      newTurnDeliveryPoint: second.deliveryPoint,
      closeStatus: killed.status,
      permissionStatus: permissionOperation.status,
      latePermissionStatus: latePermissionOperation.status,
      activeJobPid: closeJobPid,
      cancelledSession: cancelledClosed.status,
      isolatedSession: authorizedClosed.status,
    })}\n`,
  );
} finally {
  connection?.close();
}
