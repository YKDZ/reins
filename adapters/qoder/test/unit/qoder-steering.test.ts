import type { SDKMessage } from "@qodercn-ai/qodercn-agent-sdk";
import type { DomainEvent, SessionId, TurnId } from "@reins/protocol";
import { expect, test } from "vitest";

import { createQoderDriver } from "#/qoder-driver";

import { createFakeSdk } from "../helpers/fake-sdk.ts";

const sessionId =
  "session:00000000-0000-4000-8000-000000000000:steering:1" as SessionId;
const turnId = "turn-one" as TurnId;
const nativeSessionId = "00000000-0000-4000-8000-000000000001";
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const assistantToolUse = (id: string): SDKMessage => ({
  type: "assistant",
  message: {
    id: `assistant-${id}`,
    role: "assistant",
    content: [
      { type: "tool_use", id, name: "Bash", input: { command: "true" } },
    ],
    stop_reason: "tool_use",
  },
  parent_tool_use_id: null,
  uuid: `message-${id}`,
  session_id: nativeSessionId,
});

test("active_turn stops the exact input before queuing its continuation", async () => {
  const fake = createFakeSdk({ interrupt: async () => ({ still_queued: [] }) });
  const events: DomainEvent[] = [];
  const driver = createQoderDriver({ sdk: fake.sdk })({
    emit(event) {
      events.push(event);
    },
    diagnostics: async () => undefined,
  });

  try {
    await driver.start({
      sessionId,
      turnId,
      harness: "qoder",
      message: "initial request",
      cwd: "/tmp/qoder-steering",
    });
    const initial = fake.controls.delivered()[0];
    if (initial?.uuid === undefined)
      throw new Error("Qoder did not receive the initial input UUID");
    fake.controls.acknowledge(initial.uuid, "started");

    const continuation = driver
      .deliver(
        sessionId,
        turnId,
        "replace the unfinished request",
        "active_turn",
      )
      .then(
        () => ({ accepted: true as const }),
        (error: unknown) => ({ accepted: false as const, error }),
      );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fake.controls.interruptCount()).toBe(1);
    expect(fake.controls.delivered()).toHaveLength(1);

    fake.controls.acknowledge(initial.uuid, "cancelled");
    fake.controls.push({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["Operation aborted"],
      uuid: "result-initial",
      session_id: nativeSessionId,
    } as unknown as SDKMessage);

    expect(await continuation).toEqual({ accepted: true });
    const messages = fake.controls.delivered();
    expect(messages).toHaveLength(2);
    expect(messages[1]?.uuid).not.toBe(initial.uuid);
    expect(messages[1]?.message.content).toBe("replace the unfinished request");
    expect(events.filter((event) => event.type === "turn.completed")).toEqual(
      [],
    );
  } finally {
    await driver.terminate(sessionId);
  }
});

test("a stopped phase stays as a known effect when continuation acceptance is unknown", async () => {
  const fake = createFakeSdk({
    interrupt: async () => ({ still_queued: [] }),
    autoQueueAcceptance: false,
  });
  const events: DomainEvent[] = [];
  const driver = createQoderDriver({ sdk: fake.sdk })({
    emit(event) {
      events.push(event);
    },
    diagnostics: async () => undefined,
  });

  try {
    await driver.start({
      sessionId,
      turnId,
      harness: "qoder",
      message: "initial request",
      cwd: "/tmp/qoder-steering",
    });
    const initial = fake.controls.delivered()[0];
    if (initial?.uuid === undefined)
      throw new Error("Qoder did not receive the initial input UUID");
    fake.controls.acknowledge(initial.uuid, "started");

    const continuation = driver.deliver(
      sessionId,
      turnId,
      "continue after stopping",
      "active_turn",
    );
    await flush();
    fake.controls.acknowledge(initial.uuid, "cancelled");
    fake.controls.pushRaw({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      uuid: "cancelled-root-result",
      session_id: nativeSessionId,
    } as unknown as SDKMessage);
    await flush();

    const sent = fake.controls.delivered();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.uuid).not.toBe(initial.uuid);
    fake.controls.fail(new Error("transport closed before queue receipt"));

    await expect(continuation).rejects.toMatchObject({
      name: "WorkerDeliveryFailure",
      acceptance: "unknown",
      effect: {
        kind: "execution_phase_cancelled",
        sessionId,
        turnId,
      },
    });
    expect(fake.controls.delivered()).toHaveLength(2);
    expect(events.filter((event) => event.type === "turn.completed")).toEqual(
      [],
    );
  } finally {
    await driver.terminate(sessionId);
  }
});

