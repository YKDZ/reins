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
}

export function isAlreadyDiagnosedError(
  error: unknown,
): error is AlreadyDiagnosedError {
  return (
    error instanceof AlreadyDiagnosedError &&
    // oxlint-disable-next-line typescript/no-unnecessary-boolean-literal-compare -- 运行时信任边界只接受精确 true。
    error.alreadyDiagnosed === true &&
    (error.diagnosticId === undefined || isDiagnosticId(error.diagnosticId))
  );
}
