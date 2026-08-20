import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import {
  commandSpecForName,
  commandSpecs,
  flagDisplay,
  fullUsageFor,
  type CommandArg,
  type ValueKind,
} from "../../src/command-spec.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const cliBin = join(repoRoot, "apps/cli/dist/cli.js");
const daemonBin = join(repoRoot, "packages/daemon/dist/main.js");
const fixturesModule = join(
  repoRoot,
  "apps/cli/test/e2e/fixtures/fake-adapters.ts",
);

type CliResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  options?: { input?: string; timeoutMs?: number },
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, [cliBin, ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout?.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    if (options?.input !== undefined) {
      child.stdin?.write(options.input);
    }
    child.stdin?.end();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        exitCode: -1,
      });
    }, options?.timeoutMs ?? 15_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        exitCode: code ?? -1,
      });
    });
  });
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 5000,
): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("等待条件超时");
    }
    await sleep(50);
  }
}

const cleanupDirs: string[] = [];

afterEach(async () => {
  for (const dir of cleanupDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function testEnv(dir: string): NodeJS.ProcessEnv {
  return {
    REINS_SOCKET: join(dir, "reins.sock"),
    REINS_DAEMON_BIN: daemonBin,
    REINS_ADAPTERS_MODULE: fixturesModule,
    REINS_IDLE_TIMEOUT_MS: "300",
  };
}

async function freshEnv(): Promise<{
  dir: string;
  env: NodeJS.ProcessEnv;
  socketPath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "reins-cli-e2e-"));
  cleanupDirs.push(dir);
  return {
    dir,
    env: testEnv(dir),
    socketPath: join(dir, "reins.sock"),
  };
}

describe("A 类：帮助（stdout + 退出 0）", () => {
  test("无子命令输出 stdout 帮助", async () => {
    const { env } = await freshEnv();
    const result = await runCli([], env);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: reins [options] <command>");
  });

  test("--help 输出 stdout 帮助", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["--help"], env);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: reins [options] <command>");
  });

  test("子命令 --help 输出完整参数表", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["spawn", "--help"], env);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "Usage: reins spawn <harness> <message...> [options]",
    );
    expect(result.stdout).toContain("--authorization-mode");
  });

  test("interrupt help 不再声明 message", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["interrupt", "--help"], env);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "Usage: reins interrupt <ids...> [options]",
    );
    expect(result.stdout).not.toContain("--message");
  });

  test("--version 输出 stdout", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["--version"], env);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("0.0.0\n");
  });
});

