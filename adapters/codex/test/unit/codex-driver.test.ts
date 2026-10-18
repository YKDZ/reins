import { randomUUID } from "node:crypto";

import { WorkerStartFailure } from "@reins/protocol";
import type {
  DriverDiagnosticFact,
  DomainEvent,
  PermissionId,
  SessionId,
  TurnId,
  WorkerSpec,
} from "@reins/protocol";
import { describe, expect, test } from "vitest";

import { createCodexDriver } from "#/codex-driver";
import {
  CodexRequestError,
  createCodexTransport,
  type CodexChild,
} from "#/transport";

import { createFakeTransport } from "../helpers/fake-transport.ts";

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};
const sessionId =
  "session:00000000-0000-4000-8000-000000000000:reviewer:1" as SessionId;
const firstTurnId = "t1" as TurnId;
const secondTurnId = "t2" as TurnId;
const permissionId = "p1" as PermissionId;

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function makeDriver(fake: ReturnType<typeof createFakeTransport>) {
  const events: DomainEvent[] = [];
  const driver = createCodexDriver({
    transportFactory: () => fake.transport,
  })({
    emit: (event) => events.push(event),
    diagnostics: async () => undefined,
  });
  return { driver, events };
}

function startTracked(
  driver: ReturnType<ReturnType<typeof createCodexDriver>>,
  sessionId: SessionId,
  turnId: TurnId,
): Promise<void> {
  return driver.start({
    sessionId,
    turnId,
    harness: "codex",
    message: "caller task",
    cwd: "/tmp/demo",
  });
}

test("结构化额度失败不从正文猜测限流，停止等待在途失败提交", async () => {
  const fake = createFakeTransport();
  const events: DomainEvent[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let accepted!: () => void;
  const acceptance = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  const driver = createCodexDriver({ transportFactory: () => fake.transport })({
    emit: (event) => events.push(event),
    diagnostics: async (input) => {
      if (input.kind === "turn_failure") {
        accepted();
        await gate;
      }
      return undefined;
    },
  });
  await driver.start({
    sessionId,
    turnId: firstTurnId,
    harness: "codex",
    cwd: "/tmp",
    message: "caller task",
  });
  await flush();
  fake.controls.pushInbound({
    kind: "notification",
    method: "turn/completed",
    params: {
      turn: {
        id: "turn1",
        status: "failed",
        error: { message: "rate limit", codexErrorInfo: "usageLimitExceeded" },
      },
    },
  });
  await acceptance;
  let stopped = false;
  const stopping = driver.terminate(sessionId).then(() => {
    stopped = true;
  });
  await flush();
  expect(stopped).toBe(false);
  release();
  await stopping;
  expect(events.filter((event) => event.type === "turn.completed")).toEqual([
    {
      type: "turn.completed",
      sessionId,
      turnId: firstTurnId,
      stopReason: "failed",
      finalReply: null,
      failure: {
        failureCategory: "quota_exhausted",
        retryDisposition: "external_state_change",
      },
    },
  ]);
});

async function setup(
  authorizationMode: "interactive" | "allowAll" | "omitted" = "interactive",
  terminateTimeoutMs?: number,
  workerOverrides: Partial<Pick<WorkerSpec, "model" | "reasoning">> = {},
): Promise<{
  events: DomainEvent[];
  diagnostics: DriverDiagnosticFact[];
  fake: ReturnType<typeof createFakeTransport>;
  driver: ReturnType<ReturnType<typeof createCodexDriver>>;
}> {
  const fake = createFakeTransport();
  const diagnostics: DriverDiagnosticFact[] = [];
  const factory = createCodexDriver({
    transportFactory: () => fake.transport,
    ...(terminateTimeoutMs === undefined ? {} : { terminateTimeoutMs }),
  });
  const events: DomainEvent[] = [];
  const driver = factory({
    emit: (event) => events.push(event),
    diagnostics: async (input) => {
      diagnostics.push(input);
      return undefined;
    },
  });
  await driver.start({
    sessionId,
    turnId: firstTurnId,
    harness: "codex",
    message: "检查",
    cwd: "/tmp/demo",
    ...(authorizationMode === "omitted" ? {} : { authorizationMode }),
    ...workerOverrides,
  });
  return { events, diagnostics, fake, driver };
}

async function setupWithMalformedResponse(
  method: "turn/steer" | "thread/delete",
): Promise<{
  diagnostics: DriverDiagnosticFact[];
  driver: ReturnType<ReturnType<typeof createCodexDriver>>;
  events: DomainEvent[];
}> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const emitter = new EventEmitter();
  const child: CodexChild = {
    stdin,
    stdout,
    on: (event, listener) => emitter.on(event, listener),
    kill: () => {
      emitter.emit("exit");
      stdout.end();
      return true;
    },
  };
  let outbound = "";
  stdin.on("data", (chunk) => {
    outbound += String(chunk);
    for (;;) {
      const newline = outbound.indexOf("\n");
      if (newline < 0) break;
      const request = JSON.parse(outbound.slice(0, newline)) as {
        id?: number;
        method?: string;
      };
      outbound = outbound.slice(newline + 1);
      if (request.id === undefined) continue;
      const result =
        request.method === method
          ? null
          : request.method === "thread/start"
            ? { thread: { id: "thr1" } }
            : request.method === "turn/start"
              ? { turn: { id: "turn1" } }
              : {};
      queueMicrotask(() => {
        stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      });
    }
  });
  const diagnostics: DriverDiagnosticFact[] = [];
  const events: DomainEvent[] = [];
  const factory = createCodexDriver({
    transportFactory: (options) =>
      createCodexTransport({ ...options, spawnChild: () => child }),
  });
  const driver = factory({
    emit: (event) => events.push(event),
    diagnostics: async (input) => {
      diagnostics.push(input);
      return undefined;
    },
  });
  await driver.start({
    sessionId,
    turnId: firstTurnId,
    harness: "codex",
    message: "检查",
    cwd: "/tmp/demo",
    authorizationMode: "interactive",
  });
  return { diagnostics, driver, events };
}

