import {
  DriverFailure,
  isDiagnosticId,
  type AdapterDiagnosticFact,
  type DiagnosticId,
  type DriverDiagnosticFact,
} from "@reins/protocol";

// 只有已持久化且当前可查询的证据才返回 ID；其余情况返回 undefined 或拒绝。
export type DiagnosticSink = (
  input: DriverDiagnosticFact,
) => Promise<DiagnosticId | undefined>;
export type AdapterDiagnosticSink = (
  input: AdapterDiagnosticFact,
) => Promise<DiagnosticId | undefined>;

export const noopDiagnosticSink: DiagnosticSink = async () => undefined;

// 诊断是可选证据。固定内部预算不进入调用方动作输入，也不重试底层操作。
export async function withinDiagnosticBudget<T>(
  operation: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Diagnostic acceptance timed out")),
          250,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function acceptDiagnostic<T>(
  operation: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await withinDiagnosticBudget(operation);
  } catch {
    return undefined;
  }
}

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
