import { resolve } from "node:path";
import type { Writable } from "node:stream";
import { pathToFileURL } from "node:url";

import {
  defineCli,
  executeCli,
  helpCapability,
  outputCapability,
  parseCliInvocation,
} from "@ykdz/cli-contract";
import { isNodeBrokenPipe, nodeCliOutput } from "@ykdz/cli-contract/node";
import { z } from "zod";

import { DEFAULT_BOOTSTRAP_IMAGE } from "./defaults.ts";
import {
  destroyPlatform,
  destroyResultSchema,
  platformStatusSchema,
  statusPlatform,
} from "./lifecycle.ts";
import type { DestroyResult } from "./lifecycle.ts";
import { roundResultSchema, runRound } from "./round.ts";
import { PlatformError } from "./types.ts";
import type { PlatformOptions } from "./types.ts";

const DEFAULT_STATE_DIRECTORY = ".artifacts/test-platform";

const define = defineCli<CliDependencies>();

const commonFields = {
  stateDir: {
    kind: "valueOption",
    longOption: "--state-dir",
    description: "Absolute platform state directory",
  },
  bootstrapImage: {
    kind: "valueOption",
    longOption: "--bootstrap-image",
    description: "Digest-pinned DinD bootstrap image reference",
  },
  dockerBinary: {
    kind: "valueOption",
    longOption: "--docker-binary",
    description: "Docker executable name",
  },
} as const;

const commonInput = z.strictObject({
  stateDir: z.string().min(1).default(DEFAULT_STATE_DIRECTORY),
  bootstrapImage: z.string().min(1).default(DEFAULT_BOOTSTRAP_IMAGE),
  dockerBinary: z.string().min(1).optional(),
});

const rejectionSchema = z.strictObject({
  code: z.enum([
    "busy",
    "executionError",
    "invalidManifest",
    "invalidOptions",
    "occupiedStateDirectory",
    "ownershipConflict",
    "reclamationFailed",
    "reuseRejected",
    "targetUnusable",
    "unreachable",
  ]),
  message: z.string(),
  details: z.array(z.string()),
  stateDirectory: z.string(),
});

function projectRejection(
  error: unknown,
  stateDirectory: string,
): z.infer<typeof rejectionSchema> {
  if (error instanceof PlatformError) {
    return {
      code: error.code,
      message: error.message,
      details: [...error.details],
      stateDirectory,
    };
  }
  return {
    code: "executionError",
    message:
      error instanceof Error && error.message !== ""
        ? error.message
        : "Test platform command failed.",
    details: [],
    stateDirectory,
  };
}

function toPlatformOptions(input: {
  stateDir: string;
  bootstrapImage: string;
  dockerBinary?: string | undefined;
}): PlatformOptions {
  if (!input.stateDir.startsWith("/")) {
    throw new PlatformError(
      "invalidOptions",
      "The platform state directory must be an absolute path.",
      [`Received ${input.stateDir}.`],
    );
  }
  return {
    stateDirectory: input.stateDir,
    bootstrapImage: input.bootstrapImage,
    ...(input.dockerBinary === undefined
      ? {}
      : { dockerBinary: input.dockerBinary }),
  };
}

/** 环境变量按名称显式转发；未定义的变量必须明确失败，不静默省略。 */
function resolveEnvironment(
  names: readonly string[],
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of new Set(names)) {
    const value = environment[name];
    if (value === undefined) {
      missing.push(name);
      continue;
    }
    resolved[name] = value;
  }
  if (missing.length > 0) {
    throw new PlatformError(
      "invalidOptions",
      "Requested environment variables are not set in the caller environment.",
      missing.map((name) => `${name} is undefined.`),
    );
  }
  return resolved;
}

