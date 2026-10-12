import { CliWriteError } from "@ykdz/cli-contract";
import type {
  AgentFact,
  AgentSubscriptionEnd,
  FactSubscription,
  ReinsConnection,
  SessionHandle,
  TurnHandle,
} from "@ykdz/reins-sdk";
import { expect, test } from "vitest";

import { main, type CliRuntime } from "../../src/main.ts";

test("attach waits for each write before reading again and closes on writer failure", async () => {
  let nextCalls = 0;
  let subscriptionClosed = false;
  let connectionClosed = false;
  let resolveDone!: (end: AgentSubscriptionEnd) => void;
  const done = new Promise<AgentSubscriptionEnd>((resolve) => {
    resolveDone = resolve;
  });
  const target = {
    scope: "session" as const,
    sessionHandle: "session@g1" as SessionHandle,
  };
  const fact: AgentFact = {
    type: "turn.started",
    factId: "fact1_hash" as AgentFact["factId"],
    sessionHandle: target.sessionHandle,
    turnHandle: "turn1_hash" as TurnHandle,
  };
  const subscription: FactSubscription = {
    establishment: {
      target,
      window: { oldest: 1, head: 1, truncated: false },
      replayed: 0,
    },
    done,
    checkpoint: "resume1_hash" as FactSubscription["checkpoint"],
    async next() {
      nextCalls += 1;
      return { value: fact, done: false };
    },
    async return() {
      this.close();
      return { value: undefined, done: true };
    },
    async throw(error?: unknown) {
      this.close();
      throw error;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    close() {
      if (subscriptionClosed) return;
      subscriptionClosed = true;
      resolveDone({ target, reason: "closed" });
    },
  };
  const connection = {
    handshake: { protocolMajorVersion: 1, daemonGeneration: "g1" },
    async capabilities() {
      return { capabilities: [], failures: [] };
    },
    async list() {
      return [];
    },
    async attach() {
      return subscription;
    },
    close() {
      connectionClosed = true;
    },
  } satisfies ReinsConnection;

  let establishedAttempt!: () => void;
  const establishedWriteStarted = new Promise<void>((resolve) => {
    establishedAttempt = resolve;
  });
  let releaseEstablished!: () => void;
  const establishedWrite = new Promise<void>((resolve) => {
    releaseEstablished = resolve;
  });
  let factWriteStarted!: () => void;
  const factWriteAttempted = new Promise<void>((resolve) => {
    factWriteStarted = resolve;
  });
  let rejectFactWrite!: (error: Error) => void;
  const writeFailure = new Error("consumer stopped reading");
  const runtime: CliRuntime = {
    argv: [
      "node",
      "reins",
      "attach",
      target.sessionHandle,
      "--scope",
      "session",
      "--replay",
      "none",
    ],
    version: "test",
    dependencies: { connect: async () => connection },
    write(output) {
      const frame = JSON.parse(output.chunk) as {
        kind?: string;
        variant?: string;
      };
      if (frame.kind === "record" && frame.variant === "established") {
        establishedAttempt();
        return establishedWrite;
      }
      if (frame.kind === "record" && frame.variant === "fact") {
        factWriteStarted();
        return new Promise<void>((_resolve, reject) => {
          rejectFactWrite = reject;
        });
      }
      return Promise.resolve();
    },
  };

  const listenersBefore = process.listenerCount("SIGINT");
  const running = main(runtime);
  await establishedWriteStarted;
  expect(nextCalls).toBe(0);
  releaseEstablished();
  await factWriteAttempted;
  expect(nextCalls).toBe(1);
  rejectFactWrite(writeFailure);
  const failure = await running.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(CliWriteError);
  expect(failure).toMatchObject({
    destination: "stdout",
    cause: writeFailure,
  });
  expect(subscriptionClosed).toBe(true);
  expect(connectionClosed).toBe(true);
  expect(process.listenerCount("SIGINT")).toBe(listenersBefore);
});