describe("CLI 进程边界（缝 D）", () => {
  test("capabilities 输出能力矩阵（JSON 默认）", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["capabilities"], env);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      capabilities: Array<{ harness: string }>;
      failures: unknown[];
    };
    expect(parsed.failures).toEqual([]);
    expect(parsed.capabilities.map((entry) => entry.harness).sort()).toEqual([
      "fake",
      "hang",
      "permission",
    ]);
  });

  test("spawn 成功并以 JSON 输出 sessionId", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["spawn", "fake", "hello"], env);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ sessionId: "s1" });
    await runCli(["kill", "s1"], env);
  });

  test("spawn 接受合法 --authorization-mode 与 --meta", async () => {
    const { env } = await freshEnv();
    const result = await runCli(
      [
        "spawn",
        "fake",
        "hi",
        "--authorization-mode",
        "allow-all",
        "--meta",
        '{"a":1}',
      ],
      env,
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ sessionId: "s1" });
    await runCli(["kill", "s1"], env);
  });

  test("run 默认只返回紧凑最终结果，不流式回放事件", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["run", "fake", "hello"], env);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      sessionId: "s1",
      stopReason: "end_turn",
      finalReply: "ok",
    });
    expect(result.stdout).not.toContain('"method":"event"');
    await runCli(["kill", "s1"], env);
  });

  test("--pretty run 输出人类可读最终结果", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["--pretty", "run", "fake", "hello"], env);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Turn completed: end_turn (s1)\nok\n");
    await runCli(["kill", "s1"], env);
  });

  test("attach 仍默认流式回放事件（JSON 诊断视图）", async () => {
    const { env } = await freshEnv();
    const spawned = await runCli(["spawn", "fake", "hello"], env);
    expect(spawned.exitCode).toBe(0);
    const sessionId = (JSON.parse(spawned.stdout) as { sessionId: string })
      .sessionId;
    const attached = await runCli(
      ["attach", sessionId, "--exit-on", "end_turn"],
      env,
    );
    expect(attached.exitCode).toBe(0);
    expect(attached.stdout).toContain('"kind":"notification"');
    expect(attached.stdout).toContain('"method":"event"');
    expect(attached.stdout).toContain('"stopReason":"end_turn"');
    expect(attached.stdout).toContain('"role":"worker"');
    await runCli(["kill", sessionId], env);
  });

  test("wait 超时退出码 4", async () => {
    const { env } = await freshEnv();
    const spawned = await runCli(["spawn", "hang", "wait me"], env);
    expect(spawned.exitCode).toBe(0);
    const sessionId = (JSON.parse(spawned.stdout) as { sessionId: string })
      .sessionId;
    const waited = await runCli(["wait", sessionId, "--timeout", "100"], env);
    expect(waited.exitCode).toBe(4);
    expect(JSON.parse(waited.stdout)).toEqual({
      status: "timeout",
      results: [],
    });
    await runCli(["kill", sessionId], env);
  });

  test("--pretty spawn 输出人类可读英文", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["--pretty", "spawn", "fake", "hi"], env);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Created session s1\n");
    await runCli(["kill", "s1"], env);
  });

  test("attach pretty 权限交互并随决议结束", async () => {
    const { env } = await freshEnv();
    const spawned = await runCli(["spawn", "permission", "do it"], env);
    expect(spawned.exitCode).toBe(0);
    const sessionId = (JSON.parse(spawned.stdout) as { sessionId: string })
      .sessionId;
    const attached = await runCli(
      ["attach", sessionId, "--pretty", "--exit-on", "end_turn"],
      env,
      { input: "1\n" },
    );
    expect(attached.exitCode).toBe(0);
    expect(attached.stdout).toContain("Permission requested");
    expect(attached.stdout).toContain("[attach ended]");
    expect(attached.stdout).toContain("resolved:allow");
    await runCli(["kill", sessionId], env);
  });

  test("attach pretty 显示 caller/worker 角色", async () => {
    const { env } = await freshEnv();
    const spawned = await runCli(["spawn", "fake", "hello"], env);
    expect(spawned.exitCode).toBe(0);
    const sessionId = (JSON.parse(spawned.stdout) as { sessionId: string })
      .sessionId;
    const sent = await runCli(["send", sessionId, "next"], env);
    expect(sent.exitCode).toBe(0);
    const attached = await runCli(
      ["attach", sessionId, "--pretty", "--exit-on", "end_turn"],
      env,
    );
    expect(attached.exitCode).toBe(0);
    expect(attached.stdout).toContain("worker: interim");
    expect(attached.stdout).toContain("caller: next");
    await runCli(["kill", sessionId], env);
  });

  test("自动拉起 daemon，空闲后清理 socket", async () => {
    const { env, socketPath } = await freshEnv();
    expect(await pathExists(socketPath)).toBe(false);
    const result = await runCli(["capabilities"], env);
    expect(result.exitCode).toBe(0);
    await waitFor(async () => pathExists(socketPath));
    await waitFor(async () => !(await pathExists(socketPath)), 5000);
  });
});

type UsageCase = {
  name: string;
  args: readonly string[];
  issue:
    | "missing_argument"
    | "unknown_command"
    | "unknown_option"
    | "invalid_value";
  target?: "argument" | "option";
  field?: string;
  value?: string;
  valid?: readonly string[];
  hint?: string;
  suggestionContains?: readonly string[];
  specName?: string;
};

function sampleForArg(arg: CommandArg): string {
  switch (arg.name) {
    case "harness":
      return "fake";
    case "message":
      return "hi";
    case "sessionId":
      return "s1";
    case "permissionId":
      return "p1";
    case "ids":
      return "s1";
    default:
      return "x";
  }
}

function sampleForOption(option: { flags: string; kind: ValueKind }): string {
  if (option.kind.type === "enum") return option.kind.values[0] ?? "x";
  return "x";
}

