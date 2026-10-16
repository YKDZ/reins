import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { DriverDiagnosticFact } from "@reins/protocol";
import { afterEach, describe, expect, test } from "vitest";

import { createQoderDriver } from "#/qoder-driver";
import { createRealQoderSdk } from "#/sdk-binding";

const runtimePath = fileURLToPath(
  new URL("../fixtures/owned-lifecycle-runtime.ts", import.meta.url),
);

const environmentKeys = [
  "QODERCLI_PATH",
  "QODER_LIFECYCLE_DIR",
  "QODER_LIFECYCLE_HELPER_MODE",
  "QODER_LIFECYCLE_MODEL_MODE",
  "QODER_LIFECYCLE_ROOT_MODE",
] as const;
const priorEnvironment = new Map<string, string | undefined>();

function configureEnvironment(directory: string): void {
  for (const key of environmentKeys) {
    priorEnvironment.set(key, process.env[key]);
  }
  process.env.QODERCLI_PATH = runtimePath;
  process.env.QODER_LIFECYCLE_DIR = directory;
  delete process.env.QODER_LIFECYCLE_HELPER_MODE;
  delete process.env.QODER_LIFECYCLE_MODEL_MODE;
  delete process.env.QODER_LIFECYCLE_ROOT_MODE;
}

