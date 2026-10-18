import {
  connect,
  openControl,
  parseRuntimeScopeId,
  ReinsSdkError,
  type ControlByteChannel,
  type ControlChannelOpener,
  type ControlRuntimeTarget,
  type ReinsConnection,
} from "@ykdz/reins-sdk";

declare const process: {
  env: Record<string, string | undefined>;
  stdout: { write(value: string): void };
  getBuiltinModule(name: string): unknown;
};

type ChildInput = {
  readonly writableEnded: boolean;
  write(bytes: Uint8Array, callback: (error?: Error | null) => void): boolean;
  end(callback?: () => void): void;
  once(event: "error", listener: (error: Error) => void): ChildInput;
  removeListener(event: "error", listener: (error: Error) => void): ChildInput;
};

type ChildProcess = {
  readonly stdin: ChildInput;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  once(event: "spawn", listener: () => void): ChildProcess;
  once(event: "error", listener: (error: Error) => void): ChildProcess;
  once(
    event: "exit",
    listener: (exitCode: number | null, signal: string | null) => void,
  ): ChildProcess;
  removeListener(event: "spawn", listener: () => void): ChildProcess;
  removeListener(
    event: "error",
    listener: (error: Error) => void,
  ): ChildProcess;
  kill(signal?: string): boolean;
};

type ChildProcessModule = {
  spawn(
    command: string,
    args: string[],
    options: {
      env: Record<string, string | undefined>;
      stdio: ["pipe", "pipe", "pipe"];
    },
  ): ChildProcess;
};

const childProcess = process.getBuiltinModule(
  "node:child_process",
) as ChildProcessModule;
const children: ChildProcess[] = [];
const childTerminations: Promise<{
  exitCode: number | null;
  signal: string | null;
}>[] = [];
const channels: ControlByteChannel[] = [];
const diagnosticTasks = new Map<ControlByteChannel, Promise<number>>();
const connections: ReinsConnection[] = [];

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "")
    throw new Error(`The installed byte-channel fixture needs ${name}`);
  return value;
}

function abortError(): Error {
  const error = new Error("The control target open was aborted");
  error.name = "AbortError";
  return error;
}

function drainDiagnostics(channel: ControlByteChannel): Promise<number> {
  return (async () => {
    let totalBytes = 0;
    for await (const bytes of channel.diagnostics) totalBytes += bytes.length;
    return totalBytes;
  })();
}

async function openTarget(
  target: ControlRuntimeTarget,
  signal: AbortSignal,
): Promise<ControlByteChannel> {
  if (signal.aborted) throw abortError();
  const child = childProcess.spawn(target.command, [...target.args], {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  const terminated = new Promise<{
    exitCode: number | null;
    signal: string | null;
  }>((resolve) => {
    child.once("exit", (exitCode, signalName) =>
      resolve({ exitCode, signal: signalName }),
    );
  });
  childTerminations.push(terminated);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onError);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve();
      else reject(error);
    };
    const onSpawn = (): void => finish();
    const onError = (error: Error): void => finish(error);
    const onAbort = (): void => {
      child.kill("SIGTERM");
      finish(abortError());
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  const channel: ControlByteChannel = {
    readable: child.stdout,
    diagnostics: child.stderr,
    async write(bytes) {
      if (child.stdin.writableEnded)
        throw new Error("The target control input is closed");
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          child.stdin.removeListener("error", onError);
          reject(error);
        };
        child.stdin.once("error", onError);
        child.stdin.write(bytes, (error) => {
          child.stdin.removeListener("error", onError);
          if (error == null) resolve();
          else reject(error);
        });
      });
    },
    close() {
      if (child.stdin.writableEnded) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const onError = (error: Error): void => {
          child.stdin.removeListener("error", onError);
          reject(error);
        };
        child.stdin.once("error", onError);
        child.stdin.end(() => {
          child.stdin.removeListener("error", onError);
          resolve();
        });
      });
    },
    terminated,
  };
  channels.push(channel);
  diagnosticTasks.set(channel, drainDiagnostics(channel));
  return channel;
}