function suggestionForMissing(
  arg: CommandArg | { flags: string; description: string; kind: ValueKind },
): string {
  if (arg.kind.type === "enum") {
    return `Allowed: ${arg.kind.values.join(", ")}`;
  }
  if (
    arg.kind.type === "dynamic" ||
    arg.kind.type === "number" ||
    arg.kind.type === "jsonObject"
  ) {
    return arg.kind.hint;
  }
  return arg.description;
}

function missingArgumentCases(): UsageCase[] {
  return commandSpecs.flatMap((spec) =>
    spec.args.map((arg, index) => {
      const prefix = [
        ...spec.args.slice(0, index).map(sampleForArg),
        ...spec.options
          .filter((option) => option.required === true)
          .flatMap((option) => [
            flagDisplay(option.flags),
            sampleForOption(option),
          ]),
      ];
      return {
        name: `${spec.name} missing ${arg.name}`,
        args: [spec.name, ...prefix],
        issue: "missing_argument" as const,
        target: "argument" as const,
        field: arg.name,
        specName: spec.name,
        suggestionContains: [suggestionForMissing(arg)],
      };
    }),
  );
}

function missingOptionCases(): UsageCase[] {
  return commandSpecs.flatMap((spec) =>
    spec.options
      .filter((option) => option.required === true)
      .map((option) => ({
        name: `${spec.name} missing option ${option.name}`,
        args: [spec.name, ...spec.args.map(sampleForArg)],
        issue: "missing_argument" as const,
        target: "option" as const,
        field: option.flags,
        specName: spec.name,
        suggestionContains: [suggestionForMissing(option)],
      })),
  );
}

function invalidEnumCases(): UsageCase[] {
  return commandSpecs.flatMap((spec) =>
    spec.options
      .filter(
        (
          option,
        ): option is typeof option & {
          kind: { type: "enum"; values: readonly string[] };
        } => option.kind.type === "enum",
      )
      .map((option) => ({
        name: `${spec.name} invalid ${option.name}`,
        args: [
          spec.name,
          ...spec.args.map(sampleForArg),
          ...spec.options
            .filter(
              (candidate) =>
                candidate.required === true && candidate.name !== option.name,
            )
            .flatMap((candidate) => [
              flagDisplay(candidate.flags),
              sampleForOption(candidate),
            ]),
          flagDisplay(option.flags),
          "bogus",
        ],
        issue: "invalid_value" as const,
        field: flagDisplay(option.flags),
        value: "bogus",
        valid: [...option.kind.values],
        specName: spec.name,
        suggestionContains: [`Allowed: ${option.kind.values.join(", ")}`],
      })),
  );
}

const specialValueCases: UsageCase[] = [
  {
    name: "wait invalid timeout",
    args: ["wait", "s1", "--timeout", "abc"],
    issue: "invalid_value",
    field: "--timeout",
    value: "abc",
    hint: "Expected a non-negative number",
    suggestionContains: ["Expected a non-negative number"],
    specName: "wait",
  },
  {
    name: "attach invalid replay",
    args: ["attach", "s1", "--replay", "-1"],
    issue: "invalid_value",
    field: "--replay",
    value: "-1",
    hint: "Expected a non-negative integer",
    suggestionContains: ["Expected a non-negative integer"],
    specName: "attach",
  },
  {
    name: "spawn invalid meta",
    args: ["spawn", "fake", "hi", "--meta", "not-json"],
    issue: "invalid_value",
    field: "--meta",
    value: "not-json",
    hint: "Expected a JSON object",
    suggestionContains: ["Expected a JSON object"],
    specName: "spawn",
  },
  {
    name: "capabilities excess arguments",
    args: ["capabilities", "x"],
    issue: "invalid_value",
    field: "arguments",
    hint: "Remove the extra arguments",
    suggestionContains: ["Remove the extra arguments"],
    specName: "capabilities",
  },
];

const unknownCommandCase: UsageCase = {
  name: "unknown command",
  args: ["bogus"],
  issue: "unknown_command",
  value: "bogus",
  valid: commandSpecs.map((spec) => spec.name),
  suggestionContains: ["Allowed: spawn"],
};

