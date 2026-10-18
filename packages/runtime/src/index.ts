import { machineErrorSchema, makeErrorCause } from "@reins/protocol";
import {
  connect as connectSdk,
  ReinsSdkError,
  type ReinsConnection,
  type ReinsFailure,
} from "@ykdz/reins-sdk";
import * as v from "valibot";

import type { OpenLocalOptions } from "./application-contracts.js";
import {
  connectWithStartup,
  isReinsStartupTransportFailure,
} from "./application-runtime.ts";

export type { OpenLocalOptions } from "./application-contracts.js";

// 本机 daemon 的启动归运行包应用层；连接、握手和查询统一使用公开 SDK。
export async function openLocal(
  options: OpenLocalOptions,
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
  if (error instanceof ReinsSdkError) return undefined;
  if (isReinsStartupTransportFailure(error)) {
    return new ReinsSdkError(
      {
        code: "daemon_start_failed",
        facts: { transportCode: error.code },
      },
      "connect",
    );
  }
  if (error instanceof Error) {
    const systemCode = (error as Error & { code?: unknown }).code;
    if (typeof systemCode === "string") {
      return new ReinsSdkError(
        {
          code: "daemon_start_failed",
          facts: {
            cause: makeErrorCause("io", error.message),
            systemCode,
          },
        },
        "connect",
      );
    }
  }
  const parsed = v.safeParse(machineErrorSchema, error);
  if (!parsed.success) return undefined;
  const machineError = parsed.output;
  const failure = ((): ReinsFailure => {
    switch (machineError.code) {
      case "consumer_context_required":
        return { code: "consumer_context_required", facts: {} };
      case "protocol_error":
        return { code: "protocol_error", facts: {} };
      case "daemon_timeout":
        return { code: "daemon_timeout", facts: {} };
      case "invalid_daemon_response":
        return { code: "invalid_daemon_response", facts: {} };
      case "daemon_disconnected":
        return { code: "daemon_disconnected", facts: {} };
      case "daemon_shutting_down":
        return { code: "daemon_shutting_down", facts: {} };
      case "workspace_detaching":
        return { code: "workspace_detaching", facts: {} };
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
  return new ReinsSdkError(failure, "connect");
}
