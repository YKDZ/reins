import {
  ReinsSdkError,
  type ReinsConnection,
  type SessionHandle,
} from "@ykdz/reins-sdk";
import { connectReins } from "@ykdz/reins/application";

declare const process: {
  env: Record<string, string | undefined>;
  cwd(): string;
  stdout: { write(value: string): void };
};

async function main(): Promise<void> {
  const socketPath = process.env.REINS_SOCKET;
  const consumerContext = process.env.REINS_CONSUMER_CONTEXT;
  const daemonBin = process.env.REINS_DAEMON_BIN;
  if (
    socketPath === undefined ||
    consumerContext === undefined ||
    daemonBin === undefined
  ) {
    throw new Error("The installed application query needs its runtime env");
  }

  const connection: ReinsConnection = await connectReins({
    consumerContext,
    env: process.env,
  });
  try {
    const currentModelCatalog = await connection.modelCatalog();
    const sessions = await connection.list();
    if (
      currentModelCatalog.catalogs[0]?.harness !== "codex" ||
      currentModelCatalog.failures.length !== 0 ||
      sessions.length !== 0
    ) {
      throw new Error("The installed application returned unexpected data");
    }

    const spawned = await connection.spawn(
      {
        harness: "codex",
        sessionName: "packed-application-session",
        message: "programmatic runtime consumption",
        cwd: process.env.REINS_WORKER_CWD ?? process.cwd(),
      },
      connection.prepareOperation("spawn"),
    );
    const pending = await connection.wait({
      targets: [spawned.turnHandle],
      completion: "all",
      timeoutMs: 0,
    });
    if (
      pending.status !== "timeout" ||
      pending.completed.length !== 0 ||
      pending.pending.length !== 1 ||
      pending.pending[0] !== spawned.turnHandle
    ) {
      throw new Error(
        "The installed application changed the exact wait target",
      );
    }
    const busy = await connection.list({
      sessionHandle: spawned.sessionHandle,
    });
    if (
      busy.length !== 1 ||
      busy[0]?.state !== "busy" ||
      busy[0].activeTurn !== spawned.turnHandle
    ) {
      throw new Error("The installed application changed the spawned session");
    }
    const killed = await connection.kill(
      { sessionHandle: spawned.sessionHandle },
      connection.prepareOperation("kill"),
    );
    const completed = await connection.wait({
      targets: [spawned.turnHandle],
      completion: "all",
    });
    if (
      killed.status !== "killed" ||
      killed.sessionHandle !== spawned.sessionHandle ||
      completed.status !== "satisfied" ||
      completed.completed[0]?.turnHandle !== spawned.turnHandle ||
      completed.completed[0]?.stopReason !== "killed"
    ) {
      throw new Error(
        "The installed application did not recover its exact close",
      );
    }

    let queryFailure:
      | { code: string; stage: string; includesSessionHandle: boolean }
      | undefined;
    try {
      await connection.list({ sessionHandle: "" as SessionHandle });
    } catch (error) {
      if (!(error instanceof ReinsSdkError)) throw error;
      queryFailure = {
        code: error.failure.code,
        stage: error.stage,
        includesSessionHandle:
          error.failure.code === "invalid_params" &&
          error.failure.facts.issues.some((issue) =>
            issue.issue === "invalid_combination"
              ? issue.paths.includes("sessionHandle")
              : issue.path === "sessionHandle",
          ),
      };
    }
    if (
      queryFailure === undefined ||
      queryFailure.stage !== "query" ||
      queryFailure.code !== "invalid_params" ||
      !queryFailure.includesSessionHandle
    ) {
      throw new Error(
        "The installed application omitted its typed query error",
      );
    }

    process.stdout.write(
      `${JSON.stringify({
        status: "queried",
        modelCatalogHarness: currentModelCatalog.catalogs[0]?.harness,
        sessionCount: sessions.length,
        failureCode: queryFailure.code,
        failureStage: queryFailure.stage,
        sessionHandle: spawned.sessionHandle,
        turnHandle: spawned.turnHandle,
        closeReason: completed.completed[0]?.stopReason,
      })}\n`,
    );
  } finally {
    connection.close();
  }
}

await main();
