import type { ReinsConnection } from "@ykdz/reins-sdk";
import {
  connectReins,
  type ConnectReinsOptions,
} from "@ykdz/reins/application";

declare const process: { env: Record<string, string | undefined> };

const options: ConnectReinsOptions = {
  consumerContext: "installed-runtime-consumer",
  timeoutMs: 5_000,
  env: process.env,
};
const connection: Promise<ReinsConnection> = connectReins(options);

void connection;