const runCommand = define.command("run")({
  kind: "command",
  parent: "platform",
  name: "run",
  description:
    "Prepare the platform when absent, execute one scenario, export evidence, and reclaim the platform by default",
  fields: {
    ...commonFields,
    image: {
      kind: "valueOption",
      longOption: "--image",
      description: "Container image for the scenario",
    },
    source: {
      kind: "valueOption",
      longOption: "--source",
      description: "Local directory copied into the scenario workspace",
    },
    workdir: {
      kind: "valueOption",
      longOption: "--workdir",
      description: "Absolute container workdir",
    },
    timeoutMs: {
      kind: "valueOption",
      longOption: "--timeout-ms",
      description: "Scenario command timeout in milliseconds",
    },
    evidenceDir: {
      kind: "valueOption",
      longOption: "--evidence-dir",
      description: "Absolute external directory for exported evidence",
    },
    env: {
      kind: "repeatableOption",
      longOption: "--env",
      description: "Forward this caller environment variable by name",
    },
    logPath: {
      kind: "repeatableOption",
      longOption: "--log-path",
      description: "Workspace-relative log file collected before reclaim",
    },
    dockerAccess: {
      kind: "flag",
      longOption: "--docker-access",
      description: "Expose the inner Docker socket to the scenario command",
    },
    reuse: {
      kind: "flag",
      longOption: "--reuse",
      description: "Retain a verified clean platform after the round",
    },
    argv: {
      kind: "variadicPositional",
      description: "Scenario command and unchanged arguments after --",
    },
  },
  input: commonInput.extend({
    image: z.string().min(1),
    evidenceDir: z.string().min(1),
    argv: z.array(z.string()).min(1),
    source: z.string().min(1).optional(),
    workdir: z.string().min(1).optional(),
    timeoutMs: z.string().regex(/^\d+$/).optional(),
    env: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).optional(),
    logPath: z.array(z.string().min(1)).optional(),
    dockerAccess: z.boolean().optional(),
    reuse: z.boolean().optional(),
  }),
  success: {
    kind: "data",
    variants: {
      completed: {
        description:
          "Round finished with every required verification item passed",
        schema: roundResultSchema,
        exitCode: 0,
      },
    },
  },
  failures: {
    failed: {
      description:
        "Round finished with a failed or unfinished verification item; the scenario exit code is preserved",
      schema: roundResultSchema,
      exitCode: 1,
    },
    timedOut: {
      description: "The scenario command reached its timeout",
      schema: roundResultSchema,
      exitCode: 124,
    },
    interrupted: {
      description: "The round was cancelled by SIGINT",
      schema: roundResultSchema,
      exitCode: 130,
    },
    terminated: {
      description: "The round was cancelled by SIGTERM",
      schema: roundResultSchema,
      exitCode: 143,
    },
    rejected: {
      description:
        "The request was rejected before the round produced a result",
      schema: rejectionSchema,
      exitCode: 1,
    },
  },
  async handler({ input, outcome, dependencies }) {
    const stateDirectory = input.stateDir;
    let options: PlatformOptions;
    try {
      options = toPlatformOptions(input);
      if (!input.evidenceDir.startsWith("/")) {
        throw new PlatformError(
          "invalidOptions",
          "The evidence directory must be an absolute path.",
          [`Received ${input.evidenceDir}.`],
        );
      }
    } catch (error) {
      return outcome.failure.rejected(projectRejection(error, stateDirectory));
    }
    const controller = new AbortController();
    const release = (
      dependencies.watchCancellation ?? watchProcessCancellation
    )((reason) => controller.abort(reason));
    try {
      const environment = resolveEnvironment(
        input.env ?? [],
        dependencies.environment ?? process.env,
      );
      const result = await (dependencies.runRound ?? runRound)(options, {
        evidenceDirectory: input.evidenceDir,
        reuse: input.reuse ?? false,
        signal: controller.signal,
        scenarios: [
          {
            image: input.image,
            command: input.argv,
            ...(input.source === undefined
              ? {}
              : { sourceDirectory: resolve(input.source) }),
            ...(input.workdir === undefined ? {} : { workdir: input.workdir }),
            ...(input.timeoutMs === undefined
              ? {}
              : { timeoutMs: Number(input.timeoutMs) }),
            ...(input.logPath === undefined || input.logPath.length === 0
              ? {}
              : { logPaths: input.logPath }),
            ...(Object.keys(environment).length === 0 ? {} : { environment }),
            ...(input.dockerAccess === true ? { dockerAccess: true } : {}),
          },
        ],
      });
      // 平台只按声明的结果类别选择变体，被测命令真实退出码保留在载荷中。
      switch (result.exitCode) {
        case 0:
          return outcome.data.completed(result);
        case 124:
          return outcome.failure.timedOut(result);
        case 130:
          return outcome.failure.interrupted(result);
        case 143:
          return outcome.failure.terminated(result);
        default:
          return outcome.failure.failed(result);
      }
    } catch (error) {
      return outcome.failure.rejected(projectRejection(error, stateDirectory));
    } finally {
      release();
    }
  },
});

const statusCommand = define.command("status")({
  kind: "command",
  parent: "platform",
  name: "status",
  description:
    "Report the recorded platform phase together with the observed engine state",
  fields: commonFields,
  input: commonInput,
  success: {
    kind: "data",
    variants: {
      snapshot: {
        description:
          "Platform state was observed and both engines are reachable",
        schema: platformStatusSchema,
        exitCode: 0,
      },
    },
  },
  failures: {
    degraded: {
      description: "Platform state was observed but an engine is unreachable",
      schema: platformStatusSchema,
      exitCode: 1,
    },
    rejected: {
      description: "Platform state could not be observed",
      schema: rejectionSchema,
      exitCode: 1,
    },
  },
  async handler({ input, outcome, dependencies }) {
    let options: PlatformOptions;
    try {
      options = toPlatformOptions(input);
    } catch (error) {
      return outcome.failure.rejected(projectRejection(error, input.stateDir));
    }
    try {
      const status = await (dependencies.statusPlatform ?? statusPlatform)(
        options,
      );
      return status.outer === "unreachable" || status.inner === "unreachable"
        ? outcome.failure.degraded(status)
        : outcome.data.snapshot(status);
    } catch (error) {
      return outcome.failure.rejected(projectRejection(error, input.stateDir));
    }
  },
});

