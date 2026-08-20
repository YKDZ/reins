import type { DiagnosticId, DiagnosticInput } from "@reins/protocol";

// recorder 的异步窄缝：只有 store 接受且可查询后才返回 ID。
export type DiagnosticEmitter = {
  record(input: DiagnosticInput): Promise<DiagnosticId | undefined>;
};

export const noopDiagnosticEmitter: DiagnosticEmitter = {
  record: async () => undefined,
};