type ConnectedTarget = {
  readonly connection: ReinsConnection;
  readonly channel: ControlByteChannel;
};

async function connectTarget(
  target: ControlRuntimeTarget,
): Promise<ConnectedTarget> {
  let channel: ControlByteChannel | undefined;
  const openControlChannel: ControlChannelOpener = async (
    runtimeTarget,
    signal,
  ) => {
    channel = await openTarget(runtimeTarget, signal);
    return channel;
  };
  const connection = await openControl({
    consumerContext: "packed-byte-consumer",
    runtimeTarget: target,
    openControlChannel,
  });
  connections.push(connection);
  if (channel === undefined) throw new Error("The SDK did not open a channel");
  return { connection, channel };
}

async function waitForTermination(
  terminated: Promise<{ exitCode: number | null; signal: string | null }>,
): Promise<{ exitCode: number | null; signal: string | null }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("The control target did not terminate")),
        5_000,
      );
    });
    return await Promise.race([terminated, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForExit(
  channel: ControlByteChannel,
): Promise<{ exitCode: number | null; signal: string | null }> {
  return waitForTermination(channel.terminated);
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function wireResponse(
  request: {
    readonly requestId: string;
    readonly method: string;
    readonly params?: { readonly protocolMajorVersion?: number };
  },
  result: unknown,
): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify({ kind: "response", requestId: request.requestId, result })}\n`,
  );
}

function handshakeChannel(runtimeScopeId: string): ControlByteChannel {
  const responseBytes = deferred<Uint8Array>();
  const termination = deferred<{
    exitCode: number | null;
    signal: string | null;
  }>();
  return {
    readable: (async function* () {
      yield await responseBytes.promise;
    })(),
    diagnostics: (async function* () {})(),
    async write(bytes) {
      const request = JSON.parse(new TextDecoder().decode(bytes)) as {
        requestId: string;
        method: string;
        params?: { protocolMajorVersion?: number };
      };
      if (request.method === "initialize")
        responseBytes.resolve(
          wireResponse(request, {
            protocolMajorVersion: request.params?.protocolMajorVersion,
            daemonGeneration: "ab12cd",
            runtimeScopeId,
          }),
        );
    },
    async close() {
      termination.resolve({ exitCode: 0, signal: null });
    },
    terminated: termination.promise,
  };
}

async function verifyRuntimeScopeRequired(
  target: ControlRuntimeTarget,
): Promise<void> {
  let openedWithoutScope = false;
  const targetWithoutScope = { ...target } as Record<string, unknown>;
  delete targetWithoutScope.runtimeScopeId;
  try {
    const connection = await openControl({
      consumerContext: "packed-byte-consumer",
      runtimeTarget: targetWithoutScope as unknown as ControlRuntimeTarget,
      openControlChannel: async () => {
        openedWithoutScope = true;
        return handshakeChannel(target.runtimeScopeId);
      },
    });
    connection.close();
    throw new Error("An injected target without runtime scope was accepted");
  } catch (error) {
    if (
      !(error instanceof ReinsSdkError) ||
      error.failure.code !== "runtime_scope_invalid" ||
      error.stage !== "connect"
    )
      throw error;
  }
  if (openedWithoutScope)
    throw new Error("An incomplete injected target opened a byte channel");
}

async function verifyMixedSocketAndTargetRejected(
  target: ControlRuntimeTarget,
): Promise<void> {
  let openedMixedConnection = false;
  try {
    await connect({
      consumerContext: "packed-byte-consumer",
      socketPath: `${required("REINS_SOCKET")}.invalid-mixed-config`,
      runtimeTarget: target,
      openControlChannel: async () => {
        openedMixedConnection = true;
        return handshakeChannel(target.runtimeScopeId);
      },
    } as never);
    throw new Error("A mixed socket and injected connection was accepted");
  } catch (error) {
    if (
      !(error instanceof ReinsSdkError) ||
      error.failure.code !== "invalid_params" ||
      error.stage !== "connect"
    )
      throw error;
  }
  if (openedMixedConnection)
    throw new Error("A mixed connection opened its injected byte channel");

  let openedSocketOnInjectedEntry = false;
  try {
    await openControl({
      consumerContext: "packed-byte-consumer",
      socketPath: `${required("REINS_SOCKET")}.invalid-mixed-config`,
      runtimeTarget: target,
      openControlChannel: async () => {
        openedSocketOnInjectedEntry = true;
        return handshakeChannel(target.runtimeScopeId);
      },
    } as never);
    throw new Error("The injected entry accepted a mixed socket configuration");
  } catch (error) {
    if (
      !(error instanceof ReinsSdkError) ||
      error.failure.code !== "invalid_params" ||
      error.stage !== "connect"
    )
      throw error;
  }
  if (openedSocketOnInjectedEntry)
    throw new Error(
      "The injected entry ignored its mixed socket configuration",
    );
}

async function verifyAbortClosesBlockedWrite(
  target: ControlRuntimeTarget,
): Promise<void> {
  const writeStarted = deferred<void>();
  const releaseWrite = deferred<void>();
  const readableEnd = deferred<void>();
  const closed = deferred<void>();
  const termination = deferred<{
    exitCode: number | null;
    signal: string | null;
  }>();
  let closeCalls = 0;
  const channel: ControlByteChannel = {
    readable: (async function* () {
      await readableEnd.promise;
      yield new Uint8Array(0);
    })(),
    diagnostics: (async function* () {})(),
    async write(_bytes) {
      writeStarted.resolve(undefined);
      await releaseWrite.promise;
    },
    async close() {
      closeCalls += 1;
      releaseWrite.resolve(undefined);
      readableEnd.resolve(undefined);
      termination.resolve({ exitCode: 0, signal: null });
      closed.resolve(undefined);
    },
    terminated: termination.promise,
  };
  const controller = new AbortController();
  const result = openControl({
    consumerContext: "packed-byte-consumer",
    runtimeTarget: target,
    signal: controller.signal,
    openControlChannel: async () => channel,
  }).then(
    () => undefined,
    (error: unknown) => error,
  );

  await writeStarted.promise;
  controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closeStarted: boolean;
  try {
    closeStarted = await Promise.race([
      closed.promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 300);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (!closeStarted) {
    await channel.close();
    await result;
    throw new Error(
      "Abort waited for a blocked write before closing the channel",
    );
  }
  const error = await result;
  if (!(error instanceof Error) || error.name !== "AbortError")
    throw new Error("A blocked-write cancellation did not return AbortError");
  if (closeCalls !== 1)
    throw new Error(
      "Abort did not close the blocked byte channel exactly once",
    );
}

async function verifyExitDrainsTailResponse(
  target: ControlRuntimeTarget,
): Promise<void> {
  const handshakeBytes = deferred<Uint8Array>();
  const tailResponseBytes = deferred<Uint8Array>();
  const readableEnd = deferred<void>();
  const termination = deferred<{
    exitCode: number | null;
    signal: string | null;
  }>();
  let closeCalls = 0;
  const channel: ControlByteChannel = {
    readable: (async function* () {
      yield await handshakeBytes.promise;
      yield await tailResponseBytes.promise;
      await readableEnd.promise;
    })(),
    diagnostics: (async function* () {})(),
    async write(bytes) {
      const request = JSON.parse(new TextDecoder().decode(bytes)) as {
        requestId: string;
        method: string;
        params?: { protocolMajorVersion?: number };
      };
      if (request.method === "initialize")
        handshakeBytes.resolve(
          wireResponse(request, {
            protocolMajorVersion: request.params?.protocolMajorVersion,
            daemonGeneration: "ab12cd",
            runtimeScopeId: target.runtimeScopeId,
          }),
        );
      else if (request.method === "list") {
        tailResponseBytes.resolve(wireResponse(request, []));
        termination.resolve({ exitCode: 1, signal: null });
        throw new Error("The target exited after accepting the request bytes");
      }
    },
    async close() {
      closeCalls += 1;
      readableEnd.resolve(undefined);
    },
    terminated: termination.promise,
  };
  const connection = await openControl({
    consumerContext: "packed-byte-consumer",
    runtimeTarget: target,
    openControlChannel: async () => channel,
  });
  try {
    const sessions = await connection.list();
    if (sessions.length !== 0)
      throw new Error("The buffered response before process exit was lost");
    if (closeCalls === 0)
      throw new Error("Target termination did not close the byte channel");
    const pendingAfterExit = connection.list().then(
      () => false,
      () => true,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectedAfterExit: boolean;
    try {
      rejectedAfterExit = await Promise.race([
        pendingAfterExit,
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 300);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (!rejectedAfterExit)
      throw new Error("A request remained pending after target termination");
  } finally {
    connection.close();
  }
}

async function main(): Promise<void> {
  const target = JSON.parse(
    required("REINS_CONTROL_RUNTIME_TARGET"),
  ) as ControlRuntimeTarget;
  try {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    let openedAfterAbort = false;
    try {
      await openControl({
        consumerContext: "packed-byte-consumer",
        runtimeTarget: target,
        signal: alreadyAborted.signal,
        openControlChannel: async () => {
          openedAfterAbort = true;
          throw new Error("A pre-aborted connection opened the target");
        },
      });
      throw new Error("A pre-aborted connection unexpectedly succeeded");
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "AbortError") throw error;
    }
    if (openedAfterAbort)
      throw new Error("Abort did not cancel target opening");

    const regressionFailures: string[] = [];
    for (const [name, verify] of [
      ["required runtime scope", () => verifyRuntimeScopeRequired(target)],
      [
        "mutually exclusive socket configuration",
        () => verifyMixedSocketAndTargetRejected(target),
      ],
      ["abort of blocked writes", () => verifyAbortClosesBlockedWrite(target)],
      [
        "tail response after target exit",
        () => verifyExitDrainsTailResponse(target),
      ],
    ] as const) {
      try {
        await verify();
      } catch (error) {
        regressionFailures.push(
          `${name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (regressionFailures.length > 0)
      throw new Error(
        `Control channel regressions: ${regressionFailures.join("; ")}`,
      );

    const openingAbort = new AbortController();
    let markOpeningStarted = (): void => {};
    const openingStarted = new Promise<void>((resolve) => {
      markOpeningStarted = resolve;
    });
    const openingChildCount = children.length;
    const opening = openControl({
      consumerContext: "packed-byte-consumer",
      runtimeTarget: target,
      signal: openingAbort.signal,
      openControlChannel: async (runtimeTarget, signal) => {
        markOpeningStarted();
        return openTarget(runtimeTarget, signal);
      },
    });
    await openingStarted;
    openingAbort.abort();
    try {
      await opening;
      throw new Error("An in-progress target open ignored cancellation");
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "AbortError") throw error;
    }
    if (children.length !== openingChildCount + 1)
      throw new Error("Cancellation did not exercise a running target process");
    const canceledTermination = await waitForTermination(
      childTerminations.at(-1)!,
    );
    if (
      canceledTermination.exitCode === null &&
      canceledTermination.signal === null
    )
      throw new Error("The canceled target did not report its termination");

    const [first, second] = await Promise.all([
      connectTarget(target),
      connectTarget(target),
    ]);
    if (
      first.connection.handshake.runtimeScopeId !== target.runtimeScopeId ||
      second.connection.handshake.runtimeScopeId !== target.runtimeScopeId
    )
      throw new Error(
        "The action connections did not handshake with the target scope",
      );

    const spawned = await first.connection.spawn(
      {
        harness: "codex",
        sessionLabel: "packed-control-channel-session",
        message: "control through the public byte channel",
        cwd: required("REINS_WORKER_CWD"),
      },
      first.connection.prepareOperation("spawn"),
    );
    const observed = await second.connection.list({
      sessionHandle: spawned.sessionHandle,
    });
    if (observed.length !== 1 || observed[0]?.state !== "busy")
      throw new Error("The second byte connection did not observe the session");

    first.connection.close();
    const firstTermination = await waitForExit(first.channel);
    const stillPresent = await second.connection.list({
      sessionHandle: spawned.sessionHandle,
    });
    if (
      firstTermination.exitCode !== 0 ||
      firstTermination.signal !== null ||
      stillPresent.length !== 1
    )
      throw new Error("Closing a byte channel closed the runtime session");

    second.connection.close();
    const secondTermination = await waitForExit(second.channel);
    const third = await connectTarget(target);
    const reconnected = await third.connection.list({
      sessionHandle: spawned.sessionHandle,
    });
    if (
      secondTermination.exitCode !== 0 ||
      secondTermination.signal !== null ||
      reconnected.length !== 1 ||
      reconnected[0]?.state !== "busy"
    )
      throw new Error("Reconnect did not preserve the action session");

    await third.connection.kill(
      { sessionHandle: spawned.sessionHandle },
      third.connection.prepareOperation("kill"),
    );
    const completed = await third.connection.wait({
      targets: [spawned.turnHandle],
      completion: "all",
    });
    if (
      completed.status !== "satisfied" ||
      completed.completed[0]?.stopReason !== "killed"
    )
      throw new Error("The byte-channel session did not complete after kill");
    third.connection.close();
    const thirdTermination = await waitForExit(third.channel);
    const diagnosticBytes = await Promise.all(
      channels.map((channel) => diagnosticTasks.get(channel)!),
    );
    if (
      thirdTermination.exitCode !== 0 ||
      thirdTermination.signal !== null ||
      diagnosticBytes.some((count) => count !== 0)
    )
      throw new Error(
        "The stdio control entry mixed diagnostics into the protocol",
      );

    const mismatchTarget = {
      ...target,
      runtimeScopeId: parseRuntimeScopeId(
        "00000000-0000-4000-8000-000000000001",
      ),
    };
    let mismatchChannel: ControlByteChannel | undefined;
    try {
      let mismatchConnection: ReinsConnection | undefined;
      try {
        const mismatch = await connectTarget(mismatchTarget);
        mismatchConnection = mismatch.connection;
        mismatchChannel = mismatch.channel;
      } finally {
        mismatchConnection?.close();
      }
      throw new Error("The SDK accepted a target with the wrong runtime scope");
    } catch (error) {
      if (
        !(error instanceof ReinsSdkError) ||
        error.failure.code !== "runtime_scope_mismatch" ||
        error.stage !== "handshake"
      )
        throw error;
      mismatchChannel = channels.at(-1);
    }
    if (mismatchChannel !== undefined) {
      const mismatchTermination = await waitForExit(mismatchChannel);
      if (mismatchTermination.signal !== null)
        throw new Error(
          "A rejected scope handshake left a control entry running",
        );
    }

    process.stdout.write(
      `${JSON.stringify({
        status: "byte-channel-accepted",
        channelCount: channels.length,
        openedAfterAbort,
        sessionSurvivedClose: true,
        sessionSurvivedReconnect: true,
        scopeMismatch: "handshake",
        diagnosticsWereSeparate: true,
      })}\n`,
    );
  } finally {
    for (const connection of connections) connection.close();
    await Promise.all(
      channels.map((channel) => channel.close().catch(() => undefined)),
    );
    for (const child of children) child.kill("SIGTERM");
    await Promise.all(
      channels.map((channel) => waitForExit(channel).catch(() => undefined)),
    );
  }
}

await main();
