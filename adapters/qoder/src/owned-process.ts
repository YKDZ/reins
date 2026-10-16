import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Duplex } from "node:stream";

import type {
  SpawnOptions,
  SpawnedProcess,
} from "@qodercn-ai/qodercn-agent-sdk";

import { resolveQoderResourceHolderPath } from "./holder-path.ts";

type ControlRequest = {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type Waiter = {
  resolve: () => void;
  reject: (error: Error) => void;
};

const processExitTimeoutMs = 5_000;
const owners = new WeakMap<object, OwnedProcessTree>();

function cleanupError(message: string, cause?: unknown): Error {
  return new Error(`Qoder owned-process cleanup failed: ${message}`, { cause });
}

function errnoName(errno: number): string {
  if (errno === 1) return "EPERM";
  if (errno === 2) return "ENOENT";
  if (errno === 3) return "ESRCH";
  if (errno === 13) return "EACCES";
  return `errno ${errno}`;
}

class OwnedRuntimeProcess {
  private readonly child: ChildProcess;
  private readonly control: Duplex;
  private readonly requests = new Map<number, ControlRequest>();
  private readonly waiters = new Set<Waiter>();
  private nextRequestId = 1;
  private completeReceived = false;
  private holderExited = false;
  private holderExitCode: number | null = null;
  private failure: Error | undefined;
  private closed = false;
  private readonly abortSignal: AbortSignal;
  private readonly abortListener: () => void;

  constructor(options: SpawnOptions) {
    if (process.platform !== "linux" || process.arch !== "x64") {
      throw cleanupError("the resource holder requires Linux x64");
    }

    const helperPath = resolveQoderResourceHolderPath();
    const command =
      options.command === "node" ? process.execPath : options.command;
    this.child = spawn(helperPath, ["--", command, ...options.args], {
      argv0: helperPath,
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    this.child.stderr?.resume();

    const control = this.child.stdio[3];
    if (control === null || control === undefined || !("write" in control)) {
      this.child.kill("SIGKILL");
      throw cleanupError("could not create the holder control channel");
    }
    this.control = control as Duplex;
    this.readControlMessages();

    this.abortSignal = options.signal;
    this.abortListener = () => {
      // SDK 的 abort 会先关闭 stdin，公开 transport 随后调用 kill。
      // 此控制通知确保信号始终由 holder 协议处理。
      this.sendAbortRequest();
    };
    if (this.abortSignal.aborted) this.abortListener();
    else
      this.abortSignal.addEventListener("abort", this.abortListener, {
        once: true,
      });

    this.child.once("error", (error) => {
      this.reportFailure(
        cleanupError("resource holder process errored", error),
      );
    });
    this.child.once("exit", (code, signal) => {
      this.holderExited = true;
      this.holderExitCode = code;
      this.abortSignal.removeEventListener("abort", this.abortListener);
      if (!this.completeReceived) {
        this.reportFailure(
          cleanupError(
            `resource holder exited without a closure receipt (code=${code}, signal=${signal ?? "none"})`,
          ),
        );
        return;
      }
      this.closed = true;
      this.failure = undefined;
      this.resolveWaiters();
    });
  }

  get facade(): SpawnedProcess {
    const processHandle = this.child as ChildProcess & SpawnedProcess;
    Object.defineProperty(processHandle, "kill", {
      configurable: true,
      value: (signal: NodeJS.Signals = "SIGTERM") => {
        if (signal !== "SIGTERM" && signal !== "SIGKILL") return false;
        if (this.holderExited) return false;
        void this.requestClose(signal === "SIGKILL").catch((error: unknown) => {
          this.reportFailure(
            error instanceof Error
              ? error
              : cleanupError("resource holder close request failed", error),
          );
        });
        return true;
      },
    });
    return processHandle;
  }

  async close(force: boolean): Promise<void> {
    if (this.closed) return;
    const deadline = Date.now() + processExitTimeoutMs;
    await this.requestClose(force, deadline);
    await this.waitForRootExit(deadline);
  }

  async waitForRootExit(
    deadline = Date.now() + processExitTimeoutMs,
  ): Promise<void> {
    if (this.closed) return;
    if (this.failure !== undefined) throw this.failure;

    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => {
          clearTimeout(timeout);
          this.waiters.delete(waiter);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timeout);
          this.waiters.delete(waiter);
          reject(error);
        },
      };
      const timeout = setTimeout(
        () => {
          waiter.reject(
            cleanupError(
              "resource holder did not confirm process-tree closure",
            ),
          );
        },
        Math.max(0, deadline - Date.now()),
      );
      timeout.unref?.();
      this.waiters.add(waiter);
      if (this.closed) waiter.resolve();
      else if (this.failure !== undefined) waiter.reject(this.failure);
    });
  }

  private readControlMessages(): void {
    const lines = createInterface({ input: this.control });
    lines.on("line", (line) => this.handleControlMessage(line));
    lines.on("close", () => {
      if (!this.holderExited && !this.completeReceived) {
        this.reportFailure(
          cleanupError("resource holder control channel closed unexpectedly"),
        );
      }
    });
    this.control.on("error", (error) => {
      this.reportFailure(
        cleanupError("resource holder control channel errored", error),
      );
    });
  }

  private handleControlMessage(line: string): void {
    const [kind, requestText, detail, pidText, errnoText] = line.split(" ");
    if (kind === "READY") return;
    if (kind === "ACK") {
      const requestId = Number(requestText);
      const request = this.requests.get(requestId);
      if (request !== undefined) {
        clearTimeout(request.timeout);
        this.requests.delete(requestId);
        request.resolve();
      }
      return;
    }
    if (kind === "COMPLETE") {
      this.completeReceived = true;
      return;
    }
    if (kind === "FAILED") {
      const requestId = Number(requestText);
      const errorNumber = Number(errnoText);
      const pid = Number(pidText);
      const error = cleanupError(
        `holder could not close its owned tree (${detail ?? "unknown"}, pid=${Number.isFinite(pid) ? pid : "unknown"}, ${Number.isFinite(errorNumber) ? errnoName(errorNumber) : "unknown error"})`,
      );
      const request = this.requests.get(requestId);
      if (request !== undefined) {
        clearTimeout(request.timeout);
        request.reject(error);
      }
      this.requests.delete(requestId);
      this.reportFailure(error);
      return;
    }
    this.reportFailure(
      cleanupError(`invalid holder control response: ${line}`),
    );
  }

  private sendAbortRequest(): void {
    const requestId = this.nextRequestId++;
    this.control.write(`ABORT ${requestId}\n`, (error) => {
      if (error !== null && error !== undefined) {
        this.reportFailure(
          cleanupError("could not deliver SDK abort to resource holder", error),
        );
      }
    });
  }

  private requestClose(
    force: boolean,
    deadline = Date.now() + processExitTimeoutMs,
  ): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.completeReceived) return this.waitForRootExit(deadline);
    this.failure = undefined;
    const requestId = this.nextRequestId++;
    const request = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => {
          const pending = this.requests.get(requestId);
          if (pending === undefined) return;
          this.requests.delete(requestId);
          const error = cleanupError(
            "resource holder did not confirm process-tree closure",
          );
          reject(error);
          this.reportFailure(error);
        },
        Math.max(0, deadline - Date.now()),
      );
      timeout.unref?.();
      this.requests.set(requestId, { resolve, reject, timeout });
    });
    const signal = force ? "KILL" : "TERM";
    this.control.write(`CLOSE ${requestId} ${signal}\n`, (error) => {
      if (error !== null && error !== undefined) {
        const failure = cleanupError(
          "could not request resource-tree closure",
          error,
        );
        const pending = this.requests.get(requestId);
        if (pending !== undefined) {
          clearTimeout(pending.timeout);
          pending.reject(failure);
        }
        this.requests.delete(requestId);
        this.reportFailure(failure);
      }
    });
    return request;
  }

  private reportFailure(error: Error): void {
    this.failure = error;
    for (const waiter of this.waiters) waiter.reject(error);
    for (const request of this.requests.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.requests.clear();
  }

  private resolveWaiters(): void {
    for (const waiter of this.waiters) waiter.resolve();
    this.waiters.clear();
    for (const request of this.requests.values()) {
      clearTimeout(request.timeout);
      request.resolve();
    }
    this.requests.clear();
  }
}