test("provider failure after queued continuation does not undo acceptance", async () => {
  const fake = createFakeSdk({ interrupt: async () => ({ still_queued: [] }) });
  const events: DomainEvent[] = [];
  const driver = createQoderDriver({ sdk: fake.sdk })({
    emit(event) {
      events.push(event);
    },
    diagnostics: async () => undefined,
  });

  try {
    await driver.start({
      sessionId,
      turnId,
      harness: "qoder",
      message: "initial request",
      cwd: "/tmp/qoder-steering",
    });
    const initial = fake.controls.delivered()[0];
    if (initial?.uuid === undefined)
      throw new Error("Qoder did not receive the initial input UUID");
    fake.controls.acknowledge(initial.uuid, "started");

    const continuation = driver.deliver(
      sessionId,
      turnId,
      "continue after stopping",
      "active_turn",
    );
    await flush();
    fake.controls.acknowledge(initial.uuid, "cancelled");
    fake.controls.pushRaw({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      uuid: "cancelled-root-result",
      session_id: nativeSessionId,
    } as unknown as SDKMessage);
    await continuation;

    const accepted = fake.controls.delivered()[1];
    if (accepted?.uuid === undefined)
      throw new Error("Qoder did not receive the continuation input UUID");
    fake.controls.finish(accepted.uuid, {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      uuid: "continuation-provider-failure",
      session_id: nativeSessionId,
    } as unknown as SDKMessage);
    await flush();

    expect(
      events.filter((event) => event.type === "turn.completed"),
    ).toMatchObject([
      {
        type: "turn.completed",
        turnId,
        stopReason: "failed",
      },
    ]);
    expect(fake.controls.delivered()).toHaveLength(2);
  } finally {
    await driver.terminate(sessionId);
  }
});

test("a permission callback from a stopped root cannot enter its continuation", async () => {
  const fake = createFakeSdk({ interrupt: async () => ({ still_queued: [] }) });
  const events: DomainEvent[] = [];
  const driver = createQoderDriver({ sdk: fake.sdk })({
    emit(event) {
      events.push(event);
    },
    diagnostics: async () => undefined,
  });

  try {
    await driver.start({
      sessionId,
      turnId,
      harness: "qoder",
      message: "initial request",
      cwd: "/tmp/qoder-steering",
      authorizationMode: "interactive",
    });
    const initial = fake.controls.delivered()[0];
    if (initial?.uuid === undefined)
      throw new Error("Qoder did not receive the initial input UUID");
    fake.controls.pushRaw(assistantToolUse("tool-before-steer"));
    await flush();
    const callback = fake.controls.lastOptions()?.canUseTool;
    if (callback === undefined)
      throw new Error("Qoder did not register canUseTool");
    const oldPermission = callback(
      "Bash",
      { command: "true" },
      {
        signal: new AbortController().signal,
        toolUseID: "tool-before-steer",
      },
    );
    await flush();

    const continuation = driver.deliver(
      sessionId,
      turnId,
      "replace the unfinished request",
      "active_turn",
    );
    await flush();
    fake.controls.acknowledge(initial.uuid, "cancelled");
    fake.controls.pushRaw({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["Operation aborted"],
      uuid: "result-initial",
      session_id: nativeSessionId,
    } as unknown as SDKMessage);
    await continuation;

    await expect(oldPermission).rejects.toThrow(
      "Qoder execution phase ended before permission resolution",
    );
    await expect(
      callback(
        "Bash",
        { command: "stale" },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-before-steer",
        },
      ),
    ).rejects.toThrow(
      "Qoder permission callback belongs to a closed input root",
    );
    expect(
      events.filter((event) => event.type === "permission.requested"),
    ).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn.completed")).toEqual(
      [],
    );
    expect(fake.controls.delivered()).toHaveLength(2);
  } finally {
    await driver.terminate(sessionId);
  }
});

