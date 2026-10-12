export type ControlCliResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number | null;
  readonly status?: number | null;
};

export type ControlCliRunner = (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
) => Promise<ControlCliResult>;

export type ControlCliData = Record<string, unknown> & {
  readonly operation?: string;
  readonly credential?: string;
  readonly sessionHandle?: string;
  readonly turnHandle?: string;
};

export type ControlSpawnInput = {
  readonly sessionName: string;
  readonly harness: string;
  readonly message: string;
  readonly cwd?: string;
  readonly agent?: string;
  readonly model?: string;
  readonly reasoning?: string;
  readonly authorizationMode?: "interactive" | "allowAll";
  readonly sandbox?: string;
  readonly captureHarnessStderr?: boolean;
};

function statusOf(result: ControlCliResult): number | null | undefined {
  return result.exitCode ?? result.status;
}

export function controlData(result: ControlCliResult): ControlCliData {
  const output = result.stdout.length > 0 ? result.stdout : result.stderr;
  const parsed = JSON.parse(output) as { data?: ControlCliData };
  if (parsed.data === undefined) throw new Error("CLI 结构化响应缺少 data");
  return parsed.data;
}

async function prepareCredential(
  run: ControlCliRunner,
  env: NodeJS.ProcessEnv,
  cwd: string,
  operation: "spawn" | "kill",
): Promise<string> {
  const prepared = await run(["prepare-operation", operation], env, cwd);
  if (statusOf(prepared) !== 0)
    throw new Error(`准备 ${operation} 凭据失败：${prepared.stderr}`);
  const data = controlData(prepared);
  if (data.operation !== operation || typeof data.credential !== "string")
    throw new Error(`准备 ${operation} 凭据的响应无效`);
  return data.credential;
}

export async function spawnWithControlCli(
  run: ControlCliRunner,
  env: NodeJS.ProcessEnv,
  invocationCwd: string,
  input: ControlSpawnInput,
): Promise<ControlCliResult> {
  const credential = await prepareCredential(run, env, invocationCwd, "spawn");
  const args = [
    "spawn",
    "--operation",
    credential,
    "--name",
    input.sessionName,
    "--harness",
    input.harness,
    "--message",
    input.message,
    "--cwd",
    input.cwd ?? invocationCwd,
  ];
  for (const [flag, value] of [
    ["--agent", input.agent],
    ["--model", input.model],
    ["--reasoning", input.reasoning],
    ["--authorization-mode", input.authorizationMode],
    ["--sandbox", input.sandbox],
  ] as const) {
    if (value !== undefined) args.push(flag, value);
  }
  if (input.captureHarnessStderr === true)
    args.push("--capture-harness-stderr");
  return run(args, env, invocationCwd);
}

export async function killWithControlCli(
  run: ControlCliRunner,
  env: NodeJS.ProcessEnv,
  invocationCwd: string,
  sessionHandle: string,
): Promise<ControlCliResult> {
  const credential = await prepareCredential(run, env, invocationCwd, "kill");
  return run(
    ["kill", "--session", sessionHandle, "--operation", credential],
    env,
    invocationCwd,
  );
}
