import {
  createReinsClient,
  AgentSubscriptionError,
  ReinsClientError,
  type ReinsClient as ControlClient,
  type AgentFact as ClientAgentFact,
  type AgentTarget as ClientAgentTarget,
  type AgentSubscriptionInitial as ClientAgentSubscriptionInitial,
} from "@reins/client/control";
import type {
  AttachParams,
  DiagnosticRecord as ProtocolDiagnosticRecord,
  DiagnosticsResult as ProtocolDiagnosticsResult,
  MachineError,
  ProtocolMessage,
  ProtocolParams,
  ProtocolResult,
  OperationKey as ProtocolOperationKey,
  OperationRecord as ProtocolOperationRecord,
  DaemonGeneration as ProtocolDaemonGeneration,
  RuntimeScopeId as ProtocolRuntimeScopeId,
  SideEffectMethod,
  SessionInfo as ProtocolSessionInfo,
  SessionId,
  TurnId,
} from "@reins/protocol";
import {
  consumerContextSchema,
  decodePermissionHandle,
  decodeTurnHandle,
  diagnosticsParamsSchema,
  diagnosticIdSchema,
  encodeMessageKey,
  encodePermissionHandle,
  encodeTurnHandle,
  messageKeySchema,
  operationRecordSchemaFor,
  permissionHandleSchema,
  parseOperationKey as parseProtocolOperationKey,
  REINS_PROTOCOL_MAJOR_VERSION,
  resumeCursorSchema,
  sessionIdSchema,
  runtimeScopeIdSchema,
  subscriptionStartSchema,
  toolKeySchema,
  turnHandleSchema,
} from "@reins/protocol";
import { createUnixSocketClient, isTransportError } from "@reins/transport";
import * as v from "valibot";

import {
  type ConnectOptions,
  type ControlByteChannel,
  type OpenControlOptions,
  type DiagnosticId,
  type DiagnosticRecord,
  type DiagnosticsQuery,
  type DiagnosticsResult,
  type OperationKey,
  type OperationKind,
  type OperationOptions,
  type OperationRecord,
  type ReinsConnection,
  type ReinsFailure,
  type RuntimeScopeId,
  type AgentFact,
  type AgentFactId,
  type AgentSubscriptionEnd,
  type AgentSubscriptionBaseline,
  type AgentSubscriptionInitial,
  type AgentTarget,
  type SubscriptionStart,
  type ResumeCursor,
  type FactSubscription,
  type SessionHandle,
  type SessionInfo,
  type MessageKey,
  type ToolKey,
  type PermissionHandle,
  type TurnHandle,
  type SendInput,
  type SendResult,
  type WaitInput,
  type WaitResult,
  type InterruptInput,
  type InterruptResult,
} from "./contracts.ts";
import { createControlByteTransport } from "./control-channel.ts";
import { ReinsSdkError } from "./errors.ts";

export function parseRuntimeScopeId(value: string): RuntimeScopeId {
  return v.parse(runtimeScopeIdSchema, value) as unknown as RuntimeScopeId;
}

export function serializeRuntimeScopeId(value: RuntimeScopeId): string {
  return v.parse(runtimeScopeIdSchema, value);
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error && signal.reason.name === "AbortError")
    return signal.reason;
  const error =
    signal.reason === undefined
      ? new Error("The operation was aborted")
      : new Error("The operation was aborted", { cause: signal.reason });
  error.name = "AbortError";
  return error;
}

function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function invalidConnectInput(path: string): ReinsSdkError {
  return new ReinsSdkError(
    {
      code: "invalid_params",
      facts: { issues: [{ issue: "invalid_value", path }] },
    },
    "connect",
  );
}

export { ReinsSdkError } from "./errors.ts";
export type { ReinsSdkErrorStage } from "./errors.ts";
export type {
  ModelCatalogResult,
  ModelCatalogFailure,
  ModelCatalogEntry,
  ConnectOptions,
  ControlByteChannel,
  ControlChannelOpener,
  ControlChannelTermination,
  ControlRuntimeTarget,
  OpenControlOptions,
  DiagnosticId,
  DiagnosticKind,
  DiagnosticRecord,
  DiagnosticSeverity,
  DiagnosticSource,
  DiagnosticTextEvidence,
  DiagnosticsFilter,
  DiagnosticsQuery,
  DiagnosticsResult,
  KillInput,
  KillResult,
  SendInput,
  SendResult,
  WaitInput,
  WaitResult,
  CompletedTurn,
  InterruptInput,
  InterruptResult,
  HarnessId,
  OperationKey,
  OperationKind,
  OperationOptions,
  OperationRecord,
  HarnessModelCatalog,
  HarnessFailure,
  LastCompletedTurn,
  ReinsConnection,
  ReinsFailure,
  ReinsFailureCode,
  ReinsHandshake,
  RuntimeScopeId,
  SessionFilter,
  SessionHandle,
  SessionInfo,
  SessionState,
  SpawnInput,
  SpawnResult,
  StopReason,
  TurnHandle,
  AgentFact,
  AgentFactId,
  MessageContent,
  MessageContentPart,
  AgentSubscriptionEnd,
  AgentSubscriptionBaseline,
  AgentSubscriptionInitial,
  AgentTarget,
  FactSubscription,
  MessageKey,
  PermissionOption,
  PermissionHandle,
  PermissionResolution,
  SubscriptionStart,
  ResumeCursor,
  ToolKey,
} from "./contracts.ts";

function parseWithBrand<Brand extends string>(
  schema: v.GenericSchema,
  value: unknown,
): Brand {
  return v.parse(schema, value) as Brand;
}

