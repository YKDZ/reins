import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { vi } from "vitest";

import { OWNER_LABEL } from "../src/manifest.ts";
import type {
  CommandResult,
  DockerExecutor,
  PlatformOptions,
} from "../src/types.ts";

export const BOOTSTRAP_IMAGE = `docker.io/library/docker:29.8.2-dind@sha256:${"a".repeat(64)}`;

export function result(
  stdout = "",
  exitCode: number | null = 0,
  stderr = "",
  timedOut = false,
  signal: string | null = null,
): CommandResult {
  return { exitCode, signal, stdout, stderr, timedOut };
}

export interface InnerContainer {
  id: string;
  name: string;
}

interface OuterResource {
  id: string;
  labels: Record<string, string>;
  running: boolean;
}

export interface RunOutcome {
  exitCode?: number | null;
  timedOut?: boolean;
  signal?: string | null;
  stderr?: string;
  /** 场景命令在内层留下的子资源，用于验证逐场景回收。 */
  containers?: InnerContainer[];
  networks?: string[];
  volumes?: string[];
}

export interface FakeEngineSettings {
  bootstrapImage?: string;
  imageExisted?: boolean;
  outerEngineId?: string;
  innerEngineId?: string;
  innerServerVersion?: string;
  innerDefaultNetworks?: string[];
  runOutcomes?: RunOutcome[];
}

export interface FakeEngine {
  execute: DockerExecutor;
  calls: string[][];
  outer: Map<string, OuterResource>;
  images: Map<string, string>;
  inner: {
    containers: InnerContainer[];
    networks: string[];
    volumes: string[];
  };
  /** 列出的名称或 id 一律拒绝删除，用来制造不收敛的清理边界。 */
  undeletable: string[];
  innerDown: boolean;
  outerDown: boolean;
  setFailure(
    predicate: ((args: readonly string[]) => boolean) | undefined,
  ): void;
  scenarioRuns(): string[][];
}

