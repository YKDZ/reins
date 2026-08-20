import {
  DriverFailure,
  isDiagnosticId,
  type AdapterDiagnosticFact,
  type DiagnosticId,
  type DriverDiagnosticFact,
} from "@reins/protocol";

export type DiagnosticSink = (
  input: DriverDiagnosticFact,
) => Promise<DiagnosticId | undefined>;
export type AdapterDiagnosticSink = (
  input: AdapterDiagnosticFact,
) => Promise<DiagnosticId | undefined>;

export const noopDiagnosticSink: DiagnosticSink = async () => undefined;

// adapter 已在最接近根因的边界写入诊断；上层只传递因果，不重复记录。
export class AlreadyDiagnosedError extends DriverFailure {
  readonly alreadyDiagnosed = true;

  constructor(message: string, diagnosticId?: DiagnosticId) {
    super(message, diagnosticId);
  }
}

export function isAlreadyDiagnosedError(
  error: unknown,
): error is AlreadyDiagnosedError {
  return (
    error instanceof AlreadyDiagnosedError &&
    error.alreadyDiagnosed === true &&
    (error.diagnosticId === undefined || isDiagnosticId(error.diagnosticId))
  );
}
