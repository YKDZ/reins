import {
  parseTransportFailureFact,
  type TransportFailureFact,
} from "@reins/protocol";

export const TRANSPORT_ERROR_CODES = [
  "invalid_frame",
  "transport_closed",
  "io_error",
  "timeout",
  "address_in_use",
] as const;
export type TransportErrorCode = (typeof TRANSPORT_ERROR_CODES)[number];

type SelectTransportFailureForReason<TFact, TReason> = TFact extends {
  reason: TReason;
}
  ? TFact
  : never;
type TransportFailureForReason<TReason extends TransportFailureFact["reason"]> =
  SelectTransportFailureForReason<TransportFailureFact, TReason>;

type TransportErrorInput =
  | {
      code: "invalid_frame";
      fact: TransportFailureForReason<"invalid_frame">;
    }
  | {
      code: "transport_closed";
      fact: TransportFailureForReason<"disconnected">;
    }
  | {
      code: "io_error";
      fact: TransportFailureForReason<"io_error">;
    }
  | {
      code: "timeout";
      fact: TransportFailureForReason<"timeout">;
    }
  | {
      code: "address_in_use";
      fact: Extract<
        TransportFailureForReason<"io_error">,
        { operation: "listen"; reason: "io_error" }
      >;
    };

export type TransportError = Error & {
  readonly code: TransportErrorCode;
  readonly fact: TransportFailureFact;
};

const transportErrors = new WeakMap<
  object,
  Readonly<{ code: TransportErrorCode; fact: TransportFailureFact }>
>();

function codeMatchesFact(
  code: TransportErrorCode,
  fact: TransportFailureFact,
): boolean {
  switch (code) {
    case "invalid_frame":
      return fact.operation === "read" && fact.reason === "invalid_frame";
    case "transport_closed":
      return fact.reason === "disconnected";
    case "io_error":
      return fact.reason === "io_error";
    case "timeout":
      return fact.reason === "timeout";
    case "address_in_use":
      return fact.operation === "listen" && fact.reason === "io_error";
  }
}

export function createTransportError(
  input: TransportErrorInput,
): TransportError {
  const fact = parseTransportFailureFact(input.fact);
  if (!codeMatchesFact(input.code, fact)) {
    throw new TypeError("Invalid transport error fact");
  }
  const code = input.code;
  const error = new Error(code) as TransportError;
  Object.defineProperties(error, {
    code: { value: code, enumerable: true },
    fact: { value: fact, enumerable: true },
  });
  transportErrors.set(error, Object.freeze({ code, fact }));
  return error;
}

export function isTransportError(value: unknown): value is TransportError {
  return transportFailureFactOf(value) !== undefined;
}

export function transportFailureFactOf(
  value: unknown,
): TransportFailureFact | undefined {
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  )
    return undefined;
  return transportErrors.get(value)?.fact;
}

export function transportErrorCodeOf(
  value: unknown,
): TransportErrorCode | undefined {
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  )
    return undefined;
  return transportErrors.get(value)?.code;
}

export function isTransportErrorCode(
  value: unknown,
): value is TransportErrorCode {
  return (
    typeof value === "string" &&
    TRANSPORT_ERROR_CODES.some((candidate) => candidate === value)
  );
}

export type TransportEvent<TMessage = unknown> =
  | { kind: "message"; message: TMessage }
  | { kind: "error"; error: TransportError }
  | { kind: "closed" };

// 传输接缝：协议层只依赖 send / onEvent / close，不感知具体传输。
export interface TransportConnection<TMessage = unknown> {
  send(message: TMessage): void;
  onEvent(listener: (event: TransportEvent<TMessage>) => void): () => void;
  close(): void;
}

export interface TransportServer<TMessage = unknown> {
  listen(): Promise<void>;
  close(): Promise<void>;
  onConnection(
    listener: (connection: TransportConnection<TMessage>) => void,
  ): () => void;
}