export function parseSessionHandle(value: unknown): SessionHandle {
  return parseWithBrand<SessionHandle>(sessionIdSchema, value);
}
export function serializeSessionHandle(handle: SessionHandle): string {
  return v.parse(sessionIdSchema, handle);
}
export function parseTurnHandle(value: unknown): TurnHandle {
  return parseWithBrand<TurnHandle>(turnHandleSchema, value);
}
export function serializeTurnHandle(handle: TurnHandle): string {
  return v.parse(turnHandleSchema, handle);
}
export function parsePermissionHandle(value: unknown): PermissionHandle {
  return parseWithBrand<PermissionHandle>(permissionHandleSchema, value);
}
export function serializePermissionHandle(handle: PermissionHandle): string {
  return v.parse(permissionHandleSchema, handle);
}
export function parseMessageKey(value: unknown): MessageKey {
  return parseWithBrand<MessageKey>(messageKeySchema, value);
}
export function serializeMessageKey(key: MessageKey): string {
  return v.parse(messageKeySchema, key);
}
export function parseToolKey(value: unknown): ToolKey {
  return parseWithBrand<ToolKey>(toolKeySchema, value);
}
export function serializeToolKey(key: ToolKey): string {
  return v.parse(toolKeySchema, key);
}
export function parseDiagnosticId(value: unknown): DiagnosticId {
  return parseWithBrand<DiagnosticId>(diagnosticIdSchema, value);
}
export function serializeDiagnosticId(id: DiagnosticId): string {
  return v.parse(diagnosticIdSchema, id);
}
export function parseResumeCursor(value: unknown): ResumeCursor {
  return parseWithBrand<ResumeCursor>(resumeCursorSchema, value);
}
export function serializeResumeCursor(cursor: ResumeCursor): string {
  return v.parse(resumeCursorSchema, cursor);
}
export function parseOperationKey(value: unknown): OperationKey<OperationKind>;
export function parseOperationKey<Kind extends OperationKind>(
  value: unknown,
  kind: Kind,
): OperationKey<Kind>;
export function parseOperationKey(
  value: unknown,
  kind?: OperationKind,
): OperationKey<OperationKind> {
  if (typeof value !== "string") throw new Error("Invalid OperationKey");
  if (kind === undefined) parseProtocolOperationKey(value);
  else parseProtocolOperationKey(value, kind);
  return value as OperationKey<OperationKind>;
}
export function serializeOperationKey<Kind extends OperationKind>(
  operationKey: OperationKey<NoInfer<Kind>>,
): string {
  return parseOperationKey(operationKey);
}

function operationKeyFor<Kind extends OperationKind>(
  client: ControlClient,
  kind: Kind,
  options: OperationOptions<Kind> | undefined,
): OperationKey<Kind> {
  if (options === undefined)
    return parseOperationKey(client.prepareOperation(kind), kind);
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => key !== "operationKey")
  )
    throw invalidInput("options", "operation");
  const operationKey = (options as { operationKey?: unknown }).operationKey;
  if (operationKey === undefined)
    return parseOperationKey(client.prepareOperation(kind), kind);
  try {
    return parseOperationKey(operationKey, kind);
  } catch {
    throw invalidInput("operationKey", "operation");
  }
}
export function parseAgentFactId(value: unknown): AgentFactId {
  if (typeof value !== "string" || !/^fact1_[A-Za-z0-9_-]+$/u.test(value))
    throw new Error("Invalid agent fact ID");
  return value as AgentFactId;
}
export function serializeAgentFactId(id: AgentFactId): string {
  return parseAgentFactId(id);
}

function projectAgentTarget(target: ClientAgentTarget): AgentTarget {
  return target.scope === "session"
    ? {
        scope: "session",
        sessionHandle: parseSessionHandle(target.sessionHandle),
      }
    : { scope: "turn", turnHandle: parseTurnHandle(target.turnHandle) };
}

function projectAgentFact(fact: ClientAgentFact): AgentFact {
  const projected: Record<string, unknown> = {
    ...fact,
    factId: parseAgentFactId(fact.factId),
    sessionHandle: parseSessionHandle(fact.sessionHandle),
  };
  if ("turnHandle" in fact)
    projected.turnHandle = parseTurnHandle(fact.turnHandle);
  if ("messageKey" in fact)
    projected.messageKey = parseMessageKey(fact.messageKey);
  if ("toolKey" in fact) projected.toolKey = parseToolKey(fact.toolKey);
  if ("permissionHandle" in fact)
    projected.permissionHandle = parsePermissionHandle(fact.permissionHandle);
  if ("diagnosticId" in fact && fact.diagnosticId !== undefined)
    projected.diagnosticId = parseDiagnosticId(fact.diagnosticId);
  return projected as AgentFact;
}

export function connect(options: ConnectOptions): Promise<ReinsConnection> {
  return connectClient(options, false);
}

export function openControl(
  options: OpenControlOptions,
): Promise<ReinsConnection> {
  return connectClient(options, true);
}