/** 内存模型代替 Docker，但保留真实调用参数，使归属与回收顺序可以被断言。 */
export function fakeEngine(settings: FakeEngineSettings = {}): FakeEngine {
  const image = settings.bootstrapImage ?? BOOTSTRAP_IMAGE;
  const outerEngineId = settings.outerEngineId ?? "outer-engine-id";
  const innerEngineId = settings.innerEngineId ?? "inner-engine-id";
  const innerServerVersion = settings.innerServerVersion ?? "29.8.2";
  const calls: string[][] = [];
  const outer = new Map<string, OuterResource>();
  const images = new Map<string, string>();
  const inner: FakeEngine["inner"] = {
    containers: [],
    networks: [
      ...(settings.innerDefaultNetworks ?? ["bridge", "host", "none"]),
    ],
    volumes: [],
  };
  if (settings.imageExisted === true) images.set(image, "b".repeat(64));
  let failure: ((args: readonly string[]) => boolean) | undefined;
  let runIndex = 0;

  const engine: FakeEngine = {
    execute,
    calls,
    outer,
    images,
    inner,
    undeletable: [],
    innerDown: false,
    outerDown: false,
    setFailure(predicate) {
      failure = predicate;
    },
    scenarioRuns() {
      return calls.filter((args) => isScenarioRun(args));
    },
  };

  function labelsOf(args: readonly string[]): Record<string, string> {
    const labels: Record<string, string> = {};
    args.forEach((arg, index) => {
      if (arg !== "--label") return;
      const pair = args[index + 1] ?? "";
      const split = pair.indexOf("=");
      if (split > 0) labels[pair.slice(0, split)] = pair.slice(split + 1);
    });
    return labels;
  }

  async function writeDiagnostics(
    value: CommandResult,
    commandOptions: { outputDirectory?: string },
  ): Promise<CommandResult> {
    const directory = commandOptions.outputDirectory;
    if (directory === undefined) return value;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "stdout.log"), value.stdout, {
      mode: 0o600,
    });
    await writeFile(join(directory, "stderr.log"), value.stderr, {
      mode: 0o600,
    });
    return value;
  }

  function innerRemove(command: readonly string[]): CommandResult {
    const target = command.at(-1)!;
    const words = command[0] === "container" ? command.slice(1) : command;
    const reject = engine.undeletable.includes(target);
    if (words[0] === "rm") {
      const index = inner.containers.findIndex(
        (item) => item.id === target || item.name === target,
      );
      if (reject)
        return result(
          "",
          1,
          `Error response from daemon: cannot remove ${target}`,
        );
      if (index < 0) {
        // 本机 Docker 29.8.2 的强制删除会把 NotFound 吞掉并成功返回，退出码因此不能
        // 证明目标存在过；只有内层清单可以判定回收是否收敛。
        if (words.includes("--force")) return result();
        return result(
          "",
          1,
          `Error response from daemon: No such container: ${target}`,
        );
      }
      inner.containers.splice(index, 1);
      return result(target);
    }
    if (words[0] === "network") {
      const index = inner.networks.indexOf(target);
      if (reject || index < 0) {
        return result(
          "",
          1,
          `Error response from daemon: network ${target} not found`,
        );
      }
      inner.networks.splice(index, 1);
      return result(target);
    }
    const index = inner.volumes.indexOf(target);
    if (reject || index < 0) {
      return result(
        "",
        1,
        `Error response from daemon: get ${target}: no such volume`,
      );
    }
    inner.volumes.splice(index, 1);
    return result(target);
  }

  async function execute(
    _options: PlatformOptions,
    args: readonly string[],
    commandOptions = {},
  ): Promise<CommandResult> {
    calls.push([...args]);
    if (failure?.(args) === true) return result("", 1, "Injected failure");
    if (!isInnerExec(args) && engine.outerDown) {
      return result(
        "",
        1,
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
      );
    }
    if (isInnerExec(args)) {
      if (engine.innerDown) {
        return result(
          "",
          1,
          "error during connect: Is the inner engine running?",
        );
      }
      if (args[2] === "docker") {
        const command = args.slice(3);
        if (command[0] === "info") {
          return result(
            JSON.stringify(
              command.at(-1) === "{{json .ID}}"
                ? innerEngineId
                : innerServerVersion,
            ),
          );
        }
        if (command[0] === "ps") {
          const byNames = command.includes("{{.Names}}");
          return result(
            inner.containers
              .map((item) => (byNames ? item.name : item.id))
              .join("\n"),
          );
        }
        if (command[0] === "network" && command[1] === "ls") {
          return result(inner.networks.join("\n"));
        }
        if (command[0] === "volume" && command[1] === "ls") {
          return result(inner.volumes.join("\n"));
        }
        if (command[0] === "image" && command[1] === "inspect") {
          return result(
            JSON.stringify([
              {
                Id: `sha256:${"c".repeat(64)}`,
                RepoDigests: [`scenario/repo@sha256:${"d".repeat(64)}`],
              },
            ]),
          );
        }
        if (
          command[0] === "rm" ||
          command[0] === "container" ||
          command[0] === "network" ||
          command[0] === "volume"
        ) {
          return innerRemove(command);
        }
        return result();
      }
      if (args[2] === "sh") {
        const script = args[4] ?? "";
        if (script.includes('exec "$@"')) {
          const outcome = nextOutcome();
          const name = args[5]!;
          inner.containers.push({ id: `sha256:${name}`, name });
          inner.containers.push(...(outcome.containers ?? []));
          inner.networks.push(...(outcome.networks ?? []));
          inner.volumes.push(...(outcome.volumes ?? []));
          return await writeDiagnostics(
            result(
              "",
              outcome.exitCode === undefined ? 0 : outcome.exitCode,
              outcome.stderr ?? "",
              outcome.timedOut ?? false,
              outcome.signal ?? null,
            ),
            commandOptions,
          );
        }
        return result();
      }
      return result();
    }
    const kind = args[0]!;
    const operation = args[1];
    const name = args.at(-1)!;
    if (kind === "--version")
      return result("Docker version 29.8.2, build fake");
    if (kind === "info") return result(JSON.stringify(outerEngineId));
    if (kind === "image") {
      if (operation === "pull") {
        images.set(name, "b".repeat(64));
        return result(`Status: Downloaded newer image for ${name}`);
      }
      if (operation === "rm") {
        if (!images.has(name)) {
          return result(
            "",
            1,
            `Error response from daemon: No such image: ${name}`,
          );
        }
        images.delete(name);
        return result(`Untagged: ${name}`);
      }
      const id = images.get(name);
      return id === undefined
        ? result("", 1, `Error response from daemon: No such image: ${name}`)
        : result(JSON.stringify({ Id: `sha256:${id}` }));
    }
    if (operation === "inspect") {
      const resource = outer.get(`${kind}:${name}`);
      if (resource === undefined) {
        return result(
          "",
          1,
          `Error response from daemon: No such ${kind}: ${name}`,
        );
      }
      return result(
        kind === "container"
          ? JSON.stringify({
              Id: `sha256:${resource.id}`,
              Config: { Labels: resource.labels },
              State: { Running: resource.running },
            })
          : JSON.stringify({ Name: resource.id, Labels: resource.labels }),
      );
    }
    if (operation === "create") {
      outer.set(`${kind}:${name}`, {
        id: `${kind}-${name}`,
        labels: labelsOf(args),
        running: false,
      });
      return result(name);
    }
    if (kind === "run") {
      const containerName = args[args.indexOf("--name") + 1]!;
      outer.set(`container:${containerName}`, {
        id: `container-${containerName}`,
        labels: labelsOf(args),
        running: true,
      });
      return result(containerName);
    }
    if (operation === "rm") {
      if (engine.undeletable.includes(name)) {
        return result(
          "",
          1,
          `Error response from daemon: cannot remove ${name}`,
        );
      }
      outer.delete(`${kind}:${name}`);
      return result(name);
    }
    if (kind === "logs") {
      // 真实 Docker 在容器已消失后拒绝取日志，重试销毁必须面对同一事实。
      if (!outer.has(`container:${name}`)) {
        return result("", 1, `Error: No such container: ${name}`);
      }
      return await writeDiagnostics(
        result("dockerd started", 0, "dockerd warning"),
        commandOptions,
      );
    }
    if (kind === "cp") return result();
    throw new Error(`Unexpected Docker arguments: ${args.join(" ")}`);
  }

  function nextOutcome(): RunOutcome {
    const outcomes = settings.runOutcomes ?? [];
    if (outcomes.length === 0) return {};
    const outcome = outcomes[Math.min(runIndex, outcomes.length - 1)]!;
    runIndex += 1;
    return outcome;
  }

  return engine;
}

