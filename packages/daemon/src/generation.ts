import { randomBytes as secureRandomBytes } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  daemonGenerationSchema,
  makeDiagnosticId,
  sessionIdSchema,
  type DaemonGeneration,
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

export { daemonGenerationSchema, type DaemonGeneration };

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

// 耐久 generation 的持久文件只保存单调递增的状态谱系计数器；对外发布的
// generation token 再把一次 daemon 启动的随机 boot epoch 折叠进低位。计数器
// 保证同一谱系内跨重启与并发启动不复用；boot epoch 保证删除／回滚／替换把
// 计数器恢复到旧值时，重新分配的 token 仍与旧标识不同，从而让旧引用失效而非
// 冒充原命名空间连续（ADR-0023 §7、GLOSSARY 状态谱系、spec 正式控制协议段）。
const generationEpochBits = 40n;

function renderDurableGeneration(
  counter: bigint,
  epoch: bigint,
): DaemonGeneration {
  return parseGeneration(
    ((counter << generationEpochBits) | epoch).toString(36),
  );
}

function randomBootEpoch(randomBytes: (size: number) => Buffer): bigint {
  return BigInt(randomBytes(5).readUIntBE(0, 5));
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
  return new DurableGenerationAllocator(
    state.directory,
    lease,
    randomBootEpoch(randomBytes),
  );
}

class DurableGenerationAllocator implements GenerationAllocatorLease {
  readonly #directory: string;
  readonly #lease: AdvisoryFileLease;
  readonly #epoch: bigint;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(directory: string, lease: AdvisoryFileLease, epoch: bigint) {
    this.#directory = directory;
    this.#lease = lease;
    this.#epoch = epoch;
  }

  allocate(): Promise<DaemonGeneration> {
    if (this.#closed) {
      return Promise.reject(new Error("Generation allocator is closed"));
    }
    const allocation = this.#tail.then(async () => {
      await this.#lease.assertHeld();
      const counter =
        (await readGeneration(join(this.#directory, "generation"))) + 1n;
      await persistGeneration(this.#directory, counter.toString(36));
      return renderDurableGeneration(counter, this.#epoch);
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
