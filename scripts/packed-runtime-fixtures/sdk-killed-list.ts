import { connect, type SessionHandle } from "@ykdz/reins-sdk";

declare const process: {
  env: Record<string, string | undefined>;
  stdout: { write(value: string): void };
};

async function main(): Promise<void> {
  const socketPath = process.env.REINS_SOCKET;
  const consumerContext = process.env.REINS_CONSUMER_CONTEXT;
  const sessionHandle = process.env.REINS_TARGET_SESSION;
  if (
    socketPath === undefined ||
    consumerContext === undefined ||
    sessionHandle === undefined
  ) {
    throw new Error("The SDK list fixture needs socket, context, and handle");
  }

  const connection = await connect({
    socketPath,
    consumerContext,
  });
  try {
    const sessions = await connection.list({
      sessionHandle: sessionHandle as SessionHandle,
    });
    const [session] = sessions;
    if (
      sessions.length !== 1 ||
      session?.state !== "killed" ||
      session.lastCompletedTurn?.stopReason !== "end_turn" ||
      session.lastCompletedTurn.turnHandle === ""
    ) {
      throw new Error("The SDK omitted the killed session's completed turn");
    }
    process.stdout.write(
      `${JSON.stringify({
        state: session.state,
        sessionHandle: session.sessionHandle,
        lastCompletedTurn: session.lastCompletedTurn,
      })}\n`,
    );
  } finally {
    connection.close();
  }
}

await main();
