import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { finished } from "node:stream/promises";

import type {
  CommandResult,
  DockerCommandOptions,
  PlatformOptions,
} from "./types.ts";

export type {
  CommandResult,
  DockerCommandOptions,
  DockerExecutor,
} from "./types.ts";

const SUMMARY_BYTES = 64 * 1024;
// 慢文件系统上单条 Docker 命令（容器创建、卷挂载）可能远超常规耗时。
const DEFAULT_TIMEOUT_MS = 300_000;

export async function executeDocker(
  options: PlatformOptions,
  args: readonly string[],
  commandOptions: DockerCommandOptions = {},
): Promise<CommandResult> {
  const timeoutMs =
    commandOptions.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Docker command timeout must be a positive finite number.");
  }
  if (commandOptions.outputDirectory !== undefined) {
    await mkdir(commandOptions.outputDirectory, { recursive: true });
  }
  if (commandOptions.signal?.aborted === true) {
    return {
      exitCode: null,
      signal: "SIGTERM",
      stdout: "",
      stderr: "",
      timedOut: false,
    };
  }

  const child = spawn(options.dockerBinary ?? "docker", args, {
    cwd: commandOptions.cwd,
    env: commandOptions.env,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let timedOut = false;
  let failure: Error | undefined;
  let closed = false;
  let stopping = false;
  let forceTimer: NodeJS.Timeout | undefined;

  const sendSignal = (signal: NodeJS.Signals): void => {
    if (closed || child.pid === undefined) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ESRCH")
      ) {
        failure = error instanceof Error ? error : new Error(String(error));
      }
    }
  };
  const stop = (): void => {
    if (stopping || closed) return;
    stopping = true;
    sendSignal("SIGTERM");
    forceTimer = setTimeout(() => sendSignal("SIGKILL"), 1_000);
    forceTimer.unref();
  };
  const logWrites: Promise<void>[] = [];
  if (commandOptions.outputDirectory !== undefined) {
    for (const [name, source] of [
      ["stdout.log", child.stdout],
      ["stderr.log", child.stderr],
    ] as const) {
      const target = createWriteStream(
        join(commandOptions.outputDirectory, name),
      );
      logWrites.push(
        finished(target).catch((error: unknown) => {
          failure = error instanceof Error ? error : new Error(String(error));
          stop();
        }),
      );
      source.pipe(target);
    }
  }
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = Buffer.concat([stdout, chunk]).subarray(-SUMMARY_BYTES);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = Buffer.concat([stderr, chunk]).subarray(-SUMMARY_BYTES);
  });
  child.on("error", (error) => {
    failure = error;
  });
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") {
      failure = error;
      stop();
    }
  });

  const result = new Promise<CommandResult>((resolve) => {
    child.once("close", (exitCode, signal) => {
      closed = true;
      resolve({
        exitCode,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        timedOut,
      });
    });
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  timeout.unref();
  commandOptions.signal?.addEventListener("abort", stop, { once: true });
  child.stdin.end(commandOptions.input);
  try {
    const completed = await result;
    await Promise.all(logWrites);
    if (failure !== undefined) throw failure;
    return completed;
  } finally {
    clearTimeout(timeout);
    if (forceTimer !== undefined) clearTimeout(forceTimer);
    commandOptions.signal?.removeEventListener("abort", stop);
  }
}