test("a permission callback can arrive before its assistant tool-use message", async () => {
  const fake = createFakeSdk({ interrupt: async () => ({ still_queued: [] }) });
  const events: DomainEvent[] = [];
  const driver = createQoderDriver({ sdk: fake.sdk })({
    emit(event) {
      events.push(event);
    },
    diagnostics: async () => undefined,
  });

  try {
    await driver.start({
      sessionId,
      turnId,
      harness: "qoder",
      message: "initial request",
      cwd: "/tmp/qoder-steering",
      authorizationMode: "interactive",
    });
    const initial = fake.controls.delivered()[0];
    if (initial?.uuid === undefined)
      throw new Error("Qoder did not receive the initial input UUID");
    fake.controls.acknowledge(initial.uuid, "started");
    const callback = fake.controls.lastOptions()?.canUseTool;
    if (callback === undefined)
      throw new Error("Qoder did not register canUseTool");

    const permission = callback(
      "Bash",
      { command: "true" },
      {
        signal: new AbortController().signal,
        toolUseID: "tool-before-assistant-message",
      },
    );
    await flush();
    expect(
      events.filter((event) => event.type === "permission.requested"),
    ).toHaveLength(0);

    fake.controls.pushRaw(assistantToolUse("tool-before-assistant-message"));
    await flush();
    const requested = events.find(
      (event) => event.type === "permission.requested",
    );
    expect(requested?.type).toBe("permission.requested");
    if (requested?.type !== "permission.requested")
      throw new Error(
        "Qoder did not expose permission after its tool-use owner",
      );
    expect(
      driver.resolvePermission(sessionId, requested.permissionId, {
        outcome: "allow",
        scope: "once",
      }),
    ).toBeUndefined();
    await expect(permission).resolves.toMatchObject({ behavior: "allow" });

    const lateSignal = new AbortController();
    const latePermission = callback(
      "Bash",
      { command: "stale" },
      {
        signal: lateSignal.signal,
        toolUseID: "late-tool-use-from-closed-phase",
      },
    );
    await flush();
    expect(
      events.filter((event) => event.type === "permission.requested"),
    ).toHaveLength(1);

    const continuation = driver.deliver(
      sessionId,
      turnId,
      "replace the unfinished request",
      "active_turn",
    );
    await flush();
    fake.controls.acknowledge(initial.uuid, "cancelled");
    fake.controls.pushRaw({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["Operation aborted"],
      uuid: "result-initial",
      session_id: nativeSessionId,
    } as unknown as SDKMessage);
    await continuation;

    await expect(latePermission).rejects.toThrow(
      "Qoder permission callback belongs to a closed input root",
    );
    // 原生控制请求取消时，SDK 会中止对应回调。
    lateSignal.abort();
    fake.controls.pushRaw(assistantToolUse("late-tool-use-from-closed-phase"));
    await flush();
    await expect(
      callback(
        "Bash",
        { command: "stale" },
        {
          signal: lateSignal.signal,
          toolUseID: "late-tool-use-from-closed-phase",
        },
      ),
    ).rejects.toThrow("Qoder permission request was aborted");
    expect(
      events.filter((event) => event.type === "permission.requested"),
    ).toHaveLength(1);
    expect(fake.controls.delivered()).toHaveLength(2);
  } finally {
    await driver.terminate(sessionId);
  }
});

