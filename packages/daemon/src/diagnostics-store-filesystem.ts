import {
  appendFile,
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  truncate,
  unlink,
} from "node:fs/promises";

import type { AdvisoryFileLease } from "./diagnostics-store-lock.ts";

export type DiagnosticsFileOperation =
  | "appendFile"
  | "chmod"
  | "mkdir"
  | "open"
  | "readFile"
  | "readdir"
  | "rename"
  | "stat"
  | "truncate"
  | "unlink";

export type BeforeDiagnosticsFileOperation = (
  operation: DiagnosticsFileOperation,
  path: string,
) => Promise<void>;

/**
 * Store-private filesystem primitive. Every named filesystem action performs
 * a fresh ownership check immediately before entering the Node filesystem
 * implementation. The second check protects asynchronous test barriers and
 * any future preparation added between admission and the syscall.
 */
export class LeaseGuardedDiagnosticsFilesystem {
  readonly #lease: AdvisoryFileLease;
  readonly #beforeOperation: BeforeDiagnosticsFileOperation | undefined;

  constructor(
    lease: AdvisoryFileLease,
    beforeOperation?: BeforeDiagnosticsFileOperation,
  ) {
    this.#lease = lease;
    this.#beforeOperation = beforeOperation;
  }

  async assertHeld(): Promise<void> {
    await this.#lease.assertHeld();
  }

  async mkdir(path: string, mode: number): Promise<void> {
    await this.#run("mkdir", path, async () => {
      await mkdir(path, { recursive: true, mode });
    });
  }

  async chmod(path: string, mode: number): Promise<void> {
    await this.#run("chmod", path, async () => {
      await chmod(path, mode);
    });
  }

  async mode(path: string): Promise<number> {
    return await this.#run("stat", path, async () => (await stat(path)).mode);
  }

  async readdir(path: string): Promise<string[]> {
    return await this.#run("readdir", path, async () => await readdir(path));
  }

  async readFile(path: string): Promise<Buffer> {
    return await this.#run("readFile", path, async () => await readFile(path));
  }

  async touch(path: string, mode: number): Promise<void> {
    await this.#run("open", path, async () => {
      const handle = await open(path, "a", mode);
      await handle.close();
    });
  }

  async appendFile(path: string, data: string, mode: number): Promise<void> {
    await this.#run("appendFile", path, async () => {
      await appendFile(path, data, { encoding: "utf8", mode });
    });
  }

  async rename(from: string, to: string): Promise<void> {
    await this.#run("rename", from, async () => {
      await rename(from, to);
    });
  }

  async unlink(path: string): Promise<void> {
    await this.#run("unlink", path, async () => {
      await unlink(path);
    });
  }

  async truncate(path: string, length: number): Promise<void> {
    await this.#run("truncate", path, async () => {
      await truncate(path, length);
    });
  }

  async close(): Promise<void> {
    await this.#lease.assertHeld();
    await this.#lease.close();
  }

  async #run<T>(
    operation: DiagnosticsFileOperation,
    path: string,
    action: () => Promise<T>,
  ): Promise<T> {
    await this.#lease.assertHeld();
    await this.#beforeOperation?.(operation, path);
    await this.#lease.assertHeld();
    return await action();
  }
}
