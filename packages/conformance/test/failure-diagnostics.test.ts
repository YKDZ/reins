import { createReinsClient, type AgentEvent } from "@reins/client";
import { openEphemeralDaemonForTest } from "@reins/daemon/testing";
import type { ConsumerContext, SessionName } from "@reins/protocol";
import { createQoderCapabilities, createQoderDriver } from "@reins/qoder";
import {
  createQoderFixtureSdk,
  loadRecordedQoderFixture,
} from "@reins/qoder/testing";
import { expect, test } from "vitest";

test("capabilities 保留部分成功，私有失败文本只在有限诊断查询中出现", async () => {
  const sdk = createQoderFixtureSdk([]);
  const daemon = await openEphemeralDaemonForTest({
    adapters: new Map([
      [
        "working",
        {
          driverFactory: createQoderDriver({ sdk }),
          capabilities: async () => ({
            harness: "working",
            models: [
              {
                id: "explicit-model",
                displayName: "Working",
                reasoningEfforts: [],
              },
            ],
          }),
        },
      ],
      [
        "qoder",
        {
          driverFactory: createQoderDriver({ sdk }),
          capabilities: createQoderCapabilities({
            ...sdk,
            async getAvailableModels() {
              throw new Error(
                "private credential quota exhausted rate limit text",
              );
            },
          }),
        },
      ],
    ]),
  });
  const client = createReinsClient(daemon.connect(), {
    consumerContext: "reins-wrr19-capabilities" as ConsumerContext,
  });
  try {
    await client.initialize();
    const result = await client.request("capabilities", {});
    expect(result).toMatchObject({
      result: {
        capabilities: [
          { harness: "working", models: [{ id: "explicit-model" }] },
        ],
        failures: [
          {
            harness: "qoder",
            failure: {
              failureCategory: "unclassified",
              retryDisposition: "unknown",
            },
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain("private credential");
    if ("error" in result) throw new Error(JSON.stringify(result.error));
    const diagnosticId = result.result.failures[0]?.diagnosticId;
    expect(diagnosticId).toBeDefined();
    expect(
      await client.request("diagnostics", { diagnosticId: diagnosticId! }),
    ).toMatchObject({
      result: {
        record: {
          diagnosticId,
          kind: "request_failure",
          harness: "qoder",
          message: { text: expect.stringContaining("private credential") },
        },
      },
    });
    expect(
      await client.request("diagnostics", {
        kinds: ["request_failure"],
        limit: 1,
      }),
    ).toMatchObject({
      result: {
        records: [expect.objectContaining({ diagnosticId })],
        truncated: false,
      },
    });
    expect(await client.request("diagnostics", { limit: 1_001 })).toMatchObject(
      { error: { code: "invalid_params" } },
    );
  } finally {
    client.close();
    await daemon.close();
  }
});

test.each(["rejected", "hung", "late"] as const)(
  "诊断 %s 不阻止真实失败，不降级已知限流或返回不可接受引用",
  async (mode) => {
    const recording = await loadRecordedQoderFixture("two-tools");
    const assistant = recording.messages.find(
      (message) => message.type === "assistant",
    );
    if (assistant?.type !== "assistant")
      throw new Error("Missing recorded assistant");
    const sdk = createQoderFixtureSdk([
      {
        ...assistant,
        isApiErrorMessage: true,
        error: "rate_limit",
        message: { ...assistant.message, content: [] },
      },
    ]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const daemon = await openEphemeralDaemonForTest({
      adapters: new Map([
        [
          "qoder",
          {
            capabilities: async () => ({ harness: "qoder", models: [] }),
            driverFactory: (context) =>
              createQoderDriver({ sdk })({
                ...context,
                diagnostics: async (fact) => {
                  if (fact.kind !== "turn_failure")
                    return await context.diagnostics(fact);
                  if (mode === "rejected")
                    throw new Error("Store write rejected");
                  const accepted =
                    mode === "late"
                      ? await context.diagnostics(fact)
                      : undefined;
                  await gate;
                  return accepted;
                },
              }),
          },
        ],
      ]),
    });
    const client = createReinsClient(daemon.connect(), {
      consumerContext: ("reins-wrr19-diagnostic-" + mode) as ConsumerContext,
    });
    try {
      await client.initialize();
      const spawn = await client.request("spawn", {
        harness: "qoder",
        cwd: "/tmp",
        sessionName: ("reins-wrr19-" + mode) as SessionName,
        message: "caller supplied task",
      });
      if ("error" in spawn) throw new Error(JSON.stringify(spawn.error));
      const target = {
        sessionId: spawn.result.sessionId,
        turnId: spawn.result.turnId,
      };
      const wait = await client.request("wait", {
        targets: [target],
        completion: "all",
        timeoutMs: 1_000,
      });
      expect(wait).toMatchObject({
        result: {
          status: "satisfied",
          completed: [
            {
              ...target,
              stopReason: "failed",
              failure: {
                failureCategory: "rate_limited",
                retryDisposition: "wait",
              },
            },
          ],
          pending: [],
        },
      });
      if ("error" in wait) throw new Error(JSON.stringify(wait.error));
      expect(wait.result.completed[0]).not.toHaveProperty("diagnosticId");
      release();
      expect(
        await client.request("wait", {
          targets: [target],
          completion: "all",
          timeoutMs: 0,
        }),
      ).toEqual(expect.objectContaining({ result: wait.result }));
      expect(await client.request("list", {})).toMatchObject({
        result: [{ state: "idle" }],
      });
    } finally {
      release();
      client.close();
      await daemon.close();
    }
  },
);

test("结构化限流优先于含额度字样的正文，诊断引用在返回时可查", async () => {
  const recording = await loadRecordedQoderFixture("two-tools");
  const assistant = recording.messages.find(
    (message) => message.type === "assistant",
  );
  if (assistant?.type !== "assistant")
    throw new Error("Missing recorded assistant");
  const sdk = createQoderFixtureSdk([
    {
      ...assistant,
      isApiErrorMessage: true,
      error: "rate_limit",
      message: {
        ...assistant.message,
        content: [
          { type: "text", text: "quota exhausted credentials invalid" },
        ],
      },
    },
  ]);
  const daemon = await openEphemeralDaemonForTest({
    adapters: new Map([
      [
        "qoder",
        {
          driverFactory: createQoderDriver({ sdk }),
          capabilities: async () => ({ harness: "qoder", models: [] }),
        },
      ],
    ]),
  });
  const client = createReinsClient(daemon.connect(), {
    consumerContext: "reins-wrr19-classified" as ConsumerContext,
  });
  try {
    await client.initialize();
    const spawn = await client.request("spawn", {
      harness: "qoder",
      cwd: "/tmp",
      sessionName: "reins-wrr19-rate" as SessionName,
      message: "explicit caller task",
    });
    if ("error" in spawn) throw new Error(JSON.stringify(spawn.error));
    const wait = await client.request("wait", {
      targets: [
        { sessionId: spawn.result.sessionId, turnId: spawn.result.turnId },
      ],
      completion: "all",
      timeoutMs: 1_000,
    });
    expect(wait).toMatchObject({
      result: {
        completed: [
          {
            failure: {
              failureCategory: "rate_limited",
              retryDisposition: "wait",
            },
          },
        ],
      },
    });
    if ("error" in wait) throw new Error(JSON.stringify(wait.error));
    const diagnosticId = wait.result.completed[0]?.diagnosticId;
    expect(diagnosticId).toBeDefined();
    const subscription = await client.subscribe({
      scope: "turn",
      sessionId: spawn.result.sessionId,
      turnId: spawn.result.turnId,
      replay: { mode: "available" },
    });
    const events: AgentEvent[] = [];
    subscription.onEvent((event) => events.push(event));
    expect(await subscription.done).toMatchObject({ reason: "failed" });
    const completed = events.filter((event) => event.type === "turn.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      stopReason: "failed",
      failure: { failureCategory: "rate_limited", retryDisposition: "wait" },
      diagnosticId,
      turnHandle: expect.any(String),
      sessionHandle: spawn.result.sessionId,
    });
    expect(completed[0]).not.toHaveProperty("turnId");
    expect(completed[0]).not.toHaveProperty("subscriptionId");
    const query = await client.request("diagnostics", {
      diagnosticId: diagnosticId!,
    });
    expect(query).toMatchObject({
      result: {
        record: {
          diagnosticId,
          sessionId: spawn.result.sessionId,
          turnId: spawn.result.turnId,
          kind: "turn_failure",
        },
      },
    });
  } finally {
    client.close();
    await daemon.close();
  }
});

test("原生失败经 daemon 与 client wait 保留未知原因和显式重试处置", async () => {
  const recording = await loadRecordedQoderFixture("two-tools");
  const result = recording.messages.at(-1);
  if (result?.type !== "result") throw new Error("Missing recorded result");
  const sdk = createQoderFixtureSdk([{ ...result, is_error: true }]);
  const daemon = await openEphemeralDaemonForTest({
    adapters: new Map([
      [
        "qoder",
        {
          driverFactory: createQoderDriver({ sdk }),
          capabilities: async () => ({ harness: "qoder", models: [] }),
        },
      ],
    ]),
  });
  const client = createReinsClient(daemon.connect(), {
    consumerContext: "reins-wrr19-failure" as ConsumerContext,
  });
  try {
    await client.initialize();
    const spawned = await client.request("spawn", {
      harness: "qoder",
      cwd: "/tmp",
      sessionName: "reins-wrr19-failed" as SessionName,
      message: "caller supplied fixture task",
    });
    if ("error" in spawned) throw new Error(JSON.stringify(spawned.error));
    const waited = await client.request("wait", {
      targets: [
        { sessionId: spawned.result.sessionId, turnId: spawned.result.turnId },
      ],
      completion: "all",
      timeoutMs: 1_000,
    });
    expect(waited).toMatchObject({
      result: {
        status: "satisfied",
        completed: [
          {
            stopReason: "failed",
            failure: {
              failureCategory: "unclassified",
              retryDisposition: "unknown",
            },
          },
        ],
        pending: [],
      },
    });
  } finally {
    client.close();
    await daemon.close();
  }
});