async function connectClient(
  options: ConnectOptions | OpenControlOptions,
  injected: boolean,
): Promise<ReinsConnection> {
  let client: ControlClient | undefined;
  let byteTransport: ReturnType<typeof createControlByteTransport> | undefined;
  let openedChannel: ControlByteChannel | undefined;
  let openingChannel: Promise<ControlByteChannel> | undefined;
  let openingAbort: AbortController | undefined;
  let removeAbortListener: (() => void) | undefined;
  let connectionSignal: AbortSignal | undefined;
  let stage: "connect" | "handshake" = "connect";
  try {
    if (typeof options !== "object" || options === null)
      throw invalidConnectInput("options");
    const fields = options as unknown as Record<string, unknown>;
    if (injected) {
      if (Object.hasOwn(fields, "socketPath"))
        throw invalidConnectInput("socketPath");
      if (Object.hasOwn(fields, "runtimeScopeId"))
        throw invalidConnectInput("runtimeScopeId");
      if (typeof fields.openControlChannel !== "function")
        throw invalidConnectInput("openControlChannel");
    } else {
      if (
        typeof fields.socketPath !== "string" ||
        fields.socketPath.length === 0
      )
        throw invalidConnectInput("socketPath");
      if (Object.hasOwn(fields, "runtimeTarget"))
        throw invalidConnectInput("runtimeTarget");
      if (Object.hasOwn(fields, "openControlChannel"))
        throw invalidConnectInput("openControlChannel");
      if (Object.hasOwn(fields, "signal")) throw invalidConnectInput("signal");
    }
    const consumerContext = v.safeParse(
      consumerContextSchema,
      options.consumerContext,
    );
    if (!consumerContext.success)
      throw new ReinsSdkError(
        {
          code: "consumer_context_required",
          facts: {},
        },
        stage,
      );
    const injectedOptions = injected
      ? (options as OpenControlOptions)
      : undefined;
    const localOptions = injected ? undefined : (options as ConnectOptions);
    if (injected) {
      openingAbort = new AbortController();
      connectionSignal = openingAbort.signal;
      const externalSignal = injectedOptions!.signal;
      if (externalSignal !== undefined) {
        const forwardAbort = (): void =>
          openingAbort?.abort(externalSignal.reason);
        if (externalSignal.aborted) forwardAbort();
        else {
          externalSignal.addEventListener("abort", forwardAbort, {
            once: true,
          });
          removeAbortListener = () =>
            externalSignal.removeEventListener("abort", forwardAbort);
        }
      }
    }
    const configuredScopeId = injected
      ? injectedOptions!.runtimeTarget?.runtimeScopeId
      : localOptions!.runtimeScopeId;
    let runtimeScopeId: RuntimeScopeId | undefined;
    if (injected || configuredScopeId !== undefined) {
      const parsed = v.safeParse(runtimeScopeIdSchema, configuredScopeId);
      if (!parsed.success)
        throw new ReinsSdkError(
          { code: "runtime_scope_invalid", facts: {} },
          stage,
        );
      runtimeScopeId = parsed.output as unknown as RuntimeScopeId;
    }
    let transport: import("@reins/transport").TransportConnection<ProtocolMessage>;
    if (injected) {
      const target = injectedOptions!.runtimeTarget;
      if (
        typeof target !== "object" ||
        target === null ||
        Array.isArray(target)
      )
        throw invalidConnectInput("runtimeTarget");
      if (typeof target.command !== "string" || target.command.length === 0)
        throw invalidConnectInput("runtimeTarget.command");
      if (
        !Array.isArray(target.args) ||
        !target.args.every((argument) => typeof argument === "string")
      )
        throw invalidConnectInput("runtimeTarget.args");
      const signal = connectionSignal!;
      if (signal.aborted) throw abortError(signal);
      openingChannel = Promise.resolve().then(() =>
        injectedOptions!.openControlChannel(target, signal),
      );
      openedChannel = await raceWithAbort(openingChannel, signal);
      byteTransport = createControlByteTransport(openedChannel);
      transport = byteTransport.connection;
    } else {
      transport = await createUnixSocketClient<ProtocolMessage>(
        localOptions!.socketPath,
      );
    }
    client = createReinsClient(transport, {
      consumerContext: consumerContext.output,
      ...(runtimeScopeId === undefined
        ? {}
        : {
            runtimeScopeId: runtimeScopeId as unknown as ProtocolRuntimeScopeId,
          }),
    });
    stage = "handshake";
    const initialization = client.initialize(options.timeoutMs);
    const handshakeResponse =
      connectionSignal === undefined
        ? await initialization
        : await raceWithAbort(initialization, connectionSignal);
    if ("error" in handshakeResponse)
      throw new ReinsSdkError(projectFailure(handshakeResponse.error), stage);
    if (
      handshakeResponse.result.protocolMajorVersion !==
      REINS_PROTOCOL_MAJOR_VERSION
    )
      throw new ReinsSdkError(
        {
          code: "protocol_version_mismatch",
          facts: {
            requestedProtocolMajorVersion: REINS_PROTOCOL_MAJOR_VERSION,
            supportedProtocolMajorVersion:
              handshakeResponse.result.protocolMajorVersion,
          },
        },
        stage,
      );
    const handshake = {
      protocolMajorVersion: handshakeResponse.result.protocolMajorVersion,
      daemonGeneration: handshakeResponse.result.daemonGeneration,
      runtimeScopeId: handshakeResponse.result
        .runtimeScopeId as unknown as RuntimeScopeId,
    };
    removeAbortListener?.();

    return {
      handshake,
      async modelCatalog() {
        const result = await query(client!, "modelCatalog", {});
        return {
          catalogs: result.catalogs,
          failures: result.failures.map(
            ({ code: _code, diagnosticId, failure, harness }) => ({
              harness,
              ...failure,
              ...(diagnosticId === undefined
                ? {}
                : { diagnosticId: parseDiagnosticId(diagnosticId) }),
            }),
          ),
        };
      },
      async list(filter) {
        const { sessionHandle, ...rest } = filter ?? {};
        const params = {
          ...rest,
          ...(sessionHandle === undefined
            ? {}
            : {
                sessionId: sessionIdFromHandle(
                  sessionHandle,
                  "sessionHandle",
                  "query",
                ),
              }),
        } as ProtocolParams<"list">;
        return (await query(client!, "list", params)).map(mapSessionInfo);
      },
      async diagnostics(filter) {
        const result = await query(
          client!,
          "diagnostics",
          projectDiagnosticsParams(filter),
        );
        return projectDiagnosticsResult(result);
      },
      async attach(target, start, signal) {
        let source: Awaited<ReturnType<ControlClient["subscribeFacts"]>>;
        try {
          source = await client!.subscribeFacts(
            projectAttachParams(target, start),
            signal,
          );
        } catch (error) {
          throw projectSubscriptionError(error);
        }
        const done = source.done.catch((error: unknown) => {
          throw projectSubscriptionError(error);
        });
        const projectedDone = done.then(({ target: endedTarget, reason }) => ({
          target: projectAgentTarget(endedTarget),
          reason,
        }));
        void projectedDone.catch(() => undefined);
        let finished = false;
        const sourceFacts = new WeakMap<object, ClientAgentFact>();
        const subscription: FactSubscription = {
          initial: projectAgentSubscriptionInitial(source.initial),
          done: projectedDone as Promise<AgentSubscriptionEnd>,
          get checkpoint() {
            return parseResumeCursor(source.checkpoint);
          },
          acknowledge(fact) {
            const sourceFact =
              typeof fact === "object" && fact !== null
                ? sourceFacts.get(fact)
                : undefined;
            if (sourceFact === undefined)
              throw new ReinsSdkError({
                code: "invalid_params",
                facts: {
                  issues: [{ issue: "invalid_value", path: "factId" }],
                },
              });
            try {
              source.acknowledge(sourceFact);
            } catch (error) {
              throw projectSubscriptionError(error);
            }
          },
          async next() {
            if (finished) return { value: undefined, done: true };
            try {
              const item = await source.next();
              if (item.done) {
                finished = true;
                return { value: undefined, done: true };
              }
              const fact = projectAgentFact(item.value);
              sourceFacts.set(fact, item.value);
              return { value: fact, done: false };
            } catch (error) {
              throw projectSubscriptionError(error);
            }
          },
          async return() {
            finished = true;
            await source.return?.();
            return { value: undefined, done: true };
          },
          async throw(error?: unknown) {
            finished = true;
            await source.throw?.(error);
            throw error;
          },
          [Symbol.asyncIterator]() {
            return subscription;
          },
          close() {
            finished = true;
            source.close();
          },
        };
        return subscription;
      },
      prepareOperation(kind) {
        try {
          return client!.prepareOperation(kind) as unknown as OperationKey<
            typeof kind
          >;
        } catch (error) {
          if (error instanceof ReinsClientError)
            throw new ReinsSdkError(
              projectClientFailure(error.failure),
              "operation",
            );
          throw new ReinsSdkError(
            { code: "unexpected_failure", facts: {} },
            "operation",
          );
        }
      },
      async getOperation<Kind extends "spawn" | "send">(
        operationKey: OperationKey<Kind>,
      ): Promise<OperationRecord<Kind>> {
        let kind: "spawn" | "send";
        let generation: ProtocolDaemonGeneration;
        try {
          const claims = parseProtocolOperationKey(operationKey);
          if (claims.kind !== "spawn" && claims.kind !== "send")
            throw new Error("Operation kind is not recoverable");
          kind = claims.kind;
          generation = claims.generation;
        } catch {
          throw invalidInput("operationKey", "query");
        }
        const result = await query(client!, "getOperation", {
          operationKey: serializeOperationKey(
            operationKey,
          ) as ProtocolOperationKey,
        });
        return projectOperationRecord(
          v.parse(
            operationRecordSchemaFor(kind),
            result,
          ) as ProtocolOperationRecord,
          kind,
          generation,
        ) as OperationRecord<Kind>;
      },
      async spawn(input, options) {
        return projectSpawnResult(
          await perform(
            client!,
            "spawn",
            input,
            operationKeyFor(client!, "spawn", options),
          ),
        );
      },
      async kill(input, options) {
        const result = await perform(
          client!,
          "kill",
          {
            sessionId: sessionIdFromHandle(
              input.sessionHandle,
              "sessionHandle",
            ),
          },
          operationKeyFor(client!, "kill", options),
        );
        return {
          sessionHandle: parseSessionHandle(result.sessionId),
          status: result.status,
        };
      },
      async resolvePermission(permissionHandle, resolution, options) {
        let target: ReturnType<typeof decodePermissionHandle>;
        try {
          target = decodePermissionHandle(
            serializePermissionHandle(parsePermissionHandle(permissionHandle)),
          );
        } catch {
          throw new ReinsSdkError(
            {
              code: "invalid_params",
              facts: {
                issues: [{ issue: "invalid_value", path: "permissionHandle" }],
              },
            },
            "operation",
          );
        }
        const result = await perform(
          client!,
          "resolvePermission",
          { ...target, resolution },
          operationKeyFor(client!, "resolvePermission", options),
          permissionHandle,
        );
        return {
          permissionHandle: parsePermissionHandle(
            encodePermissionHandle(result),
          ),
          status: "resolved",
        };
      },
      async send(input: SendInput, options) {
        if (
          typeof input !== "object" ||
          input === null ||
          (input.placement !== "active_turn" && input.placement !== "new_turn")
        )
          throw invalidInput("placement", "operation");
        let params: ProtocolParams<"send">;
        if (input.placement === "active_turn") {
          if (Object.hasOwn(input, "ifLastCompletedTurn"))
            throw invalidInput("ifLastCompletedTurn", "operation");
          const target = targetFromHandle(input.turnHandle, "turnHandle");
          params = {
            placement: "active_turn",
            ...target,
            message: input.message,
          };
        } else {
          const sessionId = sessionIdFromHandle(
            input.sessionHandle,
            "sessionHandle",
          );
          const ifLastCompletedTurn =
            input.ifLastCompletedTurn === undefined
              ? undefined
              : targetFromHandle(
                  input.ifLastCompletedTurn,
                  "ifLastCompletedTurn",
                );
          if (
            ifLastCompletedTurn !== undefined &&
            ifLastCompletedTurn.sessionId !== sessionId
          )
            throw invalidInput("ifLastCompletedTurn", "operation");
          params = {
            placement: "new_turn",
            sessionId,
            ...(ifLastCompletedTurn === undefined
              ? {}
              : { ifLastCompletedTurn }),
            message: input.message,
          };
        }
        const result = await perform(
          client!,
          "send",
          params,
          operationKeyFor(client!, "send", options),
        );
        return {
          sessionHandle: parseSessionHandle(result.sessionId),
          turnHandle: parseTurnHandle(
            encodeTurnHandle({
              sessionId: result.sessionId,
              turnId: result.turnId,
            }),
          ),
          messageKey: parseMessageKey(
            encodeMessageKey({
              generation: handshake.daemonGeneration,
              sessionId: result.sessionId,
              turnId: result.turnId,
              messageId: result.messageId,
            }),
          ),
          deliveryPoint: result.deliveryPoint,
        } satisfies SendResult;
      },
      async wait(input: WaitInput) {
        if (!Array.isArray(input.targets) || input.targets.length === 0)
          throw invalidInput("targets", "query");
        const targets = input.targets.map((handle) =>
          targetFromHandle(handle, "targets", "query"),
        );
        if (
          new Set(
            targets.map(({ sessionId, turnId }) => `${sessionId}/${turnId}`),
          ).size !== targets.length
        )
          throw invalidInput("targets", "query");
        if (input.completion !== "any" && input.completion !== "all")
          throw invalidInput("completion", "query");
        if (
          input.timeoutMs !== undefined &&
          (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 0)
        )
          throw invalidInput("timeoutMs", "query");
        const result = await query(client!, "wait", {
          targets,
          completion: input.completion,
          ...(input.timeoutMs === undefined
            ? {}
            : { timeoutMs: input.timeoutMs }),
        });
        const fields = {
          completed: result.completed.map(projectCompletedTurn),
          pending: result.pending.map((target) =>
            parseTurnHandle(encodeTurnHandle(target)),
          ),
        };
        if (result.status === "unreachable")
          return {
            ...fields,
            status: result.status,
            unreachable: result.unreachable.map(({ reason, ...target }) => ({
              turnHandle: parseTurnHandle(encodeTurnHandle(target)),
              reason,
            })),
          } satisfies WaitResult;
        return {
          ...fields,
          status: result.status,
          ...(result.unreachable === undefined
            ? {}
            : {
                unreachable: result.unreachable.map(
                  ({ reason, ...target }) => ({
                    turnHandle: parseTurnHandle(encodeTurnHandle(target)),
                    reason,
                  }),
                ),
              }),
        } satisfies WaitResult;
      },
      async interrupt(input: InterruptInput, options) {
        const target = targetFromHandle(input.turnHandle, "turnHandle");
        await perform(
          client!,
          "interrupt",
          target,
          operationKeyFor(client!, "interrupt", options),
        );
        return {
          turnHandle: input.turnHandle,
          status: "accepted",
        } satisfies InterruptResult;
      },
      close() {
        client?.close();
      },
    };
  } catch (error) {
    openingAbort?.abort(error);
    client?.close();
    await byteTransport?.closeAndWait().catch(() => undefined);
    if (openedChannel === undefined && openingChannel !== undefined) {
      void openingChannel.then(
        (channel) => channel.close().catch(() => undefined),
        () => undefined,
      );
    }
    removeAbortListener?.();
    if (error instanceof Error && error.name === "AbortError") throw error;
    if (error instanceof ReinsSdkError) throw error;
    if (error instanceof ReinsClientError)
      throw new ReinsSdkError(projectClientFailure(error.failure), stage);
    if (isTransportError(error))
      throw new ReinsSdkError(
        {
          code: "daemon_disconnected",
          facts: {},
        },
        stage,
      );
    throw new ReinsSdkError(
      {
        code: "unexpected_failure",
        facts: {},
      },
      stage,
    );
  }
}

