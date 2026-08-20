import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";

import {
  AlreadyDiagnosedError,
  createAsyncQueue,
  type DiagnosticSink,
} from "@reins/adapter-kit";
import {
  makeTextEvidence,
  type DiagnosticId,
  type DiagnosticInput,
  type SessionId,
  type TurnId,
} from "@reins/protocol";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 1_000;
const STDERR_CHUNK_BYTES = 16 * 1024;

// adapter 私有：边界已写入 protocol_violation，调用方只需终止控制流。
export class ProtocolBoundaryError extends AlreadyDiagnosedError {}

export type CodexChild = {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr?: NodeJS.ReadableStream;
  on(event: "exit" | "error", listener: (error?: Error) => void): void;
  kill(signal?: NodeJS.Signals): boolean | void;
};

export type SpawnChild = (
  command: string,
  args: readonly string[],
  options: { readonly stdio: readonly ("pipe" | "inherit")[] },
) => CodexChild;

function spawnRealChild(
  command: string,
  args: readonly string[],
  options: { readonly stdio: readonly ("pipe" | "inherit")[] },
): CodexChild {
  const child = spawn(command, [...args], { stdio: [...options.stdio] });
  return {
    stdin: child.stdin as NodeJS.WritableStream,
    stdout: child.stdout as NodeJS.ReadableStream,
    ...(child.stderr === null ? {} : { stderr: child.stderr }),
    on: (event, listener) => {
      if (event === "error") child.on("error", listener);
      else child.on("exit", () => listener());
    },
    kill: (signal) => child.kill(signal),
  };
}

type ToolItemStatus = "inProgress" | "completed" | "failed" | "declined";

export type CodexInboundItem =
  | { type: "agentMessage"; id: string; text: string }
  | {
      type: "commandExecution";
      id: string;
      status: ToolItemStatus;
      output: string | null;
    }
  | { type: "fileChange"; id: string; status: ToolItemStatus; changes: string }
  | {
      type: "mcpToolCall";
      id: string;
      status: "inProgress" | "completed" | "failed";
      result: string;
      error: { message: string } | null;
    };

type TokenCounts = {
  totalTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
};

export type CodexTokenUsage = {
  total?: TokenCounts;
  last?: TokenCounts;
  modelContextWindow?: number;
};

type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

type FileSystemPath =
  | { type: "path"; path: string }
  | { type: "glob_pattern"; pattern: string }
  | {
      type: "special";
      value:
        | { kind: "root" | "minimal" | "tmpdir" | "slash_tmp" }
        | { kind: "project_roots"; subpath: string | null }
        | { kind: "unknown"; path: string; subpath: string | null };
    };

type RequestedPermissions = {
  network?: { enabled: boolean | null };
  fileSystem?: {
    read: readonly string[] | null;
    write: readonly string[] | null;
    globScanMaxDepth?: number;
    entries?: readonly {
      path: FileSystemPath;
      access: "read" | "write" | "deny";
    }[];
  };
};

export type CodexApprovalRequest = {
  kind: "request";
  id: number;
  method:
    | "item/commandExecution/requestApproval"
    | "item/fileChange/requestApproval"
    | "item/permissions/requestApproval";
  input: unknown;
  availableDecisions: readonly ApprovalDecision[];
  requestedPermissions: RequestedPermissions;
};

export type InboundMessage =
  | {
      kind: "notification";
      method: "item/agentMessage/delta";
      params: { itemId: string; delta: string };
    }
  | {
      kind: "notification";
      method: "item/started" | "item/completed";
      params: { item: CodexInboundItem };
    }
  | {
      kind: "notification";
      method: "thread/tokenUsage/updated";
      params: { tokenUsage: CodexTokenUsage };
    }
  | {
      kind: "notification";
      method: "turn/completed";
      params: {
        turn: { status: "completed" | "interrupted" | "failed" | "inProgress" };
      };
    }
  | {
      kind: "notification";
      method: "serverRequest/resolved";
      params: { requestId: number };
    }
  | CodexApprovalRequest
  | {
      kind: "request";
      id: number;
      method: "unsupported";
      nativeMethod: string;
    };

