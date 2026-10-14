import { spawn, type ChildProcess } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createReinsClient } from "@reins/client";
import {
  consumerContextSchema,
  decodeTurnHandle,
  encodePermissionHandle,
  type DomainEvent,
  type ProtocolMessage,
} from "@reins/protocol";
import { createUnixSocketClient } from "@reins/transport";
import * as v from "valibot";
import { afterEach, expect, test, vi } from "vitest";

import {
  controlData,
  spawnWithControlCli,
  type ControlCliRunner,
  type ControlSpawnInput,
} from "./fixtures/control-cli.ts";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const cliBin = join(repo, "apps/cli/dist/reins.js");
const daemonBin = join(repo, "packages/daemon/dist/main.js");
const adapters = fileURLToPath(
  new URL(
    "../../../../packages/daemon/test/fixtures/faithful-adapters.ts",
    import.meta.url,
  ),
);
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "reins-wrr05-cwd-"));
  const runtime = await mkdtemp("/dev/shm/reins-wrr05-runtime-");
  cleanup.push(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  });
  const daemonCwd = join(root, "daemon");
  const callerCwd = join(root, "caller", "nested");
  await mkdir(daemonCwd, { recursive: true });
  await mkdir(callerCwd, { recursive: true });
  await writeFile(join(daemonCwd, "marker.txt"), "daemon-owned-marker");
  await writeFile(join(callerCwd, "marker.txt"), "caller-owned-marker");
  const env = {
    ...process.env,
    REINS_SOCKET: join(runtime, "reins.sock"),
    REINS_STATE_DIR: join(runtime, "state"),
    REINS_CONSUMER_CONTEXT: "faithful-input-test",
    REINS_DAEMON_BIN: daemonBin,
    REINS_W05_NATIVE_LOG: join(runtime, "native.jsonl"),
  };
  const daemon: ChildProcess = spawn(
    process.execPath,
    [daemonBin, "--adapters", adapters],
    { cwd: daemonCwd, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const errors: string[] = [];
  daemon.stderr?.on("data", (chunk) => errors.push(String(chunk)));
  cleanup.push(async () => {
    if (daemon.exitCode !== null || daemon.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      daemon.once("close", () => resolve());
      daemon.kill("SIGTERM");
    });
  });
  async function cli(
    args: readonly string[],
    cwd = callerCwd,
    commandEnv: NodeJS.ProcessEnv = env,
  ) {
    const child = spawn(process.execPath, [cliBin, ...args], {
      env: commandEnv,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    const exitCode = await new Promise<number | null>((resolve) =>
      child.once("close", resolve),
    );
    return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
  }
  const runControlCli: ControlCliRunner = (args, commandEnv, cwd) =>
    cli(args, cwd, commandEnv);
  const spawnControl = (input: ControlSpawnInput) =>
    spawnWithControlCli(runControlCli, env, callerCwd, input);
  await vi.waitFor(async () => {
    expect(daemon.exitCode, errors.join("")).toBeNull();
    await access(env.REINS_SOCKET);
    const result = await cli(["list"]);
    expect(result.exitCode, result.stderr + errors.join("")).toBe(0);
    expect(controlData(result).sessions).toEqual([]);
  });
  async function client(consumerContext = env.REINS_CONSUMER_CONTEXT) {
    const connection = await createUnixSocketClient<ProtocolMessage>(
      env.REINS_SOCKET,
    );
    const client = createReinsClient(connection, {
      consumerContext: v.parse(consumerContextSchema, consumerContext),
    });
    cleanup.push(async () => client.close());
    expect(await client.initialize()).toHaveProperty("result");
    return client;
  }
  return {
    root,
    runtime,
    daemonCwd,
    callerCwd,
    env,
    cli,
    client,
    spawnControl,
  };
}

test("explicit unsupported Codex sandbox rejects before any native worker starts", async () => {
  const { env, cli, spawnControl } = await fixture();
  const result = await spawnControl({
    sessionName: "unsupported",
    harness: "codex",
    message: "caller-only-message",
    sandbox: "unmapped-policy",
  });
  if (result.exitCode === 0)
    await vi.waitFor(async () =>
      expect(await readFile(env.REINS_W05_NATIVE_LOG, "utf8")).toContain(
        "turn/start",
      ),
    );
  const nativeStarted = await access(env.REINS_W05_NATIVE_LOG).then(
    () => true,
    () => false,
  );
  expect({
    exitCode: result.exitCode,
    nativeStarted,
    stdout: result.stdout,
  }).toMatchObject({ exitCode: 70, nativeStarted: false });
  expect(controlData(result).failure).toMatchObject({
    code: "unsupported_feature",
  });
  expect(controlData(await cli(["list"])).sessions).toEqual([]);
});

test("explicit unsupported Qoder effort rejects before SDK query or initial message", async () => {
  const { env, cli, spawnControl } = await fixture();
  const result = await spawnControl({
    sessionName: "unsupported",
    harness: "qoder",
    message: "caller-only-message",
    reasoning: "high",
  });
  if (result.exitCode === 0)
    await vi.waitFor(async () =>
      expect(await readFile(env.REINS_W05_NATIVE_LOG, "utf8")).toContain(
        "sdk.message",
      ),
    );
  const nativeStarted = await access(env.REINS_W05_NATIVE_LOG).then(
    () => true,
    () => false,
  );
  expect({
    exitCode: result.exitCode,
    nativeStarted,
    stdout: result.stdout,
  }).toMatchObject({ exitCode: 70, nativeStarted: false });
  expect(controlData(result).failure).toMatchObject({
    code: "unsupported_feature",
  });
  expect(controlData(await cli(["list"])).sessions).toEqual([]);
});

test("Codex approval advertises only native decisions that can be faithfully answered", async () => {
  const { env, client: connectClient, spawnControl } = await fixture();
  const spawned = await spawnControl({
    sessionName: "permission",
    harness: "codex",
    message: "permission",
    authorizationMode: "interactive",
  });
  expect(spawned.exitCode, spawned.stdout).toBe(0);
  const target = decodeTurnHandle(controlData(spawned).turnHandle as string);
  const client = await connectClient();
  const events: DomainEvent[] = [];
  client.onNotification((n) => {
    if (n.method === "event") events.push(n.params.event);
  });
  expect(
    await client.request("attach", {
      scope: "session",
      sessionId: target.sessionId,
      replay: { mode: "available" },
    }),
  ).toHaveProperty("result");
  await vi.waitFor(() =>
    expect(events.some((e) => e.type === "permission.requested")).toBe(true),
  );
  const requested = events.find((e) => e.type === "permission.requested")!;
  if (requested.type !== "permission.requested")
    throw new Error("Missing permission");
  expect(requested.options).toEqual([{ outcome: "allow", scope: "once" }]);
  expect(
    await client.request("resolvePermission", {
      turnId: target.turnId,
      sessionId: target.sessionId,
      permissionId: requested.permissionId,
      resolution: { outcome: "deny", feedback: "caller authored feedback" },
    }),
  ).toMatchObject({ error: { code: "permission_resolution_mismatch" } });
  expect(
    await client.request("resolvePermission", {
      turnId: target.turnId,
      sessionId: target.sessionId,
      permissionId: requested.permissionId,
      resolution: { outcome: "allow", scope: "once" },
    }),
  ).toHaveProperty("result");
  await vi.waitFor(async () =>
    expect(await readFile(env.REINS_W05_NATIVE_LOG, "utf8")).toContain(
      '"decision":"accept"',
    ),
  );
  const native = (await readFile(env.REINS_W05_NATIVE_LOG, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { method?: string });
  expect(native.filter((r) => r.method === "turn/start")).toHaveLength(1);
  expect(native.some((r) => r.method === "turn/steer")).toBe(false);
  expect(events.filter((e) => e.type === "permission.resolved")).toHaveLength(
    1,
  );
});

test("an approval with only unrepresentable Codex decisions is explicitly refused", async () => {
  const { env, spawnControl } = await fixture();
  const result = await spawnControl({
    sessionName: "cancel",
    harness: "codex",
    message: "cancel-only",
    authorizationMode: "interactive",
  });
  expect(result.exitCode, result.stdout).toBe(0);
  await vi.waitFor(async () =>
    expect(await readFile(env.REINS_W05_NATIVE_LOG, "utf8")).toContain(
      '"error":{"code":-32601',
    ),
  );
  const log = await readFile(env.REINS_W05_NATIVE_LOG, "utf8");
  expect(log).not.toContain('"decision":"decline"');
});

async function nativeLog(path: string): Promise<
  {
    method?: string;
    params?: Record<string, unknown>;
    options?: Record<string, unknown>;
    keys?: string[];
    message?: unknown;
    result?: unknown;
  }[]
> {
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
test.each(["codex", "qoder"])(
  "%s keeps omitted fields absent and faithfully passes explicit supported inputs",
  async (harness) => {
    const { env, spawnControl } = await fixture();
    const omitted = await spawnControl({
      sessionName: "omitted",
      harness,
      message: "  caller-only message  ",
    });
    expect(omitted.exitCode, omitted.stdout).toBe(0);
    await vi.waitFor(async () =>
      expect(
        (await nativeLog(env.REINS_W05_NATIVE_LOG)).some(
          (r) =>
            r.method === (harness === "codex" ? "turn/start" : "sdk.message"),
        ),
      ).toBe(true),
    );
    let log = await nativeLog(env.REINS_W05_NATIVE_LOG);
    if (harness === "codex") {
      const thread = log.find((r) => r.method === "thread/start")!.params!;
      const turn = log.find((r) => r.method === "turn/start")!.params!;
      for (const key of ["model", "approvalPolicy", "sandbox"])
        expect(thread).not.toHaveProperty(key);
      for (const key of ["model", "effort", "sandboxPolicy"])
        expect(turn).not.toHaveProperty(key);
      expect(turn.input).toEqual([
        { type: "text", text: "  caller-only message  ", text_elements: [] },
      ]);
    } else {
      const query = log.find((r) => r.method === "sdk.query")!;
      for (const key of [
        "model",
        "permissionMode",
        "canUseTool",
        "allowDangerouslySkipPermissions",
        "reasoning",
        "sandbox",
        "agent",
      ])
        expect(query.keys).not.toContain(key);
      expect(
        log.find((r) => r.method === "sdk.message")!.message,
      ).toMatchObject({ message: { content: "  caller-only message  " } });
    }
    for (const mode of ["interactive", "allow-all"]) {
      const explicit = await spawnControl({
        sessionName: mode,
        harness,
        message: "explicit message",
        model: "fixture-model",
        ...(harness === "codex" ? { reasoning: "high" } : {}),
        authorizationMode: mode === "allow-all" ? "allowAll" : "interactive",
      });
      expect(explicit.exitCode, explicit.stdout).toBe(0);
      await vi.waitFor(async () =>
        expect(
          (await nativeLog(env.REINS_W05_NATIVE_LOG)).filter(
            (r) =>
              r.method === (harness === "codex" ? "turn/start" : "sdk.message"),
          ).length,
        ).toBe(mode === "interactive" ? 2 : 3),
      );
      log = await nativeLog(env.REINS_W05_NATIVE_LOG);
      if (harness === "codex") {
        expect(
          log.filter((r) => r.method === "turn/start").at(-1)!.params,
        ).toMatchObject({
          model: "fixture-model",
          effort: "high",
          input: [
            { type: "text", text: "explicit message", text_elements: [] },
          ],
        });
        const thread = log
          .filter((r) => r.method === "thread/start")
          .at(-1)!.params!;
        expect(thread.approvalPolicy).toBe(
          mode === "interactive" ? "on-request" : "never",
        );
        if (mode === "interactive")
          expect(thread).not.toHaveProperty("sandbox");
        else expect(thread.sandbox).toBe("danger-full-access");
      } else {
        const query = log.filter((r) => r.method === "sdk.query").at(-1)!;
        expect(query.options).toMatchObject({
          model: "fixture-model",
          permissionMode:
            mode === "interactive" ? "default" : "bypassPermissions",
        });
        if (mode === "interactive") {
          expect(query.keys).toContain("canUseTool");
          expect(query.keys).not.toContain("allowDangerouslySkipPermissions");
        } else {
          expect(query.keys).not.toContain("canUseTool");
          expect(query.options!.allowDangerouslySkipPermissions).toBe(true);
        }
      }
    }
  },
);
test.each(["permission", "session-permission"])(
  "Qoder %s returns only the native menu and caller-authored resolution to the same callback",
  async (message) => {
    const { env, cli, client: connectClient, spawnControl } = await fixture();
    const spawned = await spawnControl({
      sessionName: "permission",
      harness: "qoder",
      message,
      authorizationMode: "interactive",
    });
    expect(spawned.exitCode, spawned.stdout).toBe(0);
    const target = decodeTurnHandle(controlData(spawned).turnHandle as string);
    const client = await connectClient();
    const events: DomainEvent[] = [];
    client.onNotification((n) => {
      if (n.method === "event") events.push(n.params.event);
    });
    await client.request("attach", {
      scope: "session",
      sessionId: target.sessionId,
      replay: { mode: "available" },
    });
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === "permission.requested")).toBe(true),
    );
    const requested = events.find((e) => e.type === "permission.requested")!;
    if (requested.type !== "permission.requested")
      throw new Error("Missing permission");
    const feedback = "  caller feedback\nsecond line  ";
    const resolve = async (args: readonly string[]) => {
      const prepared = await cli(["prepare-operation", "resolve-permission"]);
      expect(prepared.exitCode, `${prepared.stdout}\n${prepared.stderr}`).toBe(
        0,
      );
      const credential = controlData(prepared).credential;
      if (typeof credential !== "string") throw new Error("执行凭据缺失");
      return cli([...args, "--operation", credential]);
    };
    if (message === "permission") {
      expect(requested.options).toEqual([
        { outcome: "allow", scope: "once" },
        { outcome: "deny", feedback: true },
      ]);
      const wrong = await resolve([
        "resolve-permission",
        encodePermissionHandle({
          sessionId: target.sessionId,
          turnId: target.turnId,
          permissionId: requested.permissionId,
        }),
        "--outcome",
        "allow",
        "--scope",
        "session",
      ]);
      expect(wrong.exitCode).toBe(70);
      expect(controlData(wrong).failure).toMatchObject({
        code: "permission_resolution_mismatch",
      });
      const missing = await resolve([
        "resolve-permission",
        encodePermissionHandle({
          sessionId: target.sessionId,
          turnId: target.turnId,
          permissionId: requested.permissionId,
        }),
        "--outcome",
        "deny",
      ]);
      expect(missing.exitCode).toBe(70);
      expect(controlData(missing).failure).toMatchObject({
        code: "permission_resolution_mismatch",
      });
      const denied = await resolve([
        "resolve-permission",
        encodePermissionHandle({
          sessionId: target.sessionId,
          turnId: target.turnId,
          permissionId: requested.permissionId,
        }),
        "--outcome",
        "deny",
        "--feedback",
        feedback,
      ]);
      expect(denied.exitCode, denied.stdout).toBe(0);
    } else {
      expect(requested.options).toContainEqual({
        outcome: "allow",
        scope: "session",
      });
      expect(
        (
          await resolve([
            "resolve-permission",
            encodePermissionHandle({
              sessionId: target.sessionId,
              turnId: target.turnId,
              permissionId: requested.permissionId,
            }),
            "--outcome",
            "allow",
            "--scope",
            "session",
          ])
        ).exitCode,
      ).toBe(0);
    }
    await vi.waitFor(async () =>
      expect(
        (await nativeLog(env.REINS_W05_NATIVE_LOG)).some(
          (r) => r.method === "sdk.permissionResult",
        ),
      ).toBe(true),
    );
    const log = await nativeLog(env.REINS_W05_NATIVE_LOG);
    const result = log.find((r) => r.method === "sdk.permissionResult")!.result;
    if (message === "permission")
      expect(result).toEqual({
        behavior: "deny",
        message: feedback,
        toolUseID: "native-tool",
      });
    else
      expect(result).toEqual({
        behavior: "allow",
        updatedInput: { command: "caller command" },
        toolUseID: "native-tool",
        updatedPermissions: [
          {
            type: "addRules",
            rules: [{ toolName: "Bash" }],
            behavior: "allow",
            destination: "session",
          },
        ],
      });
    expect(log.filter((r) => r.method === "sdk.query")).toHaveLength(1);
    expect(log.filter((r) => r.method === "sdk.message")).toHaveLength(1);
    expect(events.filter((e) => e.type === "turn.started")).toHaveLength(1);
    expect(
      events.filter((e) => e.type === "permission.resolved"),
    ).toMatchObject([{ sessionId: target.sessionId, turnId: target.turnId }]);
  },
);

test("an already resolved native approval cannot acknowledge an unperformed caller decision", async () => {
  const { client: connectClient, spawnControl } = await fixture();
  const spawned = await spawnControl({
    sessionName: "resolved",
    harness: "codex",
    message: "resolved-permission",
    authorizationMode: "interactive",
  });
  expect(spawned.exitCode, spawned.stdout).toBe(0);
  const target = decodeTurnHandle(controlData(spawned).turnHandle as string);
  const client = await connectClient();
  const events: DomainEvent[] = [];
  client.onNotification((n) => {
    if (n.method === "event") events.push(n.params.event);
  });
  await client.request("attach", {
    scope: "session",
    sessionId: target.sessionId,
    replay: { mode: "available" },
  });
  await vi.waitFor(() =>
    expect(events.some((e) => e.type === "permission.requested")).toBe(true),
  );
  const requested = events.find((e) => e.type === "permission.requested")!;
  if (requested.type !== "permission.requested")
    throw new Error("Missing permission");
  expect(
    await client.request("resolvePermission", {
      turnId: target.turnId,
      sessionId: target.sessionId,
      permissionId: requested.permissionId,
      resolution: { outcome: "allow", scope: "once" },
    }),
  ).toMatchObject({ error: { code: "permission_not_pending" } });
  expect(events.some((e) => e.type === "permission.resolved")).toBe(false);
});

test.each([
  ["codex", "agent"],
  ["qoder", "agent"],
  ["qoder", "sandbox"],
])(
  "%s rejects explicit unsupported %s before a native effect",
  async (harness, field) => {
    const { env, cli, spawnControl } = await fixture();
    const response = await spawnControl({
      sessionName: "unsupported",
      harness: harness!,
      message: "caller message",
      ...(field === "agent"
        ? { agent: "caller value" }
        : { sandbox: "caller value" }),
    });
    expect(response.exitCode, response.stdout).toBe(70);
    expect(controlData(response).failure).toMatchObject({
      code: "unsupported_feature",
    });
    expect(
      await access(env.REINS_W05_NATIVE_LOG).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(controlData(await cli(["list"])).sessions).toEqual([]);
  },
);