afterEach(() => {
  for (const key of environmentKeys) {
    const value = priorEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  priorEnvironment.clear();
});

async function waitFor<T>(
  read: () => Promise<T | undefined>,
  description: string,
): Promise<T> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${description}`);
}

type FixtureSession = {
  rootPid: number;
  rootStartTime: string;
  ownerPid: number;
  ownerStartTime: string;
  helperPid?: number;
  helperStartTime?: string;
  helperReadyPath?: string;
  lateHelperPid?: number;
  lateHelperStartTime?: string;
};

async function fixtureSessions(directory: string): Promise<FixtureSession[]> {
  const names = await readdir(directory);
  const files = names.filter(
    (name) => name.startsWith("session-") && name.endsWith(".json"),
  );
  const sessions: FixtureSession[] = [];
  for (const name of files) {
    try {
      sessions.push(
        JSON.parse(
          await readFile(join(directory, name), "utf8"),
        ) as FixtureSession,
      );
    } catch {
      // 对测试而言，fixture 会以原子方式写入就绪记录。
    }
  }
  return sessions;
}

async function processInfo(
  pid: number,
): Promise<
  { parentPid: number; startTime: string; state: string } | undefined
> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/u);
    const state = fields[0];
    const parentPid = Number(fields[1]);
    const startTime = fields[19];
    if (
      state === undefined ||
      !Number.isSafeInteger(parentPid) ||
      startTime === undefined
    ) {
      return undefined;
    }
    return { parentPid, startTime, state };
  } catch {
    return undefined;
  }
}

async function processGroupId(pid: number): Promise<number | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return Number(
      stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/u)[2],
    );
  } catch {
    return undefined;
  }
}

async function isRunning(pid: number, startTime: string): Promise<boolean> {
  const info = await processInfo(pid);
  return (
    info !== undefined &&
    info.startTime === startTime &&
    info.state !== "Z" &&
    info.state !== "X"
  );
}

async function waitForExit(pid: number, startTime: string): Promise<void> {
  await waitFor(
    async () => ((await isRunning(pid, startTime)) ? undefined : true),
    `${pid} to exit`,
  );
}

async function forceFixtureCleanup(directory: string): Promise<void> {
  const sessions = await fixtureSessions(directory);
  for (const session of sessions) {
    if (await isRunning(session.ownerPid, session.ownerStartTime)) {
      try {
        process.kill(session.ownerPid, "SIGCONT");
      } catch {
        // holder 可能在身份检查后自然退出。
      }
    }
  }
  for (const session of sessions) {
    const identities = [
      [session.rootPid, session.rootStartTime],
      [session.helperPid, session.helperStartTime],
      [session.lateHelperPid, session.lateHelperStartTime],
    ] as const;
    for (const [pid, startTime] of identities) {
      if (
        pid === undefined ||
        startTime === undefined ||
        !(await isRunning(pid, startTime))
      ) {
        continue;
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // fixture 进程可能在存活检查与发送信号之间退出。
      }
    }
  }
  for (const session of sessions) {
    if (await isRunning(session.ownerPid, session.ownerStartTime)) {
      try {
        process.kill(session.ownerPid, "SIGTERM");
      } catch {
        // holder 可能在身份检查后自然退出。
      }
    }
  }
  await Promise.all(
    sessions.flatMap((session) => [
      waitForExit(session.rootPid, session.rootStartTime),
      waitForExit(session.ownerPid, session.ownerStartTime),
      ...(session.helperPid === undefined ||
      session.helperStartTime === undefined
        ? []
        : [waitForExit(session.helperPid, session.helperStartTime)]),
      ...(session.lateHelperPid === undefined ||
      session.lateHelperStartTime === undefined
        ? []
        : [waitForExit(session.lateHelperPid, session.lateHelperStartTime)]),
    ]),
  );
}

describe("Qoder SDK process ownership", () => {
  test("termination escalates to resistant descendants and isolates sessions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-qoder-owned-"));
    configureEnvironment(directory);
    const sdk = createRealQoderSdk();
    const diagnosticsA: DriverDiagnosticFact[] = [];
    const diagnosticsB: DriverDiagnosticFact[] = [];
    const createDriver = (diagnostics: DriverDiagnosticFact[]) =>
      createQoderDriver({ sdk })({
        emit: () => {},
        diagnostics: async (fact) => {
          diagnostics.push(fact);
          return undefined;
        },
      });
    const driverA = createDriver(diagnosticsA);
    const driverB = createDriver(diagnosticsB);
    const start = (
      driver: ReturnType<typeof createDriver>,
      sessionId: string,
    ) =>
      driver.start({
        sessionId: sessionId as never,
        turnId: "turn" as never,
        sessionName: sessionId as never,
        harness: "qoder",
        message: "keep this real SDK input stream open",
        cwd: directory,
        authorizationMode: "allowAll",
      });

    try {
      process.env.QODER_LIFECYCLE_HELPER_MODE = "ignore-term";
      start(driverA, "owned-a");
      const sessionA = await waitFor(
        async () => (await fixtureSessions(directory))[0],
        "session A",
      );
      await waitFor(
        async () =>
          sessionA.helperReadyPath === undefined
            ? undefined
            : access(sessionA.helperReadyPath).then(
                () => true,
                () => undefined,
              ),
        "session A helper readiness",
      );
      expect(await processGroupId(sessionA.helperPid!)).toBe(
        sessionA.helperPid,
      );
      expect(await processGroupId(sessionA.helperPid!)).not.toBe(
        await processGroupId(sessionA.rootPid),
      );

      process.env.QODER_LIFECYCLE_HELPER_MODE = "ignore-term";
      start(driverB, "owned-b");
      const sessionB = await waitFor(
        async () =>
          (await fixtureSessions(directory)).find(
            (session) => session.rootPid !== sessionA.rootPid,
          ),
        "session B",
      );
      await waitFor(
        async () =>
          sessionB.helperReadyPath === undefined
            ? undefined
            : access(sessionB.helperReadyPath).then(
                () => true,
                () => undefined,
              ),
        "session B helper readiness",
      );

      await driverA.terminate("owned-a" as never);
      await waitForExit(sessionA.rootPid, sessionA.rootStartTime);
      await waitForExit(sessionA.helperPid!, sessionA.helperStartTime!);
      expect(await isRunning(sessionB.rootPid, sessionB.rootStartTime)).toBe(
        true,
      );
      expect(
        await isRunning(sessionB.helperPid!, sessionB.helperStartTime!),
      ).toBe(true);
      expect(
        await readFile(
          join(directory, `interrupt-${sessionA.rootPid}.count`),
          "utf8",
        ),
      ).toBe("1");
      expect(
        diagnosticsA.filter((fact) => fact.reason === "closed"),
      ).toHaveLength(1);

      await driverB.terminate("owned-b" as never);
      await waitForExit(sessionB.rootPid, sessionB.rootStartTime);
      await waitForExit(sessionB.helperPid!, sessionB.helperStartTime!);
      expect(
        diagnosticsB.filter((fact) => fact.reason === "closed"),
      ).toHaveLength(1);
    } finally {
      await forceFixtureCleanup(directory);
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  test("live model lookup sends its control request before temporary input reaches EOF", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-qoder-models-"));
    configureEnvironment(directory);
    try {
      const models = await createRealQoderSdk().getAvailableModels({
        fetchStrategy: "live",
      });
      expect(models).toEqual([
        {
          value: "fixture-model",
          displayName: "Fixture model",
          description: "Local control fixture",
        },
      ]);
      const session = await waitFor(
        async () => (await fixtureSessions(directory))[0],
        "model query process",
      );
      const events = await readFile(
        join(directory, `events-${session.rootPid}.jsonl`),
        "utf8",
      );
      expect(events.indexOf("get_models_response")).toBeGreaterThanOrEqual(0);
      expect(events.indexOf("get_models_response")).toBeLessThan(
        events.indexOf("stdin_eof"),
      );
      await waitForExit(session.rootPid, session.rootStartTime);
    } finally {
      await forceFixtureCleanup(directory);
      await rm(directory, { recursive: true, force: true });
    }
  }, 8_000);

  test("cleans a captured helper after the interrupt ACK lets its root exit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-qoder-orphan-"));
    configureEnvironment(directory);
    process.env.QODER_LIFECYCLE_HELPER_MODE = "ignore-term";
    process.env.QODER_LIFECYCLE_ROOT_MODE = "exit-on-interrupt";
    const driver = createQoderDriver({ sdk: createRealQoderSdk() })({
      emit: () => {},
      diagnostics: async () => undefined,
    });
    driver.start({
      sessionId: "orphaned-root" as never,
      turnId: "turn" as never,
      sessionName: "orphaned-root" as never,
      harness: "qoder",
      message: "keep this real SDK input stream open",
      cwd: directory,
      authorizationMode: "allowAll",
    });

    try {
      const session = await waitFor(
        async () => (await fixtureSessions(directory))[0],
        "orphan test session",
      );
      await waitFor(
        async () =>
          session.helperReadyPath === undefined
            ? undefined
            : access(session.helperReadyPath).then(
                () => true,
                () => undefined,
              ),
        "orphan test helper readiness",
      );
      await waitFor(async () => {
        try {
          return (
            await readFile(
              join(directory, `events-${session.rootPid}.jsonl`),
              "utf8",
            )
          ).includes("initialize_request")
            ? true
            : undefined;
        } catch {
          return undefined;
        }
      }, "orphan test initialize request");
      expect(await processGroupId(session.helperPid!)).toBe(session.helperPid);
      expect(await processGroupId(session.helperPid!)).not.toBe(
        await processGroupId(session.rootPid),
      );

      await driver.terminate("orphaned-root" as never);

      await waitForExit(session.rootPid, session.rootStartTime);
      await waitForExit(session.helperPid!, session.helperStartTime!);
    } finally {
      await forceFixtureCleanup(directory);
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);

  test("cleans a helper first spawned while the runtime handles stdin EOF", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-qoder-late-child-"));
    configureEnvironment(directory);
    process.env.QODER_LIFECYCLE_ROOT_MODE = "late-child-on-eof";
    const diagnostics: DriverDiagnosticFact[] = [];
    const driver = createQoderDriver({ sdk: createRealQoderSdk() })({
      emit: () => {},
      diagnostics: async (fact) => {
        diagnostics.push(fact);
        return undefined;
      },
    });
    driver.start({
      sessionId: "late-child" as never,
      turnId: "turn" as never,
      sessionName: "late-child" as never,
      harness: "qoder",
      message: "keep this real SDK input stream open",
      cwd: directory,
      authorizationMode: "allowAll",
    });

    try {
      const initial = await waitFor(
        async () => (await fixtureSessions(directory))[0],
        "late-child session",
      );
      await waitFor(async () => {
        try {
          return (
            await readFile(
              join(directory, `events-${initial.rootPid}.jsonl`),
              "utf8",
            )
          ).includes("initialize_request")
            ? true
            : undefined;
        } catch {
          return undefined;
        }
      }, "late-child initialize request");

      await driver.terminate("late-child" as never);

      const closed = diagnostics.some((fact) => fact.reason === "closed");
      expect(closed).toBe(true);
      const session = await waitFor(
        async () =>
          (await fixtureSessions(directory)).find(
            (entry) => entry.lateHelperPid !== undefined,
          ),
        "EOF-spawned helper identity",
      );
      expect(await isRunning(session.rootPid, session.rootStartTime)).toBe(
        false,
      );
      expect(await isRunning(initial.ownerPid, initial.ownerStartTime)).toBe(
        false,
      );
      expect(
        await isRunning(session.lateHelperPid!, session.lateHelperStartTime!),
      ).toBe(false);
    } finally {
      await forceFixtureCleanup(directory);
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);

  test("does not treat an unexpected holder exit as tree closure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-qoder-dead-holder-"));
    configureEnvironment(directory);
    process.env.QODER_LIFECYCLE_HELPER_MODE = "ignore-term";
    const diagnostics: DriverDiagnosticFact[] = [];
    const driver = createQoderDriver({ sdk: createRealQoderSdk() })({
      emit: () => {},
      diagnostics: async (fact) => {
        diagnostics.push(fact);
        return undefined;
      },
    });
    driver.start({
      sessionId: "dead-holder" as never,
      turnId: "turn" as never,
      sessionName: "dead-holder" as never,
      harness: "qoder",
      message: "keep this real SDK input stream open",
      cwd: directory,
      authorizationMode: "allowAll",
    });

    try {
      const session = await waitFor(
        async () => (await fixtureSessions(directory))[0],
        "unexpected-holder-exit session",
      );
      await waitFor(
        async () =>
          session.helperReadyPath === undefined
            ? undefined
            : access(session.helperReadyPath).then(
                () => true,
                () => undefined,
              ),
        "unexpected-holder-exit helper readiness",
      );
      expect(await isRunning(session.ownerPid, session.ownerStartTime)).toBe(
        true,
      );
      process.kill(session.ownerPid, "SIGKILL");
      await waitForExit(session.ownerPid, session.ownerStartTime);

      await expect(driver.terminate("dead-holder" as never)).rejects.toThrow();
      expect(diagnostics.some((fact) => fact.reason === "closed")).toBe(false);
      expect(
        await isRunning(session.helperPid!, session.helperStartTime!),
      ).toBe(true);
    } finally {
      await forceFixtureCleanup(directory);
      await rm(directory, { recursive: true, force: true });
    }
  }, 8_000);

  test("failed live model lookup still closes its temporary query and propagates the error", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "reins-qoder-model-failure-"),
    );
    configureEnvironment(directory);
    process.env.QODER_LIFECYCLE_MODEL_MODE = "reject";
    try {
      await expect(
        createRealQoderSdk().getAvailableModels({ fetchStrategy: "live" }),
      ).rejects.toThrow("fixture model lookup failure");
      const session = await waitFor(
        async () => (await fixtureSessions(directory))[0],
        "failed model query process",
      );
      await waitForExit(session.rootPid, session.rootStartTime);
    } finally {
      await forceFixtureCleanup(directory);
      await rm(directory, { recursive: true, force: true });
    }
  }, 8_000);

  test("retries a failed model-query cleanup before opening the next query", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "reins-qoder-model-cleanup-retry-"),
    );
    configureEnvironment(directory);
    process.env.QODER_LIFECYCLE_HELPER_MODE = "ignore-term";
    process.env.QODER_LIFECYCLE_MODEL_MODE = "reject";
    const sdk = createRealQoderSdk();

    try {
      const firstLookup = sdk.getAvailableModels({ fetchStrategy: "live" });
      const original = await waitFor(
        async () => (await fixtureSessions(directory))[0],
        "first model-query process",
      );
      await waitFor(
        async () =>
          original.helperReadyPath === undefined
            ? undefined
            : access(original.helperReadyPath).then(
                () => true,
                () => undefined,
              ),
        "first model-query helper",
      );
      const owner = await processInfo(original.ownerPid);
      expect(owner?.startTime).toBe(original.ownerStartTime);
      process.kill(original.ownerPid, "SIGSTOP");

      let firstFailure: unknown;
      try {
        await firstLookup;
      } catch (error) {
        firstFailure = error;
      }
      expect(firstFailure).toBeInstanceOf(AggregateError);
      const firstErrors = (firstFailure as AggregateError).errors;
      expect(
        firstErrors.some((error) =>
          String(error).includes("fixture model lookup failure"),
        ),
      ).toBe(true);
      expect(
        firstErrors.some((error) =>
          String(error).includes("resource holder did not confirm"),
        ),
      ).toBe(true);
      expect(
        await isRunning(original.helperPid!, original.helperStartTime!),
      ).toBe(true);

      delete process.env.QODER_LIFECYCLE_MODEL_MODE;
      const nextLookup = sdk.getAvailableModels({ fetchStrategy: "live" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await fixtureSessions(directory)).toHaveLength(1);
      const currentOwner = await processInfo(original.ownerPid);
      if (currentOwner?.startTime === original.ownerStartTime) {
        process.kill(original.ownerPid, "SIGCONT");
      }
      const models = await nextLookup;
      expect(models).toEqual([
        {
          value: "fixture-model",
          displayName: "Fixture model",
          description: "Local control fixture",
        },
      ]);
      const sessions = await fixtureSessions(directory);
      expect(sessions).toHaveLength(2);
      expect(
        await isRunning(original.helperPid!, original.helperStartTime!),
      ).toBe(false);
      const next = sessions.find(
        (session) => session.rootPid !== original.rootPid,
      );
      expect(next).toBeDefined();
      await waitForExit(next!.rootPid, next!.rootStartTime);
      await waitForExit(next!.helperPid!, next!.helperStartTime!);
    } finally {
      await forceFixtureCleanup(directory);
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  test("waits for a failed model-query root before opening the next query", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "reins-qoder-model-root-cleanup-retry-"),
    );
    configureEnvironment(directory);
    process.env.QODER_LIFECYCLE_ROOT_MODE = "delayed-exit-after-eof";
    const sdk = createRealQoderSdk();

    try {
      const firstLookup = sdk.getAvailableModels({ fetchStrategy: "live" });
      const original = await waitFor(
        async () => (await fixtureSessions(directory))[0],
        "root-close failure process",
      );
      const owner = await processInfo(original.ownerPid);
      expect(owner?.startTime).toBe(original.ownerStartTime);
      process.kill(original.ownerPid, "SIGSTOP");
      await expect(firstLookup).rejects.toThrow(
        "resource holder did not confirm process-tree closure",
      );
      expect(await isRunning(original.rootPid, original.rootStartTime)).toBe(
        true,
      );
      expect(await fixtureSessions(directory)).toHaveLength(1);

      delete process.env.QODER_LIFECYCLE_ROOT_MODE;
      const nextLookup = sdk.getAvailableModels({ fetchStrategy: "live" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await fixtureSessions(directory)).toHaveLength(1);
      const currentOwner = await processInfo(original.ownerPid);
      if (currentOwner?.startTime === original.ownerStartTime) {
        process.kill(original.ownerPid, "SIGCONT");
      }
      const models = await nextLookup;
      expect(models).toEqual([
        {
          value: "fixture-model",
          displayName: "Fixture model",
          description: "Local control fixture",
        },
      ]);
      expect(await isRunning(original.rootPid, original.rootStartTime)).toBe(
        false,
      );
      const sessions = await fixtureSessions(directory);
      expect(sessions).toHaveLength(2);
      const next = sessions.find(
        (session) => session.rootPid !== original.rootPid,
      );
      expect(next).toBeDefined();
      await waitForExit(next!.rootPid, next!.rootStartTime);
    } finally {
      await forceFixtureCleanup(directory);
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