function projectAttachParams(
  target: AgentTarget,
  start: SubscriptionStart,
): AttachParams {
  const parsed = v.safeParse(subscriptionStartSchema, start);
  if (!parsed.success)
    throw new ReinsSdkError({
      code: "invalid_params",
      facts: { issues: [{ issue: "invalid_value", path: "start" }] },
    });
  const parsedStart = parsed.output;
  const protocolStart =
    parsedStart.mode === "after"
      ? {
          mode: "after" as const,
          cursor: v.parse(resumeCursorSchema, parsedStart.cursor),
        }
      : parsedStart;
  if (target.scope === "session")
    return {
      scope: "session",
      sessionId: sessionIdFromHandle(
        target.sessionHandle,
        "sessionHandle",
        "query",
      ),
      start: protocolStart,
    };
  return {
    scope: "turn",
    ...decodeTurnHandle(target.turnHandle),
    start: protocolStart,
  };
}

function projectAgentSubscriptionInitial(
  initial: ClientAgentSubscriptionInitial,
): AgentSubscriptionInitial {
  const target = projectAgentTarget(initial.target);
  if (initial.mode !== "snapshot")
    return {
      ...initial,
      target,
      cursor: parseResumeCursor(initial.cursor),
    };
  return {
    ...initial,
    target,
    cursor: parseResumeCursor(initial.cursor),
    baseline: {
      session: mapSessionInfo(initial.baseline.session),
      confirmedTerminals: initial.baseline.confirmedTerminals.map(
        projectAgentFact,
      ) as AgentSubscriptionBaseline["confirmedTerminals"],
      pendingPermissions: initial.baseline.pendingPermissions.map(
        projectAgentFact,
      ) as AgentSubscriptionBaseline["pendingPermissions"],
    },
  };
}