describe("codex driver", () => {
  test("冷 HOME 首次 initialize 成功前排队，之后 worker 可并发初始化", async () => {
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = `/tmp/reins-codex-cold-${randomUUID()}`;
    const firstFake = createFakeTransport();
    const secondFake = createFakeTransport();
    const thirdFake = createFakeTransport();
    const firstInitialize = deferred<Record<string, never>>();
    const secondInitialize = deferred<Record<string, never>>();
    const thirdInitialize = deferred<Record<string, never>>();
    firstFake.controls.setResponse("initialize", firstInitialize.promise);
    secondFake.controls.setResponse("initialize", secondInitialize.promise);
    thirdFake.controls.setResponse("initialize", thirdInitialize.promise);
    let firstStarts = 0;
    let secondStarts = 0;
    let thirdStarts = 0;
    firstFake.transport.start = () => {
      firstStarts += 1;
    };
    secondFake.transport.start = () => {
      secondStarts += 1;
    };
    thirdFake.transport.start = () => {
      thirdStarts += 1;
    };
    const first = makeDriver(firstFake);
    const second = makeDriver(secondFake);
    const third = makeDriver(thirdFake);
    const firstSession =
      "session:00000000-0000-4000-8000-000000000000:coldfirst:1" as SessionId;
    const secondSession =
      "session:00000000-0000-4000-8000-000000000000:coldsecond:1" as SessionId;
    const thirdSession =
      "session:00000000-0000-4000-8000-000000000000:coldthird:1" as SessionId;
    const starts: Promise<void>[] = [];

    try {
      const firstStart = startTracked(first.driver, firstSession, firstTurnId);
      starts.push(firstStart);
      await flush();
      expect(firstStarts).toBe(1);
      expect(firstFake.controls.requests().map(({ method }) => method)).toEqual(
        ["initialize"],
      );

      const secondStart = startTracked(
        second.driver,
        secondSession,
        secondTurnId,
      );
      starts.push(secondStart);
      await flush();
      expect(secondStarts).toBe(0);
      expect(secondFake.controls.requests()).toEqual([]);

      firstInitialize.resolve({});
      await firstStart;
      await flush();
      expect(secondStarts).toBe(1);
      expect(
        secondFake.controls.requests().map(({ method }) => method),
      ).toEqual(["initialize"]);

      const thirdStart = startTracked(
        third.driver,
        thirdSession,
        "t3" as TurnId,
      );
      starts.push(thirdStart);
      await flush();
      expect(thirdStarts).toBe(1);
      expect(thirdFake.controls.requests().map(({ method }) => method)).toEqual(
        ["initialize"],
      );
    } finally {
      firstInitialize.resolve({});
      secondInitialize.resolve({});
      thirdInitialize.resolve({});
      await Promise.allSettled(starts);
      await Promise.all([
        first.driver.terminate(firstSession),
        second.driver.terminate(secondSession),
        third.driver.terminate(thirdSession),
      ]);
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
    }
  });

  test("冷 HOME initialize 失败保留失败且不会自动启动排队 worker", async () => {
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = `/tmp/reins-codex-failed-${randomUUID()}`;
    const firstFake = createFakeTransport();
    const queuedFake = createFakeTransport();
    const laterFake = createFakeTransport();
    const firstInitialize = deferred<Record<string, never>>();
    firstFake.controls.setResponse("initialize", firstInitialize.promise);
    let queuedStarts = 0;
    let laterStarts = 0;
    queuedFake.transport.start = () => {
      queuedStarts += 1;
    };
    laterFake.transport.start = () => {
      laterStarts += 1;
    };
    const first = makeDriver(firstFake);
    const queued = makeDriver(queuedFake);
    const later = makeDriver(laterFake);
    const firstSession =
      "session:00000000-0000-4000-8000-000000000000:failedfirst:1" as SessionId;
    const queuedSession =
      "session:00000000-0000-4000-8000-000000000000:failedqueued:1" as SessionId;
    const laterSession =
      "session:00000000-0000-4000-8000-000000000000:failedlater:1" as SessionId;
    const starts: Promise<void>[] = [];

    try {
      const firstStart = startTracked(first.driver, firstSession, firstTurnId);
      starts.push(firstStart);
      await flush();
      const queuedStart = startTracked(
        queued.driver,
        queuedSession,
        secondTurnId,
      );
      starts.push(queuedStart);
      await flush();
      expect(queuedStarts).toBe(0);

      firstInitialize.reject(new Error("sqlite initialization failed"));
      await expect(firstStart).rejects.toBeInstanceOf(WorkerStartFailure);
      await expect(firstStart).rejects.toMatchObject({
        name: "WorkerStartFailure",
        acceptance: "not_accepted",
        cause: expect.objectContaining({
          message: "sqlite initialization failed",
        }),
      });
      await expect(queuedStart).rejects.toBeInstanceOf(WorkerStartFailure);
      await expect(queuedStart).rejects.toMatchObject({
        name: "WorkerStartFailure",
        acceptance: "not_accepted",
        cause: expect.objectContaining({
          message: "sqlite initialization failed",
        }),
      });
      await flush();
      expect(queuedStarts).toBe(0);

      const laterStart = startTracked(
        later.driver,
        laterSession,
        "t3" as TurnId,
      );
      starts.push(laterStart);
      await laterStart;
      await flush();
      expect(laterStarts).toBe(1);
      expect(
        laterFake.controls.requests().map(({ method }) => method),
      ).toContain("initialize");
    } finally {
      firstInitialize.resolve({});
      await Promise.allSettled(starts);
      await Promise.all([
        first.driver.terminate(firstSession),
        queued.driver.terminate(queuedSession),
        later.driver.terminate(laterSession),
      ]);
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
    }
  });

  test("终止排队 worker 后首次 initialize 完成不会复活它", async () => {
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = `/tmp/reins-codex-cancelled-${randomUUID()}`;
    const firstFake = createFakeTransport();
    const queuedFake = createFakeTransport();
    const firstInitialize = deferred<Record<string, never>>();
    firstFake.controls.setResponse("initialize", firstInitialize.promise);
    let queuedStarts = 0;
    queuedFake.transport.start = () => {
      queuedStarts += 1;
    };
    const first = makeDriver(firstFake);
    const queued = makeDriver(queuedFake);
    const firstSession =
      "session:00000000-0000-4000-8000-000000000000:cancelfirst:1" as SessionId;
    const queuedSession =
      "session:00000000-0000-4000-8000-000000000000:cancelqueued:1" as SessionId;
    const starts: Promise<void>[] = [];

    try {
      const firstStart = startTracked(first.driver, firstSession, firstTurnId);
      starts.push(firstStart);
      await flush();
      const queuedStart = startTracked(
        queued.driver,
        queuedSession,
        secondTurnId,
      );
      starts.push(queuedStart);
      await flush();
      expect(queuedStarts).toBe(0);

      await queued.driver.terminate(queuedSession);
      expect(queuedFake.controls.closed()).toBe(true);
      firstInitialize.resolve({});
      await firstStart;
      await expect(queuedStart).rejects.toThrow();
      await flush();
      expect(queuedStarts).toBe(0);
      expect(queuedFake.controls.requests()).toEqual([]);
    } finally {
      firstInitialize.resolve({});
      await Promise.allSettled(starts);
      await first.driver.terminate(firstSession);
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
    }
  });

  test("spawn 走 initialize → thread/start → turn/start", async () => {
    const { fake } = await setup();
    await flush();

    const methods = fake.controls.requests().map((request) => request.method);
    expect(methods).toEqual(["initialize", "thread/start", "turn/start"]);
    const threadStart = fake.controls.requests()[1];
    expect(threadStart?.params).toEqual({
      ephemeral: true,
      cwd: "/tmp/demo",
      approvalPolicy: "on-request",
    });
    const turnStart = fake.controls.requests()[2];
    expect(turnStart?.params).toEqual({
      threadId: "thr1",
      input: [{ type: "text", text: "检查", text_elements: [] }],
    });
  });

  test("thread/start 尚未派发首条输入时失败记为未接受", async () => {
    const fake = createFakeTransport();
    const failure = new Error("thread/start response lost");
    let rejectThreadStart!: (error: unknown) => void;
    fake.controls.setResponse(
      "thread/start",
      new Promise<never>((_resolve, reject) => {
        rejectThreadStart = reject;
      }),
    );
    const { driver } = makeDriver(fake);
    const starting = driver.start({
      sessionId,
      turnId: firstTurnId,
      harness: "codex",
      message: "caller task",
      cwd: "/tmp/demo",
    });
    await flush();
    expect(fake.controls.requests().map(({ method }) => method)).toEqual([
      "initialize",
      "thread/start",
    ]);
    rejectThreadStart(failure);
    await expect(starting).rejects.toBeInstanceOf(WorkerStartFailure);
    await expect(starting).rejects.toMatchObject({
      acceptance: "not_accepted",
      cause: failure,
    });
    await driver.terminate(sessionId);
  });

  test("首个 turn/start 明确拒绝记为未接受，断流仅记为未知", async () => {
    const rejected = createFakeTransport();
    const rejection = new CodexRequestError("native rejected turn/start");
    let rejectTurnStart!: (error: unknown) => void;
    rejected.controls.setResponse(
      "turn/start",
      new Promise<never>((_resolve, reject) => {
        rejectTurnStart = reject;
      }),
    );
    const rejectedDriver = makeDriver(rejected);
    const rejectedStart = rejectedDriver.driver.start({
      sessionId,
      turnId: firstTurnId,
      harness: "codex",
      message: "caller task",
      cwd: "/tmp/demo",
    });
    await flush();
    expect(rejected.controls.requests().map(({ method }) => method)).toEqual([
      "initialize",
      "thread/start",
      "turn/start",
    ]);
    rejectTurnStart(rejection);
    await expect(rejectedStart).rejects.toBeInstanceOf(WorkerStartFailure);
    await expect(rejectedStart).rejects.toMatchObject({
      name: "WorkerStartFailure",
      acceptance: "not_accepted",
      cause: rejection,
    });
    await rejectedDriver.driver.terminate(sessionId);

    const lost = createFakeTransport();
    const disconnect = new Error("codex app-server closed after turn dispatch");
    let loseTurnStart!: (error: unknown) => void;
    lost.controls.setResponse(
      "turn/start",
      new Promise<never>((_resolve, reject) => {
        loseTurnStart = reject;
      }),
    );
    const lostDriver = makeDriver(lost);
    const lostStart = lostDriver.driver.start({
      sessionId,
      turnId: firstTurnId,
      harness: "codex",
      message: "caller task",
      cwd: "/tmp/demo",
    });
    await flush();
    expect(lost.controls.requests().map(({ method }) => method)).toEqual([
      "initialize",
      "thread/start",
      "turn/start",
    ]);
    loseTurnStart(disconnect);
    await expect(lostStart).rejects.toBeInstanceOf(WorkerStartFailure);
    await expect(lostStart).rejects.toMatchObject({
      name: "WorkerStartFailure",
      acceptance: "unknown",
      cause: disconnect,
    });
    await lostDriver.driver.terminate(sessionId);
  });

  test("allowAll 映射 approvalPolicy never + 沙箱全访问", async () => {
    const { fake } = await setup("allowAll");
    await flush();

    const threadStart = fake.controls.requests()[1];
    expect(threadStart?.params).toEqual({
      ephemeral: true,
      cwd: "/tmp/demo",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  });

  test("未指定授权模式时不注入 approvalPolicy 或 sandbox", async () => {
    const { fake } = await setup("omitted");
    await flush();

    const threadStart = fake.controls.requests()[1];
    expect(threadStart?.params).toEqual({
      ephemeral: true,
      cwd: "/tmp/demo",
    });
  });

  test("model 与 reasoning 只作为每次 turn/start override", async () => {
    const { diagnostics, driver, fake } = await setup(
      "interactive",
      undefined,
      {
        model: "gpt-5.4",
        reasoning: "high",
      },
    );
    await flush();

    expect(fake.controls.requests()[1]?.params).toEqual({
      ephemeral: true,
      cwd: "/tmp/demo",
      approvalPolicy: "on-request",
    });
    expect(fake.controls.requests()[2]?.params).toEqual({
      threadId: "thr1",
      input: [{ type: "text", text: "检查", text_elements: [] }],
      model: "gpt-5.4",
      effort: "high",
    });
    fake.controls.pushInbound({
      kind: "notification",
      method: "turn/completed",
      params: { turn: { id: "turn1", status: "completed", error: null } },
    });
    await flush();
    await driver.deliver(sessionId, secondTurnId, "下一步", "new_turn");
    await flush();
    expect(fake.controls.requests().at(-1)?.params).toEqual({
      threadId: "thr1",
      input: [{ type: "text", text: "下一步", text_elements: [] }],
      model: "gpt-5.4",
      effort: "high",
    });
    expect(
      diagnostics.filter(
        (input) =>
          input.kind === "mapping_gap" &&
          input.operation === "spawn" &&
          input.fields.includes("reasoning"),
      ),
    ).toEqual([]);
  });

  test("agentMessage delta 与 completed、turn completed 映射事件流", async () => {
    const { events, fake } = await setup();
    await flush();
    fake.controls.pushInbound({
      kind: "notification",
      method: "item/agentMessage/delta",
      params: {
        itemId: "m1",
        delta: "分析",
      },
    });
    fake.controls.pushInbound({
      kind: "notification",
      method: "item/completed",
      params: {
        item: { type: "agentMessage", id: "m1", text: "分析完成" },
      },
    });
    fake.controls.pushInbound({
      kind: "notification",
      method: "turn/completed",
      params: { turn: { id: "turn1", status: "completed", error: null } },
    });
    await flush();

    expect(events.map((event) => event.type)).toEqual([
      "text.delta",
      "message",
      "turn.completed",
    ]);
    expect(events.at(-1)).toEqual({
      type: "turn.completed",
      sessionId,
      turnId: firstTurnId,
      stopReason: "end_turn",
      finalReply: "分析完成",
    });
  });

  test("工具 item 映射 tool.requested/tool.completed(isError)", async () => {
    const { events, fake } = await setup();
    await flush();
    fake.controls.pushInbound({
      kind: "notification",
      method: "item/started",
      params: {
        item: {
          type: "commandExecution",
          id: "e1",
          status: "inProgress",
          output: null,
        },
      },
    });
    fake.controls.pushInbound({
      kind: "notification",
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: "e1",
          status: "failed",
          output: "not found",
        },
      },
    });
    await flush();

    expect(
      events.filter(
        (event) =>
          event.type === "tool.requested" || event.type === "tool.completed",
      ),
    ).toEqual([
      {
        type: "tool.requested",
        sessionId,
        turnId: firstTurnId,
        toolCallId: "c1",
        name: "commandExecution",
      },
      {
        type: "tool.completed",
        sessionId,
        turnId: firstTurnId,
        toolCallId: "c1",
        name: "commandExecution",
        result: "not found",
        isError: true,
      },
    ]);
  });

  test("审批请求转 permission.requested，决议翻译为决策应答", async () => {
    const { events, fake, driver } = await setup();
    await flush();
    fake.controls.pushInbound({
      kind: "request",
      id: 7,
      method: "item/commandExecution/requestApproval",
      input: {
        threadId: "thr1",
        turnId: "turn1",
        itemId: "e1",
        command: "ls",
      },
      availableDecisions: ["accept", "acceptForSession", "decline"],
      requestedPermissions: {},
    });
    await flush();

    const requested = events.find(
      (event) => event.type === "permission.requested",
    );
    expect(requested).toEqual({
      type: "permission.requested",
      sessionId,
      turnId: firstTurnId,
      permissionId: "p1",
      kind: "tool:commandExecution",
      input: { threadId: "thr1", turnId: "turn1", itemId: "e1", command: "ls" },
      options: [
        { outcome: "allow", scope: "once" },
        { outcome: "allow", scope: "session" },
        { outcome: "deny", feedback: false },
      ],
    });

    driver.resolvePermission(sessionId, permissionId, {
      outcome: "allow",
      scope: "once",
    });
    expect(fake.controls.responded()).toEqual([
      { id: 7, result: { decision: "accept" } },
    ]);
  });

  test("不支持的入站请求归一化为 compatibility_gap，不泄漏请求对象", async () => {
    const { diagnostics, fake } = await setup();
    await flush();
    fake.controls.pushInbound({
      kind: "request",
      id: 17,
      method: "unsupported",
      nativeMethod: "worker/unknownRequest",
    });
    await flush();

    expect(diagnostics.filter((input) => input.kind !== "lifecycle")).toEqual([
      expect.objectContaining({
        sessionId,
        turnId: firstTurnId,
        kind: "compatibility_gap",
        operation: "receive_worker_request",
        reason: "unsupported_request",
        message: expect.objectContaining({ text: "worker/unknownRequest" }),
      }),
    ]);
  });

  test("worker reported failure 保留上游 message 到 turn_failure", async () => {
    const { diagnostics, fake } = await setup();
    await flush();
    fake.controls.pushInbound({
      kind: "notification",
      method: "turn/completed",
      params: {
        turn: {
          id: "turn1",
          status: "failed",
          error: { message: "Requested reasoning effort is unsupported" },
        },
      },
    });
    await flush();

    expect(diagnostics.filter((input) => input.kind !== "lifecycle")).toEqual([
      expect.objectContaining({
        kind: "turn_failure",
        operation: "run_turn",
        reason: "worker_reported_failure",
        sessionId,
        turnId: firstTurnId,
        message: expect.objectContaining({
          text: "Requested reasoning effort is unsupported",
        }),
      }),
    ]);
  });

  test("worker 未提供失败 message 时使用通用证据", async () => {
    const { diagnostics, fake } = await setup();
    await flush();
    fake.controls.pushInbound({
      kind: "notification",
      method: "turn/completed",
      params: { turn: { id: "turn1", status: "failed", error: null } },
    });
    await flush();

    expect(diagnostics.filter((input) => input.kind !== "lifecycle")).toEqual([
      expect.objectContaining({
        kind: "turn_failure",
        message: expect.objectContaining({
          text: "worker reported a failed turn",
        }),
      }),
    ]);
  });

  test("availableDecisions 只映射为菜单中的对应选项", async () => {
    const { events, fake } = await setup();
    await flush();
    fake.controls.pushInbound({
      kind: "request",
      id: 9,
      method: "item/commandExecution/requestApproval",
      input: {
        threadId: "thr1",
        turnId: "turn1",
        itemId: "e2",
      },
      availableDecisions: ["accept"],
      requestedPermissions: {},
    });
    await flush();

    const requested = events.find(
      (event) => event.type === "permission.requested",
    );
    expect(
      requested?.type === "permission.requested" ? requested.options : [],
    ).toEqual([{ outcome: "allow", scope: "once" }]);
  });

  test("deny 映射 decline", async () => {
    const { fake, driver } = await setup();
    await flush();
    fake.controls.pushInbound({
      kind: "request",
      id: 8,
      method: "item/fileChange/requestApproval",
      input: { threadId: "thr1", turnId: "turn1", itemId: "f1" },
      availableDecisions: ["accept", "acceptForSession", "decline"],
      requestedPermissions: {},
    });
    await flush();

    driver.resolvePermission(sessionId, permissionId, {
      outcome: "deny",
    });
    expect(fake.controls.responded()).toEqual([
      { id: 8, result: { decision: "decline" } },
    ]);
  });

  test("busy 时 deliver 走 steer，回合结束后走新 turn/start", async () => {
    const { fake, driver } = await setup();
    await flush();

    await driver.deliver(sessionId, firstTurnId, "继续", "active_turn");
    await flush();
    const steer = fake.controls.requests().at(-1);
    expect(steer?.method).toBe("turn/steer");
    expect(steer?.params).toEqual({
      threadId: "thr1",
      input: [{ type: "text", text: "继续", text_elements: [] }],
      expectedTurnId: "turn1",
    });

    fake.controls.pushInbound({
      kind: "notification",
      method: "turn/completed",
      params: { turn: { id: "turn1", status: "completed", error: null } },
    });
    await flush();
    await driver.deliver(sessionId, secondTurnId, "下一步", "new_turn");
    await flush();
    expect(fake.controls.requests().at(-1)?.method).toBe("turn/start");
  });

  test("真实 transport 已记录的 steer protocol error 不在 driver 重复记录", async () => {
    const { diagnostics, driver } =
      await setupWithMalformedResponse("turn/steer");
    await flush();

    await expect(
      driver.deliver(sessionId, firstTurnId, "继续", "active_turn"),
    ).rejects.toMatchObject({ alreadyDiagnosed: true });
    await flush();

    expect(diagnostics.filter((input) => input.kind !== "lifecycle")).toEqual([
      expect.objectContaining({
        kind: "protocol_violation",
        operation: "validate_worker_response",
        reason: "invalid_shape",
      }),
    ]);
  });

  test("精确 interrupt 等待原生接受，结束竞争不换用新 native TurnId", async () => {
    const { events, fake, driver } = await setup();
    await flush();
    let accept!: (value: Record<string, never>) => void;
    fake.controls.setResponse(
      "turn/interrupt",
      new Promise((resolve) => {
        accept = resolve;
      }),
    );
    let settled = false;
    const pending = driver.interrupt(sessionId, firstTurnId).then(() => {
      settled = true;
    });
    await flush();
    expect(fake.controls.requests().at(-1)).toEqual({
      method: "turn/interrupt",
      params: { threadId: "thr1", turnId: "turn1" },
    });
    expect(settled).toBe(false);
    expect(events.filter((event) => event.type === "turn.completed")).toEqual(
      [],
    );
    fake.controls.pushInbound({
      kind: "notification",
      method: "turn/completed",
      params: { turn: { id: "turn1", status: "interrupted", error: null } },
    });
    await flush();
    await driver.deliver(
      sessionId,
      secondTurnId,
      "explicit next task",
      "new_turn",
    );
    accept({});
    await pending;
    const count = fake.controls.requests().length;
    await expect(
      driver.interrupt(sessionId, firstTurnId),
    ).rejects.toMatchObject({ code: "turn_not_active", turnId: firstTurnId });
    expect(fake.controls.requests()).toHaveLength(count);
    expect(
      events.filter((event) => event.type === "turn.completed"),
    ).toMatchObject([{ turnId: firstTurnId, stopReason: "cancelled" }]);
  });

  test("interrupt 走 turn/interrupt，interrupted 合成 cancelled", async () => {
    const { events, fake, driver } = await setup();
    await flush();

    await driver.interrupt(sessionId, firstTurnId);
    await flush();
    expect(fake.controls.requests().at(-1)?.method).toBe("turn/interrupt");

    fake.controls.pushInbound({
      kind: "notification",
      method: "turn/completed",
      params: { turn: { id: "turn1", status: "interrupted", error: null } },
    });
    await flush();
    expect(events.at(-1)).toEqual({
      type: "turn.completed",
      sessionId,
      turnId: firstTurnId,
      stopReason: "cancelled",
      finalReply: null,
    });
  });

  test("terminate 走 thread/delete 并关闭传输，不补发 failed", async () => {
    const { events, diagnostics, fake, driver } = await setup();
    await flush();

    await driver.terminate(sessionId);
    expect(fake.controls.requests().at(-1)?.method).toBe("thread/delete");
    expect(fake.controls.closed()).toBe(true);
    expect(events.filter((event) => event.type === "turn.completed")).toEqual(
      [],
    );
    expect(
      diagnostics
        .filter((input) => input.kind === "lifecycle")
        .map((input) => input.reason),
    ).toEqual(["initialized", "closed"]);
  });

  test("terminate 的 delete 超时强制关闭资源树但不能确认 kill", async () => {
    const { diagnostics, fake, driver } = await setup("interactive", 5);
    await flush();
    fake.controls.setResponse("thread/delete", new Promise(() => {}));

    await expect(driver.terminate(sessionId)).rejects.toMatchObject({
      code: "internal_error",
      cause: { kind: "timeout" },
    });

    expect(fake.controls.closed()).toBe(true);
    expect(
      diagnostics
        .filter((input) => input.kind === "lifecycle")
        .map((input) => input.reason),
    ).toEqual(["initialized", "closed"]);
    expect(diagnostics.filter((input) => input.kind !== "lifecycle")).toEqual([
      expect.objectContaining({
        kind: "request_failure",
        operation: "kill",
        stage: "terminate",
        reason: "timeout",
      }),
    ]);
    await expect(driver.terminate(sessionId)).rejects.toMatchObject({
      code: "internal_error",
      cause: { kind: "timeout" },
    });
  });

  test("terminate 的 delete 拒绝关闭资源树但不能确认 kill", async () => {
    const { diagnostics, fake, driver } = await setup();
    await flush();
    fake.controls.setResponse(
      "thread/delete",
      Promise.reject(new Error("delete rejected")),
    );

    await expect(driver.terminate(sessionId)).rejects.toMatchObject({
      code: "internal_error",
      cause: { kind: "upstream" },
    });

    expect(fake.controls.closed()).toBe(true);
    expect(diagnostics.filter((input) => input.kind !== "lifecycle")).toEqual([
      expect.objectContaining({
        kind: "request_failure",
        operation: "kill",
        stage: "terminate",
        reason: "upstream_error",
      }),
    ]);
    expect(
      diagnostics
        .filter((input) => input.kind === "lifecycle")
        .map((input) => input.reason),
    ).toEqual(["initialized", "closed"]);
  });

  test("thread/delete 成功但 close 拒绝时也只记录一条 terminate 失败", async () => {
    const { diagnostics, fake, driver } = await setup();
    await flush();
    fake.controls.setCloseError(new Error("close rejected"));

    await expect(driver.terminate(sessionId)).rejects.toMatchObject({
      code: "internal_error",
      cause: { message: expect.stringContaining("close rejected") },
      effect: { kind: "session_closed", sessionId },
    });

    expect(diagnostics.filter((input) => input.kind !== "lifecycle")).toEqual([
      expect.objectContaining({
        kind: "request_failure",
        operation: "kill",
        stage: "terminate",
        reason: "upstream_error",
        message: expect.objectContaining({ text: "Error: close rejected" }),
      }),
    ]);

    fake.controls.setCloseError(undefined);
    await expect(driver.terminate(sessionId)).resolves.toBeUndefined();
    expect(
      diagnostics
        .filter((input) => input.kind === "lifecycle")
        .map((input) => input.reason),
    ).toEqual(["initialized", "closed"]);
  });

  test("真实 transport 已记录的 thread/delete protocol error 不在 terminate 重复记录", async () => {
    const { diagnostics, driver } =
      await setupWithMalformedResponse("thread/delete");
    await flush();

    await expect(driver.terminate(sessionId)).rejects.toMatchObject({
      code: "internal_error",
      cause: { kind: "upstream" },
    });

    expect(diagnostics.filter((input) => input.kind !== "lifecycle")).toEqual([
      expect.objectContaining({
        kind: "protocol_violation",
        operation: "validate_worker_response",
        reason: "invalid_shape",
      }),
    ]);
  });

  test("transport 关闭后新消息拒绝且不伪造新回合事实", async () => {
    const { events, fake, driver } = await setup();
    await flush();

    // 第一轮正常结束，随后传输关闭（等价于 codex 子进程退出）。
    fake.controls.pushInbound({
      kind: "notification",
      method: "turn/completed",
      params: { turn: { id: "turn1", status: "completed", error: null } },
    });
    await flush();
    fake.controls.end();

    await expect(
      driver.deliver(sessionId, secondTurnId, "继续", "new_turn"),
    ).rejects.toThrow("codex app-server closed");
    await flush();

    expect(
      events.filter(
        (event) =>
          event.type === "turn.completed" && event.turnId === secondTurnId,
      ),
    ).toEqual([]);
  });

  test("worker stream 读取异常只记录 read_error", async () => {
    const { diagnostics, events, fake } = await setup();
    await flush();

    fake.controls.fail(new Error("stdout read failed"));
    await flush();

    expect(diagnostics.filter((input) => input.kind !== "lifecycle")).toEqual([
      expect.objectContaining({
        kind: "stream_failure",
        operation: "receive_worker_stream",
        reason: "read_error",
      }),
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "turn.completed",
      stopReason: "failed",
    });
  });

  test("worker stream 自然 EOF 只记录 closed_unexpectedly", async () => {
    const { diagnostics, events, fake } = await setup();
    await flush();

    fake.controls.end();
    await flush();

    expect(
      diagnostics.filter(
        (input) =>
          input.kind === "lifecycle" && input.reason === "exited_unexpectedly",
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "lifecycle",
        operation: "worker",
        reason: "exited_unexpectedly",
      }),
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "turn.completed",
      stopReason: "failed",
    });
  });

  test("idle worker clean EOF 仍记录一次 exited_unexpectedly 且不伪造 turn", async () => {
    const { diagnostics, events, fake, driver } = await setup();
    await flush();
    fake.controls.pushInbound({
      kind: "notification",
      method: "turn/completed",
      params: { turn: { id: "turn1", status: "completed", error: null } },
    });
    await flush();
    const completedBeforeEof = events.filter(
      (event) => event.type === "turn.completed",
    ).length;

    fake.controls.end();
    await flush();

    expect(
      diagnostics.filter(
        (input) =>
          input.kind === "lifecycle" && input.reason === "exited_unexpectedly",
      ),
    ).toEqual([
      expect.objectContaining({
        operation: "worker",
        reason: "exited_unexpectedly",
      }),
    ]);
    expect(
      diagnostics.find(
        (input) =>
          input.kind === "lifecycle" && input.reason === "exited_unexpectedly",
      ),
    ).toMatchObject({
      message: expect.objectContaining({
        text: "worker stream ended unexpectedly while idle",
      }),
    });
    expect(
      diagnostics.find(
        (input) =>
          input.kind === "lifecycle" && input.reason === "exited_unexpectedly",
      ),
    ).not.toHaveProperty("turnId");
    expect(
      events.filter((event) => event.type === "turn.completed"),
    ).toHaveLength(completedBeforeEof);

    const requestsBeforeTerminate = fake.controls.requests().length;
    await expect(driver.terminate(sessionId)).rejects.toMatchObject({
      code: "internal_error",
      cause: { kind: "closed" },
    });
    expect(fake.controls.requests()).toHaveLength(requestsBeforeTerminate);
    expect(
      diagnostics
        .filter((input) => input.kind === "lifecycle")
        .map((input) => input.reason),
    ).toEqual(["initialized", "exited_unexpectedly"]);
  });
});
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