const unknownOptionSpec = commandSpecForName("spawn");
const unknownOptionCase: UsageCase = {
  name: "unknown option",
  args: ["spawn", "fake", "hi", "--nope"],
  issue: "unknown_option",
  value: "--nope",
  valid: [
    ...(unknownOptionSpec?.options.map((option) => flagDisplay(option.flags)) ??
      []),
    "--pretty",
  ],
  suggestionContains: ["Allowed: --agent"],
  specName: "spawn",
};

const removedInterruptMessageOptionCase: UsageCase = {
  name: "interrupt removed message option",
  args: ["interrupt", "s1", "--message", "legacy explanation"],
  issue: "unknown_option",
  value: "--message",
  valid: ["--pretty"],
  suggestionContains: ["Allowed: --pretty"],
  specName: "interrupt",
};

const usageCases: UsageCase[] = [
  ...missingArgumentCases(),
  ...missingOptionCases(),
  ...invalidEnumCases(),
  ...specialValueCases,
  unknownCommandCase,
  unknownOptionCase,
  removedInterruptMessageOptionCase,
];

describe("CLI 错误矩阵（缝 D，从命令规范派生）", () => {
  for (const usageCase of usageCases) {
    const spec =
      usageCase.specName === undefined
        ? undefined
        : commandSpecForName(usageCase.specName);
    for (const pretty of [false, true]) {
      test(`${usageCase.name}（${pretty ? "pretty" : "json"}）`, async () => {
        const { env } = await freshEnv();
        const args = pretty ? ["--pretty", ...usageCase.args] : usageCase.args;
        const result = await runCli(args, env);
        expect(result.exitCode, usageCase.name).toBe(64);
        if (pretty) {
          expect(result.stdout).toBe("");
          expect(result.stderr).not.toContain("error: error:");
          expect(result.stderr.startsWith("error: ")).toBe(true);
          expect(result.stderr).toContain("suggestion: ");
          expect(result.stderr).toContain(`usage: reins ${fullUsageFor(spec)}`);
          for (const fragment of usageCase.suggestionContains ?? []) {
            expect(result.stderr, usageCase.name).toContain(fragment);
          }
          return;
        }
        expect(result.stderr).toBe("");
        const parsed = JSON.parse(result.stdout) as {
          code: string;
          message: string;
          context: {
            issue?: string;
            target?: string;
            field?: string;
            value?: string;
            valid?: string[];
            hint?: string;
          };
        };
        expect(parsed.code).toBe("usage_error");
        expect(parsed.context.issue).toBe(usageCase.issue);
        if (usageCase.target !== undefined) {
          expect(parsed.context.target).toBe(usageCase.target);
        }
        if (usageCase.field !== undefined) {
          expect(parsed.context.field).toBe(usageCase.field);
        }
        if (usageCase.value !== undefined) {
          expect(parsed.context.value).toBe(usageCase.value);
        }
        if (usageCase.valid !== undefined) {
          expect(parsed.context.valid).toEqual([...usageCase.valid]);
        }
        if (usageCase.hint !== undefined) {
          expect(parsed.context.hint).toBe(usageCase.hint);
        }
        for (const fragment of usageCase.suggestionContains ?? []) {
          expect(parsed.message, usageCase.name).toContain(fragment);
        }
      });
    }
  }
});

describe("CLI 输出金样（逐字节）", () => {
  test("缺 harness 的 pretty 错误块", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["--pretty", "spawn"], env);
    expect(result.exitCode).toBe(64);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "error: Missing required argument 'harness'\n" +
        "suggestion: Run 'reins capabilities' to list valid harnesses\n" +
        "usage: reins spawn <harness> <message...> [options]\n",
    );
  });

  test("缺 harness 的 JSON 机器错误", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["spawn"], env);
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      `${JSON.stringify({
        code: "usage_error",
        message:
          "Missing required argument 'harness'. Run 'reins capabilities' to list valid harnesses",
        context: {
          issue: "missing_argument",
          target: "argument",
          field: "harness",
        },
      })}\n`,
    );
  });

  test("非法 state 的 pretty 错误块", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["--pretty", "list", "--state", "bogus"], env);
    expect(result.exitCode).toBe(64);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "error: Invalid value 'bogus' for '--state'\n" +
        "suggestion: Allowed: busy, idle, killed\n" +
        "usage: reins list [options]\n",
    );
  });

  test("拼错命令保留 Did you mean", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["--pretty", "spwan"], env);
    expect(result.exitCode).toBe(64);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "error: Unknown command 'spwan'. Did you mean 'spawn'?\n" +
        "suggestion: Allowed: spawn, send, wait, interrupt, kill, list, attach, run, capabilities, resolve-permission\n" +
        "usage: reins [options] <command>\n",
    );
  });

  test("未知 harness 的 pretty 错误块（能力矩阵内联）", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["--pretty", "spawn", "nope", "x"], env);
    expect(result.exitCode).toBe(64);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "error: Unknown harness 'nope'\n" +
        "suggestion: Allowed: fake, hang, permission\n" +
        "usage: reins spawn <harness> <message...> [options]\n",
    );
  });
});

