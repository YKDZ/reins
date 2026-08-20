import * as callbackFs from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import lockfile from "proper-lockfile";

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_UPDATE_MS = 10_000;
const DEFAULT_RETRY_DELAY_MS = 100;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

export type AdvisoryFileLeaseOptions = {
  timeoutMs?: number;
  staleMs?: number;
  updateMs?: number;
  retryDelayMs?: number;
  closeTimeoutMs?: number;
  signal?: AbortSignal;
  /** @internal Fault injection for contract tests. */
  afterLockAcquired?: (lockDirectory: string) => Promise<void>;
};

export interface AdvisoryFileLease {
  assertHeld(): Promise<void>;
  close(): Promise<void>;
}

export class AdvisoryLockUnavailableError extends Error {
  readonly code = "LOCK_UNAVAILABLE";

  constructor(message = "File already has an exclusive writer") {
    super(message);
    this.name = "AdvisoryLockUnavailableError";
  }
}

export class AdvisoryLockCompromisedError extends Error {
  readonly code = "LOCK_COMPROMISED";

  constructor(message = "Exclusive writer lease was lost") {
    super(message);
    this.name = "AdvisoryLockCompromisedError";
  }
}

export class AdvisoryLockSystemError extends Error {
  readonly code = "LOCK_SYSTEM_ERROR";

  constructor(message = "Unable to manage exclusive writer lease") {
    super(message);
    this.name = "AdvisoryLockSystemError";
  }
}

export async function acquireAdvisoryFileLease(
  path: string,
  options: AdvisoryFileLeaseOptions = {},
): Promise<AdvisoryFileLease> {
  let target: string;
  try {
    target = await canonicalTarget(path);
  } catch (error: unknown) {
    throw boundedLockError(error);
  }
  const lockDirectory = `${target}.lock`;
  const timeoutMs = nonNegative(options.timeoutMs ?? 0, "timeoutMs");
  const retryDelayMs = positive(
    options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    "retryDelayMs",
  );
  const staleMs = positive(options.staleMs ?? DEFAULT_STALE_MS, "staleMs");
  const updateMs = positive(options.updateMs ?? DEFAULT_UPDATE_MS, "updateMs");
  const closeTimeoutMs = positive(
    options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
    "closeTimeoutMs",
  );
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    throwIfAborted(options.signal);
    try {
      await rejectSymbolicLockDirectory(lockDirectory);
    } catch (error: unknown) {
      if (error instanceof AdvisoryLockUnavailableError) throw error;
      throw boundedLockError(error);
    }
    let compromised: Error | undefined;
    let release: (() => Promise<void>) | undefined;
    const guardedFs = new GuardedLockFilesystem(lockDirectory);
    try {
      release = await lockfile.lock(target, {
        fs: guardedFs.implementation,
        lockfilePath: lockDirectory,
        realpath: false,
        retries: 0,
        stale: staleMs,
        update: updateMs,
        onCompromised(error) {
          compromised = error;
          void guardedFs.closeDescriptor();
        },
      });
      await options.afterLockAcquired?.(lockDirectory);
      await guardedFs.assertOwned();
      return new ProperLockLease(
        guardedFs,
        release,
        () => compromised,
        closeTimeoutMs,
      );
    } catch (error: unknown) {
      if (release !== undefined) {
        await withTimeout(
          release(),
          closeTimeoutMs,
          "Timed out while cleaning up exclusive writer lease",
        ).catch(() => undefined);
      }
      await guardedFs.closeDescriptor();
      if (!isLockContention(error)) throw boundedLockError(error);
      if (Date.now() >= deadline) throw new AdvisoryLockUnavailableError();
      await abortableDelay(
        Math.min(retryDelayMs, Math.max(1, deadline - Date.now())),
        options.signal,
      );
    }
  }
}

type LockIdentity = { dev: bigint; ino: bigint; links: bigint };

class ProperLockLease implements AdvisoryFileLease {
  readonly #guardedFs: GuardedLockFilesystem;
  readonly #release: () => Promise<void>;
  readonly #compromised: () => Error | undefined;
  readonly #closeTimeoutMs: number;
  #closed = false;
  #terminalError: AdvisoryLockCompromisedError | undefined;
  #closePromise: Promise<void> | undefined;
  #releasePromise: Promise<void> | undefined;
  #releaseState: "pending" | "succeeded" | "failed" | undefined;
  #releaseError: unknown;

