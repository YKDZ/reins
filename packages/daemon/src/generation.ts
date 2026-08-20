import { randomBytes as secureRandomBytes } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  makeDiagnosticId,
  sessionIdSchema,
  type DiagnosticId,
  type SessionId,
  type SessionName,
} from "@reins/protocol";
import * as v from "valibot";

import {
  acquireAdvisoryFileLease,
  type AdvisoryFileLease,
  type AdvisoryFileLeaseOptions,
} from "./diagnostics-store-lock.ts";
import type { DaemonState } from "./state.ts";

export const daemonGenerationSchema = v.pipe(
  v.string(),
  v.regex(/^[0-9a-z]+$/),
  v.brand<string, "DaemonGeneration">("DaemonGeneration"),
);
export type DaemonGeneration = v.InferOutput<typeof daemonGenerationSchema>;

function parseGeneration(value: string): DaemonGeneration {
  return v.parse(daemonGenerationSchema, value);
}

async function readGeneration(path: string): Promise<bigint> {
  try {
    const handle = await open(path, "r");
    try {
      const value = (await handle.readFile({ encoding: "utf8" })).trim();
      if (!/^[0-9a-z]+$/.test(value))
        throw new Error("Invalid generation state");
      let parsed = 0n;
      for (const character of value) {
        const digit = BigInt(parseInt(character, 36));
        parsed = parsed * 36n + digit;
      }
      return parsed;
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return 0n;
    }
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    if (process.platform === "win32") return;
    throw error;
  }
}

async function persistGeneration(
  directory: string,
  generation: string,
): Promise<void> {
  const destination = join(directory, "generation");
  const temporary = join(
    directory,
    `.generation-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${generation}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close();
    await rm(temporary, { force: true });
    throw error;
  }
}

function randomGeneration(
  randomBytes: (size: number) => Buffer,
): DaemonGeneration {
  for (;;) {
    const value = randomBytes(6).readUIntBE(0, 6);
    if (value >= 2 ** 40) return parseGeneration(value.toString(36));
  }
}

export type GenerationAllocatorLease = {
  allocate(): Promise<DaemonGeneration>;
  close(): Promise<void>;
};

export async function acquireGenerationAllocator(
  state: DaemonState,
  options?: {
    randomBytes?: (size: number) => Buffer;
    lock?: AdvisoryFileLeaseOptions;
  },
): Promise<GenerationAllocatorLease> {
  const randomBytes = options?.randomBytes ?? secureRandomBytes;
  if (!state.durable) {
    return {
      async allocate() {
        return randomGeneration(randomBytes);
      },
      async close() {},
    };
  }

  const lease = await acquireAdvisoryFileLease(
    join(state.directory, "generation-allocator"),
    options?.lock ?? { timeoutMs: 30_000 },
  );
  return new DurableGenerationAllocator(state.directory, lease);
}

class DurableGenerationAllocator implements GenerationAllocatorLease {
  readonly #directory: string;
  readonly #lease: AdvisoryFileLease;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(directory: string, lease: AdvisoryFileLease) {
    this.#directory = directory;
    this.#lease = lease;
  }

  allocate(): Promise<DaemonGeneration> {
    if (this.#closed) {
      return Promise.reject(new Error("Generation allocator is closed"));
    }
    const allocation = this.#tail.then(async () => {
      await this.#lease.assertHeld();
      const current = await readGeneration(join(this.#directory, "generation"));
      const next = parseGeneration((current + 1n).toString(36));
      await persistGeneration(this.#directory, next);
      return next;
    });
    this.#tail = allocation.then(
      () => undefined,
      () => undefined,
    );
    return allocation;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#tail;
    await this.#lease.close();
  }
}

export type DaemonIdFactory = {
  session(sessionName: SessionName): SessionId;
  diagnostic(): DiagnosticId;
};

export function createDaemonIdFactory(
  generation: DaemonGeneration,
): DaemonIdFactory {
  let diagnosticCounter = 0;
  return {
    session(sessionName) {
      return v.parse(sessionIdSchema, `${sessionName}@g${generation}`);
    },
    diagnostic() {
      diagnosticCounter += 1;
      return makeDiagnosticId(generation, diagnosticCounter.toString(36));
    },
  };
}