function isInnerExec(args: readonly string[]): boolean {
  return args[0] === "exec";
}

function isScenarioRun(args: readonly string[]): boolean {
  return (
    args[0] === "exec" &&
    args[2] === "sh" &&
    (args[4] ?? "").includes('exec "$@"') &&
    (args[4] ?? "").includes("pid_file")
  );
}

/** 采集 CLI 写入的结构化输出，供断言载荷与退出码。 */
export function capture(): {
  stdout: PassThrough;
  stderr: PassThrough;
  text(): { stdout: string; stderr: string };
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const chunks: { stdout: Buffer[]; stderr: Buffer[] } = {
    stdout: [],
    stderr: [],
  };
  stdout.on("data", (chunk: Buffer) => chunks.stdout.push(chunk));
  stderr.on("data", (chunk: Buffer) => chunks.stderr.push(chunk));
  return {
    stdout,
    stderr,
    text: () => ({
      stdout: Buffer.concat(chunks.stdout).toString("utf8"),
      stderr: Buffer.concat(chunks.stderr).toString("utf8"),
    }),
  };
}

export function ownerLabels(id: string): Record<string, string> {
  return { [OWNER_LABEL]: id };
}

/**
 * 回收窗口的等待时长是实现取值而不是合同常量，用例因此用受控时钟推进它。业务在被中断的
 * 场景里还会穿插真实文件操作，那之后才注册假计时器，所以这里围绕业务是否完成持续交替：先让
 * 真实事件循环走一圈，再推进时钟。工具自己失锁时在真实时间上界处报错，不让业务用例挂到运行器
 * 的超时。
 */
export async function settleWithFakeClock<T>(
  start: () => Promise<T>,
  realBudgetMs = 20_000,
): Promise<T> {
  vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
  const startedAt = Number(process.hrtime.bigint() / 1_000_000n);
  try {
    let settled = false;
    const pending = start().then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        throw error;
      },
    );
    while (!settled) {
      const waited = Number(process.hrtime.bigint() / 1_000_000n) - startedAt;
      if (waited > realBudgetMs) {
        throw new Error(
          `The controlled clock did not finish the scenario within ${realBudgetMs} ms of real time (waited ${waited} ms).`,
        );
      }
      await new Promise<void>((yielded) => {
        setImmediate(yielded);
      });
      if (vi.getTimerCount() > 0) {
        await vi.advanceTimersToNextTimerAsync();
      } else {
        await vi.advanceTimersByTimeAsync(1_000);
      }
    }
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}
