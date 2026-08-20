import {
  spawn as spawnChild,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";

const DEFAULT_DEADLINE_MS = 5_000;
const MAX_OUTPUT = 8_192;

type ChildState = {
  stdout: string;
  stderr: string;
  error: Error | undefined;
};

export type ChildObservation = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
};

export class ChildProcessHarness {
  readonly #children = new Set<ChildProcessWithoutNullStreams>();
  readonly #states = new Map<ChildProcessWithoutNullStreams, ChildState>();

  spawn(
    fixture: string,
    arguments_: readonly string[],
  ): ChildProcessWithoutNullStreams {
    const child = spawnChild(process.execPath, [fixture, ...arguments_], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const state: ChildState = { stdout: "", stderr: "", error: undefined };
    this.#children.add(child);
    this.#states.set(child, state);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      state.stdout = boundedOutput(state.stdout, chunk);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      state.stderr = boundedOutput(state.stderr, chunk);
    });
    child.once("error", (error) => {
      state.error = error;
    });
    return child;
  }

  async waitForHandshake<T>(
    child: ChildProcessWithoutNullStreams,
    classify: (observation: ChildObservation) => T | undefined,
    deadlineMs = DEFAULT_DEADLINE_MS,
  ): Promise<T> {
    return await this.#waitFor(
      child,
      deadlineMs,
      "Child handshake timed out",
      () => {
        const observation = this.#observation(child);
        const result = classify(observation);
        if (result !== undefined) return result;
        if (observation.exitCode !== null || observation.signalCode !== null) {
          throw new Error(
            `Child exited before handshake: ${observation.stderr.slice(0, MAX_OUTPUT)}`,
          );
        }
        return undefined;
      },
    );
  }

  async waitForExit(
    child: ChildProcessWithoutNullStreams,
    deadlineMs = DEFAULT_DEADLINE_MS,
  ): Promise<ChildObservation> {
    return await this.#waitFor(
      child,
      deadlineMs,
      "Child exit timed out",
      () => {
        const observation = this.#observation(child);
        return observation.exitCode !== null || observation.signalCode !== null
          ? observation
          : undefined;
      },
    );
  }

  async close(): Promise<void> {
    const children = [...this.#children];
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
    try {
      await Promise.all(
        children.map((child) => this.#reap(child, DEFAULT_DEADLINE_MS)),
      );
    } finally {
      this.#children.clear();
      this.#states.clear();
    }
  }

  #observation(child: ChildProcessWithoutNullStreams): ChildObservation {
    const state = this.#states.get(child);
    if (state === undefined) throw new Error("Child is not registered");
    if (state.error !== undefined) throw state.error;
    return {
      stdout: state.stdout,
      stderr: state.stderr,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
    };
  }

  async #waitFor<T>(
    child: ChildProcessWithoutNullStreams,
    deadlineMs: number,
    timeoutMessage: string,
    inspect: () => T | undefined,
  ): Promise<T> {
    const immediate = inspect();
    if (immediate !== undefined) return immediate;
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        try {
          const result = inspect();
          if (result === undefined) return;
          settled = true;
          cleanup();
          resolve(result);
        } catch (error) {
          settled = true;
          cleanup();
          reject(error);
        }
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(timeoutMessage));
      }, deadlineMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        child.stdout.off("data", finish);
        child.stderr.off("data", finish);
        child.off("exit", finish);
        child.off("error", finish);
      };
      child.stdout.on("data", finish);
      child.stderr.on("data", finish);
      child.on("exit", finish);
      child.on("error", finish);
      finish();
    });
  }

  async #reap(
    child: ChildProcessWithoutNullStreams,
    deadlineMs: number,
  ): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Child reap timed out"));
      }, deadlineMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        child.off("exit", exited);
        child.off("error", exited);
      };
      const exited = (): void => {
        cleanup();
        resolve();
      };
      child.once("exit", exited);
      child.once("error", exited);
    });
  }
}

export async function withChildHarness<T>(
  run: (harness: ChildProcessHarness) => Promise<T>,
): Promise<T> {
  const harness = new ChildProcessHarness();
  try {
    return await run(harness);
  } finally {
    await harness.close();
  }
}

function boundedOutput(current: string, chunk: string): string {
  if (current.length >= MAX_OUTPUT) return current;
  return (current + chunk).slice(0, MAX_OUTPUT);
}