function projectSubscriptionError(error: unknown): ReinsSdkError | Error {
  if (error instanceof Error && error.name === "AbortError") return error;
  if (error instanceof ReinsSdkError) return error;
  if (error instanceof AgentSubscriptionError) {
    const failure = projectFailure(error.failure);
    if (
      failure.code === "daemon_disconnected" &&
      error.resumeCursor !== undefined
    )
      return new ReinsSdkError({
        code: "daemon_disconnected",
        facts: {
          resumeCursor: parseResumeCursor(error.resumeCursor),
        },
      });
    return new ReinsSdkError(failure);
  }
  if (error instanceof ReinsClientError)
    return new ReinsSdkError(projectClientFailure(error.failure));
  if (isTransportError(error))
    return new ReinsSdkError({ code: "daemon_disconnected", facts: {} });
  return new ReinsSdkError({ code: "unexpected_failure", facts: {} });
}
async function perform<M extends SideEffectMethod>(
  client: ControlClient,
  method: M,
  params: ProtocolParams<M>,
  operationKey: OperationKey<M & OperationKind>,
  permissionHandle?: PermissionHandle,
): Promise<ProtocolResult<M>> {
  try {
    const response = await client.executeOperation(
      method,
      params,
      operationKey as unknown as ProtocolOperationKey<M>,
    );
    if ("error" in response)
      throw new ReinsSdkError(
        projectFailure(response.error, permissionHandle),
        "operation",
      );
    return response.result;
  } catch (error) {
    if (error instanceof ReinsSdkError) throw error;
    if (error instanceof ReinsClientError)
      throw new ReinsSdkError(projectClientFailure(error.failure), "operation");
    throw new ReinsSdkError(
      { code: "unexpected_failure", facts: {} },
      "operation",
    );
  }
}