test.each([false, true])(
  "a natural root completion wins before correction dispatch (lifecycleFirst=%s)",
  async (lifecycleFirst) => {
    const fake = createFakeSdk({
      interrupt: async () => ({ still_queued: [] }),
    });
    const events: DomainEvent[] = [];
    const driver = createQoderDriver({ sdk: fake.sdk })({
      emit(event) {
        events.push(event);
      },
      diagnostics: async () => undefined,
    });

    try {
      await driver.start({
        sessionId,
        turnId,
        harness: "qoder",
        message: "initial request",
        cwd: "/tmp/qoder-steering",
      });
      const initial = fake.controls.delivered()[0];
      if (initial?.uuid === undefined)
        throw new Error("Qoder did not receive the initial input UUID");
      fake.controls.acknowledge(initial.uuid, "started");

      const correction = driver.deliver(
        sessionId,
        turnId,
        "late correction",
        "active_turn",
      );
      await flush();
      fake.controls.finish(
        initial.uuid,
        {
          type: "result",
          subtype: "success",
          is_error: false,
          stop_reason: "end_turn",
          result: "NATURAL_DONE",
          uuid: "natural-result",
          session_id: nativeSessionId,
        } as unknown as SDKMessage,
        lifecycleFirst,
      );

      await expect(correction).rejects.toMatchObject({
        code: "turn_not_active",
        turnId,
      });
      expect(fake.controls.interruptCount()).toBe(1);
      expect(fake.controls.delivered()).toHaveLength(1);
      expect(events.filter((event) => event.type === "turn.completed")).toEqual(
        [
          {
            type: "turn.completed",
            sessionId,
            turnId,
            stopReason: "end_turn",
            finalReply: null,
          },
        ],
      );
    } finally {
      await driver.terminate(sessionId);
    }
  },
);

test.each([false, true])(
  "natural completion wins a false exact-queue cancellation (lifecycleFirst=%s)",
  async (lifecycleFirst) => {
    let rootUuid: string | undefined;
    let interruptCalls = 0;
    let fake!: ReturnType<typeof createFakeSdk>;
    fake = createFakeSdk({
      interrupt: async () => {
        interruptCalls += 1;
        return { still_queued: [rootUuid!] };
      },
      cancelAsyncMessage: async (uuid) => {
        if (uuid !== rootUuid) return false;
        fake.controls.finish(
          uuid,
          {
            type: "result",
            subtype: "success",
            is_error: false,
            stop_reason: "end_turn",
            result: "NATURAL_DONE",
            uuid: `natural-result-${lifecycleFirst}`,
            session_id: nativeSessionId,
          } as unknown as SDKMessage,
          lifecycleFirst,
        );
        await flush();
        await flush();
        return false;
      },
      cancelAsyncLifecycle: false,
    });
    const events: DomainEvent[] = [];
    const driver = createQoderDriver({ sdk: fake.sdk })({
      emit(event) {
        events.push(event);
      },
      diagnostics: async () => undefined,
    });

    try {
      await driver.start({
        sessionId,
        turnId,
        harness: "qoder",
        message: "initial request",
        cwd: "/tmp/qoder-steering",
      });
      const initial = fake.controls.delivered()[0];
      if (initial?.uuid === undefined)
        throw new Error("Qoder did not receive the initial input UUID");
      rootUuid = initial.uuid;

      await expect(
        driver.deliver(
          sessionId,
          turnId,
          "do not send after natural completion",
          "active_turn",
        ),
      ).rejects.toMatchObject({ code: "turn_not_active", turnId });

      expect(interruptCalls).toBe(1);
      expect(fake.controls.cancelAsyncCount()).toBe(1);
      expect(fake.controls.delivered()).toHaveLength(1);
      expect(events.filter((event) => event.type === "turn.completed")).toEqual(
        [
          {
            type: "turn.completed",
            sessionId,
            turnId,
            stopReason: "end_turn",
            finalReply: null,
          },
        ],
      );
    } finally {
      await driver.terminate(sessionId);
    }
  },
);