export type CodexModel = {
  model: string;
  displayName: string;
  supportedReasoningEfforts: readonly { reasoningEffort: string }[];
  hidden: boolean;
};

export type CodexRequestResultMap = {
  initialize: Record<string, never>;
  "thread/start": { thread: { id: string } };
  "turn/start": { turn: { id: string } };
  "turn/steer": Record<string, never>;
  "turn/interrupt": Record<string, never>;
  "thread/delete": Record<string, never>;
  "model/list": { data: readonly CodexModel[] };
};

export type CodexRequestMethod = keyof CodexRequestResultMap;

export type CodexDiagnosticContext = {
  sessionId: SessionId;
  turnId: TurnId | null;
};

// app-server 的 JSON-RPC 2.0 传输（jsonrpc 头省略，stdio JSONL）。
export type CodexTransport = {
  start(): void;
  request<TMethod extends CodexRequestMethod>(
    method: TMethod,
    params: unknown,
  ): Promise<CodexRequestResultMap[TMethod]>;
  notify(method: "initialized", params: Record<string, never>): void;
  respond(id: number, result: unknown): void;
  respondError(id: number, code: number, message: string): void;
  messages: AsyncIterable<InboundMessage>;
  close(): Promise<void>;
};

export function createCodexTransport(options: {
  binaryPath?: string;
  spawnChild?: SpawnChild;
  requestTimeoutMs?: number;
  shutdownGraceMs?: number;
  captureHarnessStderr?: boolean;
  diagnostics?: DiagnosticSink;
  diagnosticContext?: () => CodexDiagnosticContext | null;
}): CodexTransport {
  let child: CodexChild | null = null;
  let nextId = 0;
  let closed = false;
  let childSettled = false;
  let shutdownTimer: ReturnType<typeof setTimeout> | null = null;
  let closePromise: Promise<void> | null = null;
  let closeFailure: unknown;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  const pending = new Map<
    number,
    {
      method: CodexRequestMethod;
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const inbox = createAsyncQueue<InboundMessage>();
  let inboxFailure: unknown;
  const stderrDecoder = new StringDecoder("utf8");
  let stderrDecoderBytes = 0;
  let stderrStream: NodeJS.ReadableStream | null = null;
  let stderrWork = Promise.resolve();
  let stderrFinishing = false;
  let stderrFinished = options.captureHarnessStderr !== true;
  let resolveStderrDone: (() => void) | null = null;
  const stderrDone =
    options.captureHarnessStderr === true
      ? new Promise<void>((resolve) => {
          resolveStderrDone = resolve;
        })
      : Promise.resolve();
  let resolveStdoutDone: (() => void) | null = null;
  const stdoutDone = new Promise<void>((resolve) => {
    resolveStdoutDone = resolve;
  });
  let stdoutFinished = false;

  function clearShutdownTimerWhenDrained(): void {
    if (!stdoutFinished || !stderrFinished || shutdownTimer === null) return;
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }

  async function record(
    input: DiagnosticInput,
  ): Promise<DiagnosticId | undefined> {
    if (options.diagnostics === undefined) return undefined;
    try {
      return await options.diagnostics(input);
    } catch {
      return undefined;
    }
  }

  function protocolViolation(
    ...[operation, reason, line]:
      | [
          "decode_worker_message",
          "invalid_json" | "invalid_shape" | "unexpected_message",
          string,
        ]
      | [
          "validate_worker_response" | "validate_worker_event",
          "invalid_shape" | "unexpected_message",
          string,
        ]
  ): Promise<DiagnosticId | undefined> {
    const message = makeTextEvidence(line);
    const context = options.diagnosticContext?.() ?? null;
    if (context === null) {
      if (operation === "decode_worker_message") {
        return record({
          source: "adapter",
          harness: "codex",
          kind: "protocol_violation",
          operation,
          reason,
          message,
        });
      } else {
        return record({
          source: "adapter",
          harness: "codex",
          kind: "protocol_violation",
          operation,
          reason,
          message,
        });
      }
    }
    if (operation === "decode_worker_message") {
      return record({
        source: "adapter",
        harness: "codex",
        sessionId: context.sessionId,
        ...(context.turnId === null ? {} : { turnId: context.turnId }),
        kind: "protocol_violation",
        operation,
        reason,
        message,
      });
    } else {
      return record({
        source: "adapter",
        harness: "codex",
        sessionId: context.sessionId,
        ...(context.turnId === null ? {} : { turnId: context.turnId }),
        kind: "protocol_violation",
        operation,
        reason,
        message,
      });
    }
  }

  async function emitHarnessStderr(
    text: string,
    context: CodexDiagnosticContext | null,
    originalBytes = Buffer.byteLength(text, "utf8"),
  ): Promise<void> {
    if (text.length === 0) return;
    let chunk = "";
    let chunkBytes = 0;
    let textBytesRemaining = Buffer.byteLength(text, "utf8");
    let sourceBytesRemaining = originalBytes;
    async function emit(): Promise<void> {
      if (chunkBytes === 0 || options.diagnostics === undefined) return;
      if (context === null) return;
      const chunkOriginalBytes =
        chunkBytes === textBytesRemaining
          ? sourceBytesRemaining
          : Math.min(chunkBytes, sourceBytesRemaining);
      try {
        await options.diagnostics({
          source: "harness",
          harness: "codex",
          sessionId: context.sessionId,
          ...(context.turnId === null ? {} : { turnId: context.turnId }),
          kind: "harness_stderr",
          operation: "worker_process",
          reason: "stderr_output",
          text: {
            text: chunk,
            truncated: false,
            originalBytes: chunkOriginalBytes,
          },
        });
      } catch {
        // 诊断 sink 的失败由其 owner 暴露，stderr 读取必须继续。
      }
      textBytesRemaining -= chunkBytes;
      sourceBytesRemaining -= chunkOriginalBytes;
    }
    for (const character of text) {
      const characterBytes = Buffer.byteLength(character, "utf8");
      if (chunkBytes + characterBytes > STDERR_CHUNK_BYTES) {
        await emit();
        chunk = "";
        chunkBytes = 0;
      }
      chunk += character;
      chunkBytes += characterBytes;
    }
    if (chunkBytes > 0) {
      await emit();
    }
  }

  function consumeHarnessStderr(value: Buffer | string): void {
    const stream = stderrStream;
    stream?.pause();
    const bytes = typeof value === "string" ? Buffer.from(value) : value;
    const context = options.diagnosticContext?.() ?? null;
    stderrWork = stderrWork
      .then(async () => {
        for (
          let offset = 0;
          offset < bytes.byteLength;
          offset += STDERR_CHUNK_BYTES
        ) {
          const slice = bytes.subarray(
            offset,
            Math.min(offset + STDERR_CHUNK_BYTES, bytes.byteLength),
          );
          stderrDecoderBytes += slice.byteLength;
          const decoded = stderrDecoder.write(slice);
          const decodedBytes = Buffer.byteLength(decoded, "utf8");
          if (decodedBytes > 0) {
            await emitHarnessStderr(decoded, context, decodedBytes);
            stderrDecoderBytes = Math.max(0, stderrDecoderBytes - decodedBytes);
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!stderrFinishing) stream?.resume();
      });
  }

  function finishHarnessStderr(force = false): Promise<void> {
    if (stderrFinishing) return stderrDone;
    stderrFinishing = true;
    const context = options.diagnosticContext?.() ?? null;
    stderrWork = stderrWork
      .then(async () => {
        const tail = stderrDecoder.end();
        const originalBytes = stderrDecoderBytes;
        stderrDecoderBytes = 0;
        await emitHarnessStderr(tail, context, originalBytes);
      })
      .catch(() => {})
      .finally(() => {
        stderrFinished = true;
        resolveStderrDone?.();
        resolveStderrDone = null;
        clearShutdownTimerWhenDrained();
      });
    if (force) {
      stderrFinished = true;
      resolveStderrDone?.();
      resolveStderrDone = null;
      clearShutdownTimerWhenDrained();
    }
    return stderrDone;
  }

  function push(message: InboundMessage): void {
    inbox.push(message);
  }

  function finishStdout(): void {
    if (stdoutFinished) return;
    stdoutFinished = true;
    closed = true;
    inbox.end();
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("codex app-server closed"));
    }
    pending.clear();
    resolveStdoutDone?.();
    resolveStdoutDone = null;
    clearShutdownTimerWhenDrained();
  }

  function destroyStream(stream: NodeJS.ReadableStream | null): void {
    if (stream === null) return;
    const destroy = (
      stream as NodeJS.ReadableStream & {
        destroy?: (error?: Error) => void;
      }
    ).destroy;
    try {
      destroy?.call(stream);
    } catch {
      // 输出面已在强制收口，destroy 失败不得让 close 挂起。
    }
  }

  function forceDrain(): void {
    destroyStream(child?.stdout ?? null);
    destroyStream(stderrStream);
    void finishHarnessStderr(true);
    finishStdout();
  }

  function scheduleForcedDrain(): void {
    if (shutdownTimer !== null) return;
    shutdownTimer = setTimeout(() => {
      shutdownTimer = null;
      if (!childSettled) {
        try {
          const killed = child?.kill("SIGKILL");
          if (killed === false && closeFailure === undefined) {
            closeFailure = new Error("codex app-server rejected SIGKILL");
          }
        } catch (error) {
          closeFailure ??= error;
        }
      }
      forceDrain();
    }, shutdownGraceMs);
  }

  function settleChild(): void {
    childSettled = true;
    if (closed) {
      scheduleForcedDrain();
      return;
    }
    closed = true;
    scheduleForcedDrain();
  }

  function failChild(error?: Error): void {
    inboxFailure ??= error ?? new Error("codex app-server process error");
    settleChild();
  }

  function write(payload: unknown): void {
    if (child === null || closed) return;
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  function hasOwn(value: Record<string, unknown>, property: string): boolean {
    return Object.hasOwn(value, property);
  }

  function isValidId(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value);
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  const ignoredItemTypes = new Set([
    "userMessage",
    "hookPrompt",
    "plan",
    "reasoning",
    "dynamicToolCall",
    "collabAgentToolCall",
    "subAgentActivity",
    "webSearch",
    "imageView",
    "sleep",
    "imageGeneration",
    "enteredReviewMode",
    "exitedReviewMode",
    "contextCompaction",
  ]);

  function parseToolStatus(value: unknown): ToolItemStatus | null {
    return value === "inProgress" ||
      value === "completed" ||
      value === "failed" ||
      value === "declined"
      ? value
      : null;
  }

  function parseItem(
    value: unknown,
  ):
    | { status: "mapped"; item: CodexInboundItem }
    | { status: "ignored" }
    | null {
    if (!isRecord(value) || typeof value.type !== "string") return null;
    if (ignoredItemTypes.has(value.type)) {
      return typeof value.id === "string" ? { status: "ignored" } : null;
    }
    if (typeof value.id !== "string") return null;
    if (value.type === "agentMessage") {
      return typeof value.text === "string"
        ? {
            status: "mapped",
            item: { type: "agentMessage", id: value.id, text: value.text },
          }
        : null;
    }
    if (value.type === "commandExecution") {
      const status = parseToolStatus(value.status);
      if (
        status === null ||
        (value.aggregatedOutput !== null &&
          typeof value.aggregatedOutput !== "string")
      )
        return null;
      return {
        status: "mapped",
        item: {
          type: "commandExecution",
          id: value.id,
          status,
          output: value.aggregatedOutput,
        },
      };
    }
    if (value.type === "fileChange") {
      const status = parseToolStatus(value.status);
      if (status === null || !Array.isArray(value.changes)) return null;
      return {
        status: "mapped",
        item: {
          type: "fileChange",
          id: value.id,
          status,
          changes: JSON.stringify(value.changes),
        },
      };
    }
    if (value.type === "mcpToolCall") {
      const status = parseToolStatus(value.status);
      const error = value.error;
      if (
        status === null ||
        status === "declined" ||
        !hasOwn(value, "result") ||
        (error !== null &&
          (!isRecord(error) || typeof error.message !== "string"))
      )
        return null;
      return {
        status: "mapped",
        item: {
          type: "mcpToolCall",
          id: value.id,
          status,
          result: JSON.stringify(value.result),
          error: error === null ? null : { message: error.message as string },
        },
      };
    }
    return null;
  }

  const tokenCountFields = [
    "totalTokens",
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
  ] as const;

  function parseTokenCounts(value: unknown): TokenCounts | null {
    if (!isRecord(value)) return null;
    const result: TokenCounts = {};
    for (const field of tokenCountFields) {
      const count = value[field];
      if (count !== undefined && typeof count !== "number") return null;
      if (typeof count === "number") result[field] = count;
    }
    return result;
  }

  function parseTokenUsage(value: unknown): CodexTokenUsage | null {
    if (!isRecord(value)) return null;
    const total =
      value.total === undefined ? undefined : parseTokenCounts(value.total);
    const last =
      value.last === undefined ? undefined : parseTokenCounts(value.last);
    if (total === null || last === null) return null;
    if (
      value.modelContextWindow !== undefined &&
      typeof value.modelContextWindow !== "number"
    )
      return null;
    return {
      ...(total === undefined ? {} : { total }),
      ...(last === undefined ? {} : { last }),
      ...(typeof value.modelContextWindow === "number"
        ? { modelContextWindow: value.modelContextWindow }
        : {}),
    };
  }

  function parseNotification(
    method: string,
    params: unknown,
  ): InboundMessage | "ignored" | null {
    if (
      method !== "item/agentMessage/delta" &&
      method !== "item/started" &&
      method !== "item/completed" &&
      method !== "thread/tokenUsage/updated" &&
      method !== "turn/completed" &&
      method !== "serverRequest/resolved"
    )
      return "ignored";
    if (!isRecord(params)) return null;
    if (method === "item/agentMessage/delta") {
      return typeof params.itemId === "string" &&
        typeof params.delta === "string"
        ? {
            kind: "notification",
            method,
            params: { itemId: params.itemId, delta: params.delta },
          }
        : null;
    }
    if (method === "item/started" || method === "item/completed") {
      const parsed = parseItem(params.item);
      if (parsed === null) return null;
      return parsed.status === "ignored"
        ? "ignored"
        : {
            kind: "notification",
            method,
            params: { item: parsed.item },
          };
    }
    if (method === "thread/tokenUsage/updated") {
      const tokenUsage = parseTokenUsage(params.tokenUsage);
      return tokenUsage === null
        ? null
        : { kind: "notification", method, params: { tokenUsage } };
    }
    if (method === "turn/completed") {
      if (!isRecord(params.turn)) return null;
      const status = params.turn.status;
      return status === "completed" ||
        status === "interrupted" ||
        status === "failed" ||
        status === "inProgress"
        ? { kind: "notification", method, params: { turn: { status } } }
        : null;
    }
    return isValidId(params.requestId)
      ? {
          kind: "notification",
          method: "serverRequest/resolved",
          params: { requestId: params.requestId },
        }
      : null;
  }

  function parseApprovalRequest(
    id: number,
    method: string,
    params: unknown,
  ): Extract<InboundMessage, { kind: "request" }> | "unsupported" | null {
    if (
      method !== "item/commandExecution/requestApproval" &&
      method !== "item/fileChange/requestApproval" &&
      method !== "item/permissions/requestApproval"
    )
      return "unsupported";
    if (!isRecord(params)) return null;
    const rawDecisions = params.availableDecisions;
    if (rawDecisions !== undefined && !Array.isArray(rawDecisions)) return null;
    const availableDecisions: ApprovalDecision[] = [];
    for (const decision of rawDecisions ?? [
      "accept",
      "acceptForSession",
      "decline",
    ]) {
      if (
        decision !== "accept" &&
        decision !== "acceptForSession" &&
        decision !== "decline" &&
        decision !== "cancel"
      )
        return null;
      availableDecisions.push(decision);
    }
    if (availableDecisions.length === 0) return null;
    const permissions = params.permissions;
    if (permissions !== undefined && !isRecord(permissions)) return null;
    const requestedPermissions = parseRequestedPermissions(permissions);
    if (requestedPermissions === null) return null;
    return {
      kind: "request",
      id,
      method,
      input: params,
      availableDecisions,
      requestedPermissions,
    };
  }

  function parseFileSystemPath(value: unknown): FileSystemPath | null {
    if (!isRecord(value)) return null;
    if (value.type === "path" && typeof value.path === "string") {
      return { type: "path", path: value.path };
    }
    if (value.type === "glob_pattern" && typeof value.pattern === "string") {
      return { type: "glob_pattern", pattern: value.pattern };
    }
    if (value.type !== "special" || !isRecord(value.value)) return null;
    const special = value.value;
    if (
      special.kind === "root" ||
      special.kind === "minimal" ||
      special.kind === "tmpdir" ||
      special.kind === "slash_tmp"
    ) {
      return { type: "special", value: { kind: special.kind } };
    }
    if (
      special.kind === "project_roots" &&
      (special.subpath === null || typeof special.subpath === "string")
    ) {
      return {
        type: "special",
        value: { kind: special.kind, subpath: special.subpath },
      };
    }
    if (
      special.kind === "unknown" &&
      typeof special.path === "string" &&
      (special.subpath === null || typeof special.subpath === "string")
    ) {
      return {
        type: "special",
        value: {
          kind: special.kind,
          path: special.path,
          subpath: special.subpath,
        },
      };
    }
    return null;
  }

  function parseStringArray(value: unknown): readonly string[] | null {
    return Array.isArray(value) &&
      value.every((entry): entry is string => typeof entry === "string")
      ? value
      : null;
  }

  function parseRequestedPermissions(
    value: Record<string, unknown> | undefined,
  ): RequestedPermissions | null {
    if (value === undefined) return {};
    let network: RequestedPermissions["network"];
    if (value.network !== undefined && value.network !== null) {
      if (
        !isRecord(value.network) ||
        (value.network.enabled !== null &&
          typeof value.network.enabled !== "boolean")
      )
        return null;
      network = { enabled: value.network.enabled };
    }
    let fileSystem: RequestedPermissions["fileSystem"];
    if (value.fileSystem !== undefined && value.fileSystem !== null) {
      if (!isRecord(value.fileSystem)) return null;
      const read =
        value.fileSystem.read === null
          ? null
          : parseStringArray(value.fileSystem.read);
      const write =
        value.fileSystem.write === null
          ? null
          : parseStringArray(value.fileSystem.write);
      if (read === null && value.fileSystem.read !== null) return null;
      if (write === null && value.fileSystem.write !== null) return null;
      if (
        value.fileSystem.globScanMaxDepth !== undefined &&
        typeof value.fileSystem.globScanMaxDepth !== "number"
      )
        return null;
      let entries: NonNullable<RequestedPermissions["fileSystem"]>["entries"];
      if (value.fileSystem.entries !== undefined) {
        if (!Array.isArray(value.fileSystem.entries)) return null;
        const parsedEntries: NonNullable<
          NonNullable<RequestedPermissions["fileSystem"]>["entries"]
        >[number][] = [];
        for (const entry of value.fileSystem.entries) {
          if (!isRecord(entry)) return null;
          const path = parseFileSystemPath(entry.path);
          if (
            path === null ||
            (entry.access !== "read" &&
              entry.access !== "write" &&
              entry.access !== "deny")
          )
            return null;
          parsedEntries.push({ path, access: entry.access });
        }
        entries = parsedEntries;
      }
      fileSystem = {
        read,
        write,
        ...(typeof value.fileSystem.globScanMaxDepth === "number"
          ? { globScanMaxDepth: value.fileSystem.globScanMaxDepth }
          : {}),
        ...(entries === undefined ? {} : { entries }),
      };
    }
    return {
      ...(network === undefined ? {} : { network }),
      ...(fileSystem === undefined ? {} : { fileSystem }),
    };
  }

  function parseModel(value: unknown): CodexModel | null {
    if (
      !isRecord(value) ||
      typeof value.model !== "string" ||
      typeof value.displayName !== "string" ||
      typeof value.hidden !== "boolean" ||
      !Array.isArray(value.supportedReasoningEfforts)
    )
      return null;
    const efforts: { reasoningEffort: string }[] = [];
    for (const effort of value.supportedReasoningEfforts) {
      if (!isRecord(effort) || typeof effort.reasoningEffort !== "string")
        return null;
      efforts.push({ reasoningEffort: effort.reasoningEffort });
    }
    return {
      model: value.model,
      displayName: value.displayName,
      hidden: value.hidden,
      supportedReasoningEfforts: efforts,
    };
  }

  function parseResponseResult(
    method: CodexRequestMethod,
    result: unknown,
  ): CodexRequestResultMap[CodexRequestMethod] | null {
    if (!isRecord(result)) return null;
    if (method === "thread/start")
      return isRecord(result.thread) && typeof result.thread.id === "string"
        ? { thread: { id: result.thread.id } }
        : null;
    if (method === "turn/start")
      return isRecord(result.turn) && typeof result.turn.id === "string"
        ? { turn: { id: result.turn.id } }
        : null;
    if (method === "model/list") {
      if (!Array.isArray(result.data)) return null;
      const data: CodexModel[] = [];
      for (const value of result.data) {
        const model = parseModel(value);
        if (model === null) return null;
        data.push(model);
      }
      return { data };
    }
    return {};
  }

  function validResponseError(value: unknown): boolean {
    return (
      isRecord(value) &&
      typeof value.code === "number" &&
      typeof value.message === "string"
    );
  }

  function handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      void protocolViolation("decode_worker_message", "invalid_json", line);
      return;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      void protocolViolation("decode_worker_message", "invalid_shape", line);
      return;
    }
    const message = parsed as Record<string, unknown>;
    const hasMethod = hasOwn(message, "method");
    const hasId = hasOwn(message, "id");
    const hasResult = hasOwn(message, "result");
    const hasError = hasOwn(message, "error");

    if (hasMethod) {
      if (typeof message.method !== "string") {
        void protocolViolation("validate_worker_event", "invalid_shape", line);
        return;
      }
      if (hasResult || hasError) {
        void protocolViolation(
          "validate_worker_event",
          "unexpected_message",
          line,
        );
        return;
      }
      if (!hasId) {
        const notification = parseNotification(message.method, message.params);
        if (notification === null) {
          void protocolViolation(
            "validate_worker_event",
            "invalid_shape",
            line,
          );
          return;
        }
        if (notification !== "ignored") push(notification);
        return;
      }
      if (!isValidId(message.id)) {
        void protocolViolation("validate_worker_event", "invalid_shape", line);
        return;
      }
      const request = parseApprovalRequest(
        message.id,
        message.method,
        message.params,
      );
      if (request === null) {
        void protocolViolation("validate_worker_event", "invalid_shape", line);
        write({
          id: message.id,
          error: { code: -32602, message: "Invalid server request" },
        });
        return;
      }
      push(
        request === "unsupported"
          ? {
              kind: "request",
              id: message.id,
              method: "unsupported",
              nativeMethod: message.method,
            }
          : request,
      );
      return;
    }

    if (!hasId || !isValidId(message.id)) {
      void protocolViolation("validate_worker_response", "invalid_shape", line);
      return;
    }
    const entry = pending.get(message.id);
    if (entry === undefined) {
      void protocolViolation(
        "validate_worker_response",
        "unexpected_message",
        line,
      );
      return;
    }
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (hasResult === hasError) {
      void protocolViolation(
        "validate_worker_response",
        hasResult ? "unexpected_message" : "invalid_shape",
        line,
      ).then((diagnosticId) => {
        entry.reject(
          new ProtocolBoundaryError(
            "codex app-server response had invalid shape",
            diagnosticId,
          ),
        );
      });
      return;
    }
    if (hasError) {
      if (validResponseError(message.error)) {
        entry.reject(new Error(JSON.stringify(message.error)));
      } else {
        void protocolViolation(
          "validate_worker_response",
          "invalid_shape",
          line,
        ).then((diagnosticId) => {
          entry.reject(
            new ProtocolBoundaryError(
              "codex app-server error response had invalid shape",
              diagnosticId,
            ),
          );
        });
      }
    } else {
      const result = parseResponseResult(entry.method, message.result);
      if (result === null) {
        void protocolViolation(
          "validate_worker_response",
          "invalid_shape",
          line,
        ).then((diagnosticId) => {
          entry.reject(
            new ProtocolBoundaryError(
              "codex app-server response had invalid shape",
              diagnosticId,
            ),
          );
        });
      } else {
        entry.resolve(result);
      }
    }
  }

  return {
    start() {
      const doSpawn = options.spawnChild ?? spawnRealChild;
      try {
        child = doSpawn(
          options.binaryPath ?? "codex",
          ["app-server", "--listen", "stdio://"],
          {
            stdio: [
              "pipe",
              "pipe",
              options.captureHarnessStderr === true ? "pipe" : "inherit",
            ],
          },
        );
      } catch (error) {
        closed = true;
        forceDrain();
        throw error;
      }
      child.on("exit", settleChild);
      child.on("error", failChild);
      if (options.captureHarnessStderr === true) {
        if (child.stderr === undefined) {
          try {
            child.kill("SIGTERM");
          } catch {
            // start 失败保留原始 cause，同时继续强制收口。
          }
          closed = true;
          forceDrain();
          throw new Error("codex stderr capture unavailable");
        }
        stderrStream = child.stderr;
        child.stderr.on("data", consumeHarnessStderr);
        child.stderr.on("end", () => {
          void finishHarnessStderr();
        });
        child.stderr.on("close", () => {
          void finishHarnessStderr();
        });
      }
      const lines = createInterface({ input: child.stdout });
      lines.on("line", handleLine);
      lines.on("close", finishStdout);
      child.stdout.on("error", (error: unknown) => {
        inboxFailure ??= error;
        finishStdout();
      });
    },
    request<TMethod extends CodexRequestMethod>(
      method: TMethod,
      params: unknown,
    ): Promise<CodexRequestResultMap[TMethod]> {
      if (closed) {
        return Promise.reject(new Error("codex app-server closed"));
      }
      nextId += 1;
      const id = nextId;
      return new Promise<CodexRequestResultMap[TMethod]>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`codex app-server request timed out: ${method}`));
        }, requestTimeoutMs);
        pending.set(id, {
          method,
          resolve: (value) => resolve(value as CodexRequestResultMap[TMethod]),
          reject,
          timer,
        });
        write({ id, method, params });
      });
    },
    notify(method, params) {
      write({ method, params });
    },
    respond(id, result) {
      write({ id, result });
    },
    respondError(id, code, message) {
      write({ id, error: { code, message } });
    },
    messages: {
      async *[Symbol.asyncIterator]() {
        for await (const message of inbox) yield message;
        if (inboxFailure !== undefined) throw inboxFailure;
      },
    },
    async close() {
      closePromise ??= (async () => {
        closed = true;
        try {
          const killed = child?.kill("SIGTERM");
          if (killed === false) {
            closeFailure = new Error("codex app-server rejected SIGTERM");
          }
        } catch (error) {
          closeFailure = error;
        }
        scheduleForcedDrain();
        await Promise.all([stdoutDone, stderrDone]);
        if (shutdownTimer !== null) {
          clearTimeout(shutdownTimer);
          shutdownTimer = null;
        }
        if (closeFailure !== undefined) throw closeFailure;
      })();
      await closePromise;
    },
  };
}