async function query<
  M extends "modelCatalog" | "list" | "diagnostics" | "wait" | "getOperation",
>(
  client: ControlClient,
  method: M,
  params: ProtocolParams<M>,
): Promise<ProtocolResult<M>> {
  try {
    const response = await client.request(method, params);
    if ("error" in response)
      throw new ReinsSdkError(projectFailure(response.error));
    return response.result;
  } catch (error) {
    if (error instanceof ReinsSdkError) throw error;
    if (error instanceof ReinsClientError)
      throw new ReinsSdkError(projectClientFailure(error.failure));
    throw new ReinsSdkError({ code: "unexpected_failure", facts: {} });
  }
}

function projectDiagnosticsParams(
  query: DiagnosticsQuery | undefined,
): ProtocolParams<"diagnostics"> {
  if (query === undefined) return {};
  if ("diagnosticId" in query)
    return {
      diagnosticId: v.parse(
        diagnosticIdSchema,
        serializeDiagnosticId(query.diagnosticId),
      ),
    };
  const { sessionHandle, turnHandle, ...filters } = query;
  if (turnHandle !== undefined) {
    const target = targetFromHandle(turnHandle, "turnHandle", "query");
    if (
      sessionHandle !== undefined &&
      sessionIdFromHandle(sessionHandle, "sessionHandle", "query") !==
        target.sessionId
    )
      throw new ReinsSdkError({
        code: "invalid_params",
        facts: {
          issues: [
            {
              issue: "invalid_combination",
              paths: ["sessionHandle", "turnHandle"],
            },
          ],
        },
      });
    return v.parse(diagnosticsParamsSchema, { ...filters, ...target });
  }
  return v.parse(diagnosticsParamsSchema, {
    ...filters,
    ...(sessionHandle === undefined
      ? {}
      : {
          sessionId: sessionIdFromHandle(
            sessionHandle,
            "sessionHandle",
            "query",
          ),
        }),
  });
}

function projectDiagnosticsResult(
  result: ProtocolDiagnosticsResult,
): DiagnosticsResult {
  if ("record" in result)
    return { record: projectDiagnosticRecord(result.record) };
  return {
    records: result.records.map(projectDiagnosticRecord),
    truncated: result.truncated,
  };
}

function projectDiagnosticRecord(
  record: ProtocolDiagnosticRecord,
): DiagnosticRecord {
  const address = record as ProtocolDiagnosticRecord & {
    sessionId?: SessionId;
    turnId?: TurnId;
  };
  const { sessionId, turnId, diagnosticId, ...fields } = address;
  return {
    ...fields,
    diagnosticId: parseDiagnosticId(diagnosticId),
    ...(sessionId === undefined
      ? {}
      : { sessionHandle: parseSessionHandle(sessionId) }),
    ...(turnId === undefined || sessionId === undefined
      ? {}
      : {
          turnHandle: parseTurnHandle(encodeTurnHandle({ sessionId, turnId })),
        }),
  } as DiagnosticRecord;
}

function targetFromHandle(
  handle: unknown,
  path: string,
  stage: "query" | "operation" = "operation",
): {
  sessionId: SessionId;
  turnId: ReturnType<typeof decodeTurnHandle>["turnId"];
} {
  if (
    typeof handle !== "string" ||
    !v.safeParse(turnHandleSchema, handle).success
  )
    throw invalidInput(path, stage);
  return decodeTurnHandle(serializeTurnHandle(parseTurnHandle(handle)));
}

function sessionIdFromHandle(
  handle: unknown,
  path: string,
  stage: "query" | "operation" = "operation",
): SessionId {
  if (
    typeof handle !== "string" ||
    !v.safeParse(sessionIdSchema, handle).success
  )
    throw invalidInput(path, stage);
  return v.parse(
    sessionIdSchema,
    serializeSessionHandle(parseSessionHandle(handle)),
  );
}

function invalidInput(
  path: string,
  stage: "query" | "operation",
): ReinsSdkError {
  return new ReinsSdkError(
    {
      code: "invalid_params",
      facts: { issues: [{ issue: "invalid_value", path }] },
    },
    stage,
  );
}

function projectCompletedTurn(
  turn: ProtocolResult<"wait">["completed"][number],
): import("./contracts.ts").CompletedTurn {
  const { sessionId, turnId, usage, diagnosticId, ...fields } = turn;
  return {
    ...fields,
    turnHandle: parseTurnHandle(encodeTurnHandle({ sessionId, turnId })),
    ...(usage === undefined ? {} : { usage }),
    ...(diagnosticId === undefined
      ? {}
      : { diagnosticId: parseDiagnosticId(diagnosticId) }),
  } as import("./contracts.ts").CompletedTurn;
}

function projectSpawnResult(
  result: ProtocolResult<"spawn">,
): import("./contracts.ts").SpawnResult {
  return {
    sessionHandle: parseSessionHandle(result.sessionId),
    turnHandle: parseTurnHandle(
      encodeTurnHandle({
        sessionId: result.sessionId,
        turnId: result.turnId,
      }),
    ),
    cwd: result.cwd,
  };
}