test("active steering cancels only the exact queued root before continuation", async () => {
  let queuedUuid: string | undefined;
  const fake = createFakeSdk({
    interrupt: async () => ({ still_queued: [queuedUuid!] }),
    cancelAsyncMessage: async (uuid) => uuid === queuedUuid,
    cancelAsyncLifecycle: false,
  });
  const events: DomainEvent[] = [];
  const driver = createQoderDriver({ sdk: fake.sdk })({
    emit(event) {
      events.push(event);
    },
    diagnostics: async () => undefined,
  });

  try {
    await driver.start({
      sessionId,
      turnId,
      harness: "qoder",
      message: "initial request",
      cwd: "/tmp/qoder-steering",
    });
    queuedUuid = fake.controls.delivered()[0]?.uuid;
    if (queuedUuid === undefined)
      throw new Error("Qoder did not receive the initial input UUID");

    const continuation = driver.deliver(
      sessionId,
      turnId,
      "correction after queue cancellation",
      "active_turn",
    );
    await flush();
    expect(fake.controls.cancelAsyncCount()).toBe(1);
    await continuation;

    expect(fake.controls.delivered()).toHaveLength(2);
    expect(fake.controls.delivered()[1]?.uuid).not.toBe(queuedUuid);
    expect(fake.controls.delivered()[1]?.message.content).toBe(
      "correction after queue cancellation",
    );
    expect(events.filter((event) => event.type === "turn.completed")).toEqual(
      [],
    );
  } finally {
    await driver.terminate(sessionId);
  }
});

test("active steering stops a root that starts before exact queue cancellation", async () => {
  let queuedUuid: string | undefined;
  let interruptCalls = 0;
  let fake!: ReturnType<typeof createFakeSdk>;
  fake = createFakeSdk({
    interrupt: async () => {
      interruptCalls += 1;
      return interruptCalls === 1
        ? { still_queued: [queuedUuid!] }
        : { still_queued: [] };
    },
    cancelAsyncMessage: async (uuid) => {
      if (uuid !== queuedUuid) return false;
      fake.controls.acknowledge(uuid, "started");
      await flush();
      return false;
    },
    cancelAsyncLifecycle: false,
  });
  const events: DomainEvent[] = [];
  const driver = createQoderDriver({ sdk: fake.sdk })({
    emit(event) {
      events.push(event);
    },
    diagnostics: async () => undefined,
  });

  try {
    await driver.start({
      sessionId,
      turnId,
      harness: "qoder",
      message: "initial request",
      cwd: "/tmp/qoder-steering",
    });
    const initial = fake.controls.delivered()[0];
    if (initial?.uuid === undefined)
      throw new Error("Qoder did not receive the initial input UUID");
    queuedUuid = initial.uuid;

    const continuation = driver
      .deliver(
        sessionId,
        turnId,
        "continue only after stopping the exact root",
        "active_turn",
      )
      .then(
        () => ({ accepted: true as const }),
        (error: unknown) => ({ accepted: false as const, error }),
      );
    for (let attempt = 0; attempt < 5 && interruptCalls < 2; attempt += 1)
      await flush();

    expect(interruptCalls).toBe(2);
    expect(fake.controls.cancelAsyncCount()).toBe(1);
    expect(fake.controls.delivered()).toHaveLength(1);

    fake.controls.acknowledge(initial.uuid, "cancelled");
    fake.controls.pushRaw({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["Operation aborted"],
      uuid: "cancelled-after-start-result",
      session_id: nativeSessionId,
    } as unknown as SDKMessage);
    expect(await continuation).toEqual({ accepted: true });

    expect(fake.controls.delivered()).toHaveLength(2);
    expect(fake.controls.delivered()[1]?.message.content).toBe(
      "continue only after stopping the exact root",
    );
    expect(events.filter((event) => event.type === "turn.completed")).toEqual(
      [],
    );
  } finally {
    await driver.terminate(sessionId);
  }
});

