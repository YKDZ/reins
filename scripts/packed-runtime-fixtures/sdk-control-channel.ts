import {
  connect,
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
  const connection = await connect({
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

async function main(): Promise<void> {
  const target = JSON.parse(
    required("REINS_CONTROL_RUNTIME_TARGET"),
  ) as ControlRuntimeTarget;
  try {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    let openedAfterAbort = false;
    try {
      await connect({
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

    const openingAbort = new AbortController();
    let markOpeningStarted = (): void => {};
    const openingStarted = new Promise<void>((resolve) => {
      markOpeningStarted = resolve;
    });
    const openingChildCount = children.length;
    const opening = connect({
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
