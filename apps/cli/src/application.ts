import { machineErrorSchema } from "@reins/protocol";
import {
  connect as connectSdk,
  ReinsSdkError,
  type ReinsConnection,
  type ReinsFailure,
} from "@ykdz/reins-sdk";
import * as v from "valibot";

import type { ConnectReinsOptions } from "./application-contracts.js";
import {
  connectWithStartup,
  isReinsStartupTransportFailure,
} from "./application-runtime.ts";

export type { ConnectReinsOptions } from "./application-contracts.js";

// 本机 daemon 的启动归运行包应用层；连接、握手和查询统一使用公开 SDK。
export async function connectReins(
  options: ConnectReinsOptions,
): Promise<ReinsConnection> {
  try {
    return await connectWithStartup(
      options,
      (socketPath, consumerContext, timeoutMs) =>
        connectSdk({ socketPath, consumerContext, timeoutMs }),
    );
  } catch (error) {
    const failure = startupSdkFailure(error);
    if (failure !== undefined) throw failure;
    throw error;
  }
}

function startupSdkFailure(error: unknown): ReinsSdkError | undefined {
  if (isReinsStartupTransportFailure(error)) {
    return new ReinsSdkError({
      code: "daemon_start_failed",
      facts: { transportCode: error.code },
    });
  }
  const parsed = v.safeParse(machineErrorSchema, error);
  if (!parsed.success) return undefined;
  const machineError = parsed.output;
  const failure: ReinsFailure = (() => {
    switch (machineError.code) {
      case "consumer_context_required":
      case "protocol_error":
      case "daemon_timeout":
      case "invalid_daemon_response":
      case "daemon_disconnected":
      case "daemon_shutting_down":
      case "workspace_detaching":
        return { code: machineError.code, facts: {} };
      case "protocol_version_mismatch":
        return {
          code: machineError.code,
          facts: {
            requestedProtocolMajorVersion:
              machineError.requestedProtocolMajorVersion,
            supportedProtocolMajorVersion:
              machineError.supportedProtocolMajorVersion,
          },
        };
      case "daemon_start_failed":
        return {
          code: machineError.code,
          facts: { cause: machineError.cause },
        };
      default:
        return {
          code: "unexpected_failure",
          facts: { remoteCode: machineError.code },
        };
    }
  })();
  return new ReinsSdkError(failure);
}