test("adapter rejects an out-of-menu answer without consuming the original native request", async () => {
  const { fake, driver } = await setup();
  await flush();
  fake.controls.pushInbound({
    kind: "request",
    id: 70,
    method: "item/commandExecution/requestApproval",
    input: {},
    availableDecisions: ["accept"],
    requestedPermissions: {},
  });
  await flush();
  expect(() =>
    driver.resolvePermission(sessionId, permissionId, {
      outcome: "deny",
      feedback: "caller only",
    }),
  ).toThrow(
    expect.objectContaining({ code: "permission_resolution_mismatch" }),
  );
  expect(fake.controls.responded()).toEqual([]);
  driver.resolvePermission(sessionId, permissionId, {
    outcome: "allow",
    scope: "once",
  });
  expect(fake.controls.responded()).toEqual([
    { id: 70, result: { decision: "accept" } },
  ]);
});

test("active_turn 等待原生 steer 接受并核对精确原生 TurnId", async () => {
  const { driver, fake } = await setup();
  await flush();
  let accept!: (ack: { turnId: string }) => void;
  fake.controls.setResponse(
    "turn/steer",
    new Promise<{ turnId: string }>((resolve) => {
      accept = resolve;
    }),
  );
  let settled = false;
  const delivering = Promise.resolve(
    driver.deliver(sessionId, firstTurnId, "caller active task", "active_turn"),
  ).then(() => {
    settled = true;
  });
  try {
    await flush();
    expect(fake.controls.requests().at(-1)).toEqual({
      method: "turn/steer",
      params: {
        threadId: "thr1",
        input: [
          { type: "text", text: "caller active task", text_elements: [] },
        ],
        expectedTurnId: "turn1",
      },
    });
    expect(settled).toBe(false);
  } finally {
    accept({ turnId: "turn1" });
  }
  await delivering;
  await driver.terminate(sessionId);
});

