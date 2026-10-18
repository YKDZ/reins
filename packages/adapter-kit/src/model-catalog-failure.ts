import type { DiagnosticId, HarnessFailure } from "@reins/protocol";

import { AlreadyDiagnosedError } from "./diagnostic.ts";

// 目录查询可以安全保留上游分类；原始异常文本仍由诊断边界负责。
export class HarnessModelCatalogFailure extends AlreadyDiagnosedError {
  readonly failure: HarnessFailure;

  constructor(failure: HarnessFailure, diagnosticId?: DiagnosticId) {
    super("Harness model catalog query failed", diagnosticId);
    this.failure = failure;
  }
}

export function isHarnessModelCatalogFailure(
  error: unknown,
): error is HarnessModelCatalogFailure {
  return error instanceof HarnessModelCatalogFailure;
}
