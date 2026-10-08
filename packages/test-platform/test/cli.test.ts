import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { runCli } from "../src/cli.ts";
import type { CliDependencies } from "../src/cli.ts";
import { DEFAULT_BOOTSTRAP_IMAGE } from "../src/defaults.ts";
import { destroyPlatform } from "../src/lifecycle.ts";
import type { DestroyResult, PlatformStatus } from "../src/lifecycle.ts";
import { roundResultSchema, runRound } from "../src/round.ts";
import type { RoundRequest, RoundResult } from "../src/round.ts";
import { BOOTSTRAP_IMAGE, capture, fakeEngine } from "./fixtures.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

interface RoundRoot {
  stateDirectory: string;
  evidenceDirectory: string;
}

async function createRoot(): Promise<RoundRoot> {
  const base = await mkdtemp(join(tmpdir(), "reins-platform-cli-"));
  directories.push(base);
  return {
    stateDirectory: join(base, "state"),
    evidenceDirectory: join(base, "evidence"),
  };
}

const envelopeSchema = z.looseObject({
  schemaVersion: z.string(),
  command: z.string(),
  kind: z.enum(["data", "failure", "usageFailure"]),
  variant: z.string().optional(),
  data: z.unknown().optional(),
  issues: z
    .array(
      z.looseObject({
        code: z.string(),
        field: z.string().optional(),
        option: z.string().optional(),
      }),
    )
    .optional(),
});

/** 结构化结果成功写 stdout、失败写 stderr；此处取唯一一条载荷。 */
function envelope(streams: { stdout: string; stderr: string }): {
  kind: "data" | "failure" | "usageFailure";
  variant: string | undefined;
  data: unknown;
  issues: {
    code: string;
    option?: string | undefined;
    field?: string | undefined;
  }[];
} {
  const lines = (streams.stdout + streams.stderr).split("\n").filter(Boolean);
  expect(lines).toHaveLength(1);
  const parsed = envelopeSchema.parse(JSON.parse(lines[0]!));
  return {
    kind: parsed.kind,
    variant: parsed.variant,
    data: parsed.data,
    issues: (parsed.issues ?? []).map(({ code, field, option }) => ({
      code,
      ...(field === undefined ? {} : { field }),
      ...(option === undefined ? {} : { option }),
    })),
  };
}

/** 用内存引擎跑真实轮次，CLI 只负责契约、载荷与退出码。 */
function engineRound(docker = fakeEngine()) {
  const calls: { options: unknown; request: RoundRequest }[] = [];
  const runRoundDependency = async (
    options: Parameters<typeof runRound>[0],
    request: RoundRequest,
  ): Promise<RoundResult> => {
    calls.push({ options, request });
    const result = await runRound(options, request, {
      execute: docker.execute,
    });
    return result;
  };
  return { docker, calls, runRoundDependency };
}

function runArgs(root: RoundRoot, command: readonly string[]): string[] {
  return [
    "run",
    "--state-dir",
    root.stateDirectory,
    "--evidence-dir",
    root.evidenceDirectory,
    "--image",
    "alpine:3.20@sha256:keep",
    "--",
    ...command,
  ];
}

