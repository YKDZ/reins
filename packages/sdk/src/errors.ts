import type { ReinsFailure } from "./contracts.ts";

export type ReinsSdkErrorStage = "connect" | "handshake" | "query";

export class ReinsSdkError extends Error {
  readonly failure: ReinsFailure;
  readonly stage: ReinsSdkErrorStage;

  constructor(failure: ReinsFailure, stage: ReinsSdkErrorStage = "query") {
    super(failure.code);
    this.name = "ReinsSdkError";
    this.failure = failure;
    this.stage = stage;
  }
}