function projectOperationRecord<Kind extends "spawn" | "send">(
  record: ProtocolOperationRecord,
  kind: Kind,
  generation: ProtocolDaemonGeneration,
): OperationRecord<Kind> {
  const operationKey = parseOperationKey(record.operationKey, kind);
  switch (record.status) {
    case "unknown":
    case "unavailable":
    case "pending":
      return { status: record.status, operationKey } as OperationRecord<Kind>;
    case "outcome_unknown":
      return {
        status: "outcome_unknown",
        operationKey,
        ...(record.cause === undefined ? {} : { cause: record.cause }),
        ...(record.cleanupCause === undefined
          ? {}
          : { cleanupCause: record.cleanupCause }),
        ...(record.diagnosticId === undefined
          ? {}
          : { diagnosticId: parseDiagnosticId(record.diagnosticId) }),
      } as OperationRecord<Kind>;
    case "succeeded":
      return {
        status: "succeeded",
        operationKey,
        result:
          kind === "spawn"
            ? projectSpawnResult(record.result as ProtocolResult<"spawn">)
            : projectSendResult(
                record.result as ProtocolResult<"send">,
                generation,
              ),
      } as OperationRecord<Kind>;
    case "failed":
      return {
        status: "failed",
        operationKey,
        error: projectFailure(record.error),
      } as OperationRecord<Kind>;
    case "not_accepted_uncommitted":
    case "not_accepted_unconfirmed":
      return {
        status: record.status,
        operationKey,
        error: projectFailure(record.error),
        cause: record.cause,
      } as OperationRecord<Kind>;
    case "accepted_uncommitted":
      return {
        status: "accepted_uncommitted",
        operationKey,
        result:
          kind === "spawn"
            ? projectSpawnResult(record.result as ProtocolResult<"spawn">)
            : projectSendResult(
                record.result as ProtocolResult<"send">,
                generation,
              ),
        cause: record.cause,
        ...(record.cleanupCause === undefined
          ? {}
          : { cleanupCause: record.cleanupCause }),
      } as OperationRecord<Kind>;
    case "accepted_unconfirmed":
      return {
        status: "accepted_unconfirmed",
        operationKey,
        result:
          kind === "spawn"
            ? projectSpawnResult(record.result as ProtocolResult<"spawn">)
            : projectSendResult(
                record.result as ProtocolResult<"send">,
                generation,
              ),
        cause: record.cause,
        ...(record.cleanupCause === undefined
          ? {}
          : { cleanupCause: record.cleanupCause }),
      } as OperationRecord<Kind>;
  }
}

function projectSendResult(
  result: ProtocolResult<"send">,
  generation: ProtocolDaemonGeneration,
): SendResult {
  return {
    sessionHandle: parseSessionHandle(result.sessionId),
    turnHandle: parseTurnHandle(
      encodeTurnHandle({
        sessionId: result.sessionId,
        turnId: result.turnId,
      }),
    ),
    messageKey: parseMessageKey(
      encodeMessageKey({
        generation,
        sessionId: result.sessionId,
        turnId: result.turnId,
        messageId: result.messageId,
      }),
    ),
    deliveryPoint: result.deliveryPoint,
  };
}

function projectClientFailure(
  failure: ReinsClientError["failure"],
): ReinsFailure {
  return projectFailure(failure);
}