describe("平台 CLI 原生契约", () => {
  test("run 只转发调用方显式给出的输入，argv 在 -- 之后逐字保留", async () => {
    const root = await createRoot();
    const out = capture();
    const round = engineRound();
    const argumentsList = [
      "run",
      "--state-dir",
      root.stateDirectory,
      "--docker-binary",
      "podman-docker",
      "--bootstrap-image",
      BOOTSTRAP_IMAGE,
      "--evidence-dir",
      root.evidenceDirectory,
      "--image",
      "alpine:3.20@sha256:keep",
      "--source",
      "src",
      "--workdir",
      "/platform/run",
      "--timeout-ms",
      "30000",
      "--env",
      "TOKEN",
      "--env",
      "TOKEN",
      "--env",
      "BUILDKITE_COMMIT",
      "--log-path",
      "logs/unit.log",
      "--log-path",
      "logs/integration.log",
      "--docker-access",
      "--",
      "--help",
      "-e",
      "",
      "$TOKEN",
      "literal `backtick`",
      "exit 0",
    ];
    const exit = await runCli(argumentsList, {
      environment: { TOKEN: "secret-value", BUILDKITE_COMMIT: "abc123" },
      stdout: out.stdout,
      stderr: out.stderr,
      runRound: round.runRoundDependency,
    });
    expect(exit).toBe(0);
    expect(envelope(out.text())).toMatchObject({
      kind: "data",
      variant: "completed",
    });

    const [call] = round.calls;
    expect(call?.options).toEqual({
      stateDirectory: root.stateDirectory,
      bootstrapImage: BOOTSTRAP_IMAGE,
      dockerBinary: "podman-docker",
    });
    expect(call?.request.scenarios).toEqual([
      {
        image: "alpine:3.20@sha256:keep",
        command: ["--help", "-e", "", "$TOKEN", "literal `backtick`", "exit 0"],
        sourceDirectory: resolveFromCwd("src"),
        workdir: "/platform/run",
        timeoutMs: 30_000,
        logPaths: ["logs/unit.log", "logs/integration.log"],
        environment: { TOKEN: "secret-value", BUILDKITE_COMMIT: "abc123" },
        dockerAccess: true,
      },
    ]);
    expect(call?.request.reuse).toBe(false);
    expect(call?.request.signal).toBeInstanceOf(AbortSignal);
  });

  test("省略可选开关时平台不注入任何默认值", async () => {
    const root = await createRoot();
    const out = capture();
    const round = engineRound();
    const exit = await runCli(runArgs(root, ["true"]), {
      stdout: out.stdout,
      stderr: out.stderr,
      runRound: round.runRoundDependency,
    });
    expect(exit).toBe(0);
    const [call] = round.calls;
    expect(call?.options).toEqual({
      stateDirectory: root.stateDirectory,
      bootstrapImage: DEFAULT_BOOTSTRAP_IMAGE,
    });
    expect(call?.request.scenarios[0]).toEqual({
      image: "alpine:3.20@sha256:keep",
      command: ["true"],
    });
    expect(call?.request.reuse).toBe(false);
  });

  test.each([
    { variant: "completed", exitCode: 0, runOutcome: {}, scenarioExitCode: 0 },
    {
      variant: "failed",
      exitCode: 1,
      runOutcome: { exitCode: 7 },
      scenarioExitCode: 7,
    },
    {
      variant: "timedOut",
      exitCode: 124,
      runOutcome: { exitCode: null, timedOut: true },
      scenarioExitCode: null,
    },
  ])(
    "真实结果类别 $variant 映射到固定退出码 $exitCode",
    async ({ variant, exitCode, runOutcome, scenarioExitCode }) => {
      const root = await createRoot();
      const out = capture();
      const round = engineRound(fakeEngine({ runOutcomes: [runOutcome] }));
      const actual = await runCli(runArgs(root, ["sh", "-c", "exit 7"]), {
        stdout: out.stdout,
        stderr: out.stderr,
        runRound: round.runRoundDependency,
      });
      expect(actual).toBe(exitCode);
      const payload = envelope(out.text());
      expect(payload.variant).toBe(variant);
      const result = roundResultSchema.parse(payload.data);
      expect(result.disposition).toBe("destroyed");
      expect(result.scenarios[0]?.exitCode).toBe(scenarioExitCode);
    },
  );

  test.each([
    { reason: "SIGINT" as const, variant: "interrupted", exitCode: 130 },
    { reason: "SIGTERM" as const, variant: "terminated", exitCode: 143 },
  ])(
    "取消信号 $reason 报告 $variant 并在结束后释放信号监听",
    async ({ reason, variant, exitCode }) => {
      const root = await createRoot();
      const out = capture();
      const round = engineRound();
      let released = 0;
      const dependencies: CliDependencies = {
        runRound: round.runRoundDependency,
        watchCancellation: (abort) => {
          abort(reason);
          return () => {
            released += 1;
          };
        },
      };
      const actual = await runCli(runArgs(root, ["true"]), {
        ...dependencies,
        stdout: out.stdout,
        stderr: out.stderr,
      });
      expect(actual).toBe(exitCode);
      expect(envelope(out.text()).variant).toBe(variant);
      expect(roundResultSchema.parse(envelope(out.text()).data).cancelled).toBe(
        reason,
      );
      expect(released).toBe(1);
    },
  );

  test("请求的环境变量未定义时在轮次开始之前拒绝", async () => {
    const root = await createRoot();
    const out = capture();
    const round = engineRound();
    const exit = await runCli(
      [
        "run",
        "--state-dir",
        root.stateDirectory,
        "--evidence-dir",
        root.evidenceDirectory,
        "--image",
        "alpine:3.20@sha256:keep",
        "--env",
        "TOKEN",
        "--",
        "true",
      ],
      {
        environment: {},
        stdout: out.stdout,
        stderr: out.stderr,
        runRound: round.runRoundDependency,
      },
    );
    expect(exit).toBe(1);
    expect(round.calls).toEqual([]);
    const payload = envelope(out.text());
    expect(payload.variant).toBe("rejected");
    expect(payload.data).toMatchObject({
      code: "invalidOptions",
      details: ["TOKEN is undefined."],
      stateDirectory: root.stateDirectory,
    });
  });

  test("凭据值只转发给场景，不出现在 CLI 输出", async () => {
    const root = await createRoot();
    const out = capture();
    const round = engineRound(
      fakeEngine({
        runOutcomes: [{ exitCode: 1, stderr: "candidate failed" }],
      }),
    );
    const exit = await runCli(
      [
        "run",
        "--state-dir",
        root.stateDirectory,
        "--evidence-dir",
        root.evidenceDirectory,
        "--image",
        "alpine:3.20@sha256:keep",
        "--env",
        "TOKEN",
        "--",
        "true",
      ],
      {
        environment: { TOKEN: "super-secret-value" },
        stdout: out.stdout,
        stderr: out.stderr,
        runRound: round.runRoundDependency,
      },
    );
    expect(exit).toBe(1);
    expect(round.calls[0]?.request.scenarios[0]?.environment).toEqual({
      TOKEN: "super-secret-value",
    });
    const streams = out.text();
    expect(streams.stdout + streams.stderr).not.toContain("super-secret-value");
    expect(envelope(streams).variant).toBe("failed");
  });

  test.each([
    {
      name: "missing required option",
      args: ["run", "--state-dir", "/tmp/state", "--", "true"],
      issue: { code: "missingRequiredField", field: "image" },
    },
    {
      name: "unknown option",
      args: [
        "run",
        "--prepare",
        "--evidence-dir",
        "/tmp/evidence",
        "--image",
        "i",
        "--",
        "true",
      ],
      issue: { code: "unknownOption", option: "--prepare" },
    },
    {
      name: "missing scenario command",
      args: ["run", "--evidence-dir", "/tmp/evidence", "--image", "i"],
      issue: { code: "missingRequiredField", field: "argv" },
    },
    {
      name: "non-integer --timeout-ms",
      args: [
        "run",
        "--evidence-dir",
        "/tmp/evidence",
        "--image",
        "i",
        "--timeout-ms",
        "1.5",
        "--",
        "true",
      ],
      issue: { code: "inputRejected" },
    },
  ])("$name 是用法失败并以 1 退出", async ({ args, issue }) => {
    const out = capture();
    const round = engineRound();
    const exit = await runCli(args, {
      stdout: out.stdout,
      stderr: out.stderr,
      runRound: round.runRoundDependency,
    });
    expect(exit).toBe(1);
    expect(round.calls).toEqual([]);
    const payload = envelope(out.text());
    expect(payload.kind).toBe("usageFailure");
    expect(payload.issues).toContainEqual(issue);
  });

  test("相对路径的 state 或 evidence 目录被拒绝且不创建资源", async () => {
    const root = await createRoot();
    const out = capture();
    const docker = fakeEngine();
    const exit = await runCli(
      [
        "run",
        "--state-dir",
        "relative/state",
        "--evidence-dir",
        root.evidenceDirectory,
        "--image",
        "alpine:3.20@sha256:keep",
        "--",
        "true",
      ],
      { stdout: out.stdout, stderr: out.stderr },
    );
    expect(exit).toBe(1);
    expect(docker.calls).toEqual([]);
    expect(envelope(out.text()).data).toMatchObject({
      code: "invalidOptions",
      message: "The platform state directory must be an absolute path.",
    });
  });

  test("status 区分健康快照与降级观测", async () => {
    const healthy = statusPayload("absent");
    const out = capture();
    const healthyExit = await runCli(["status", "--state-dir", "/tmp/state"], {
      stdout: out.stdout,
      stderr: out.stderr,
      statusPlatform: async () => healthy,
    });
    expect(healthyExit).toBe(0);
    expect(envelope(out.text())).toMatchObject({
      kind: "data",
      variant: "snapshot",
    });

    const degraded = capture();
    const degradedExit = await runCli(["status", "--state-dir", "/tmp/state"], {
      stdout: degraded.stdout,
      stderr: degraded.stderr,
      statusPlatform: async () => ({ ...healthy, inner: "unreachable" }),
    });
    expect(degradedExit).toBe(1);
    expect(envelope(degraded.text()).variant).toBe("degraded");
  });

  test("destroy 在回收失败时要求人工恢复", async () => {
    const destroyed: DestroyResult = {
      disposition: "destroyed",
      platformId: "platform-1",
      facts: [],
      failures: [],
      evidence: { directory: null, exported: true, files: [], failures: [] },
    };
    const out = capture();
    expect(
      await runCli(["destroy", "--state-dir", "/tmp/state"], {
        stdout: out.stdout,
        stderr: out.stderr,
        destroyPlatform: async () => destroyed,
      }),
    ).toBe(0);
    expect(envelope(out.text())).toMatchObject({
      kind: "data",
      variant: "destroyed",
    });

    const failed = capture();
    expect(
      await runCli(["destroy", "--state-dir", "/tmp/state"], {
        stdout: failed.stdout,
        stderr: failed.stderr,
        destroyPlatform: async () => ({
          ...destroyed,
          disposition: "recovery_required",
          failures: ["Could not remove the platform container."],
        }),
      }),
    ).toBe(1);
    expect(envelope(failed.text()).variant).toBe("recoveryRequired");
  });

  test("destroy 的修复目标必须是绝对路径", async () => {
    const out = capture();
    const calls: unknown[] = [];
    const exit = await runCli(
      [
        "destroy",
        "--state-dir",
        "/tmp/state",
        "--evidence-dir",
        "relative/evidence",
      ],
      {
        stdout: out.stdout,
        stderr: out.stderr,
        destroyPlatform: async (options, destroyOptions) => {
          calls.push({ options, destroyOptions });
          return destroyPlatform(options, destroyOptions);
        },
      },
    );
    expect(exit).toBe(1);
    expect(calls).toEqual([]);
    expect(envelope(out.text()).data).toMatchObject({ code: "invalidOptions" });
  });

  test("帮助只暴露 run、status、destroy", async () => {
    const out = capture();
    const exit = await runCli(["--help"], {
      stdout: out.stdout,
      stderr: out.stderr,
    });
    expect(exit).toBe(0);
    const commands = out
      .text()
      .stdout.split("\n")
      .filter((line) => /^ {2}[a-z]+$/i.test(line))
      .map((line) => line.trim())
      .sort();
    expect(commands).toEqual(["destroy", "run", "status"]);
  });
});

function statusPayload(phase: PlatformStatus["phase"]): PlatformStatus {
  return {
    phase,
    manifest: null,
    outer: "absent",
    inner: "absent",
    engineIdentityMatches: null,
    busy: null,
    unfinishedScenarios: [],
    failures: [],
    detail: null,
  };
}

function resolveFromCwd(path: string): string {
  return join(process.cwd(), path);
}
