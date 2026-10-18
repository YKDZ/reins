import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { resolveDaemonState } from "@reins/daemon/state";
import {
  parseRuntimeScopeId,
  type ControlRuntimeTarget,
} from "@ykdz/reins-sdk";

export async function resolveControlRuntimeTarget(options?: {
  readonly env?: Record<string, string | undefined>;
}): Promise<ControlRuntimeTarget> {
  const env = options?.env ?? process.env;
  const state = await resolveDaemonState({ env });
  const entryUrl = import.meta.url.endsWith(".ts")
    ? new URL("../dist/stdio-main.js", import.meta.url)
    : new URL("./stdio-main.js", import.meta.url);
  const entry = fileURLToPath(entryUrl);
  if (!existsSync(entry))
    throw new Error(
      "Installed runtime package is missing its stdio control entry",
    );
  return {
    command: process.execPath,
    args: [entry],
    runtimeScopeId: parseRuntimeScopeId(state.runtimeScopeId),
  };
}
