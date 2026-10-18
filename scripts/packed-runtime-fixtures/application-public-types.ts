import { openLocal, type OpenLocalOptions } from "@ykdz/reins";
import type { ReinsConnection } from "@ykdz/reins-sdk";

declare const process: { env: Record<string, string | undefined> };

const options: OpenLocalOptions = {
  consumerContext: "installed-runtime-consumer",
  timeoutMs: 5_000,
  env: process.env,
};
const connection: Promise<ReinsConnection> = openLocal(options);

void connection;