class OwnedProcessTree {
  private process: OwnedRuntimeProcess | undefined;

  spawn(options: SpawnOptions): SpawnedProcess {
    if (this.process !== undefined) {
      throw cleanupError(
        "a Qoder query attempted to spawn more than one runtime",
      );
    }
    this.process = new OwnedRuntimeProcess(options);
    return this.process.facade;
  }

  async close(force: boolean): Promise<void> {
    await this.requireProcess().close(force);
  }

  async waitForRootExit(): Promise<void> {
    await this.requireProcess().waitForRootExit();
  }

  private requireProcess(): OwnedRuntimeProcess {
    if (this.process === undefined) {
      throw cleanupError("the Qoder query has no spawned resource holder");
    }
    return this.process;
  }
}

export function bindOwnedProcess(query: object, owner: OwnedProcessTree): void {
  owners.set(query, owner);
}

export function createOwnedProcessTree(): OwnedProcessTree {
  return new OwnedProcessTree();
}

function getOwner(query: object): OwnedProcessTree | undefined {
  // 注入的 QoderSdk 和 Linux x64 以外的平台不创建本地 holder。
  return owners.get(query);
}

export async function terminateOwnedDescendants(
  query: object,
  force = false,
): Promise<void> {
  await getOwner(query)?.close(force);
}

export async function waitForOwnedRootExit(query: object): Promise<void> {
  await getOwner(query)?.waitForRootExit();
}
