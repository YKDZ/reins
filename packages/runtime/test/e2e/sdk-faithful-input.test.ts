import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  connect,
  type AgentFact,
  type PermissionResolution,
  type ReinsConnection,
  type SpawnInput,
  type TurnHandle,
} from "@ykdz/reins-sdk";
import { afterEach, expect, test, vi } from "vitest";

const runtimePackage = fileURLToPath(new URL("../../", import.meta.url));
const daemonBin = join(runtimePackage, "node_modules/.bin/reins-daemon");
const adapters = fileURLToPath(
  new URL("./fixtures/faithful-adapters.ts", import.meta.url),
);
const clients: ReinsConnection[] = [];
const fixtures: Array<{ directory: string; daemon: ChildProcess }> = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    try {
      const sessions = await client.list();
      for (const session of sessions) {
        if (session.state === "killed") continue;
        await client.kill(
          { sessionHandle: session.sessionHandle },
          client.prepareOperation("kill"),
        );
      }
    } catch {
      // The daemon may already be shutting down after a failed native fixture.
    }
    client.close();
  }
  for (const fixture of fixtures.splice(0)) {
    if (
      fixture.daemon.exitCode === null &&
      fixture.daemon.signalCode === null
    ) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          fixture.daemon.kill("SIGKILL");
          resolve();
        }, 5_000);
        fixture.daemon.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
        fixture.daemon.kill("SIGTERM");
      });
    }
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "reins-sdk-faithful-"));
  const callerCwd = join(directory, "caller", "nested");
  await mkdir(callerCwd, { recursive: true });
  const env = {
    ...process.env,
    REINS_SOCKET: join(directory, "reins.sock"),
    REINS_STATE_DIR: join(directory, "state"),
    REINS_CONSUMER_CONTEXT: "sdk-faithful-input-test",
    REINS_W05_NATIVE_LOG: join(directory, "native.jsonl"),
    REINS_IDLE_TIMEOUT_MS: "120000",
  };
  const daemon = spawn(daemonBin, ["--adapters", adapters], {
    cwd: directory,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderr: string[] = [];
  daemon.stderr?.on("data", (chunk: Buffer) => stderr.push(String(chunk)));
  fixtures.push({ directory, daemon });
  await vi.waitFor(async () => {
    expect(daemon.exitCode, stderr.join("")).toBeNull();
    expect((await stat(env.REINS_SOCKET)).isSocket()).toBe(true);
  });
  const connection = await connect({
    socketPath: env.REINS_SOCKET,
    consumerContext: env.REINS_CONSUMER_CONTEXT,
  });
  clients.push(connection);
  return { directory, callerCwd, env, connection };
}

async function nativeLog(path: string): Promise<Record<string, unknown>[]> {
  try {
    return (await readFile(path, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function spawnSession(
  connection: ReinsConnection,
  cwd: string,
  input: Partial<SpawnInput> & Pick<SpawnInput, "harness" | "message">,
) {
  return connection.spawn(
    {
      sessionLabel: input.sessionLabel ?? `session-${Date.now()}`,
      cwd,
      ...input,
    },
    connection.prepareOperation("spawn"),
  );
}

async function permissionFact(
  connection: ReinsConnection,
  turnHandle: TurnHandle,
): Promise<{
  fact: Extract<AgentFact, { type: "permission.requested" }>;
  subscription: Awaited<ReturnType<ReinsConnection["attach"]>>;
}> {
  const subscription = await connection.attach(
    { scope: "turn", turnHandle },
    { mode: "available" },
  );
  for (;;) {
    const item = await subscription.next();
    if (item.done) break;
    if (item.value.type === "permission.requested")
      return { fact: item.value, subscription };
  }
  subscription.close();
  throw new Error("The SDK did not expose a permission request fact");
}

async function nextPermissionResolution(
  subscription: Awaited<ReturnType<ReinsConnection["attach"]>>,
): Promise<Extract<AgentFact, { type: "permission.resolved" }>> {
  for (;;) {
    const item = await subscription.next();
    if (item.done)
      throw new Error("Permission observation ended before resolution");
    if (item.value.type === "permission.resolved") return item.value;
  }
}

test.each([
  { harness: "codex", field: "sandbox", input: { sandbox: "unmapped-policy" } },
  { harness: "codex", field: "agent", input: { agent: "caller-agent" } },
  { harness: "qoder", field: "agent", input: { agent: "caller-agent" } },
  { harness: "qoder", field: "sandbox", input: { sandbox: "caller-policy" } },
  { harness: "qoder", field: "reasoning", input: { reasoning: "high" } },
])(
  "SDK rejects unsupported $harness $field before native work",
  async ({ harness, input }) => {
    const f = await fixture();
    await expect(
      spawnSession(f.connection, f.callerCwd, {
        harness,
        message: "caller-only-message",
        sessionLabel: "unsupported-input",
        ...input,
      }),
    ).rejects.toMatchObject({
      failure: { code: "unsupported_feature" },
    });
    await expect(access(f.env.REINS_W05_NATIVE_LOG)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await f.connection.list()).toEqual([]);
  },
);

test.each(["codex", "qoder"] as const)(
  "%s preserves omitted fields and faithfully projects explicit supported inputs",
  async (harness) => {
    const f = await fixture();
    await spawnSession(f.connection, f.callerCwd, {
      sessionLabel: `${harness}-omitted`,
      harness,
      message: "  caller-only message  ",
    });
    await vi.waitFor(async () => {
      const log = await nativeLog(f.env.REINS_W05_NATIVE_LOG);
      expect(
        log.some(
          (record) =>
            record.method ===
            (harness === "codex" ? "turn/start" : "sdk.message"),
        ),
      ).toBe(true);
    });
    let log = await nativeLog(f.env.REINS_W05_NATIVE_LOG);
    if (harness === "codex") {
      const thread = log.find((record) => record.method === "thread/start")
        ?.params as Record<string, unknown>;
      const turn = log.find((record) => record.method === "turn/start")
        ?.params as Record<string, unknown>;
      for (const key of ["model", "approvalPolicy", "sandbox"])
        expect(thread).not.toHaveProperty(key);
      for (const key of ["model", "effort", "sandboxPolicy"])
        expect(turn).not.toHaveProperty(key);
      expect(turn.input).toEqual([
        { type: "text", text: "  caller-only message  ", text_elements: [] },
      ]);
    } else {
      const query = log.find((record) => record.method === "sdk.query")!;
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
        (
          log.find((record) => record.method === "sdk.message")?.message as {
            message?: { content?: string };
          }
        )?.message?.content,
      ).toBe("  caller-only message  ");
    }

    for (const authorizationMode of ["interactive", "allowAll"] as const) {
      await spawnSession(f.connection, f.callerCwd, {
        sessionLabel: `${harness}-${authorizationMode === "interactive" ? "interactive" : "allow-all"}`,
        harness,
        message: "explicit message",
        model: "fixture-model",
        ...(harness === "codex" ? { reasoning: "high" } : {}),
        authorizationMode,
      });
      const method = harness === "codex" ? "turn/start" : "sdk.message";
      const expectedCount = authorizationMode === "interactive" ? 2 : 3;
      await vi.waitFor(async () => {
        const current = await nativeLog(f.env.REINS_W05_NATIVE_LOG);
        expect(
          current.filter((record) => record.method === method),
        ).toHaveLength(expectedCount);
      });
      log = await nativeLog(f.env.REINS_W05_NATIVE_LOG);
      if (harness === "codex") {
        const turns = log.filter((record) => record.method === "turn/start");
        expect(turns.at(-1)?.params).toMatchObject({
          model: "fixture-model",
          effort: "high",
          input: [
            { type: "text", text: "explicit message", text_elements: [] },
          ],
        });
        const thread = log
          .filter((record) => record.method === "thread/start")
          .at(-1)?.params as Record<string, unknown>;
        expect(thread.approvalPolicy).toBe(
          authorizationMode === "interactive" ? "on-request" : "never",
        );
        if (authorizationMode === "interactive")
          expect(thread).not.toHaveProperty("sandbox");
        else expect(thread.sandbox).toBe("danger-full-access");
      } else {
        const query = log
          .filter((record) => record.method === "sdk.query")
          .at(-1);
        expect(query?.options).toMatchObject({
          model: "fixture-model",
          permissionMode:
            authorizationMode === "interactive"
              ? "default"
              : "bypassPermissions",
        });
        if (authorizationMode === "interactive") {
          expect(query?.keys).toContain("canUseTool");
          expect(query?.keys).not.toContain("allowDangerouslySkipPermissions");
        } else {
          expect(query?.keys).not.toContain("canUseTool");
          expect(query?.options).toMatchObject({
            allowDangerouslySkipPermissions: true,
          });
        }
      }
    }
  },
);

test("Codex permission facts expose only native answers and apply the exact accepted decision", async () => {
  const f = await fixture();
  const spawned = await spawnSession(f.connection, f.callerCwd, {
    sessionLabel: "codex-permission",
    harness: "codex",
    message: "permission",
    authorizationMode: "interactive",
  });
  const { fact: requested, subscription } = await permissionFact(
    f.connection,
    spawned.turnHandle,
  );
  expect(requested.options).toEqual([{ outcome: "allow", scope: "once" }]);
  await expect(
    f.connection.resolvePermission(
      requested.permissionHandle,
      { outcome: "deny", feedback: "caller-authored feedback" },
      f.connection.prepareOperation("resolvePermission"),
    ),
  ).rejects.toMatchObject({
    failure: { code: "permission_resolution_mismatch" },
  });

  const resolvedPromise = nextPermissionResolution(subscription);
  expect(
    await f.connection.resolvePermission(
      requested.permissionHandle,
      { outcome: "allow", scope: "once" },
      f.connection.prepareOperation("resolvePermission"),
    ),
  ).toMatchObject({ status: "resolved" });
  const resolved = await resolvedPromise;
  subscription.close();
  expect(resolved.permissionHandle).toBe(requested.permissionHandle);
  await vi.waitFor(async () =>
    expect(
      (await readFile(f.env.REINS_W05_NATIVE_LOG, "utf8")).includes(
        '"decision":"accept"',
      ),
    ).toBe(true),
  );
  const log = await nativeLog(f.env.REINS_W05_NATIVE_LOG);
  expect(log.filter((record) => record.method === "turn/start")).toHaveLength(
    1,
  );
  expect(log.some((record) => record.method === "turn/steer")).toBe(false);
});

test("Codex refuses an approval menu that has no representable caller decision", async () => {
  const f = await fixture();
  await spawnSession(f.connection, f.callerCwd, {
    sessionLabel: "codex-cancel-only",
    harness: "codex",
    message: "cancel-only",
    authorizationMode: "interactive",
  });
  await vi.waitFor(async () =>
    expect(
      (await readFile(f.env.REINS_W05_NATIVE_LOG, "utf8")).includes(
        '"error":{"code":-32601',
      ),
    ).toBe(true),
  );
  const log = await readFile(f.env.REINS_W05_NATIVE_LOG, "utf8");
  expect(log).not.toContain('"decision":"decline"');
});

test.each(["permission", "session-permission"] as const)(
  "Qoder %s resolves the native menu through the SDK callback",
  async (message) => {
    const f = await fixture();
    const spawned = await spawnSession(f.connection, f.callerCwd, {
      sessionLabel: `qoder-${message}`,
      harness: "qoder",
      message,
      authorizationMode: "interactive",
    });
    const { fact: requested, subscription } = await permissionFact(
      f.connection,
      spawned.turnHandle,
    );
    if (message === "permission") {
      expect(requested.options).toEqual([
        { outcome: "allow", scope: "once" },
        { outcome: "deny", feedback: true },
      ]);
      for (const resolution of [
        { outcome: "allow", scope: "session" },
        { outcome: "deny" },
      ] as const satisfies readonly PermissionResolution[]) {
        await expect(
          f.connection.resolvePermission(
            requested.permissionHandle,
            resolution,
            f.connection.prepareOperation("resolvePermission"),
          ),
        ).rejects.toMatchObject({
          failure: { code: "permission_resolution_mismatch" },
        });
      }
    } else {
      expect(requested.options).toContainEqual({
        outcome: "allow",
        scope: "session",
      });
    }

    const resolution =
      message === "permission"
        ? {
            outcome: "deny" as const,
            feedback: "  caller feedback\nsecond line  ",
          }
        : { outcome: "allow" as const, scope: "session" as const };
    const resolvedPromise = nextPermissionResolution(subscription);
    expect(
      await f.connection.resolvePermission(
        requested.permissionHandle,
        resolution,
        f.connection.prepareOperation("resolvePermission"),
      ),
    ).toMatchObject({ status: "resolved" });
    const resolved = await resolvedPromise;
    subscription.close();
    expect(resolved).toMatchObject({
      permissionHandle: requested.permissionHandle,
      resolution,
    });

    await vi.waitFor(async () =>
      expect(
        (await nativeLog(f.env.REINS_W05_NATIVE_LOG)).some(
          (record) => record.method === "sdk.permissionResult",
        ),
      ).toBe(true),
    );
    const log = await nativeLog(f.env.REINS_W05_NATIVE_LOG);
    const result = log.find(
      (record) => record.method === "sdk.permissionResult",
    )?.result;
    expect(result).toEqual(
      message === "permission"
        ? {
            behavior: "deny",
            message: "  caller feedback\nsecond line  ",
            toolUseID: "native-tool",
          }
        : {
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
          },
    );
    expect(log.filter((record) => record.method === "sdk.query")).toHaveLength(
      1,
    );
    expect(
      log.filter((record) => record.method === "sdk.message"),
    ).toHaveLength(1);
  },
);

test("a natively resolved Codex approval cannot claim a caller resolution", async () => {
  const f = await fixture();
  const spawned = await spawnSession(f.connection, f.callerCwd, {
    sessionLabel: "already-resolved",
    harness: "codex",
    message: "resolved-permission",
    authorizationMode: "interactive",
  });
  const { fact: requested, subscription } = await permissionFact(
    f.connection,
    spawned.turnHandle,
  );
  await expect(
    f.connection.resolvePermission(
      requested.permissionHandle,
      { outcome: "allow", scope: "once" },
      f.connection.prepareOperation("resolvePermission"),
    ),
  ).rejects.toMatchObject({ failure: { code: "permission_not_pending" } });
  const later = await Promise.race([
    subscription.next(),
    new Promise<undefined>((resolve) =>
      setTimeout(() => resolve(undefined), 100),
    ),
  ]);
  subscription.close();
  if (later === undefined) return;
  if (!later.done) expect(later.value.type).not.toBe("permission.resolved");
});
