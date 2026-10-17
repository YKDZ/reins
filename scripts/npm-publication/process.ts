import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isJsonObject } from "../release-package.ts";
import { fail } from "./handoff.ts";

export type ProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};
export type ProcessOptions = {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly interactive?: boolean;
};
export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: ProcessOptions,
) => Promise<ProcessResult>;

export const runProcess: ProcessRunner = async (command, args, options) =>
  await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio:
        options.interactive === true ? "inherit" : ["ignore", "pipe", "pipe"],
      timeout: options.interactive === true ? 0 : 300_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({ exitCode: code ?? 1, stdout, stderr }),
    );
  });

export function assertPublicationContext(
  environment: Readonly<NodeJS.ProcessEnv>,
  requireOidc: boolean,
): void {
  if (
    environment.GITHUB_ACTIONS !== "true" ||
    environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    environment.GITHUB_REF !==
      `refs/heads/${environment.GITHUB_DEFAULT_BRANCH}` ||
    !environment.GITHUB_DEFAULT_BRANCH ||
    !/^[0-9a-f]{40}$/u.test(environment.GITHUB_SHA ?? "") ||
    !/^\d+$/u.test(environment.GITHUB_RUN_ID ?? "") ||
    !/^[1-9]\d*$/u.test(environment.GITHUB_RUN_ATTEMPT ?? "")
  )
    fail(
      "publication-context-invalid",
      "发布必须由默认分支的人工触发工作流执行",
    );
  if (
    requireOidc &&
    (!environment.ACTIONS_ID_TOKEN_REQUEST_URL ||
      !environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
  )
    fail("oidc-unavailable", "当前工作缺少 GitHub OIDC 授权");
}

export function assertNoAmbientNpmCredentials(
  environment: Readonly<NodeJS.ProcessEnv>,
): void {
  for (const key of Object.keys(environment)) {
    const canonical = key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
    if (
      canonical === "nodeauthtoken" ||
      ((canonical.startsWith("npm") || canonical.startsWith("pnpm")) &&
        /auth|token|password/u.test(canonical))
    )
      fail("credential-fallback", `发布不接受环境中的 npm 凭据：${key}`);
  }
}

export async function npmSession(options: {
  readonly repository: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly run?: ProcessRunner;
}): Promise<{
  readonly directory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly run: ProcessRunner;
  npm(
    args: readonly string[],
    cwd?: string,
    interactive?: boolean,
  ): Promise<ProcessResult>;
  cleanup(): Promise<void>;
}> {
  assertNoAmbientNpmCredentials(options.environment);
  if (existsSync(join(options.repository, ".npmrc")))
    fail("checkout-npmrc", "发布工作区不能携带 .npmrc 凭据回退");
  const directory = await mkdtemp(
    join(options.environment.RUNNER_TEMP ?? tmpdir(), "reins-npm-session-"),
  );
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "GITHUB_ACTIONS",
    "GITHUB_EVENT_NAME",
    "GITHUB_REF",
    "GITHUB_SHA",
    "GITHUB_REPOSITORY",
    "GITHUB_REPOSITORY_ID",
    "GITHUB_REPOSITORY_OWNER_ID",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_SERVER_URL",
    "RUNNER_ENVIRONMENT",
  ]) {
    if (options.environment[key] !== undefined)
      environment[key] = options.environment[key];
  }
  environment.HOME = join(directory, "home");
  environment.NPM_CONFIG_USERCONFIG = join(directory, "user-npmrc");
  environment.NPM_CONFIG_GLOBALCONFIG = join(directory, "global-npmrc");
  environment.NPM_CONFIG_REGISTRY = "https://registry.npmjs.org/";
  environment.NPM_CONFIG_FETCH_RETRIES = "1";
  // 隔离认证配置，公开包缓存仍在同一验收运行内复用。
  environment.NPM_CONFIG_CACHE = join(
    options.environment.RUNNER_TOOL_CACHE ?? tmpdir(),
    "reins-npm-public-cache",
  );
  const run = options.run ?? runProcess;
  try {
    await mkdir(environment.HOME);
    await writeFile(environment.NPM_CONFIG_USERCONFIG, "");
    await writeFile(environment.NPM_CONFIG_GLOBALCONFIG, "");
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    directory,
    environment,
    run,
    async npm(args, cwd = directory, interactive = false) {
      return await run(
        join(options.repository, "node_modules", ".bin", "npm"),
        args,
        { cwd, env: environment, interactive },
      );
    },
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export function readJsonResult(result: ProcessResult, code: string): unknown {
  if (result.exitCode !== 0)
    fail(code, `外部步骤未完成（退出码 ${result.exitCode}）`);
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    return fail(code, "外部步骤未返回有效 JSON");
  }
}

export function explicitNotFound(result: ProcessResult): boolean {
  if (result.exitCode === 0) return false;
  for (const output of [result.stdout, result.stderr]) {
    try {
      const value: unknown = JSON.parse(output);
      if (
        isJsonObject(value) &&
        isJsonObject(value.error) &&
        value.error.code === "E404"
      )
        return true;
    } catch {
      /* 只接受注册表明确的不存在事实。 */
    }
  }
  return false;
}
