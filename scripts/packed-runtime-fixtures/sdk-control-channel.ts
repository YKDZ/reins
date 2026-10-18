import {
  connect,
  openControl,
  parseOperationKey,
  parseRuntimeScopeId,
  parseResumeCursor,
  ReinsSdkError,
  serializeOperationKey,
  serializeResumeCursor,
  type ControlByteChannel,
  type ControlChannelOpener,
  type ControlRuntimeTarget,
  type OperationKey,
  type ReinsConnection,
  type ResumeCursor,
  type SessionHandle,
  type TurnHandle,
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
  once(event: "drain", listener: () => void): ChildInput;
  removeListener(event: "error", listener: (error: Error) => void): ChildInput;
  removeListener(event: "drain", listener: () => void): ChildInput;
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

type FileSystemModule = {
  existsSync(path: string): boolean;
  writeFileSync(path: string, contents: string, encoding: "utf8"): void;
};

type ChannelAdapterOptions = {
  readonly env?: Record<string, string | undefined>;
  readonly dropResponseFor?: string;
  readonly onRequestWritten?: (method: string) => void;
  readonly onResponseDropped?: () => void;
  readonly onWriteBackpressure?: (method: string | undefined) => void;
  readonly onWriteDrain?: (method: string | undefined) => void;
};

const childProcess = process.getBuiltinModule(
  "node:child_process",
) as ChildProcessModule;
const fileSystem = process.getBuiltinModule("node:fs") as FileSystemModule;
const children: ChildProcess[] = [];
const childTerminations: Promise<{
  exitCode: number | null;
  signal: string | null;
}>[] = [];
const channels: ControlByteChannel[] = [];
const diagnosticTasks = new Map<
  ControlByteChannel,
  Promise<{ byteLength: number; text: string }>
>();
const connections: ReinsConnection[] = [];
let fragmentedFrameCount = 0;

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

function drainDiagnostics(
  channel: ControlByteChannel,
): Promise<{ byteLength: number; text: string }> {
  return (async () => {
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    for await (const bytes of channel.diagnostics) {
      chunks.push(bytes);
      byteLength += bytes.length;
    }
    const output = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return { byteLength, text: new TextDecoder().decode(output) };
  })();
}

async function openTarget(
  target: ControlRuntimeTarget,
  signal: AbortSignal,
  options: ChannelAdapterOptions = {},
): Promise<ControlByteChannel> {
  if (signal.aborted) throw abortError();
  let droppedRequestId: string | undefined;
  const child = childProcess.spawn(target.command, [...target.args], {
    env: options.env ?? process.env,
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
    readable: (async function* () {
      let pending = new Uint8Array();
      const emitFrame = function* (frame: Uint8Array) {
        for (let offset = 0; offset < frame.length; offset += 7) {
          const end = Math.min(offset + 7, frame.length);
          if (end - offset < frame.length) fragmentedFrameCount += 1;
          yield frame.slice(offset, end);
        }
      };
      for await (const bytes of child.stdout) {
        const combined = new Uint8Array(pending.length + bytes.length);
        combined.set(pending);
        combined.set(bytes, pending.length);
        pending = combined;
        let newlineIndex: number;
        while ((newlineIndex = pending.indexOf(0x0a)) !== -1) {
          const frame = pending.slice(0, newlineIndex + 1);
          pending = pending.slice(newlineIndex + 1);
          let dropped = false;
          if (droppedRequestId !== undefined) {
            try {
              const message = JSON.parse(new TextDecoder().decode(frame)) as {
                readonly requestId?: string;
              };
              if (message.requestId === droppedRequestId) {
                droppedRequestId = undefined;
                options.onResponseDropped?.();
                if (!child.stdin.writableEnded) child.stdin.end();
                dropped = true;
              }
            } catch {
              // 协议帧由 SDK 校验；消费者适配器只用于丢弃指定请求的响应。
            }
          }
          if (!dropped) yield* emitFrame(frame);
        }
      }
      if (pending.length > 0) yield* emitFrame(pending);
    })(),
    diagnostics: child.stderr,
    async write(bytes) {
      if (child.stdin.writableEnded)
        throw new Error("The target control input is closed");
      let requestMethod: string | undefined;
      if (options.dropResponseFor !== undefined) {
        try {
          const request = JSON.parse(new TextDecoder().decode(bytes)) as {
            readonly requestId?: string;
            readonly method?: string;
          };
          requestMethod = request.method;
          if (request.method !== undefined)
            options.onRequestWritten?.(request.method);
          if (
            request.method === options.dropResponseFor &&
            request.requestId !== undefined
          )
            droppedRequestId = request.requestId;
        } catch {
          // 消费者只检查完整请求；未知字节仍原样交给正式控制入口。
        }
      } else {
        try {
          const request = JSON.parse(new TextDecoder().decode(bytes)) as {
            readonly method?: string;
          };
          requestMethod = request.method;
          if (request.method !== undefined)
            options.onRequestWritten?.(request.method);
        } catch {
          // 非请求帧仍原样交给正式控制入口。
        }
      }
      let resolveDrain!: () => void;
      let rejectDrain!: (error: Error) => void;
      const drain = new Promise<void>((resolve, reject) => {
        resolveDrain = resolve;
        rejectDrain = reject;
      });
      const onDrain = (): void => {
        child.stdin.removeListener("error", onDrainError);
        resolveDrain();
      };
      const onDrainError = (error: Error): void => {
        child.stdin.removeListener("drain", onDrain);
        rejectDrain(error);
      };
      child.stdin.once("drain", onDrain);
      child.stdin.once("error", onDrainError);
      let needsDrain = false;
      const written = new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          child.stdin.removeListener("error", onError);
          reject(error);
        };
        child.stdin.once("error", onError);
        let writable: boolean;
        try {
          writable = child.stdin.write(bytes, (error) => {
            child.stdin.removeListener("error", onError);
            if (error == null) resolve();
            else reject(error);
          });
        } catch (error) {
          child.stdin.removeListener("error", onError);
          child.stdin.removeListener("drain", onDrain);
          child.stdin.removeListener("error", onDrainError);
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (writable) {
          child.stdin.removeListener("drain", onDrain);
          child.stdin.removeListener("error", onDrainError);
          resolveDrain();
        } else {
          needsDrain = true;
          options.onWriteBackpressure?.(requestMethod);
        }
      });
      await Promise.all([written, drain]);
      if (needsDrain) options.onWriteDrain?.(requestMethod);
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
  options?: ChannelAdapterOptions,
): Promise<ConnectedTarget> {
  let channel: ControlByteChannel | undefined;
  const openControlChannel: ControlChannelOpener = async (
    runtimeTarget,
    signal,
  ) => {
    channel = await openTarget(runtimeTarget, signal, options);
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

async function verifyProcessPipeBackpressure(
  target: ControlRuntimeTarget,
): Promise<void> {
  const pressuredMethods: (string | undefined)[] = [];
  const drainedMethods: (string | undefined)[] = [];
  const opened = await connectTarget(target, {
    onWriteBackpressure: (method) => pressuredMethods.push(method),
    onWriteDrain: (method) => drainedMethods.push(method),
  });
  const gate = required("REINS_PACKED_CHANNEL_BACKPRESSURE_GATE");
  fileSystem.writeFileSync(gate, "released", "utf8");
  const spawned = await opened.connection.spawn(
    {
      harness: "qoder",
      sessionLabel: "packed-channel-pipe-backpressure",
      message: JSON.stringify({
        gate,
        messages: 0,
        reply: "x".repeat(256 * 1024),
      }),
      cwd: required("REINS_WORKER_CWD"),
    },
    { operationKey: opened.connection.prepareOperation("spawn") },
  );
  const completed = await opened.connection.wait({
    targets: [spawned.turnHandle],
    completion: "all",
  });
  if (
    !pressuredMethods.includes("spawn") ||
    !drainedMethods.includes("spawn") ||
    completed.status !== "satisfied" ||
    completed.completed[0]?.stopReason !== "end_turn"
  )
    throw new Error("实际子进程 stdin 未触发背压、排空并完成正式操作");
  opened.connection.close();
  const termination = await waitForExit(opened.channel);
  if (termination.exitCode !== 0 || termination.signal !== null)
    throw new Error("实际进程 pipe 背压场景未正常关闭");
}

async function verifyBridgeFailureDiagnostics(
  target: ControlRuntimeTarget,
): Promise<ControlByteChannel> {
  const failureEnvironment = {
    ...process.env,
    REINS_SOCKET: required("REINS_CONTROL_FAILURE_SOCKET"),
    REINS_STATE_DIR: required("REINS_CONTROL_FAILURE_STATE"),
    REINS_DAEMON_BIN: "/bin/false",
  };
  let failure: unknown;
  try {
    await connectTarget(target, { env: failureEnvironment });
  } catch (error) {
    failure = error;
  }
  const channel = channels.at(-1);
  if (channel === undefined) throw new Error("失败的控制入口没有打开进程");
  const termination = await waitForExit(channel);
  const diagnostic = await diagnosticTasks.get(channel)!;
  if (
    !(failure instanceof ReinsSdkError) ||
    failure.failure.code !== "daemon_disconnected" ||
    failure.stage !== "handshake" ||
    termination.exitCode !== 1 ||
    termination.signal !== null ||
    diagnostic.byteLength === 0 ||
    !diagnostic.text.includes("Reins control entry failed")
  )
    throw new Error("stdio 控制入口失败未独立送达诊断并收束进程");
  return channel;
}

async function verifyOperationAndCursorRecovery(
  target: ControlRuntimeTarget,
): Promise<{
  readonly operationKey: OperationKey<"spawn">;
  readonly sessionHandle: SessionHandle;
  readonly turnHandle: TurnHandle;
  readonly cursor: ResumeCursor;
}> {
  const gate = required("REINS_PACKED_CHANNEL_FACT_GATE");
  if (fileSystem.existsSync(gate))
    throw new Error("通道恢复事实闸门必须从未释放状态开始");
  const droppedResponse = deferred<void>();
  let spawnRequests = 0;
  const first = await connectTarget(target, {
    dropResponseFor: "spawn",
    onRequestWritten(method) {
      if (method === "spawn") spawnRequests += 1;
    },
    onResponseDropped: () => droppedResponse.resolve(undefined),
  });
  const operationKey = parseOperationKey(
    serializeOperationKey(first.connection.prepareOperation("spawn")),
    "spawn",
  );
  const input = {
    harness: "qoder" as const,
    sessionLabel: "packed-channel-recovery",
    message: JSON.stringify({ gate, messages: 2, reply: "channel recovery" }),
    cwd: required("REINS_WORKER_CWD"),
  };
  let unknown: unknown;
  try {
    await first.connection.spawn(input, { operationKey });
  } catch (error) {
    unknown = error;
  }
  await droppedResponse.promise;
  const termination = await waitForExit(first.channel);
  if (
    !(unknown instanceof ReinsSdkError) ||
    unknown.failure.code !== "operation_outcome_unknown" ||
    unknown.failure.facts.operationKey !== operationKey ||
    spawnRequests !== 1 ||
    termination.exitCode !== 0 ||
    termination.signal !== null
  )
    throw new Error("实际进程丢失 spawn 响应后未保留原操作未知事实");

  const reconnected = await connectTarget(target);
  const operation = await reconnected.connection.getOperation(operationKey);
  if (operation.status !== "succeeded")
    throw new Error("重连未从同一控制存储恢复原 spawn 操作");
  const spawned = operation.result;
  const [busy] = await reconnected.connection.list({
    sessionHandle: spawned.sessionHandle,
  });
  if (busy?.state !== "busy")
    throw new Error("控制入口退出被误报为原生会话停止");

  fileSystem.writeFileSync(gate, "released", "utf8");
  let completed = false;
  const deadline = Date.now() + 5_000;
  while (!completed && Date.now() < deadline) {
    const [session] = await reconnected.connection.list({
      sessionHandle: spawned.sessionHandle,
    });
    completed = session?.state === "idle";
    if (!completed)
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  if (!completed) throw new Error("通道恢复事实场景没有完成");

  const targetTurn = {
    scope: "turn" as const,
    turnHandle: spawned.turnHandle,
  };
  const subscription = await reconnected.connection.attach(targetTurn, {
    mode: "history",
  });
  const acknowledged: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const item = await subscription.next();
    if (item.done) throw new Error("游标前缀缺少已提交控制事实");
    acknowledged.push(item.value.type);
    subscription.acknowledge(item.value);
  }
  const checkpoint = parseResumeCursor(
    serializeResumeCursor(subscription.checkpoint),
  );
  const unacknowledged = await subscription.next();
  if (
    unacknowledged.done ||
    unacknowledged.value.type !== "message" ||
    JSON.stringify(acknowledged) !== JSON.stringify(["turn.started", "message"])
  )
    throw new Error(
      `游标确认前缀或未确认事实与正式轨迹不符：${JSON.stringify({ acknowledged, unacknowledged })}`,
    );
  reconnected.connection.close();
  const disconnect = await subscription.done.then(
    () => undefined,
    (error: unknown) => error,
  );
  subscription.close();
  if (
    !(disconnect instanceof ReinsSdkError) ||
    disconnect.failure.code !== "daemon_disconnected" ||
    disconnect.failure.facts.resumeCursor !== checkpoint
  )
    throw new Error("通道断开没有返回最后已确认事实的游标");

  const resumed = await connectTarget(target);
  const continued = await resumed.connection.attach(targetTurn, {
    mode: "after",
    cursor: checkpoint,
  });
  const replayed: string[] = [];
  let replayedUnacknowledged = false;
  try {
    for (;;) {
      const item = await continued.next();
      if (item.done) break;
      replayed.push(item.value.type);
      if (
        item.value.type === "message" &&
        item.value.factId === unacknowledged.value.factId
      )
        replayedUnacknowledged = true;
      continued.acknowledge(item.value);
    }
    const end = await continued.done;
    if (
      end.reason !== "end_turn" ||
      !replayedUnacknowledged ||
      JSON.stringify(replayed) !==
        JSON.stringify(["message", "message", "turn.completed"])
    )
      throw new Error(
        `重连未从确认游标重放相同未确认事实并续接尾部：${JSON.stringify({ end, replayed, replayedUnacknowledged, unacknowledged: unacknowledged.value })}`,
      );
  } finally {
    continued.close();
    resumed.connection.close();
  }
  const resumedTermination = await waitForExit(resumed.channel);
  if (resumedTermination.exitCode !== 0 || resumedTermination.signal !== null)
    throw new Error("恢复游标后的控制进程未正常退出");
  return {
    operationKey,
    sessionHandle: spawned.sessionHandle,
    turnHandle: spawned.turnHandle,
    cursor: checkpoint,
  };
}

async function verifyOtherTargetRejectsOldIdentity(
  target: ControlRuntimeTarget,
  recovered: {
    readonly operationKey: OperationKey<"spawn">;
    readonly sessionHandle: SessionHandle;
    readonly turnHandle: TurnHandle;
    readonly cursor: ResumeCursor;
  },
): Promise<void> {
  const otherTarget = JSON.parse(
    required("REINS_CONTROL_OTHER_TARGET"),
  ) as ControlRuntimeTarget;
  if (
    otherTarget.runtimeScopeId === target.runtimeScopeId ||
    otherTarget.command !== target.command ||
    JSON.stringify(otherTarget.args) !== JSON.stringify(target.args)
  )
    throw new Error("错目标场景没有复用相同入口并绑定不同运行作用域");
  const otherEnvironment = {
    ...process.env,
    REINS_SOCKET: required("REINS_CONTROL_OTHER_SOCKET"),
    REINS_STATE_DIR: required("REINS_CONTROL_OTHER_STATE"),
    REINS_DAEMON_BIN: required("REINS_CONTROL_OTHER_DAEMON_BIN"),
  };
  const other = await connectTarget(otherTarget, { env: otherEnvironment });
  try {
    let operationFailure: unknown;
    try {
      await other.connection.getOperation(recovered.operationKey);
    } catch (error) {
      operationFailure = error;
    }
    if (
      !(operationFailure instanceof ReinsSdkError) ||
      operationFailure.failure.code !== "operation_key_scope_mismatch"
    )
      throw new Error("错目标接受了旧作用域的操作标识");

    let handleFailure: unknown;
    try {
      await other.connection.attach(
        { scope: "session", sessionHandle: recovered.sessionHandle },
        { mode: "snapshot" },
      );
    } catch (error) {
      handleFailure = error;
    }
    if (
      !(handleFailure instanceof ReinsSdkError) ||
      handleFailure.failure.code !== "session_not_found"
    )
      throw new Error("错目标接受了旧作用域的会话句柄");

    const gate = required("REINS_PACKED_CHANNEL_FACT_GATE");
    const local = await other.connection.spawn(
      {
        harness: "qoder",
        sessionLabel: "packed-channel-other-target",
        message: JSON.stringify({ gate, messages: 0, reply: "other target" }),
        cwd: required("REINS_WORKER_CWD"),
      },
      { operationKey: other.connection.prepareOperation("spawn") },
    );
    const otherTurn = {
      scope: "turn" as const,
      turnHandle: local.turnHandle,
    };
    let cursorFailure: unknown;
    try {
      await other.connection.attach(otherTurn, {
        mode: "after",
        cursor: recovered.cursor,
      });
    } catch (error) {
      cursorFailure = error;
    }
    if (
      !(cursorFailure instanceof ReinsSdkError) ||
      cursorFailure.failure.code !== "invalid_params"
    )
      throw new Error("错目标接受了旧作用域的续接游标");
    const sessions = await other.connection.list();
    if (
      sessions.length !== 1 ||
      sessions[0]?.sessionHandle !== local.sessionHandle
    )
      throw new Error("拒绝错目标身份时影响了本地会话");
  } finally {
    other.connection.close();
    await waitForExit(other.channel);
  }
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

async function verifyExitCloseFailureEndsPending(
  target: ControlRuntimeTarget,
): Promise<void> {
  const handshakeBytes = deferred<Uint8Array>();
  const readableEnd = deferred<void>();
  const termination = deferred<{
    exitCode: number | null;
    signal: string | null;
  }>();
  let closeCalls = 0;
  const channel: ControlByteChannel = {
    readable: (async function* () {
      yield await handshakeBytes.promise;
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
      else if (request.method === "list")
        termination.resolve({ exitCode: 1, signal: null });
    },
    async close() {
      closeCalls += 1;
      throw new Error("The target bridge failed to close after process exit");
    },
    terminated: termination.promise,
  };
  const connection = await openControl({
    consumerContext: "packed-byte-consumer",
    runtimeTarget: target,
    openControlChannel: async () => channel,
  });
  try {
    const pending = connection.list().then(
      () => false,
      () => true,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectedBeforeReadableEnd: boolean;
    try {
      rejectedBeforeReadableEnd = await Promise.race([
        pending,
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 300);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (!rejectedBeforeReadableEnd)
      throw new Error(
        "A failed close after target exit left a request pending until readable EOF",
      );
    if (closeCalls !== 1)
      throw new Error("Target exit did not attempt byte channel close once");
  } finally {
    readableEnd.resolve(undefined);
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
      [
        "close failure after target exit",
        () => verifyExitCloseFailureEndsPending(target),
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

    await verifyProcessPipeBackpressure(target);

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
        message: JSON.stringify({
          gate: required("REINS_PACKED_CHANNEL_OPEN_GATE"),
          reply: "control through the public byte channel",
        }),
        cwd: required("REINS_WORKER_CWD"),
      },
      { operationKey: first.connection.prepareOperation("spawn") },
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
      { operationKey: third.connection.prepareOperation("kill") },
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

    const failedBridgeChannel = await verifyBridgeFailureDiagnostics(target);
    const recovery = await verifyOperationAndCursorRecovery(target);
    await verifyOtherTargetRejectsOldIdentity(target, recovery);
    const diagnosticResults = await Promise.all(
      channels.map(async (channel) => ({
        channel,
        result: await diagnosticTasks.get(channel)!,
      })),
    );
    if (
      thirdTermination.exitCode !== 0 ||
      thirdTermination.signal !== null ||
      diagnosticResults.some(
        ({ channel, result }) =>
          channel !== failedBridgeChannel && result.byteLength !== 0,
      ) ||
      !diagnosticResults.some(
        ({ channel, result }) =>
          channel === failedBridgeChannel &&
          result.text.includes("Reins control entry failed"),
      )
    )
      throw new Error("stdio 控制入口没有隔离健康协议与失败诊断字节");
    if (fragmentedFrameCount === 0)
      throw new Error("实际进程响应没有按字节分片交付");

    process.stdout.write(
      `${JSON.stringify({
        status: "byte-channel-accepted",
        channelCount: channels.length,
        openedAfterAbort,
        sessionSurvivedClose: true,
        sessionSurvivedReconnect: true,
        scopeMismatch: "handshake",
        diagnosticsWereSeparate: true,
        fragmentedResponses: fragmentedFrameCount > 0,
        processPipeBackpressureDrained: true,
        operationAndCursorRecovered: true,
        otherTargetRejectedOldIdentity: true,
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
