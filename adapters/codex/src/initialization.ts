import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { InitializeCapabilities } from "./generated/InitializeCapabilities.ts";
import type { CodexTransport } from "./transport.ts";

type HomeInitialization = {
  initialized: boolean;
  pending: Promise<void> | null;
};

const initializations = new Map<string, HomeInitialization>();

function codexHome(): string {
  return resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
}

async function startAndInitialize(transport: CodexTransport): Promise<void> {
  if (transport.isClosed()) throw new Error("Codex app-server is closed");
  transport.start();
  await transport.request("initialize", {
    clientInfo: { name: "reins", title: null, version: "0.0.0" },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
    } satisfies InitializeCapabilities,
  });
  transport.notify("initialized", {});
}

export async function initializeCodexTransport(
  transport: CodexTransport,
): Promise<void> {
  const home = codexHome();
  let state = initializations.get(home);
  if (state === undefined) {
    state = { initialized: false, pending: null };
    initializations.set(home, state);
  }

  if (state.initialized) {
    await startAndInitialize(transport);
    return;
  }
  if (state.pending !== null) {
    await state.pending;
    await startAndInitialize(transport);
    return;
  }

  const pending = Promise.resolve()
    .then(() => startAndInitialize(transport))
    .then(() => {
      state.initialized = true;
    });
  state.pending = pending;
  try {
    await pending;
  } finally {
    if (state.pending === pending) state.pending = null;
  }
}
