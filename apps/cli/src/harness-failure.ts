import type { DiagnosticId, HarnessFailure } from "@reins/protocol";

// 同一机器事实只在这里生成可读文案；不展示厂商原文，也不执行建议动作。
const reasons = {
  credential_rejected: "Harness credentials were rejected",
  quota_exhausted: "Harness quota is exhausted",
  balance_exhausted: "Harness balance is exhausted",
  account_unavailable: "Harness account is unavailable",
  rate_limited: "Harness request was rate limited",
  model_unavailable: "Requested model is unavailable",
  request_rejected: "Harness request was rejected",
  provider_unavailable: "Harness provider is unavailable",
  runtime_unavailable: "Harness runtime is unavailable",
  unclassified: "Harness failure is unclassified",
} satisfies Record<HarnessFailure["failureCategory"], string>;
const dispositions = {
  wait: "Wait before explicitly retrying the same action",
  external_state_change:
    "The same input requires an external state change before retrying",
  input_change: "Change the explicit input before trying another action",
  unknown:
    "Retry disposition is unknown; inspect the available evidence before choosing another action",
} satisfies Record<HarnessFailure["retryDisposition"], string>;

export function harnessFailureMessage(
  failure: HarnessFailure,
  diagnosticId?: DiagnosticId,
): string {
  const message = `${reasons[failure.failureCategory]}. ${dispositions[failure.retryDisposition]}`;
  return diagnosticId === undefined
    ? message
    : `${message}. reins diagnostics --id ${diagnosticId}`;
}