test("interrupt retries stop against the exact root after queue cancellation loses the race", async () => {
  let rootUuid: string | undefined;
  let interruptCalls = 0;
  let fake!: ReturnType<typeof createFakeSdk>;
  fake = createFakeSdk({
    interrupt: async () => {
      interruptCalls += 1;
      return interruptCalls === 1
        ? { still_queued: [rootUuid!] }
        : { still_queued: [] };
    },
    cancelAsyncMessage: async (uuid) => {
      if (uuid !== rootUuid) return false;
      fake.controls.acknowledge(uuid, "started");
      await flush();
      return false;
    },
    cancelAsyncLifecycle: false,
  });
  const events: DomainEvent[] = [];
  const driver = createQoderDriver({ sdk: fake.sdk })({
    emit(event) {
      events.push(event);
    },
    diagnostics: async () => undefined,
  });

  try {
    await driver.start({
      sessionId,
      turnId,
      harness: "qoder",
      message: "initial request",
      cwd: "/tmp/qoder-steering",
    });
    const initial = fake.controls.delivered()[0];
    if (initial?.uuid === undefined)
      throw new Error("Qoder did not receive the initial input UUID");
    rootUuid = initial.uuid;

    const interrupt = driver.interrupt(sessionId, turnId).then(
      () => ({ accepted: true as const }),
      (error: unknown) => ({ accepted: false as const, error }),
    );
    for (let attempt = 0; attempt < 5 && interruptCalls < 2; attempt += 1)
      await flush();

    expect(interruptCalls).toBe(2);
    expect(fake.controls.cancelAsyncCount()).toBe(1);
    expect(await interrupt).toEqual({ accepted: true });
    expect(events.filter((event) => event.type === "turn.completed")).toEqual(
      [],
    );

    fake.controls.acknowledge(initial.uuid, "cancelled");
    fake.controls.pushRaw({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["Operation aborted"],
      uuid: "interrupt-cancelled-after-start-result",
      session_id: nativeSessionId,
    } as unknown as SDKMessage);
    await flush();

    expect(events.filter((event) => event.type === "turn.completed")).toEqual([
      {
        type: "turn.completed",
        sessionId,
        turnId,
        stopReason: "cancelled",
        finalReply: null,
      },
    ]);
  } finally {
    await driver.terminate(sessionId);
  }
});

test("interrupt keeps acceptance unknown when stopping a started root cannot be confirmed", async () => {
  let rootUuid: string | undefined;
  let interruptCalls = 0;
  let fake!: ReturnType<typeof createFakeSdk>;
  fake = createFakeSdk({
    interrupt: async () => {
      interruptCalls += 1;
      if (interruptCalls === 1) return { still_queued: [rootUuid!] };
      throw new Error("control stream closed");
    },
    cancelAsyncMessage: async (uuid) => {
      if (uuid !== rootUuid) return false;
      fake.controls.acknowledge(uuid, "started");
      await flush();
      return false;
    },
    cancelAsyncLifecycle: false,
  });
  const events: DomainEvent[] = [];
  const driver = createQoderDriver({ sdk: fake.sdk })({
    emit(event) {
      events.push(event);
    },
    diagnostics: async () => undefined,
  });

  try {
    await driver.start({
      sessionId,
      turnId,
      harness: "qoder",
      message: "initial request",
      cwd: "/tmp/qoder-steering",
    });
    const initial = fake.controls.delivered()[0];
    if (initial?.uuid === undefined)
      throw new Error("Qoder did not receive the initial input UUID");
    rootUuid = initial.uuid;

    const interrupt = driver.interrupt(sessionId, turnId).then(
      () => ({ accepted: true as const }),
      (error: unknown) => ({ accepted: false as const, error }),
    );
    for (let attempt = 0; attempt < 5 && interruptCalls < 2; attempt += 1)
      await flush();

    expect(interruptCalls).toBe(2);
    expect(await interrupt).toMatchObject({
      accepted: false,
      error: { name: "WorkerInterruptFailure", acceptance: "unknown" },
    });
    expect(events.filter((event) => event.type === "turn.completed")).toEqual(
      [],
    );

    fake.controls.finish(initial.uuid);
    await flush();
    expect(
      events.filter((event) => event.type === "turn.completed"),
    ).toMatchObject([{ turnId, stopReason: "end_turn" }]);
  } finally {
    await driver.terminate(sessionId);
  }
});

