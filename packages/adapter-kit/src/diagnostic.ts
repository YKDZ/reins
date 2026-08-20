import type { DiagnosticId, DiagnosticInput } from "@reins/protocol";

export type DiagnosticSink = (
  input: DiagnosticInput,
) => Promise<DiagnosticId | undefined>;

export const noopDiagnosticSink: DiagnosticSink = async () => undefined;

// adapter 已在最接近根因的边界写入诊断；上层只传递因果，不重复记录。
export class AlreadyDiagnosedError extends Error {
  readonly alreadyDiagnosed = true;
  readonly diagnosticId: DiagnosticId | undefined;

  constructor(message: string, diagnosticId?: DiagnosticId) {
    super(message);
    this.diagnosticId = diagnosticId;
  }
}

export function isAlreadyDiagnosedError(
  error: unknown,
): error is AlreadyDiagnosedError {
  return (
    error instanceof Error &&
    "alreadyDiagnosed" in error &&
    error.alreadyDiagnosed === true &&
    (!("diagnosticId" in error) ||
      error.diagnosticId === undefined ||
      typeof error.diagnosticId === "string")
  );
}