const destroyCommand = define.command("destroy")({
  kind: "command",
  parent: "platform",
  name: "destroy",
  description:
    "Export evidence, reclaim every platform resource, and remove local platform state",
  fields: {
    ...commonFields,
    evidenceDir: {
      kind: "valueOption",
      longOption: "--evidence-dir",
      description:
        "Absolute evidence directory to continue into, or a repaired replacement target",
    },
  },
  input: commonInput.extend({
    evidenceDir: z.string().min(1).optional(),
  }),
  success: {
    kind: "data",
    variants: {
      destroyed: {
        description:
          "Platform resources and local state are gone and evidence was exported",
        schema: destroyResultSchema,
        exitCode: 0,
      },
    },
  },
  failures: {
    recoveryRequired: {
      description:
        "Reclamation or evidence export failed; the recovery manifest is kept",
      schema: destroyResultSchema,
      exitCode: 1,
    },
    rejected: {
      description: "Destroy could not be attempted",
      schema: rejectionSchema,
      exitCode: 1,
    },
  },
  async handler({ input, outcome, dependencies }) {
    let options: PlatformOptions;
    try {
      options = toPlatformOptions(input);
      if (
        input.evidenceDir !== undefined &&
        !input.evidenceDir.startsWith("/")
      ) {
        throw new PlatformError(
          "invalidOptions",
          "The evidence directory must be an absolute path.",
          [`Received ${input.evidenceDir}.`],
        );
      }
    } catch (error) {
      return outcome.failure.rejected(projectRejection(error, input.stateDir));
    }
    try {
      const result: DestroyResult = await (
        dependencies.destroyPlatform ?? destroyPlatform
      )(
        options,
        input.evidenceDir === undefined
          ? {}
          : { evidenceDirectory: input.evidenceDir },
      );
      return result.disposition === "recovery_required"
        ? outcome.failure.recoveryRequired(result)
        : outcome.data.destroyed(result);
    } catch (error) {
      return outcome.failure.rejected(projectRejection(error, input.stateDir));
    }
  },
});

const platformCli = define({
  root: "platform",
  help: helpCapability({
    shortAlias: "-h",
    headings: {
      usage: "Usage",
      commands: "Commands",
      arguments: "Arguments",
      options: "Options",
    },
    wording: {
      commandPlaceholder: "command",
      choices: "(choices: {choices})",
      default: "(default: {value})",
    },
  }),
  output: outputCapability({ defaultFormat: "structured" }),
  usageFailureExitCode: 1,
  commands: {
    platform: {
      kind: "rootGroup",
      name: "test-platform",
      description:
        "Disposable local test platform. Public commands are run, status, and destroy.",
    },
    ...runCommand,
    ...statusCommand,
    ...destroyCommand,
  },
});

export interface CliDependencies {
  environment?: NodeJS.ProcessEnv;
  runRound?: typeof runRound;
  statusPlatform?: typeof statusPlatform;
  destroyPlatform?: typeof destroyPlatform;
  /** 取消来源接缝：宿主进程信号或测试注入的取消。 */
  watchCancellation?: (
    abort: (reason: "SIGINT" | "SIGTERM") => void,
  ) => () => void;
}

function watchProcessCancellation(
  abort: (reason: "SIGINT" | "SIGTERM") => void,
): () => void {
  const interrupt = (): void => abort("SIGINT");
  const terminate = (): void => abort("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  return () => {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  };
}

export interface RunCliDependencies extends CliDependencies {
  stdout?: Writable;
  stderr?: Writable;
}

/**
 * Node 入口：解析进程 argv、执行契约，并直接采用库给出的退出码。
 * 契约对象保持模块私有，避免导出的类型把库的私有 brand 暴露到声明产物里。
 */
export async function runCli(
  args: readonly string[],
  dependencies: RunCliDependencies = {},
): Promise<number> {
  const stderr = dependencies.stderr ?? process.stderr;
  const write = nodeCliOutput({
    stdout: dependencies.stdout ?? process.stdout,
    stderr,
  });
  try {
    const termination = await executeCli(platformCli, {
      invocation: parseCliInvocation(platformCli, [...args]),
      dependencies,
      write,
    });
    return termination.exitCode;
  } catch (error) {
    // 断管只终止输出，不改变已声明的结果类别。
    if (isNodeBrokenPipe(error)) return 0;
    stderr.write(
      `Test platform command failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = await runCli(process.argv.slice(2));
}
