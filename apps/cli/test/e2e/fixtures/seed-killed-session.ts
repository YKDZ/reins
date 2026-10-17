import { stat } from "node:fs/promises";

import { createReinsClient } from "@reins/client/control";
import {
  consumerContextSchema,
  sessionNameSchema,
  type ProtocolMessage,
} from "@reins/protocol";
import { createUnixSocketClient } from "@reins/transport";
import * as v from "valibot";

async function main(): Promise<void> {
  const socketPath = process.env.REINS_SOCKET;
  const consumerContext = process.env.REINS_CONSUMER_CONTEXT;
  if (socketPath === undefined || consumerContext === undefined) {
    throw new Error("The session fixture needs socket and consumer context");
  }

  const directory = process.cwd();
  const identity = await stat(directory, { bigint: true });
  const transport = await createUnixSocketClient<ProtocolMessage>(socketPath);
  const client = createReinsClient(transport, {
    consumerContext: v.parse(consumerContextSchema, consumerContext),
  });
  try {
    const initialized = await client.initialize();
    if ("error" in initialized)
      throw new Error(`Daemon handshake failed: ${initialized.error.code}`);

    const spawned = await client.request("spawn", {
      harness: "simulated",
      message: "complete before killing this fixture session",
      sessionName: v.parse(sessionNameSchema, "ticket02-killed-list"),
      cwd: directory,
      cwdIdentity: {
        device: String(identity.dev),
        inode: String(identity.ino),
      },
    });
    if ("error" in spawned)
      throw new Error(`Session spawn failed: ${spawned.error.code}`);

    const { sessionId, turnId } = spawned.result;
    const waited = await client.request(
      "wait",
      {
        targets: [{ sessionId, turnId }],
        completion: "all",
        timeoutMs: 5_000,
      },
      6_000,
    );
    if (
      "error" in waited ||
      waited.result.status !== "satisfied" ||
      waited.result.completed[0]?.stopReason !== "end_turn"
    ) {
      const code = "error" in waited ? waited.error.code : waited.result.status;
      throw new Error(`Fixture turn did not complete: ${code}`);
    }

    const killed = await client.request("kill", { sessionId });
    if (
      "error" in killed ||
      killed.result.status !== "killed" ||
      killed.result.sessionId !== sessionId
    ) {
      const status =
        "error" in killed ? killed.error.code : killed.result.status;
      throw new Error(`Fixture session was not killed: ${status}`);
    }

    process.stdout.write(
      `${JSON.stringify({ sessionHandle: sessionId, stopReason: "end_turn" })}\n`,
    );
  } finally {
    client.close();
  }
}

await main();
