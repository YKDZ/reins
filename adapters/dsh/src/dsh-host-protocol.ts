import type { AssistantStreamFrame } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-jobs";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-tool-jobs";
import type { MessageId, TurnId } from "@reins/protocol";

export type DshSafeFailure = {
  readonly code?: string;
  readonly status?: number;
  readonly requestId?: string;
};

export type DshApprovalOutcome =
  | "allowed-once"
  | "rejected"
  | "cancelled"
  | "unavailable";

export type DshHostCommand =
  | {
      readonly id: number;
      readonly type: "start";
      readonly sessionId: string;
      readonly turnId: TurnId;
      readonly messageId?: MessageId;
      readonly message: string;
      readonly cwd: string;
      readonly provider?: string;
      readonly model?: string;
      readonly reasoningEffort?: string;
    }
  | {
      readonly id: number;
      readonly type: "deliver";
      readonly placement: "active_turn" | "new_turn";
      readonly turnId: TurnId;
      readonly messageId?: MessageId;
      readonly message: string;
    }
  | {
      readonly id: number;
      readonly type: "interrupt";
      readonly turnId: TurnId;
    }
  | {
      readonly id: number;
      readonly type: "bind-turn";
      readonly nativeTurn: number;
      readonly turnId: TurnId;
    }
  | {
      readonly id: number;
      readonly type: "cancel-turn-binding";
      readonly nativeTurn: number;
    }
  | {
      readonly id: number;
      readonly type: "resolve-approval";
      readonly approvalId: string;
      readonly outcome: "allowed-once" | "rejected" | "unavailable";
    }
  | { readonly id: number; readonly type: "close" }
  | { readonly id: number; readonly type: "catalog" };

export type DshHostEvent =
  | { readonly type: "ready" }
  | { readonly type: "fatal"; readonly failure: DshSafeFailure }
  | {
      readonly type: "session-event";
      readonly event: SessionEvent;
      readonly nativeTurn?: number;
      readonly turnId?: TurnId;
      readonly callerMessageId?: MessageId;
    }
  | {
      readonly type: "assistant-stream";
      readonly frame: AssistantStreamFrame;
      readonly nativeTurn?: number;
      readonly turnId?: TurnId;
    }
  | {
      readonly type: "approval-requested";
      readonly approvalId: string;
      readonly nativeTurn: number;
      readonly turnId: TurnId;
      readonly toolName: string;
      readonly callId?: string;
      readonly reason?: string;
    };

export type DshTurnEnd =
  | { readonly kind: "completed" }
  | { readonly kind: "aborted" }
  | { readonly kind: "blocked" }
  | { readonly kind: "error"; readonly failure: DshSafeFailure }
  | { readonly kind: "max-tokens" }
  | { readonly kind: "interrupted" }
  | { readonly kind: "forked" };

export type DshHostResponse =
  | {
      readonly id: number;
      readonly type: "accepted";
      readonly nativeMessageId: string;
    }
  | { readonly id: number; readonly type: "interrupted" }
  | { readonly id: number; readonly type: "bound" }
  | { readonly id: number; readonly type: "binding-cancelled" }
  | {
      readonly id: number;
      readonly type: "approval-decided";
      readonly approvalId: string;
      readonly outcome: DshApprovalOutcome;
    }
  | {
      readonly id: number;
      readonly type: "catalog";
      readonly models: readonly {
        readonly provider: string;
        readonly model: string;
        readonly displayName: string;
        readonly reasoningEfforts: readonly string[];
      }[];
    }
  | {
      readonly id: number;
      readonly type: "catalog-failed";
      readonly failure: DshSafeFailure;
    }
  | {
      readonly id: number;
      readonly type: "rejected";
      readonly acceptance: "not_accepted" | "unknown";
      readonly failure?: DshSafeFailure;
    }
  | { readonly id: number; readonly type: "closed" }
  | {
      readonly id: number;
      readonly type: "fatal";
      readonly failure?: DshSafeFailure;
    };

export function isHostMessage(
  value: unknown,
): value is DshHostEvent | DshHostResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
  );
}

export function failureFromSafeFacts(
  failure: DshSafeFailure,
): import("@reins/protocol").HarnessFailure {
  const code = failure.code?.toUpperCase();
  if (
    failure.status === 401 ||
    failure.status === 403 ||
    code === "AUTH" ||
    code === "AUTHENTICATION_ERROR" ||
    code === "INVALID_API_KEY"
  ) {
    return {
      failureCategory: "credential_rejected",
      retryDisposition: "external_state_change",
    };
  }
  if (failure.status === 402 || code?.includes("BALANCE")) {
    return {
      failureCategory: "balance_exhausted",
      retryDisposition: "external_state_change",
    };
  }
  if (code?.includes("QUOTA")) {
    return {
      failureCategory: "quota_exhausted",
      retryDisposition: "external_state_change",
    };
  }
  if (failure.status === 429 || code === "RATE_LIMIT") {
    return { failureCategory: "rate_limited", retryDisposition: "wait" };
  }
  if (failure.status === 404 || code?.includes("MODEL_NOT_FOUND")) {
    return {
      failureCategory: "model_unavailable",
      retryDisposition: "input_change",
    };
  }
  if (failure.status !== undefined && failure.status >= 500) {
    return {
      failureCategory: "provider_unavailable",
      retryDisposition: "wait",
    };
  }
  if (failure.status !== undefined && failure.status >= 400) {
    return {
      failureCategory: "request_rejected",
      retryDisposition: "input_change",
    };
  }
  if (
    code === "NO_ADAPTER" ||
    code === "INVALID_PREPARED_CALL" ||
    code === "DSH_PROFILE_UNAVAILABLE"
  ) {
    return {
      failureCategory: "runtime_unavailable",
      retryDisposition: "external_state_change",
    };
  }
  if (code === "ACCOUNT_UNAVAILABLE") {
    return {
      failureCategory: "account_unavailable",
      retryDisposition: "external_state_change",
    };
  }
  return { failureCategory: "unclassified", retryDisposition: "unknown" };
}

export function safeFailureFrom(error: unknown): DshSafeFailure {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Za-z0-9_.-]{1,80}$/u.test(error.code)
      ? error.code
      : undefined;
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number" &&
    Number.isInteger(error.status) &&
    error.status >= 100 &&
    error.status <= 599
      ? error.status
      : undefined;
  const requestId =
    typeof error === "object" &&
    error !== null &&
    "requestId" in error &&
    typeof error.requestId === "string" &&
    /^[A-Za-z0-9_.:-]{1,128}$/u.test(error.requestId)
      ? error.requestId
      : undefined;
  return {
    ...(code === undefined ? {} : { code }),
    ...(status === undefined ? {} : { status }),
    ...(requestId === undefined ? {} : { requestId }),
  };
}