test("an unowned queued UUID keeps a cancelled phase partial and blocks a new turn", async () => {
  let queuedUuid: string | undefined;
  const unownedUuid = "00000000-0000-4000-8000-000000000099";
  const fake = createFakeSdk({
    interrupt: async () => ({ still_queued: [queuedUuid!, unownedUuid] }),
    cancelAsyncMessage: async (uuid) => uuid === queuedUuid,
    cancelAsyncLifecycle: false,
  });
  const events: DomainEvent[] = [];
  const driver = createQoderDriver({ sdk: fake.sdk })({
    emit(event) {
      events.push(event);
    },
    diagnostics: async () => undefined,
  });

  try {
    await driver.start({
      sessionId,
      turnId,
      harness: "qoder",
      message: "initial request",
      cwd: "/tmp/qoder-steering",
    });
    queuedUuid = fake.controls.delivered()[0]?.uuid;
    if (queuedUuid === undefined)
      throw new Error("Qoder did not receive the initial input UUID");

    await expect(
      driver.deliver(
        sessionId,
        turnId,
        "correction with unowned queue state",
        "active_turn",
      ),
    ).rejects.toMatchObject({
      name: "WorkerDeliveryFailure",
      acceptance: "unknown",
      effect: {
        kind: "execution_phase_cancelled",
        sessionId,
        turnId,
      },
    });

    await expect(
      driver.deliver(
        sessionId,
        "turn-two" as TurnId,
        "independent turn",
        "new_turn",
      ),
    ).rejects.toMatchObject({ code: "turn_not_active" });
    expect(fake.controls.cancelAsyncCount()).toBe(1);
    expect(fake.controls.delivered()).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn.completed")).toEqual(
      [],
    );
  } finally {
    await driver.terminate(sessionId);
  }
});

test("concurrent corrections stay in one Reins turn and block a new turn", async () => {
  const fake = createFakeSdk({ interrupt: async () => ({ still_queued: [] }) });
  const events: DomainEvent[] = [];
  const driver = createQoderDriver({ sdk: fake.sdk })({
    emit(event) {
      events.push(event);
    },
    diagnostics: async () => undefined,
  });

  try {
    await driver.start({
      sessionId,
      turnId,
      harness: "qoder",
      message: "initial request",
      cwd: "/tmp/qoder-steering",
    });
    const firstRoot = fake.controls.delivered()[0]?.uuid;
    if (firstRoot === undefined)
      throw new Error("Qoder did not receive the initial input UUID");

    const first = driver.deliver(
      sessionId,
      turnId,
      "first correction",
      "active_turn",
    );
    await flush();
    const second = driver.deliver(
      sessionId,
      turnId,
      "second correction",
      "active_turn",
    );
    const nextTurn = driver.deliver(
      sessionId,
      "turn-two" as TurnId,
      "independent turn",
      "new_turn",
    );
    fake.controls.acknowledge(firstRoot, "cancelled");
    fake.controls.pushRaw({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["Operation aborted"],
      uuid: "first-root-cancelled",
      session_id: nativeSessionId,
    } as unknown as SDKMessage);
    await first;
    await flush();
    const secondRoot = fake.controls.delivered()[1]?.uuid;
    if (secondRoot === undefined)
      throw new Error("Qoder did not receive the first correction");
    expect(fake.controls.interruptCount()).toBe(2);

    fake.controls.acknowledge(secondRoot, "cancelled");
    fake.controls.pushRaw({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["Operation aborted"],
      uuid: "second-root-cancelled",
      session_id: nativeSessionId,
    } as unknown as SDKMessage);
    await second;
    await expect(nextTurn).rejects.toMatchObject({ code: "turn_not_active" });

    const thirdRoot = fake.controls.delivered()[2]?.uuid;
    if (thirdRoot === undefined)
      throw new Error("Qoder did not receive the second correction");
    await driver.interrupt(sessionId, turnId);
    fake.controls.acknowledge(thirdRoot, "cancelled");
    fake.controls.pushRaw({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["Operation aborted"],
      uuid: "third-root-cancelled",
      session_id: nativeSessionId,
    } as unknown as SDKMessage);
    await flush();

    expect(fake.controls.delivered()).toHaveLength(3);
    expect(
      fake.controls.delivered().map((message) => message.message.content),
    ).toEqual(["initial request", "first correction", "second correction"]);
    expect(
      events.filter((event) => event.type === "turn.completed"),
    ).toMatchObject([
      { type: "turn.completed", turnId, stopReason: "cancelled" },
    ]);
  } finally {
    await driver.terminate(sessionId);
  }
});