describe("CLI 动态值错误（能力矩阵一次往返）", () => {
  test("unknown harness JSON 内联合法列表", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["spawn", "nope", "x"], env);
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      code: string;
      message: string;
      context?: { valid?: { harness?: string[] }; value?: string };
    };
    expect(parsed.code).toBe("unknown_harness");
    expect(parsed.context?.value).toBe("nope");
    expect(parsed.context?.valid?.harness).toContain("fake");
    expect(parsed.message).toContain("Unknown harness 'nope'");
    expect(parsed.message).toContain("Allowed: fake");
  });

  test("invalid model JSON 内联合法模型", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["spawn", "fake", "x", "--model", "nope"], env);
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      code: string;
      message: string;
      context?: { valid?: { models?: Array<{ id: string }> } };
    };
    expect(parsed.code).toBe("invalid_params");
    expect(parsed.context?.valid?.models?.[0]?.id).toBe("fake-model");
    expect(parsed.message).toContain("Invalid model 'nope' for harness 'fake'");
    expect(parsed.message).toContain("Allowed models: fake-model (low, high)");
  });

  test("invalid reasoning JSON 内联合法强度", async () => {
    const { env } = await freshEnv();
    const result = await runCli(
      ["spawn", "fake", "x", "--model", "fake-model", "--reasoning", "bogus"],
      env,
    );
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      code: string;
      message: string;
    };
    expect(parsed.code).toBe("invalid_params");
    expect(parsed.message).toContain(
      "Invalid reasoning effort 'bogus' for model 'fake-model'",
    );
    expect(parsed.message).toContain("Allowed: low, high");
  });

  test("pretty invalid model 内联合法模型与 usage", async () => {
    const { env } = await freshEnv();
    const result = await runCli(
      ["--pretty", "spawn", "fake", "x", "--model", "nope"],
      env,
    );
    expect(result.exitCode).toBe(64);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "error: Invalid model 'nope' for harness 'fake'",
    );
    expect(result.stderr).toContain(
      "suggestion: Allowed models: fake-model (low, high)",
    );
    expect(result.stderr).toContain(
      "usage: reins spawn <harness> <message...> [options]",
    );
  });
});

describe("CLI 域错误（不夹带 usage）", () => {
  test("send 未知会话返回 session_not_found", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["send", "s999", "hi"], env);
    expect(result.exitCode).toBe(65);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "session_not_found",
    });
  });

  test("wait 未知会话返回 session_not_found", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["wait", "s999"], env);
    expect(result.exitCode).toBe(65);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "session_not_found",
    });
  });

  test("kill 未知会话返回 not_found 而非报错", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["kill", "s999"], env);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { sessionId: "s999", status: "not_found" },
    ]);
  });

  test("daemon 不可达返回 internal_error", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["capabilities"], {
      ...env,
      REINS_DAEMON_BIN: "/bin/false",
    });
    expect(result.exitCode).toBe(65);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "internal_error",
    });
  });

  test("pretty 域错误不输出 suggestion 与 usage", async () => {
    const { env } = await freshEnv();
    const result = await runCli(["--pretty", "send", "s999", "hi"], env);
    expect(result.exitCode).toBe(65);
    expect(result.stderr).toBe("error: Session not found: s999\n");
    expect(result.stderr).not.toContain("suggestion:");
    expect(result.stderr).not.toContain("usage:");
  });
});
