import { CliWriteError } from "@ykdz/cli-contract";
import type {
  AgentFact,
  AgentSubscriptionEnd,
  FactSubscription,
  KillInput,
  KillResult,
  OperationCredential,
  OperationKind,
  PermissionHandle,
  PermissionResolution,
  ReinsConnection,
  SessionHandle,
  SpawnInput,
  SpawnResult,
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
    async diagnostics() {
      return { records: [], truncated: false };
    },
    async attach() {
      return subscription;
    },
    prepareOperation<Kind extends OperationKind>(kind: Kind) {
      return `credential-${kind}` as OperationCredential<Kind>;
    },
    async spawn(
      _input: SpawnInput,
      _credential: OperationCredential<"spawn">,
    ): Promise<SpawnResult> {
      return {
        sessionHandle: target.sessionHandle,
        turnHandle: fact.turnHandle,
        cwd: "/tmp",
      };
    },
    async kill(
      input: KillInput,
      _credential: OperationCredential<"kill">,
    ): Promise<KillResult> {
      return { sessionHandle: input.sessionHandle, status: "killed" };
    },
    async resolvePermission(
      permissionHandle: PermissionHandle,
      _resolution: PermissionResolution,
    ) {
      return { permissionHandle, status: "resolved" as const };
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
    dependencies: {
      connect: async () => connection,
      readLine: async () => undefined,
    },
    cancelOutput() {},
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

test("SIGINT releases a blocked attach write and closes its connection", async () => {
  const sessionHandle = "session@g1" as SessionHandle;
  const target = { scope: "session" as const, sessionHandle };
  let subscriptionClosed = false;
  let connectionClosed = false;
  let cancelWriteCalled = false;
  let startEstablishedWrite!: () => void;
  const establishedWriteStarted = new Promise<void>((resolve) => {
    startEstablishedWrite = resolve;
  });
  let releaseEstablishedWrite!: () => void;
  const establishedWrite = new Promise<void>((resolve) => {
    releaseEstablishedWrite = resolve;
  });
  const subscription: FactSubscription = {
    establishment: {
      target,
      window: { oldest: 1, head: 1, truncated: false },
      replayed: 0,
    },
    done: Promise.resolve({ target, reason: "closed" }),
    checkpoint: "resume1_hash" as FactSubscription["checkpoint"],
    async next() {
      return { value: undefined, done: true };
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
      subscriptionClosed = true;
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
    async diagnostics() {
      return { records: [], truncated: false };
    },
    async attach() {
      return subscription;
    },
    prepareOperation<Kind extends OperationKind>(kind: Kind) {
      return `credential-${kind}` as OperationCredential<Kind>;
    },
    async spawn(
      _input: SpawnInput,
      _credential: OperationCredential<"spawn">,
    ): Promise<SpawnResult> {
      return {
        sessionHandle,
        turnHandle: "turn1_hash" as TurnHandle,
        cwd: "/tmp",
      };
    },
    async kill(
      input: KillInput,
      _credential: OperationCredential<"kill">,
    ): Promise<KillResult> {
      return { sessionHandle: input.sessionHandle, status: "killed" };
    },
    async resolvePermission(
      permissionHandle: PermissionHandle,
      _resolution: PermissionResolution,
    ) {
      return { permissionHandle, status: "resolved" as const };
    },
    close() {
      connectionClosed = true;
    },
  } satisfies ReinsConnection;
  const runtime: CliRuntime = {
    argv: [
      "node",
      "reins",
      "attach",
      sessionHandle,
      "--scope",
      "session",
      "--replay",
      "none",
    ],
    version: "test",
    dependencies: {
      connect: async () => connection,
      readLine: async () => undefined,
    },
    cancelOutput() {
      expect(subscriptionClosed).toBe(true);
      expect(connectionClosed).toBe(true);
      cancelWriteCalled = true;
      releaseEstablishedWrite();
    },
    write(output) {
      const frame = JSON.parse(output.chunk) as {
        kind?: string;
        variant?: string;
      };
      if (frame.kind === "record" && frame.variant === "established") {
        startEstablishedWrite();
        return establishedWrite;
      }
      return Promise.resolve();
    },
  };

  const listenersBefore = process.listenerCount("SIGINT");
  const running = main(runtime);
  try {
    await establishedWriteStarted;
    process.emit("SIGINT");
    const settled = await Promise.race([
      running.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);

    expect(settled).toBe(true);
    expect(cancelWriteCalled).toBe(true);
    expect(subscriptionClosed).toBe(true);
    expect(connectionClosed).toBe(true);
    await expect(running).resolves.toBe(0);
  } finally {
    releaseEstablishedWrite();
    await running;
  }
  expect(process.listenerCount("SIGINT")).toBe(listenersBefore);
});