test("旧原生回合终态迟到不能结束新回合或改变 active_turn 目标", async () => {
  const { driver, fake, events } = await setup();
  await flush();
  fake.controls.pushInbound({
    kind: "notification",
    method: "turn/completed",
    params: { turn: { id: "turn1", status: "completed", error: null } },
  });
  await flush();
  await driver.deliver(sessionId, secondTurnId, "next caller task", "new_turn");
  fake.controls.pushInbound({
    kind: "notification",
    method: "turn/completed",
    params: { turn: { id: "turn1", status: "completed", error: null } },
  } as never);
  await flush();
  expect(
    events.filter((event) => event.type === "turn.completed"),
  ).toHaveLength(1);
  fake.controls.setResponse("turn/steer", { turnId: "turn2" });
  await driver.deliver(
    sessionId,
    secondTurnId,
    "active caller task",
    "active_turn",
  );
  expect(fake.controls.requests().at(-1)).toMatchObject({
    method: "turn/steer",
    params: { expectedTurnId: "turn2" },
  });
  await driver.terminate(sessionId);
});

test("原生拒绝的精确分类依据已观察终态，不依据自由文本", async () => {
  const { driver, fake } = await setup();
  await flush();
  const noActiveText = new CodexRequestError(
    '{"code":-32600,"message":"no active turn to steer"}',
  );
  fake.controls.setResponse("turn/steer", Promise.reject(noActiveText));
  await expect(
    driver.deliver(
      sessionId,
      firstTurnId,
      "rejected while target is unclassified",
      "active_turn",
    ),
  ).rejects.toBe(noActiveText);
  let reject!: (error: unknown) => void;
  fake.controls.setResponse(
    "turn/steer",
    new Promise<never>((_, fail) => {
      reject = fail;
    }),
  );
  const delivering = driver.deliver(
    sessionId,
    firstTurnId,
    "rejected after target ends",
    "active_turn",
  );
  await flush();
  fake.controls.pushInbound({
    kind: "notification",
    method: "turn/completed",
    params: { turn: { id: "turn1", status: "completed", error: null } },
  });
  await flush();
  reject(
    new CodexRequestError(
      '{"code":-32600,"message":"unclassified native refusal"}',
    ),
  );
  await expect(delivering).rejects.toMatchObject({
    code: "turn_not_active",
    sessionId,
    turnId: firstTurnId,
  });
  await driver.terminate(sessionId);
});
