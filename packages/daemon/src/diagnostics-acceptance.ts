import { withinDiagnosticBudget } from "@reins/adapter-kit";
import type {
  DiagnosticId,
  DiagnosticInput,
  DiagnosticsParams,
  DiagnosticsResult,
} from "@reins/protocol";

import type { ConsumerScope } from "./consumer-scope.ts";
import type { DiagnosticsRuntime } from "./diagnostics-recorder.ts";

type RecordDiagnostic = (
  input: DiagnosticInput,
) => Promise<DiagnosticId | undefined>;

export type OrderedDiagnosticsRuntime = DiagnosticsRuntime & {
  runCausal<T>(operation: (record: RecordDiagnostic) => Promise<T>): Promise<T>;
};

/**
 * daemon 内部的单一接纳序列。query 的调用位置就是固定水位；runCausal
 * 内部的重试继续占用原接纳位置，不会被后续 query 截断。
 */
export function orderDiagnosticsAcceptance(
  runtime: DiagnosticsRuntime,
  consumerScope: ConsumerScope,
): OrderedDiagnosticsRuntime {
  let tail: Promise<void> | undefined;

  function start<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return operation();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = tail;
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 先发布接纳位置，再允许底层 operation 同步重入同一队列。
    tail = slot;

    const accepted =
      predecessor === undefined
        ? start(operation)
        : predecessor.then(operation);

    function settle(): void {
      if (tail === slot) tail = undefined;
      release();
    }

    return accepted.then(
      (value) => {
        settle();
        return value;
      },
      (error: unknown) => {
        settle();
        throw error;
      },
    );
  }

  const recordNow: RecordDiagnostic = (input) => {
    const consumer = consumerScope.ownerForFact(input);
    return withinDiagnosticBudget(() =>
      consumer === undefined
        ? runtime.record(input)
        : runtime.record(input, consumer),
    );
  };

  return {
    generation: runtime.generation,
    sessionId: (name) => runtime.sessionId(name),
    record(input) {
      const acceptedInput = structuredClone(input);
      // 归属在接纳点按请求因果确定，队列把 operation 延后也不改变所有权。
      const consumer = consumerScope.ownerForFact(acceptedInput);
      return enqueue(() =>
        withinDiagnosticBudget(() =>
          consumer === undefined
            ? runtime.record(acceptedInput)
            : runtime.record(acceptedInput, consumer),
        ),
      );
    },
    query(params: DiagnosticsParams): Promise<DiagnosticsResult> {
      const acceptedParams = structuredClone(params);
      const scope = consumerScope.current();
      return enqueue(() =>
        withinDiagnosticBudget(() =>
          scope === undefined
            ? runtime.query(acceptedParams)
            : runtime.query(acceptedParams, scope),
        ),
      );
    },
    runCausal(operation) {
      return enqueue(() => operation(recordNow));
    },
    health: () => runtime.health(),
    close: () => enqueue(() => runtime.close()),
  };
}
