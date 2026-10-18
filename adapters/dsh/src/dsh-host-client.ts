import { fork, type ChildProcess } from "node:child_process";

import {
  isHostMessage,
  type DshHostCommand,
  type DshHostEvent,
  type DshHostResponse,
  type DshSafeFailure,
} from "./dsh-host-protocol.ts";

type DshHostCommandInput = DshHostCommand extends infer TCommand
  ? TCommand extends { readonly id: number }
    ? Omit<TCommand, "id">
    : never
  : never;

export class DshHostRequestError extends Error {
  readonly acceptance: "not_accepted" | "unknown";
  readonly failure: DshSafeFailure | undefined;

  constructor(
    message: string,
    acceptance: "not_accepted" | "unknown",
    failure?: DshSafeFailure,
  ) {
    super(message);
    this.acceptance = acceptance;
    this.failure = failure;
  }
}

type PendingRequest = {
  readonly type: DshHostCommand["type"];
  readonly resolve: (response: DshHostResponse) => void;
  readonly reject: (error: DshHostRequestError) => void;
};

const HOST_READY_TIMEOUT_MS = 60_000;
const HOST_COMMAND_TIMEOUT_MS = 120_000;
const HOST_CLOSE_TIMEOUT_MS = 15_000;

function acceptanceAfterSend(
  type: DshHostCommand["type"],
): "not_accepted" | "unknown" {
  return type === "start" ||
    type === "deliver" ||
    type === "interrupt" ||
    type === "close"
    ? "unknown"
    : "not_accepted";
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeout: () => Error,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(timeout()), timeoutMs);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export class DshHostClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<(event: DshHostEvent) => void>();
  private readonly exitListeners = new Set<() => void>();
  private readonly readyPromise: Promise<void>;
  private readonly exitPromise: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
  private resolveReady!: () => void;
  private rejectReady!: (error: DshHostRequestError) => void;
  private resolveExit!: (value: {
    code: number | null;
    signal: NodeJS.Signals | null;
  }) => void;
  private nextId = 0;
  private spawned = false;
  private ready = false;
  private exited = false;
  private closedNormally = false;

  constructor(options: {
    readonly cwd: string;
    readonly env?: NodeJS.ProcessEnv;
  }) {
    const entrypoint = process.argv[1];
    if (entrypoint === undefined)
      throw new DshHostRequestError(
        "The Reins runtime entry point is unavailable",
        "not_accepted",
      );
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.child = fork(entrypoint, ["--reins-dsh-runtime-host"], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      execArgv: process.execArgv,
      detached: process.platform !== "win32",
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.child.once("spawn", () => {
      this.spawned = true;
    });
    this.child.on("message", (message: unknown) => this.onMessage(message));
    this.child.once("error", () => {
      const error = new DshHostRequestError(
        "The Reins DSH host process failed",
        this.ready ? "unknown" : "not_accepted",
      );
      if (this.spawned) {
        if (!this.ready) this.rejectReady(error);
        this.failPending(error);
      } else {
        this.completeExit({ code: null, signal: null }, error);
      }
    });
    this.child.once("exit", (code, signal) => {
      this.completeExit(
        { code, signal },
        new DshHostRequestError(
          "The Reins DSH host exited before replying",
          this.ready ? "unknown" : "not_accepted",
        ),
      );
    });
  }

  onEvent(listener: (event: DshHostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onExit(listener: () => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async readyHost(): Promise<void> {
    await withTimeout(
      this.readyPromise,
      HOST_READY_TIMEOUT_MS,
      () =>
        new DshHostRequestError(
          "The official DSH profile did not become ready",
          "not_accepted",
        ),
    );
  }

  async request(command: DshHostCommandInput): Promise<DshHostResponse> {
    if (this.exited || this.child.connected !== true)
      throw new DshHostRequestError(
        "The Reins DSH host process is unavailable",
        "not_accepted",
      );
    this.nextId += 1;
    const id = this.nextId;
    const type = command.type;
    const responsePromise = new Promise<DshHostResponse>((resolve, reject) => {
      this.pending.set(id, { type, resolve, reject });
    });
    try {
      this.child.send({ ...command, id }, (error) => {
        if (error === null || error === undefined) return;
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        this.pending.delete(id);
        pending.reject(
          new DshHostRequestError(
            "The Reins DSH host command could not be delivered",
            "unknown",
          ),
        );
      });
    } catch {
      const pending = this.pending.get(id);
      if (pending !== undefined) {
        this.pending.delete(id);
        pending.reject(
          new DshHostRequestError(
            "The Reins DSH host command could not be sent",
            "not_accepted",
          ),
        );
      }
    }
    try {
      return await withTimeout(
        responsePromise,
        command.type === "close"
          ? HOST_CLOSE_TIMEOUT_MS
          : HOST_COMMAND_TIMEOUT_MS,
        () =>
          new DshHostRequestError(
            "The Reins DSH host command timed out",
            acceptanceAfterSend(type),
          ),
      );
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closedNormally) return;
    if (this.exited && !this.spawned) {
      this.closedNormally = true;
      return;
    }
    if (this.exited)
      throw new DshHostRequestError(
        "The DSH host exited before normal shutdown was requested",
        "unknown",
      );
    try {
      await this.readyHost();
      const response = await this.request({ type: "close" });
      if (response.type !== "closed")
        throw new DshHostRequestError(
          "The official DSH profile did not shut down normally",
          "unknown",
          "failure" in response ? response.failure : undefined,
        );
      const exit = await withTimeout(
        this.exitPromise,
        HOST_CLOSE_TIMEOUT_MS,
        () =>
          new DshHostRequestError(
            "The Reins DSH host did not exit after shutdown",
            "unknown",
          ),
      );
      if (exit.code !== 0)
        throw new DshHostRequestError(
          "The Reins DSH host exited with an error",
          "unknown",
        );
      this.closedNormally = true;
    } catch (error) {
      await this.terminateOwnProcess();
      throw error;
    }
  }

  async terminateOwnProcess(): Promise<void> {
    if (this.exited) return;
    this.signalProcessTree("SIGTERM");
    try {
      await withTimeout(
        this.exitPromise,
        HOST_CLOSE_TIMEOUT_MS,
        () => new Error("The DSH host did not exit after SIGTERM"),
      );
    } catch {
      this.signalProcessTree("SIGKILL");
      await withTimeout(
        this.exitPromise,
        HOST_CLOSE_TIMEOUT_MS,
        () => new Error("The DSH host did not exit after SIGKILL"),
      );
    }
  }

  private signalProcessTree(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined) return;
    try {
      process.kill(process.platform === "win32" ? pid : -pid, signal);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      )
        return;
      this.child.kill(signal);
    }
  }

  private onMessage(message: unknown): void {
    if (!isHostMessage(message)) return;
    if ("id" in message && typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      if (message.type === "fatal") {
        pending.reject(
          new DshHostRequestError(
            "The official DSH host command failed",
            acceptanceAfterSend(pending.type),
            message.failure,
          ),
        );
      } else if (message.type === "rejected") {
        pending.reject(
          new DshHostRequestError(
            "The official DSH rejected the request",
            message.acceptance,
            message.failure,
          ),
        );
      } else if (message.type === "catalog-failed") {
        pending.reject(
          new DshHostRequestError(
            "The official DSH model catalog query failed",
            "not_accepted",
            message.failure,
          ),
        );
      } else {
        pending.resolve(message);
      }
      return;
    }
    if (message.type === "ready") {
      this.ready = true;
      this.resolveReady();
    } else if (message.type === "fatal") {
      const error = new DshHostRequestError(
        "The official DSH profile failed",
        this.pending.size === 0 ? "not_accepted" : "unknown",
        message.failure,
      );
      if (!this.ready) this.rejectReady(error);
      this.failPending(error);
    } else if (
      message.type === "session-event" ||
      message.type === "assistant-stream"
    ) {
      for (const listener of this.listeners) listener(message);
    }
  }

  private failPending(error: DshHostRequestError): void {
    for (const pending of this.pending.values()) {
      pending.reject(
        new DshHostRequestError(
          error.message,
          error.acceptance === "not_accepted"
            ? "not_accepted"
            : acceptanceAfterSend(pending.type),
          error.failure,
        ),
      );
    }
    this.pending.clear();
  }

  private completeExit(
    exit: { code: number | null; signal: NodeJS.Signals | null },
    error: DshHostRequestError,
  ): void {
    if (this.exited) return;
    this.exited = true;
    this.resolveExit(exit);
    if (!this.ready) this.rejectReady(error);
    this.failPending(error);
    for (const listener of this.exitListeners) listener();
  }
}
