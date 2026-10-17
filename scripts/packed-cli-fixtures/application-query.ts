import {
  ReinsSdkError,
  type ReinsConnection,
  type SessionHandle,
} from "@ykdz/reins-sdk";
import { connectReins } from "@ykdz/reins/application";

declare const process: {
  env: Record<string, string | undefined>;
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
    const capabilities = await connection.capabilities();
    const sessions = await connection.list();
    if (
      capabilities.capabilities[0]?.harness !== "fixture" ||
      capabilities.failures.length !== 0 ||
      sessions.length !== 0
    ) {
      throw new Error("The installed application returned unexpected data");
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
        capabilityHarness: capabilities.capabilities[0]?.harness,
        sessionCount: sessions.length,
        failureCode: queryFailure.code,
        failureStage: queryFailure.stage,
      })}\n`,
    );
  } finally {
    connection.close();
  }
}

await main();