  constructor(
    guardedFs: GuardedLockFilesystem,
    release: () => Promise<void>,
    compromised: () => Error | undefined,
    closeTimeoutMs: number,
  ) {
    this.#guardedFs = guardedFs;
    this.#release = release;
    this.#compromised = compromised;
    this.#closeTimeoutMs = closeTimeoutMs;
  }

  async assertHeld(): Promise<void> {
    if (this.#closed) throw new AdvisoryLockCompromisedError();
    if (this.#terminalError !== undefined) throw this.#terminalError;
    if (this.#compromised() !== undefined) await this.#throwCompromised();
    try {
      await this.#guardedFs.assertOwned();
    } catch (error: unknown) {
      await this.#throwCompromised(error);
    }
    if (this.#compromised() !== undefined) {
      await this.#throwCompromised();
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#terminalError !== undefined) throw this.#terminalError;
    if (this.#closePromise !== undefined) return await this.#closePromise;
    const attempt = this.#closeAttempt();
    this.#closePromise = attempt;
    try {
      await attempt;
    } finally {
      if (this.#closePromise === attempt) this.#closePromise = undefined;
    }
  }

  async #closeAttempt(): Promise<void> {
    if (this.#compromised() !== undefined) await this.#throwCompromised();

    if (this.#releaseState === "failed") {
      if (this.#releaseError instanceof AdvisoryLockCompromisedError) {
        await this.#throwCompromised(this.#releaseError);
      }
      try {
        await this.#guardedFs.removeOwned();
        this.#closed = true;
        return;
      } catch (error: unknown) {
        if (error instanceof AdvisoryLockCompromisedError) {
          await this.#throwCompromised(error);
        }
        throw boundedLockError(error);
      }
    }

    try {
      if (this.#releasePromise === undefined) {
        try {
          await this.#guardedFs.assertOwned();
        } catch (error: unknown) {
          await this.#throwCompromised(error);
        }
        if (this.#compromised() !== undefined) await this.#throwCompromised();
      }
      await withTimeout(
        this.#ensureRelease(),
        this.#closeTimeoutMs,
        "Timed out while releasing exclusive writer lease",
      );
      this.#closed = true;
      await this.#guardedFs.closeDescriptor();
    } catch (error: unknown) {
      if (
        error instanceof AdvisoryLockCompromisedError ||
        this.#compromised() !== undefined
      ) {
        await this.#throwCompromised(error);
      }
      throw boundedLockError(error);
    }
  }

  async #throwCompromised(error?: unknown): Promise<never> {
    this.#terminalError ??=
      error instanceof AdvisoryLockCompromisedError
        ? error
        : new AdvisoryLockCompromisedError();
    await withTimeout(
      this.#ensureRelease(),
      this.#closeTimeoutMs,
      "Timed out while stopping compromised exclusive writer lease",
    ).catch(() => undefined);
    await this.#guardedFs.closeDescriptor();
    throw this.#terminalError;
  }

  #ensureRelease(): Promise<void> {
    if (this.#releasePromise !== undefined) return this.#releasePromise;
    this.#releaseState = "pending";
    this.#releasePromise = this.#release().then(
      () => {
        this.#releaseState = "succeeded";
      },
      (error: unknown) => {
        this.#releaseState = "failed";
        this.#releaseError = error;
        throw error;
      },
    );
    return this.#releasePromise;
  }
}

async function canonicalTarget(path: string): Promise<string> {
  const absolute = resolve(path);
  const canonicalParent = await realpath(dirname(absolute));
  return join(canonicalParent, basename(absolute));
}

async function rejectSymbolicLockDirectory(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      throw new AdvisoryLockUnavailableError(
        "Lock path must not be a symbolic link",
      );
    }
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
}

async function lockIdentity(path: string): Promise<LockIdentity> {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new AdvisoryLockCompromisedError();
  }
  return { dev: stat.dev, ino: stat.ino, links: stat.nlink };
}

class GuardedLockFilesystem {
  readonly implementation: typeof callbackFs;
  readonly #path: string;
  #descriptor: number | undefined;
  #identity: LockIdentity | undefined;

  constructor(path: string) {
    this.#path = path;
    const implementation = Object.create(callbackFs) as typeof callbackFs;
    Object.defineProperties(implementation, {
      mkdir: { value: this.#mkdir.bind(this) },
      rmdir: { value: this.#rmdir.bind(this) },
      rmdirSync: { value: this.#rmdirSync.bind(this) },
    });
    this.implementation = implementation;
  }

  async assertOwned(): Promise<void> {
    const identity = this.#identity;
    const descriptor = this.#descriptor;
    if (identity === undefined || descriptor === undefined) {
      throw new AdvisoryLockCompromisedError();
    }
    const held = await descriptorIdentity(descriptor);
    const current = await lockIdentity(this.#path);
    if (
      held.dev !== identity.dev ||
      held.ino !== identity.ino ||
      held.links === 0n ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino
    ) {
      throw new AdvisoryLockCompromisedError();
    }
  }

  async closeDescriptor(): Promise<void> {
    const descriptor = this.#descriptor;
    this.#descriptor = undefined;
    if (descriptor === undefined) return;
    await new Promise<void>((resolveClose) => {
      callbackFs.close(descriptor, () => resolveClose());
    });
  }

  async removeOwned(): Promise<void> {
    await this.assertOwned();
    await new Promise<void>((resolveRemoval, reject) => {
      callbackFs.rmdir(this.#path, (error) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolveRemoval();
      });
    });
    await this.closeDescriptor();
  }

  #mkdir(path: string, callback: callbackFs.NoParamCallback): void {
    callbackFs.mkdir(path, (error) => {
      if (error !== null) {
        callback(error);
        return;
      }
      callbackFs.open(path, callbackFs.constants.O_RDONLY, (openError, fd) => {
        if (openError !== null) {
          callback(openError);
          return;
        }
        callbackFs.fstat(fd, { bigint: true }, (statError, stat) => {
          if (statError !== null || !stat.isDirectory()) {
            callbackFs.close(fd, () =>
              callback(statError ?? new Error("Lock path is not a directory")),
            );
            return;
          }
          this.#descriptor = fd;
          this.#identity = {
            dev: stat.dev,
            ino: stat.ino,
            links: stat.nlink,
          };
          callback(null);
        });
      });
    });
  }

  #rmdir(path: string, callback: callbackFs.NoParamCallback): void {
    if (path !== this.#path || this.#identity === undefined) {
      callbackFs.rmdir(path, callback);
      return;
    }
    void this.#removeOwned(callback);
  }

  async #removeOwned(callback: callbackFs.NoParamCallback): Promise<void> {
    try {
      await this.removeOwned();
      callback(null);
    } catch (error: unknown) {
      callback(
        error instanceof Error
          ? error
          : new Error("Unable to remove exclusive writer lease"),
      );
    }
  }

  #rmdirSync(path: string): void {
    if (path !== this.#path || this.#identity === undefined) {
      callbackFs.rmdirSync(path);
      return;
    }
    try {
      const descriptor = this.#descriptor;
      if (descriptor === undefined) return;
      const held = callbackFs.fstatSync(descriptor, { bigint: true });
      const current = callbackFs.lstatSync(path, { bigint: true });
      if (
        held.dev === this.#identity.dev &&
        held.ino === this.#identity.ino &&
        held.nlink > 0n &&
        current.dev === this.#identity.dev &&
        current.ino === this.#identity.ino
      ) {
        callbackFs.rmdirSync(path);
      }
    } finally {
      const descriptor = this.#descriptor;
      this.#descriptor = undefined;
      if (descriptor !== undefined) callbackFs.closeSync(descriptor);
    }
  }
}

async function descriptorIdentity(descriptor: number): Promise<LockIdentity> {
  return await new Promise<LockIdentity>((resolveIdentity, reject) => {
    callbackFs.fstat(descriptor, { bigint: true }, (error, stat) => {
      if (error !== null) {
        reject(error);
        return;
      }
      if (!stat.isDirectory()) {
        reject(new AdvisoryLockCompromisedError());
        return;
      }
      resolveIdentity({ dev: stat.dev, ino: stat.ino, links: stat.nlink });
    });
  });
}

function isLockContention(error: unknown): boolean {
  return hasCode(error, "ELOCKED") || hasCode(error, "EEXIST");
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function boundedLockError(error: unknown): AdvisoryLockSystemError {
  const message = error instanceof Error ? error.message : String(error);
  const bounded = boundedUtf8(message);
  return new AdvisoryLockSystemError(
    bounded.length === 0 ? "Unable to acquire exclusive writer lease" : bounded,
  );
}

function boundedUtf8(message: string): string {
  const bytes = Buffer.from(message, "utf8");
  if (bytes.length <= 4_096) return message;
  for (let end = 4_096; end > 4_092; end -= 1) {
    try {
      return strictUtf8.decode(bytes.subarray(0, end));
    } catch {
      // Retry at the preceding UTF-8 boundary.
    }
  }
  return "Unable to manage exclusive writer lease";
}

function nonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

async function abortableDelay(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
    return;
  }
  await new Promise<void>((resolveDelay, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolveDelay();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