function projectFailure(
  failure: MachineError,
  permissionHandle?: PermissionHandle,
): ReinsFailure {
  switch (failure.code) {
    case "consumer_context_required":
    case "protocol_error":
    case "daemon_timeout":
    case "invalid_daemon_response":
    case "daemon_shutting_down":
    case "workspace_detaching":
      return { code: failure.code, facts: {} };
    case "daemon_disconnected":
      return { code: failure.code, facts: {} };
    case "event_cursor_expired":
      return {
        code: failure.code,
        facts: { oldest: failure.oldest, head: failure.head },
      };
    case "event_history_unavailable":
      return {
        code: failure.code,
        facts: { sessionHandle: parseSessionHandle(failure.sessionId) },
      };
    case "operation_key_conflict":
    case "operation_key_scope_mismatch":
    case "stale_operation_key":
      return { code: failure.code, facts: {} };
    case "operation_pending":
      return {
        code: failure.code,
        facts: { operationKey: parseOperationKey(failure.operationKey) },
      };
    case "operation_outcome_unknown":
      return {
        code: failure.code,
        facts: {
          operationKey: parseOperationKey(failure.operationKey),
          ...(failure.cause === undefined ? {} : { cause: failure.cause }),
          ...(failure.cleanupCause === undefined
            ? {}
            : { cleanupCause: failure.cleanupCause }),
          ...(failure.diagnosticId === undefined
            ? {}
            : { diagnosticId: parseDiagnosticId(failure.diagnosticId) }),
        },
      };
    case "control_store_unavailable":
      if (failure.stage === "event" || failure.stage === "event_commit") {
        const eventFacts = {
          sessionHandle: parseSessionHandle(failure.sessionId),
          eventType: failure.eventType,
          ...(failure.turnId === undefined
            ? {}
            : {
                turnHandle: parseTurnHandle(
                  encodeTurnHandle({
                    sessionId: failure.sessionId,
                    turnId: failure.turnId,
                  }),
                ),
              }),
          cause: failure.cause,
          ...(failure.cleanupCause === undefined
            ? {}
            : { cleanupCause: failure.cleanupCause }),
          ...(failure.cleanupSessionId === undefined
            ? {}
            : {
                cleanupSessionHandle: parseSessionHandle(
                  failure.cleanupSessionId,
                ),
              }),
        };
        if (failure.stage === "event")
          return {
            code: failure.code,
            facts: { stage: failure.stage, ...eventFacts },
          };
        return {
          code: failure.code,
          facts: {
            stage: failure.stage,
            operationKey: parseOperationKey(failure.operationKey, "kill"),
            acceptance: failure.acceptance,
            ...eventFacts,
          },
        };
      }
      return {
        code: failure.code,
        facts: {
          operationKey: parseOperationKey(failure.operationKey),
          stage: failure.stage,
          acceptance: failure.acceptance,
          cause: failure.cause,
          ...(failure.acceptedResult === undefined
            ? {}
            : {
                acceptedResult:
                  "deliveryPoint" in failure.acceptedResult
                    ? projectSendResult(
                        failure.acceptedResult,
                        parseProtocolOperationKey(failure.operationKey)
                          .generation,
                      )
                    : projectSpawnResult(failure.acceptedResult),
              }),
          ...(failure.cleanupCause === undefined
            ? {}
            : { cleanupCause: failure.cleanupCause }),
        },
      };
    case "protocol_version_mismatch":
      return {
        code: failure.code,
        facts: {
          requestedProtocolMajorVersion: failure.requestedProtocolMajorVersion,
          supportedProtocolMajorVersion: failure.supportedProtocolMajorVersion,
        },
      };
    case "runtime_scope_mismatch":
      return {
        code: failure.code,
        facts: {
          requestedRuntimeScopeId:
            failure.requestedRuntimeScopeId as unknown as RuntimeScopeId,
          actualRuntimeScopeId:
            failure.actualRuntimeScopeId as unknown as RuntimeScopeId,
        },
      };
    case "invalid_params":
      return {
        code: failure.code,
        facts: {
          issues: failure.issues.map((issue) =>
            issue.issue === "invalid_combination"
              ? {
                  ...issue,
                  paths: issue.paths.map(publicParameterPath),
                }
              : { ...issue, path: publicParameterPath(issue.path) },
          ),
        },
      };
    case "method_not_found":
      return { code: failure.code, facts: { method: failure.method } };
    case "unknown_harness":
      return {
        code: failure.code,
        facts: {
          harness: failure.harness,
          availableHarnesses: failure.availableHarnesses,
        },
      };
    case "unsupported_feature":
      return { code: failure.code, facts: { feature: failure.feature } };
    case "session_busy":
      return {
        code: failure.code,
        facts: {
          sessionHandle: parseSessionHandle(failure.sessionId),
        },
      };
    case "turn_precondition_failed":
      return {
        code: failure.code,
        facts: {
          sessionHandle: parseSessionHandle(failure.sessionId),
          expected: parseTurnHandle(
            encodeTurnHandle({
              sessionId: failure.sessionId,
              turnId: failure.expected,
            }),
          ),
          actual: parseTurnHandle(
            encodeTurnHandle({
              sessionId: failure.sessionId,
              turnId: failure.actual,
            }),
          ),
        },
      };
    case "session_not_found":
    case "session_killed":
    case "session_terminating":
      return {
        code: failure.code,
        facts: {
          sessionHandle: parseSessionHandle(failure.sessionId),
        },
      };
    case "permission_not_pending":
    case "permission_resolution_mismatch":
      return permissionHandle === undefined
        ? { code: "unexpected_failure", facts: { remoteCode: failure.code } }
        : { code: failure.code, facts: { permissionHandle } };
    case "diagnostic_not_found":
      return {
        code: failure.code,
        facts: {
          diagnosticId: parseDiagnosticId(failure.diagnosticId),
        },
      };
    case "diagnostics_unavailable":
      return { code: failure.code, facts: {} };
    case "turn_not_active":
      return {
        code: failure.code,
        facts: {
          turnHandle: parseTurnHandle(
            encodeTurnHandle({
              sessionId: failure.sessionId,
              turnId: failure.turnId,
            }),
          ),
        },
      };
    case "model_catalog_query_failed":
    case "diagnostics_store_corrupt":
      return {
        code: failure.code,
        facts: {
          ...(failure.cause === undefined ? {} : { cause: failure.cause }),
          ...(failure.diagnosticId === undefined
            ? {}
            : { diagnosticId: parseDiagnosticId(failure.diagnosticId) }),
        },
      };
    case "internal_error":
      return {
        code: failure.code,
        facts: {
          ...(failure.cause === undefined ? {} : { cause: failure.cause }),
          ...(failure.diagnosticId === undefined
            ? {}
            : { diagnosticId: parseDiagnosticId(failure.diagnosticId) }),
          ...(failure.cleanupCause === undefined
            ? {}
            : { cleanupCause: failure.cleanupCause }),
        },
      };
    case "daemon_start_failed":
      return {
        code: failure.code,
        facts: { cause: failure.cause },
      };
    default:
      return {
        code: "unexpected_failure",
        facts: { remoteCode: failure.code },
      };
  }
}

function publicParameterPath(path: string): string {
  return path.replace(/(^|\.)sessionId(?=\.|$)/gu, "$1sessionHandle");
}

function mapSessionInfo(session: ProtocolSessionInfo): SessionInfo {
  const sessionHandle = parseSessionHandle(session.sessionId);
  const common = {
    sessionHandle,
    ...(session.sessionLabel === undefined
      ? {}
      : { sessionLabel: session.sessionLabel }),
    harness: session.harness,
    model: session.model,
    reasoning: session.reasoning,
    cwd: session.cwd,
    spawnedAt: session.spawnedAt,
    turns: session.turns,
  };
  const lastCompletedTurn =
    session.lastCompletedTurn === undefined
      ? undefined
      : {
          turnHandle: parseTurnHandle(
            encodeTurnHandle({
              sessionId: session.sessionId,
              turnId: session.lastCompletedTurn.turnId,
            }),
          ),
          stopReason: session.lastCompletedTurn.stopReason,
        };

  if (session.state === "busy") {
    return {
      ...common,
      state: "busy",
      activeTurn: parseTurnHandle(
        encodeTurnHandle({
          sessionId: session.sessionId,
          turnId: session.activeTurnId,
        }),
      ),
      ...(lastCompletedTurn === undefined ? {} : { lastCompletedTurn }),
    };
  }
  if (session.state === "idle")
    return {
      ...common,
      state: "idle",
      lastCompletedTurn: lastCompletedTurn!,
    };
  if (session.state === "unreachable") {
    if (session.lastKnownState === "busy")
      return {
        ...common,
        state: "unreachable",
        lastKnownState: session.lastKnownState,
        lastKnownActiveTurn: parseTurnHandle(
          encodeTurnHandle({
            sessionId: session.sessionId,
            turnId: session.lastKnownActiveTurn,
          }),
        ),
        ...(lastCompletedTurn === undefined ? {} : { lastCompletedTurn }),
        unreachableReason: session.unreachableReason,
      };
    return {
      ...common,
      state: "unreachable",
      lastKnownState: session.lastKnownState,
      lastCompletedTurn: lastCompletedTurn!,
      unreachableReason: session.unreachableReason,
    };
  }
  return {
    ...common,
    state: "killed",
    ...(lastCompletedTurn === undefined ? {} : { lastCompletedTurn }),
  };
}
